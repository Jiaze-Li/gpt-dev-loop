#!/usr/bin/env node
// Live E2E validation for SupervisorSession.attach() — proves a persistent
// Supervisor conversation can be reattached and continued PURELY from its
// saved conversationId, after both the original Chrome tab and the original
// Node process are gone. This is deliberately run as two independent
// invocations of this script (not one process doing both halves), because
// the whole point is that continuity does not depend on any in-memory state
// surviving — only the conversationId written to disk in phase A. Not part
// of `npm test` — this needs your real, already-logged-in Chrome with the
// gpt-dev-loop extension loaded and connected to the local bridge server
// (see extension/README.md), and it creates one real conversation in your
// real ChatGPT account.
//
// Usage (two SEPARATE commands, run in order):
//   GPT_BROWSER_MODE=extension node scripts/test-supervisor-attach-live.js --phase=a
//   ... close the ChatGPT tab yourself (or let phase A's own tab close) ...
//   GPT_BROWSER_MODE=extension node scripts/test-supervisor-attach-live.js --phase=b
//
// Phase A creates a Supervisor conversation, asks it to remember a code,
// saves the conversationId to .gpt-dev-loop/supervisor-attach-live-state.json,
// closes its own tab, and exits (the Node process ends — nothing is left
// running). Phase B is a brand-new Node process: it reads that saved
// conversationId, attach()es to the exact same conversation in a NEW worker
// tab, and asks what code was remembered — this only passes if ChatGPT
// itself still has that conversation's history, proving the reattach landed
// in the real, same conversation and not a fresh one.
//
// Only stage names, tabId/conversationId, and the literal test strings below
// (chosen to be unambiguous, not sensitive) are logged.

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError } from '../src/bridge/errors.js';
import { defaultStatePath, writeSessionState, readSessionState } from './liveSessionState.js';

const STATE_PATH = defaultStatePath('supervisor-attach-live-state');
const REMEMBER_PROMPT = 'Remember this code for this workflow: SUPERVISOR-731. Reply only ACK.';
const RECALL_PROMPT = 'What code did I ask you to remember earlier? Reply only with the code.';
const EXPECTED_CODE = 'SUPERVISOR-731';

let startedAt;
function stage(name) {
  console.log(`${name} at +${Date.now() - startedAt}ms`);
}

async function runPhaseA(config) {
  const session = new SupervisorSession(config);
  try {
    stage('phase A: creating Supervisor tab');
    const created = await session.create();
    stage(`phase A: Supervisor tab created (tabId=${created.tabId})`);

    stage('phase A: asking the Supervisor to remember a code');
    const reply = await session.ask(REMEMBER_PROMPT);
    const identity = session.getIdentity();
    stage(`phase A: reply "${reply}" (tabId=${identity.tabId}, conversationId=${identity.conversationId})`);

    if (!identity.conversationId) {
      throw new Error('phase A never captured a conversationId — nothing to save for phase B.');
    }

    await writeSessionState(STATE_PATH, { conversationId: identity.conversationId, savedAt: new Date().toISOString() });
    stage(`phase A: saved conversationId to ${STATE_PATH}`);

    stage('phase A: closing the Supervisor tab');
    await session.close();
    stage('phase A: tab closed');

    await closeExtensionServer().catch(() => {});
    console.log(
      '\nPASS (phase A): conversationId saved to disk and the tab/process are now gone.' +
        `\nRun phase B in a NEW terminal/process: GPT_BROWSER_MODE=extension node scripts/test-supervisor-attach-live.js --phase=b`
    );
    process.exitCode = 0;
  } catch (err) {
    await closeExtensionServer().catch(() => {});
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED (phase A): ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else {
      console.log(`FAIL (phase A): ${err.message}`);
    }
    process.exitCode = 1;
  }
}

async function runPhaseB(config) {
  const shouldClose = process.argv.includes('--close');
  let saved;
  try {
    saved = await readSessionState(STATE_PATH);
  } catch (err) {
    console.log(`FAIL (phase B): could not read saved state from ${STATE_PATH} — run phase A first. (${err.message})`);
    process.exitCode = 1;
    return;
  }
  if (!saved.conversationId) {
    console.log(`FAIL (phase B): ${STATE_PATH} has no conversationId saved.`);
    process.exitCode = 1;
    return;
  }
  stage(`phase B: loaded conversationId ${saved.conversationId} from disk (saved ${saved.savedAt})`);

  const session = new SupervisorSession(config);
  try {
    stage(`phase B: attaching to the exact saved conversation ${saved.conversationId} — a brand-new Node process, no in-memory state`);
    const attached = await session.attach(saved.conversationId);
    stage(`phase B: attached (tabId=${attached.tabId}, conversationId=${attached.conversationId})`);

    const identityMatches = attached.conversationId === saved.conversationId;

    stage('phase B: asking the SAME conversation to recall the code, in a process that never asked the question in phase A');
    const reply = await session.ask(RECALL_PROMPT);
    stage(`phase B: reply "${reply}"`);

    const codeRecalled = reply.trim() === EXPECTED_CODE;

    console.log('\n--- continuity check (across two independent Node processes) ---');
    console.log(`attach() landed in the exact saved conversation: ${identityMatches} (${saved.conversationId} -> ${attached.conversationId})`);
    console.log(`ask() after attach() returned the exact remembered code: ${codeRecalled} ("${reply.trim()}")`);
    console.log('no new conversation was created by attach() (SupervisorSession.attach() never calls supervisorCreate)');

    const passed = identityMatches && codeRecalled;

    if (shouldClose) {
      stage('phase B: closing the attached tab (--close was passed)');
      await session.close();
      stage('phase B: tab closed');
    } else {
      console.log(`\nAttached tab (id=${attached.tabId}) left open — pass --close to have this script close it.`);
    }

    await closeExtensionServer().catch(() => {});
    console.log(
      passed
        ? '\nPASS: a conversation created and closed in one process was exactly reattached and continued in a completely separate later process.'
        : '\nFAIL: see checks above.'
    );
    process.exitCode = passed ? 0 : 1;
  } catch (err) {
    await closeExtensionServer().catch(() => {});
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED (phase B): ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else {
      console.log(`FAIL (phase B): ${err.message}`);
    }
    process.exitCode = 1;
  }
}

async function main() {
  const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.split('=')[1] : null;
  if (phase !== 'a' && phase !== 'b') {
    console.log(
      'Usage:\n' +
        '  GPT_BROWSER_MODE=extension node scripts/test-supervisor-attach-live.js --phase=a\n' +
        '  GPT_BROWSER_MODE=extension node scripts/test-supervisor-attach-live.js --phase=b [--close]\n' +
        '\nRun phase a first, then phase b as a SEPARATE command/process.'
    );
    process.exitCode = 1;
    return;
  }

  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  if (phase === 'a') {
    await runPhaseA(config);
  } else {
    await runPhaseB(config);
  }
}

main();
