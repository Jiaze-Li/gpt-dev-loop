#!/usr/bin/env node
// Live E2E validation for the ChatGPT page-readiness handshake
// (extension/supervisorLifecycle.js's createSupervisorTab, hardened
// 2026-08-27) specifically in the CONCURRENT-tab scenario that broke live:
// a Supervisor tab created and left open, followed by a second, independent
// ChatGPT tab created for a Reviewer WHILE the Supervisor tab is still
// open. The original failure (live E2E, 2026-08-27) was the second tab
// reaching chrome.tabs "complete" while still a blank ChatGPT page, then
// hanging for the full response timeout (130s) once a review() was sent
// into it. This script isolates exactly that shape — two tabs, one held
// open — without running Claude/gate/the full automated loop for several
// minutes, so it fails fast (or passes fast) instead of taking ~2+ minutes
// to reach the same failure boundary.
//
// Not part of `npm test` — needs your real, already-logged-in Chrome with
// the gpt-dev-loop extension loaded and connected to the local bridge
// server (see extension/README.md), and creates two real conversations in
// your real ChatGPT account (both closed/left as this script's own cleanup
// determines — see the tab-closing steps below).
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-concurrent-tab-readiness-live.js

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError } from '../src/bridge/errors.js';

const TASK_ID = 'concurrent-tab-readiness-live-e2e-task';
const SUPERVISOR_PROMPT = 'Reply only with the single word ACK.';

function taskCard() {
  return {
    task_id: TASK_ID,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'none', branch: 'phase1-handshake', commit_sha: 'live-e2e' },
    goal: 'Live E2E fixture task for the concurrent-tab ChatGPT page-readiness handshake.',
    context: 'This is a synthetic task used only to prove a second ChatGPT tab, created while a Supervisor tab is still open, becomes UI-ready and usable.',
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

function evidence() {
  return {
    pass: true,
    results: [{ command: 'fixture-check', pass: true, output: 'test_value: verified' }],
  };
}

let startedAt;
function stage(name) {
  console.log(`${name} at +${Date.now() - startedAt}ms`);
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  const supervisor = new SupervisorSession(config);
  const reviewer = new ReviewerSession(config);
  let supervisorReady = false;
  let reviewerTabReady = false;
  let reviewCompleted = false;
  let reviewDecision = null;

  try {
    stage('creating Supervisor tab (this must complete the page-readiness handshake, not just chrome.tabs "complete")');
    const supervisorCreated = await supervisor.create();
    stage(`Supervisor tab ready (tabId=${supervisorCreated.tabId})`);

    stage('asking the Supervisor for a trivial ACK, to prove the tab is genuinely usable, not just open');
    const ack = await supervisor.ask(SUPERVISOR_PROMPT);
    stage(`Supervisor replied "${ack.trim()}"`);
    supervisorReady = ack.trim().toUpperCase().includes('ACK');

    stage('Supervisor tab intentionally left open — creating a SECOND, independent Reviewer tab now (the exact concurrent-tab shape that broke live)');
    const reviewerCreated = await reviewer.create(TASK_ID);
    stage(`Reviewer tab reported ready by createSupervisorTab's readiness handshake (tabId=${reviewerCreated.tabId})`);
    reviewerTabReady = true;

    stage('performing one trivial review() in the Reviewer tab immediately (no Claude/gate — isolating just the tab-readiness question)');
    const result = await reviewer.review(TASK_ID, taskCard(), executionReport(), evidence());
    reviewDecision = result.decision;
    stage(`review() returned decision=${reviewDecision}`);
    reviewCompleted = true;

    console.log('\n--- concurrent-tab readiness checks ---');
    console.log(`Supervisor tab created and answered a real prompt: ${supervisorReady}`);
    console.log(`Reviewer tab (created while the Supervisor tab was still open) passed the page-readiness handshake: ${reviewerTabReady}`);
    console.log(`Reviewer tab's first review() completed without a 130s response timeout: ${reviewCompleted} (decision=${reviewDecision})`);

    const passed = supervisorReady && reviewerTabReady && reviewCompleted;

    stage('closing both tabs');
    await reviewer.close();
    await supervisor.close();
    stage('both tabs closed');

    await closeExtensionServer().catch(() => {});
    console.log(
      passed
        ? '\nPASS: a second ChatGPT tab created while a Supervisor tab was still open became UI-ready and usable, with no response-timeout hang.'
        : '\nFAIL: see checks above.'
    );
    process.exitCode = passed ? 0 : 1;
  } catch (err) {
    await reviewer.close().catch(() => {});
    await supervisor.close().catch(() => {});
    await closeExtensionServer().catch(() => {});
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED: ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else if (err.code === 'CHATGPT_PAGE_NOT_READY') {
      console.log(`\nFAIL: the page-readiness handshake itself caught a not-ready tab (this is the bug this script exists to isolate). ${err.message}`);
    } else {
      console.log(`\nFAIL: ${err.constructor.name}: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

main();
