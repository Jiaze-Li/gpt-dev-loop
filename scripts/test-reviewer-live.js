#!/usr/bin/env node
// Live E2E validation for the ReviewerSession primitive
// (src/bridge/reviewerSession.js) — Issue #2, task-scoped Reviewer step.
// Proves a single, persistent Reviewer conversation can be created once for
// a task and reused across two review() rounds in the same task (a
// REWORK -> fix -> PASS cycle), never creating a second conversation and
// never deleting the conversation in between. Not part of `npm test` — this
// needs your real, already-logged-in Chrome with the gpt-dev-loop extension
// loaded and connected to the local bridge server (see extension/README.md),
// and it creates one real conversation in your real ChatGPT account.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-reviewer-live.js [--close]
//
// By default the Reviewer tab is left open after the run (and the
// conversation is never deleted — deletion is out of scope for this step).
// Pass --close to have the script close just the tab itself.
//
// If ChatGPT reports its own rate limit mid-run, this script stops
// immediately rather than retrying/switching tabs — see README note in
// reviewerSession.js's header comment about why high-frequency
// create/delete previously tripped that limit.

import { loadConfig } from '../src/config.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError } from '../src/bridge/errors.js';

const TASK_ID = 'reviewer-live-e2e-task';

function taskCard() {
  return {
    task_id: TASK_ID,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    goal: 'Live E2E fixture task for ReviewerSession.',
    context: 'This is a synthetic task used only to validate the task-scoped Reviewer conversation primitive.',
    scope: 'No real code changes; the Evidence below is a fixture value.',
    allowed_files: [],
    forbidden_files: [],
    acceptance_criteria: ['the test_value evidence field must be "verified"'],
    verification_commands: [],
    completion_signal: 'the test_value evidence field is verified',
  };
}

function executionReport() {
  return {
    task_id: TASK_ID,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    status: 'DONE',
    changed_files: [],
    tests_run: [],
    test_results: [],
    issues: 'none',
    next_recommendation: 'review the attached evidence',
  };
}

function evidence(testValue) {
  return {
    pass: testValue === 'verified',
    results: [{ command: 'fixture-check', pass: testValue === 'verified', output: `test_value: ${testValue}` }],
  };
}

let startedAt;
function stage(name) {
  console.log(`${name} at +${Date.now() - startedAt}ms`);
}

async function main() {
  const shouldClose = process.argv.includes('--close');
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  const session = new ReviewerSession(config);
  try {
    stage('creating Reviewer tab for task ' + TASK_ID);
    const created = await session.create(TASK_ID);
    stage(`Reviewer tab created (tabId=${created.tabId})`);

    stage('review attempt #1: test_value = pending (expect REWORK)');
    const first = await session.review(TASK_ID, taskCard(), executionReport(), evidence('pending'));
    const firstIdentity = session.getIdentity();
    stage(`attempt #1 decision: ${first.decision} (tabId=${firstIdentity.tabId}, conversationId=${firstIdentity.conversationId})`);

    stage('review attempt #2 (same conversation): test_value = verified (expect PASS)');
    const second = await session.review(TASK_ID, taskCard(), executionReport(), evidence('verified'));
    const secondIdentity = session.getIdentity();
    stage(`attempt #2 decision: ${second.decision} (tabId=${secondIdentity.tabId}, conversationId=${secondIdentity.conversationId})`);

    const tabIdStable = firstIdentity.tabId === secondIdentity.tabId;
    const conversationIdStable = firstIdentity.conversationId != null && firstIdentity.conversationId === secondIdentity.conversationId;
    const firstWasRework = first.decision === 'REWORK';
    const secondWasPass = second.decision === 'PASS';

    console.log('\n--- acceptance checks ---');
    console.log(`tabId identical across both rounds: ${tabIdStable} (${firstIdentity.tabId} -> ${secondIdentity.tabId})`);
    console.log(`conversationId identical across both rounds: ${conversationIdStable} (${firstIdentity.conversationId} -> ${secondIdentity.conversationId})`);
    console.log(`attempt #1 decision was REWORK: ${firstWasRework} (got ${first.decision})`);
    console.log(`attempt #2 decision was PASS: ${secondWasPass} (got ${second.decision})`);
    console.log('no new conversation was created between the two review() calls (ReviewerSession never calls create() again for review())');
    console.log('the Reviewer conversation was not deleted between the two review() calls (review() never does either)');

    const passed = tabIdStable && conversationIdStable && firstWasRework && secondWasPass;

    if (shouldClose) {
      stage('closing Reviewer tab (--close was passed); the conversation itself is left in the account');
      await session.close();
      stage('Reviewer tab closed');
    } else {
      console.log(`\nReviewer tab (id=${secondIdentity.tabId}) left open — pass --close to have this script close it. Conversation left in the account either way.`);
    }

    await closeExtensionServer().catch(() => {});
    console.log(passed ? '\nPASS: one persistent Reviewer conversation ran a REWORK -> fix -> PASS cycle for a single task.' : '\nFAIL: see checks above.');
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
