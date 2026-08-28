#!/usr/bin/env node
// Live E2E validation for ReviewerSession.attach() — proves a task-scoped
// Reviewer conversation can be reattached and continued PURELY from its
// saved (taskId, conversationId), after both the original Chrome tab and
// the original Node process are gone, and that a DIFFERENT taskId is
// refused even after a successful attach. Mirrors
// test-supervisor-attach-live.js's two-phase shape; see that file's header
// for why this is two separate invocations rather than one process doing
// both halves. Not part of `npm test` — needs your real, already-logged-in
// Chrome with the gpt-dev-loop extension connected to the local bridge
// server, and creates one real conversation in your real ChatGPT account.
//
// Usage (two SEPARATE commands, run in order):
//   GPT_BROWSER_MODE=extension node scripts/test-reviewer-attach-live.js --phase=a
//   ... close the ChatGPT tab yourself (or let phase A's own tab close) ...
//   GPT_BROWSER_MODE=extension node scripts/test-reviewer-attach-live.js --phase=b
//
// Phase A creates a Reviewer conversation for a fixed task, runs one
// review() round, saves (taskId, conversationId) to
// .gpt-dev-loop/reviewer-attach-live-state.json, closes its own tab, and
// exits. Phase B is a brand-new Node process: it reads that saved state,
// attach()es to the exact same conversation bound to the same taskId, runs
// a SECOND review() round in it (proving conversation continuity — the
// second round should PASS once evidence shows the fix landed, exactly the
// REWORK -> fix -> PASS shape test-reviewer-live.js already validates for
// the non-attach path), and then proves a DIFFERENT taskId is rejected
// before ever contacting the extension.

import { loadConfig } from '../src/config.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError } from '../src/bridge/errors.js';
import { ReviewerTaskMismatchError } from '../src/bridge/errors.js';
import { defaultStatePath, writeSessionState, readSessionState } from './liveSessionState.js';

const STATE_PATH = defaultStatePath('reviewer-attach-live-state');
const TASK_ID = 'reviewer-attach-live-e2e-task';
const WRONG_TASK_ID = 'reviewer-attach-live-e2e-task-WRONG';

function taskCard(overrides = {}) {
  return {
    task_id: TASK_ID,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    goal: 'Live E2E fixture task for ReviewerSession.attach().',
    context: 'This is a synthetic task used only to validate the conversation reattach/resume primitive.',
    scope: 'No real code changes; the Evidence below is a fixture value.',
    allowed_files: [],
    forbidden_files: [],
    acceptance_criteria: ['the test_value evidence field must be "verified"'],
    verification_commands: [],
    completion_signal: 'the test_value evidence field is verified',
    ...overrides,
  };
}

function executionReport(overrides = {}) {
  return {
    task_id: TASK_ID,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    status: 'DONE',
    changed_files: [],
    tests_run: [],
    test_results: [],
    issues: 'none',
    next_recommendation: 'review the attached evidence',
    ...overrides,
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

async function runPhaseA(config) {
  const session = new ReviewerSession(config);
  try {
    stage(`phase A: creating Reviewer tab for task ${TASK_ID}`);
    const created = await session.create(TASK_ID);
    stage(`phase A: Reviewer tab created (tabId=${created.tabId})`);

    stage('phase A: review round #1: test_value = pending (expect REWORK)');
    const first = await session.review(TASK_ID, taskCard(), executionReport(), evidence('pending'));
    const identity = session.getIdentity();
    stage(`phase A: round #1 decision: ${first.decision} (tabId=${identity.tabId}, conversationId=${identity.conversationId})`);

    if (!identity.conversationId) {
      throw new Error('phase A never captured a conversationId — nothing to save for phase B.');
    }

    await writeSessionState(STATE_PATH, {
      taskId: TASK_ID,
      conversationId: identity.conversationId,
      savedAt: new Date().toISOString(),
    });
    stage(`phase A: saved (taskId, conversationId) to ${STATE_PATH}`);

    stage('phase A: closing the Reviewer tab (conversation itself is left in the account)');
    await session.close();
    stage('phase A: tab closed');

    await closeExtensionServer().catch(() => {});
    const passed = first.decision === 'REWORK';
    console.log(
      (passed
        ? '\nPASS (phase A): round #1 was REWORK as expected, and (taskId, conversationId) saved to disk.'
        : `\nFAIL (phase A): expected round #1 decision REWORK, got ${first.decision}.`) +
        `\nRun phase B in a NEW terminal/process: GPT_BROWSER_MODE=extension node scripts/test-reviewer-attach-live.js --phase=b`
    );
    process.exitCode = passed ? 0 : 1;
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
  if (!saved.conversationId || !saved.taskId) {
    console.log(`FAIL (phase B): ${STATE_PATH} is missing taskId/conversationId.`);
    process.exitCode = 1;
    return;
  }
  stage(`phase B: loaded taskId=${saved.taskId} conversationId=${saved.conversationId} from disk (saved ${saved.savedAt})`);

  const session = new ReviewerSession(config);
  try {
    stage(`phase B: attaching to the exact saved conversation for task ${saved.taskId} — a brand-new Node process, no in-memory state`);
    const attached = await session.attach(saved.taskId, saved.conversationId);
    stage(`phase B: attached (tabId=${attached.tabId}, conversationId=${attached.conversationId})`);
    const identityMatches = attached.conversationId === saved.conversationId;

    stage('phase B: review round #2 (same conversation): test_value = verified (expect PASS)');
    const second = await session.review(saved.taskId, taskCard(), executionReport(), evidence('verified'));
    stage(`phase B: round #2 decision: ${second.decision}`);
    const secondWasPass = second.decision === 'PASS';

    stage(`phase B: confirming a DIFFERENT taskId (${WRONG_TASK_ID}) is rejected without contacting the extension`);
    let wrongTaskRejected = false;
    try {
      await session.review(WRONG_TASK_ID, taskCard({ task_id: WRONG_TASK_ID }), executionReport({ task_id: WRONG_TASK_ID }), evidence('verified'));
    } catch (err) {
      wrongTaskRejected = err instanceof ReviewerTaskMismatchError;
      stage(`phase B: wrong-taskId review() rejected as expected (${err.constructor.name})`);
    }

    console.log('\n--- continuity + task-lock checks (across two independent Node processes) ---');
    console.log(`attach() landed in the exact saved conversation: ${identityMatches} (${saved.conversationId} -> ${attached.conversationId})`);
    console.log(`round #2 (post-attach, same conversation) decision was PASS: ${secondWasPass} (got ${second.decision})`);
    console.log(`a different taskId on this attached session was rejected with ReviewerTaskMismatchError: ${wrongTaskRejected}`);
    console.log('no new conversation was created by attach() (ReviewerSession.attach() never calls supervisorCreate)');

    const passed = identityMatches && secondWasPass && wrongTaskRejected;

    if (shouldClose) {
      stage('phase B: closing the attached tab (--close was passed); conversation left in the account');
      await session.close();
      stage('phase B: tab closed');
    } else {
      console.log(`\nAttached tab (id=${attached.tabId}) left open — pass --close to have this script close it.`);
    }

    await closeExtensionServer().catch(() => {});
    console.log(
      passed
        ? '\nPASS: a task-scoped Reviewer conversation created in one process was exactly reattached and continued in a separate later process, with the task lock still enforced.'
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
        '  GPT_BROWSER_MODE=extension node scripts/test-reviewer-attach-live.js --phase=a\n' +
        '  GPT_BROWSER_MODE=extension node scripts/test-reviewer-attach-live.js --phase=b [--close]\n' +
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
