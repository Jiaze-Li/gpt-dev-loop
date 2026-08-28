#!/usr/bin/env node
// Live diagnostic: does a dedicated, permanently unfocused Chrome WINDOW
// (with the working ChatGPT tab `active` INSIDE it) let ChatGPT reply
// reliably without ever stealing the user's foreground window?
//
// Live evidence (2026-08-27): a background-created ChatGPT tab sometimes
// hangs/times out reading a reply while inactive; manually clicking that tab
// makes it work. scripts/test-tab-activation-readiness-live.js already ruled
// out `chrome.tabs.create`'s own `active` flag alone as sufficient. This
// script tests the next hypothesis: what actually needs to be true is
// "target tab active=true" AND "the tab's WINDOW is not the foreground
// window" simultaneously — achieved here via a dedicated automation window
// that is created focused:false and never focused afterwards, while the
// Supervisor/Reviewer tab inside it is made active as needed.
//
// This script does NOT change automatedLoop.js or any production default —
// createSupervisorTab's `windowId` option and the windowCreate/
// windowActivateTab/windowClose wire actions it exercises are diagnostic-only
// additions (see windowLifecycle.js, extensionProtocol.js, src/bridge/
// windowSession.js). No production caller uses any of them.
//
// Not part of `npm test` — needs your real, already-logged-in Chrome with
// the gpt-dev-loop extension connected to the local bridge server, and
// creates real windows/tabs/conversations in your real ChatGPT account.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-background-automation-window-live.js
//
// Logs only: windowId, window focused true/false, target tabId, target tab
// active true/false, readiness result, ask/review PASS/FAIL, and
// timing/error class — never prompt or reply content.

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { createAutomationWindow, activateTabWithoutFocusingWindow, closeAutomationWindow } from '../src/bridge/windowSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError, ResponseTimeoutError } from '../src/bridge/errors.js';

const SUPERVISOR_ACK_PROMPT = 'Reply with exactly one word: ACK.';
const TASK_ID = 'background-automation-window-live';

function taskCard(taskId, overrides = {}) {
  return {
    task_id: taskId,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    goal: 'Live fixture task for the background-automation-window diagnostic.',
    context: 'Synthetic task used only to trigger one trivial review() call inside the dedicated automation window.',
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

// Activates `tabId` inside the automation window without focusing the
// window, logs the observed state (never contents), and throws if either
// half of the invariant this whole diagnostic tests ("tab active=true" AND
// "window focused=false" simultaneously) does not actually hold.
async function activateAndVerify(config, label, tabId) {
  const activation = await activateTabWithoutFocusingWindow(config, tabId);
  console.log(
    `${label}: windowId=${activation.windowId} windowFocused=${activation.windowFocused} tabId=${activation.tabId} tabActive=${activation.active}`
  );
  if (activation.windowFocused !== false) {
    throw new Error(`${label}: automation window unexpectedly became focused (focused=${activation.windowFocused}).`);
  }
  if (activation.active !== true) {
    throw new Error(`${label}: target tab ${tabId} did not become active (active=${activation.active}).`);
  }
  return activation;
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  let windowId = null;
  const supervisor = new SupervisorSession(config);
  const reviewer = new ReviewerSession(config);
  let exitCode = 1;

  try {
    // A. Create dedicated automation window, focused=false.
    stage('A: creating dedicated automation window');
    ({ windowId } = await createAutomationWindow(config));
    stage(`A: automation window ${windowId} created`);

    // B. Create Supervisor tab inside it, active inside the window.
    stage('B: creating Supervisor tab inside automation window');
    const supervisorCreated = await supervisor.create({ windowId });
    stage(`B: Supervisor tab ${supervisorCreated.tabId} created`);
    await activateAndVerify(config, 'B: pre-ask activation', supervisorCreated.tabId);

    stage('B: sending trivial ACK to Supervisor');
    const ack = await supervisor.ask(SUPERVISOR_ACK_PROMPT);
    const ackOk = ack.trim().toUpperCase().includes('ACK');
    stage(`B: Supervisor ACK check: ${ackOk ? 'PASS' : 'FAIL (unexpected reply)'}`);
    if (!ackOk) throw new Error('Supervisor did not ACK inside the automation window — aborting.');

    // C. Keep Supervisor tab open (no action needed — it just isn't closed).
    stage('C: Supervisor tab left open');

    // D. Create Reviewer tab in the SAME automation window, verify Supervisor
    // becomes inactive, window stays unfocused, run one realistic review().
    stage('D: creating Reviewer tab inside the same automation window');
    const reviewerCreated = await reviewer.create(TASK_ID, { windowId });
    stage(`D: Reviewer tab ${reviewerCreated.tabId} created`);
    const reviewerActivation = await activateAndVerify(config, 'D: pre-review activation', reviewerCreated.tabId);
    if (reviewerActivation.tabId === supervisorCreated.tabId) {
      throw new Error('D: Reviewer tab and Supervisor tab were the same tabId — cannot verify Supervisor became inactive.');
    }

    stage('D: running one realistic review()');
    const review = await reviewer.review(TASK_ID, taskCard(TASK_ID), executionReport(TASK_ID), verifiedEvidence());
    const reviewOk = review.decision === 'PASS';
    stage(`D: review() returned ${reviewOk ? 'PASS' : `REWORK/${review.decision}`}`);
    if (!reviewOk) throw new Error(`D: expected PASS on a fixture task with verified evidence, got ${review.decision}.`);

    stage('D: closing Reviewer tab');
    await reviewer.close();
    stage('D: Reviewer tab closed');

    // E. Switch back to Supervisor tab inside automation window.
    stage('E: reactivating Supervisor tab');
    await activateAndVerify(config, 'E: pre-ask activation', supervisorCreated.tabId);

    stage('E: sending another trivial ACK to Supervisor');
    const ack2 = await supervisor.ask(SUPERVISOR_ACK_PROMPT);
    const ack2Ok = ack2.trim().toUpperCase().includes('ACK');
    stage(`E: Supervisor ACK check: ${ack2Ok ? 'PASS' : 'FAIL (unexpected reply)'}`);
    if (!ack2Ok) throw new Error('Supervisor did not ACK on the second round — aborting before declaring PASS.');

    stage('closing Supervisor tab');
    await supervisor.close();
    stage('Supervisor tab closed');

    // F. Close automation window.
    stage(`F: closing automation window ${windowId}`);
    await closeAutomationWindow(config, windowId);
    windowId = null;
    stage('F: automation window closed');

    console.log(
      '\nPASS: target tab active=true + automation window focused=false held throughout Supervisor ACK, Reviewer review() PASS, and a second Supervisor ACK.'
    );
    exitCode = 0;
  } catch (err) {
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED: ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else {
      console.log(`\nFAIL (${errorClass(err)}): ${err.message}`);
    }
  } finally {
    try {
      await supervisor.close();
    } catch {
      // best effort
    }
    try {
      await reviewer.close();
    } catch {
      // best effort
    }
    if (windowId !== null) {
      try {
        await closeAutomationWindow(config, windowId);
      } catch {
        // best effort
      }
    }
    await closeExtensionServer().catch(() => {});
    process.exitCode = exitCode;
  }
}

main();
