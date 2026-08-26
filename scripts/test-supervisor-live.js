#!/usr/bin/env node
// Live E2E validation for the SupervisorSession primitive
// (src/bridge/supervisorSession.js) — Issue #2, first step only: proves a
// single, persistent ChatGPT conversation can be created and held open
// across two independent ask() calls, with context continuity between
// them. Not part of `npm test` — this needs your real, already-logged-in
// Chrome with the gpt-dev-loop extension loaded and connected to the local
// bridge server (see extension/README.md), and it creates one real
// conversation in your real ChatGPT account.
//
// Deliberately NOT a repeat/loop like scripts/test-delete-conversation-live.js
// — a Supervisor conversation is meant to persist, not be recreated per
// iteration, so this runs exactly one create() + two ask() calls. Does not
// retry on ChatGPT's own rate limit (SupervisorSession.ask() has no
// built-in retry, unlike the Reviewer transport's askGptWithIdentity) —
// a rate limit stops the run immediately rather than hammering the real
// account.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-supervisor-live.js [--close]
//
// By default the Supervisor tab is left open after the run so you can look
// at it (and confirm by eye that both replies landed in the same
// conversation). Pass --close to have the script close it itself.
//
// Only stage names, tabId/conversationId, and the two literal test
// strings below (chosen to be unambiguous, not sensitive) are logged.

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError } from '../src/bridge/errors.js';

const FIRST_PROMPT = 'Remember this code for this test: SUPERVISOR-CONTEXT-731. Reply only ACK.';
const SECOND_PROMPT = 'What code did I ask you to remember? Reply only with the code.';
const EXPECTED_CODE = 'SUPERVISOR-CONTEXT-731';

let startedAt;
function stage(name) {
  console.log(`${name} at +${Date.now() - startedAt}ms`);
}

async function main() {
  const shouldClose = process.argv.includes('--close');
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  const session = new SupervisorSession(config);
  try {
    stage('creating Supervisor tab');
    const created = await session.create();
    stage(`Supervisor tab created (tabId=${created.tabId})`);

    stage('ask #1: asking the Supervisor to remember a code');
    const firstReply = await session.ask(FIRST_PROMPT);
    const firstIdentity = session.getIdentity();
    stage(`ask #1 reply: "${firstReply}" (tabId=${firstIdentity.tabId}, conversationId=${firstIdentity.conversationId})`);

    stage('ask #2: asking the SAME conversation to recall the code');
    const secondReply = await session.ask(SECOND_PROMPT);
    const secondIdentity = session.getIdentity();
    stage(`ask #2 reply: "${secondReply}" (tabId=${secondIdentity.tabId}, conversationId=${secondIdentity.conversationId})`);

    const tabIdStable = firstIdentity.tabId === secondIdentity.tabId;
    const conversationIdStable = firstIdentity.conversationId != null && firstIdentity.conversationId === secondIdentity.conversationId;
    const codeRecalled = secondReply.trim() === EXPECTED_CODE;

    console.log('\n--- continuity check ---');
    console.log(`tabId identical across both calls: ${tabIdStable} (${firstIdentity.tabId} -> ${secondIdentity.tabId})`);
    console.log(
      `conversationId identical across both calls: ${conversationIdStable} (${firstIdentity.conversationId} -> ${secondIdentity.conversationId})`
    );
    console.log(`ask #2 returned the exact remembered code: ${codeRecalled} ("${secondReply.trim()}")`);
    console.log('no new conversation was created between the two asks (SupervisorSession never calls create() again for ask())');
    console.log('the Supervisor conversation was not deleted/closed between the two asks (ask() never does either)');

    const passed = tabIdStable && conversationIdStable && codeRecalled;

    if (shouldClose) {
      stage('closing Supervisor tab (--close was passed)');
      await session.close();
      stage('Supervisor tab closed');
    } else {
      console.log(`\nSupervisor tab (id=${secondIdentity.tabId}) left open — pass --close to have this script close it.`);
    }

    await closeExtensionServer().catch(() => {});
    console.log(passed ? '\nPASS: one persistent Supervisor conversation held context across two independent ask() calls.' : '\nFAIL: see checks above.');
    process.exitCode = passed ? 0 : 1;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED: ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
      await closeExtensionServer().catch(() => {});
      process.exitCode = 1;
      return;
    }
    console.log(`FAIL: ${err.message}`);
    await closeExtensionServer().catch(() => {});
    process.exitCode = 1;
  }
}

main();
