#!/usr/bin/env node
// Live diagnostic reproduction for the real automated-loop failure (2026-08-27):
// the concurrent-tab readiness handshake now passes end-to-end (see
// scripts/test-concurrent-tab-readiness-live.js), but the full automated loop
// still stalls inside a REAL Reviewer review() call with nothing but a bare
// 130s Extension ResponseTimeoutError to go on. This script reproduces the
// SAME payload shape automatedLoop.js actually sends (a full-size Task Card +
// Execution Report + multi-command Evidence block, not the trivial
// single-line fixtures the other live scripts use), against a Supervisor tab
// left open exactly as automatedLoop.js leaves it, and reports the LAST
// diagnostic stage reached before either a decision comes back or the
// response times out.
//
// This does NOT run automatically as part of `npm test` (it is a plain
// script, not a *.test.js file) and is not invoked by any other script.
//
// Never logs prompt/reply/Task Card/Evidence content itself — it only
// re-prints the stage-only diagnostic lines already emitted by
// src/bridge/reviewerSession.js and src/bridge/extensionServer.js (both
// console.error, prefixed "gpt-loop: "), plus its own stage() timestamps.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-reviewer-review-diagnostics-live.js

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { RateLimitedError, ResponseTimeoutError } from '../src/bridge/errors.js';

const TASK_ID = 'reviewer-review-diagnostics-live-e2e-task';
const SUPERVISOR_PROMPT = 'Reply only with the single word ACK.';

// A realistic-sized Task Card/Execution Report/Evidence block — same shape
// (field set, rough length) as what automatedLoop.js actually assembles from
// a real Claude-driven task, not the one-line fixtures the other live
// scripts use. Content is synthetic/fixture-only; nothing here is a real
// secret, prompt, or reply.
function taskCard() {
  return {
    task_id: TASK_ID,
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'phase1-handshake',
      commit_sha: 'live-e2e-diagnostics',
    },
    goal: 'Live diagnostic fixture task reproducing the real automated-loop review() payload shape.',
    context:
      'This is a synthetic task used only to reproduce, in isolation, the exact size/shape of Task ' +
      'Card + Execution Report + Evidence that a real REWORK-round review() call sends, so a stalled ' +
      'response can be diagnosed stage-by-stage without waiting on a full multi-minute automated-loop run. ' +
      'The scenario: a bug was found in a data-validation helper, a fix was implemented, and a test suite ' +
      'was run to confirm the fix and check for regressions across several related modules.',
    scope: 'src/validation/**, tests/validation/**; no other files should be touched.',
    allowed_files: ['src/validation/inputValidator.js', 'src/validation/schemaValidator.js', 'tests/validation/inputValidator.test.js'],
    forbidden_files: ['src/config.js', 'package.json'],
    acceptance_criteria: [
      'inputValidator.validate() rejects a payload missing a required field with a specific, field-named error',
      'inputValidator.validate() accepts a payload where optional fields are omitted entirely',
      'schemaValidator.compile() does not throw for any schema already covered by the existing test fixtures',
      'the full test suite passes with no new failures introduced',
      'no changes were made outside the allowed_files list above',
    ],
    verification_commands: ['npm test -- tests/validation/inputValidator.test.js', 'npm test'],
    completion_signal: 'DONE',
  };
}

function executionReport() {
  return {
    task_id: TASK_ID,
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'phase1-handshake',
      commit_sha: 'live-e2e-diagnostics',
    },
    status: 'DONE',
    changed_files: ['src/validation/inputValidator.js', 'tests/validation/inputValidator.test.js'],
    tests_run: ['npm test -- tests/validation/inputValidator.test.js', 'npm test'],
    test_results: [
      'npm test -- tests/validation/inputValidator.test.js: 12 passed, 0 failed',
      'npm test: 342 passed, 0 failed',
    ],
    issues: 'none',
    next_recommendation: 'Ready for review; no known follow-up work.',
  };
}

function evidence() {
  return {
    pass: true,
    results: [
      {
        command: 'npm test -- tests/validation/inputValidator.test.js',
        pass: true,
        output:
          'tests 12\nsuites 0\npass 12\nfail 0\ncancelled 0\nskipped 0\ntodo 0\nduration_ms 184.223',
      },
      {
        command: 'npm test',
        pass: true,
        output: 'tests 342\nsuites 0\npass 342\nfail 0\ncancelled 0\nskipped 0\ntodo 0\nduration_ms 3309.511',
      },
    ],
  };
}

let startedAt;
function stage(name) {
  console.log(`[script] ${name} at +${Date.now() - startedAt}ms`);
}

// Captures every "gpt-loop: ..." stage line emitted (console.error) by
// reviewerSession.js/extensionServer.js during the wrapped call, without
// suppressing them from also reaching the real console — this script's
// value is in the SUMMARY it prints afterward (last stage reached), not in
// hiding the live stream.
async function withStageCapture(fn) {
  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => {
    const text = String(msg);
    if (text.startsWith('gpt-loop: ')) lines.push(text);
    originalConsoleError(msg);
  };
  try {
    const result = await fn();
    return { result, lines };
  } catch (err) {
    return { err, lines };
  } finally {
    console.error = originalConsoleError;
  }
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'extension' };
  startedAt = Date.now();

  const supervisor = new SupervisorSession(config);
  const reviewer = new ReviewerSession(config);

  try {
    stage('creating Supervisor tab and leaving it open (matches automatedLoop.js — Supervisor stays open across the whole workflow)');
    const supervisorCreated = await supervisor.create();
    stage(`Supervisor tab ready (tabId=${supervisorCreated.tabId})`);

    const ack = await supervisor.ask(SUPERVISOR_PROMPT);
    stage(`Supervisor replied "${ack.trim()}" — Supervisor tab intentionally left open`);

    stage(`creating Reviewer tab for task ${TASK_ID}`);
    const reviewerCreated = await reviewer.create(TASK_ID);
    stage(`Reviewer tab ready (tabId=${reviewerCreated.tabId})`);

    stage('sending a REALISTIC (full-size) Task Card + Execution Report + Evidence review — same payload shape as automatedLoop.js');
    const { result, err, lines } = await withStageCapture(() => reviewer.review(TASK_ID, taskCard(), executionReport(), evidence()));

    console.log('\n--- stage diagnostics captured during review() ---');
    if (lines.length === 0) {
      console.log('(no stage-only Node-side diagnostic lines were captured — check the ChatGPT tab\'s own devtools console for the ' +
        'content-script/background-side stage logs, which do not cross into this Node process\'s console.error output)');
    } else {
      for (const line of lines) console.log(line);
    }
    const lastStage = lines[lines.length - 1] ?? '(none captured)';
    console.log(`\nLast diagnostic stage reached (Node side): ${lastStage}`);

    if (err) {
      throw err;
    }

    stage(`review() returned decision=${result.decision}`);
    console.log(`\nPASS: the realistic-payload review() completed with decision=${result.decision}, no response timeout.`);

    stage('closing both tabs');
    await reviewer.close();
    await supervisor.close();
    stage('both tabs closed');
    await closeExtensionServer().catch(() => {});
    process.exitCode = 0;
  } catch (err) {
    await reviewer.close().catch(() => {});
    await supervisor.close().catch(() => {});
    await closeExtensionServer().catch(() => {});
    if (err instanceof RateLimitedError) {
      console.log(`\nSTOPPED: ChatGPT reported its own rate limit — not retrying against the real account. ${err.message}`);
    } else if (err instanceof ResponseTimeoutError) {
      console.log(`\nFAIL (reproduced): review() hit the response timeout, exactly like the real automated loop. See "Last diagnostic stage reached" above for where it stalled. ${err.message}`);
    } else {
      console.log(`\nFAIL: ${err.constructor.name}: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

main();
