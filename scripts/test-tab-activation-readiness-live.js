#!/usr/bin/env node
// Live A/B diagnostic: does chrome.tabs.create's `active` setting explain the
// intermittent blank-page failure seen on extension-created Reviewer tabs?
//
// Live evidence (2026-08-27): a second ChatGPT tab created by the extension
// (active: false) sometimes stays completely blank, and the Reviewer
// review() that follows times out. Manually opening another chatgpt.com tab
// in the SAME Chrome window (necessarily active: true) works immediately.
// ChatGPT itself and concurrent tabs are therefore not the problem — the
// prime suspect is whether the SECOND tab was created in the background.
//
// This script does NOT decide anything and does NOT change production
// behavior — createSupervisorTab/ReviewerSession.create() still default to
// active: false everywhere else (see supervisorLifecycle.js and
// reviewerSession.js). It only exercises the new, explicit `active` override
// added for this diagnostic to compare the two conditions back to back,
// against the SAME already-open Supervisor tab, so any difference in
// readiness/review outcome is attributable to `active` and not to some other
// per-run variable (a cold Chrome profile, a different Supervisor tab, etc).
//
// Not part of `npm test` — needs your real, already-logged-in Chrome with
// the gpt-dev-loop extension connected to the local bridge server, and
// creates real tabs/conversations in your real ChatGPT account.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-tab-activation-readiness-live.js
//
// Logs only: tabId, the active setting used, readiness result, elapsed
// timings, review PASS/FAIL, and timeout/error class — never prompt or
// reply content.

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError, ResponseTimeoutError } from '../src/bridge/errors.js';

const SUPERVISOR_ACK_PROMPT = 'Reply with exactly one word: ACK.';
const TASK_ID_A = 'tab-activation-readiness-live-phase-a';
const TASK_ID_B = 'tab-activation-readiness-live-phase-b';

function taskCard(taskId, overrides = {}) {
  return {
    task_id: taskId,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    goal: 'Live A/B fixture task for the tab-activation-readiness diagnostic.',
    context: 'Synthetic task used only to trigger one trivial review() call as fast as possible after tab creation.',
    scope: 'No real code changes; the Evidence below is a fixture value.',
    allowed_files: [],
    forbidden_files: [],
    acceptance_criteria: ['the test_value evidence field must be "verified"'],
    verification_commands: [],
    completion_signal: 'the test_value evidence field is verified',
    ...overrides,
  };
}

function executionReport(taskId, overrides = {}) {
  return {
    task_id: taskId,
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

function verifiedEvidence() {
  return { pass: true, results: [{ command: 'fixture-check', pass: true, output: 'test_value: verified' }] };
}

let startedAt;
function stage(name) {
  console.log(`${name} at +${Date.now() - startedAt}ms`);
}

function errorClass(err) {
  if (err instanceof RateLimitedError) return 'RateLimitedError';
  if (err instanceof ResponseTimeoutError) return 'ResponseTimeoutError';
  return err.constructor?.name ?? 'Error';
}

// Runs one phase: create a second (Reviewer) tab with the given `active`
// setting against the already-open Supervisor, immediately run one trivial
// review(), then close only that second tab. Never touches the Supervisor
// tab/session passed in.
async function runPhase(label, config, taskId, active) {
  const session = new ReviewerSession(config);
  const result = { label, active, tabId: null, readiness: 'UNKNOWN', readinessMs: null, reviewResult: 'UNKNOWN', reviewMs: null, errorClass: null };

  const createStartedAt = Date.now();
  try {
    stage(`${label}: creating Reviewer tab with active=${active}`);
    const created = await session.create(taskId, { active });
    result.tabId = created.tabId;
    result.readiness = 'READY';
    result.readinessMs = Date.now() - createStartedAt;
    stage(`${label}: tab ${created.tabId} passed the readiness handshake in ${result.readinessMs}ms`);
  } catch (err) {
    result.readiness = 'FAIL';
    result.readinessMs = Date.now() - createStartedAt;
    result.errorClass = errorClass(err);
    stage(`${label}: readiness handshake FAILED after ${result.readinessMs}ms (${result.errorClass}: ${err.message})`);
    return result;
  }

  const reviewStartedAt = Date.now();
  try {
    stage(`${label}: immediately running one trivial review()`);
    const review = await session.review(taskId, taskCard(taskId), executionReport(taskId), verifiedEvidence());
    result.reviewResult = review.decision === 'PASS' ? 'PASS' : 'REWORK';
    result.reviewMs = Date.now() - reviewStartedAt;
    stage(`${label}: review() returned ${result.reviewResult} in ${result.reviewMs}ms`);
  } catch (err) {
    result.reviewResult = 'FAIL';
    result.reviewMs = Date.now() - reviewStartedAt;
    result.errorClass = errorClass(err);
    stage(`${label}: review() FAILED after ${result.reviewMs}ms (${result.errorClass}: ${err.message})`);
  } finally {
    try {
      stage(`${label}: closing tab ${result.tabId}`);
      await session.close();
    } catch {
      // best effort — this diagnostic must not throw on cleanup
    }
  }

  return result;
}

function printResult(result) {
  console.log(
    `${result.label}: active=${result.active} tabId=${result.tabId} readiness=${result.readiness} (${result.readinessMs}ms) ` +
      `review=${result.reviewResult} (${result.reviewMs}ms)` +
      (result.errorClass ? ` errorClass=${result.errorClass}` : '')
  );
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  const supervisor = new SupervisorSession(config);
  try {
    stage('creating Supervisor tab');
    const supervisorCreated = await supervisor.create();
    stage(`Supervisor tab ${supervisorCreated.tabId} created`);

    stage('sending trivial ACK to prove the Supervisor works');
    const ack = await supervisor.ask(SUPERVISOR_ACK_PROMPT);
    const ackOk = ack.trim().toUpperCase().includes('ACK');
    stage(`Supervisor ACK check: ${ackOk ? 'ok' : 'unexpected reply'}`);
    if (!ackOk) throw new Error('Supervisor did not ACK — aborting before running the A/B comparison.');

    const phaseA = await runPhase('Phase A (active=false)', config, TASK_ID_A, false);
    const phaseB = await runPhase('Phase B (active=true)', config, TASK_ID_B, true);

    stage('closing Supervisor tab');
    await supervisor.close();
    stage('Supervisor tab closed');

    await closeExtensionServer().catch(() => {});

    console.log('\n--- tab-activation-readiness A/B results ---');
    printResult(phaseA);
    printResult(phaseB);

    const bothReady = phaseA.readiness === 'READY' && phaseB.readiness === 'READY';
    const bothReviewed = phaseA.reviewResult !== 'FAIL' && phaseB.reviewResult !== 'FAIL';
    console.log(
      bothReady && bothReviewed
        ? '\nPASS: both active=false and active=true tabs passed readiness and review() — no difference observed this run.'
        : '\nFAIL (or inconclusive): see per-phase results above for which condition failed.'
    );
    process.exitCode = bothReady && bothReviewed ? 0 : 1;
  } catch (err) {
    await closeExtensionServer().catch(() => {});
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED: ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else {
      console.log(`FAIL: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

main();
