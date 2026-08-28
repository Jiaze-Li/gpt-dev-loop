#!/usr/bin/env node
// Live E2E for the automated orchestration loop (Issue #2, step 4).
//
// NOT run automatically — this hits the real ChatGPT web UI (through the
// Chrome extension bridge) and the real `claude` CLI. Run it by hand:
//
//   node scripts/test-automated-loop-live.js
//
// Prerequisites (same as any other extension-mode run):
//   - GPT_BROWSER_MODE=extension (or leave unset and pass --browser-mode via env)
//   - Chrome running with the gpt-dev-loop extension loaded and a ChatGPT
//     tab logged in
//   - `claude` CLI on PATH and authenticated
//
// What this proves: one process start, zero human copy/paste of any
// GPT/Claude prompt, driving two independent one-file tasks end to end —
//   Supervisor -> NEXT_TASK(auto-a) -> Claude -> gate/evidence -> Reviewer PASS
//   -> Supervisor -> NEXT_TASK(auto-b) -> Claude -> gate/evidence -> Reviewer PASS
//   -> Supervisor -> WORKFLOW_DONE
//
// Deliberately does NOT try to force a REWORK round here — the
// CONTINUE_REWORK wiring (same ReviewerSession reused, fresh Claude session)
// is already covered by tests/automatedLoop.test.js's deterministic
// fakes, and the underlying fresh-Claude + GPT rework path was already
// proven live before this step (see reviewerSession.js's header comment).
// This script's only job is the outer Supervisor loop end to end.
//
// Safety: if ChatGPT replies with a rate-limit/"Too Many Requests" signal,
// this script does not retry — it lets the error surface and stops, per
// the instruction not to hammer create/switch/delete when that happens.
//
// Every Supervisor/Reviewer tab this run opens lives inside ONE dedicated,
// permanently unfocused automation window (the `windowSession` object below,
// now threaded into runAutomatedWorkflow — see automatedLoop.js's module
// doc comment) instead of the user's normal Chrome window, per the
// background-automation-window architecture proven by
// scripts/test-background-automation-window-live.js.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, rm } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { createAutomationWindow, activateTabWithoutFocusingWindow, closeAutomationWindow, closeTab, listTabs } from '../src/bridge/windowSession.js';
import { createClaudeSessionManager } from '../src/orchestrator/adapters/claudeSessionManager.js';
import { createGateRunner } from '../src/orchestrator/adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../src/adapters/gate/git-evidence/index.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';

const REPO_ROOT = process.cwd();
const WORK_DIR = path.join(REPO_ROOT, 'work');
const FILE_A = path.join(WORK_DIR, 'auto-a.txt');
const FILE_B = path.join(WORK_DIR, 'auto-b.txt');

const WORKFLOW_GOAL = `Complete exactly two independent tasks, one at a time, each its own Task Card:

Task 1: create the file work/auto-a.txt with EXACTLY this content (no trailing text, a single trailing newline is fine):
auto-a-ok

Task 2: create the file work/auto-b.txt with EXACTLY this content (no trailing text, a single trailing newline is fine):
auto-b-ok

Each task's acceptance_criteria must require the exact file content above. Each task's verification_commands must include a shell command that fails if the content is wrong, e.g.:
  test "$(cat work/auto-a.txt)" = "auto-a-ok"
Do not scope any other files. Once both files exist with the exact required content and their verification_commands pass, the workflow is done.`;

async function currentRepositoryContext() {
  return {
    repository_name: path.basename(REPO_ROOT),
    repository_url: null,
    branch: 'phase1-handshake',
    commit_sha: 'unknown', // informational only — the loop never trusts this over gate evidence
  };
}

// Debug-only CLI flags for this live script (see automatedLoop.js's
// keepOpenOnFailure/keepOpenOnSuccess doc comment) — pure and exported so
// tests/testAutomatedLoopLiveCli.test.js can exercise the parsing
// deterministically without ever running the live workflow itself.
//
//   --keep-open-on-failure — on an unexpected failure, skip the usual
//     Supervisor/Reviewer/automation-window teardown and keep this process
//     alive (so the extension's WebSocket connection stays up) until the
//     user exits manually with Ctrl+C.
//   --keep-open            — same idea, but for a successful WORKFLOW_DONE
//     (manual inspection of the final ChatGPT state). Optional; unrelated
//     to HUMAN_REQUIRED, which already preserves everything under its own
//     existing resume contract regardless of either flag.
//
// Neither flag causes any extra request to the extension/ChatGPT — they
// only decide whether the existing close() calls run.
export function parseCliFlags(argv) {
  return {
    keepOpenOnFailure: argv.includes('--keep-open-on-failure'),
    keepOpen: argv.includes('--keep-open'),
  };
}

// Never resolves — used to keep this process alive (so the extension's
// WebSocket connection stays available) after a keep-open run, until the
// user exits manually with Ctrl+C, per this flag's own contract.
function hangUntilManuallyExited() {
  return new Promise(() => {});
}

async function main() {
  const config = loadConfig();
  if (config.browserMode !== 'extension') {
    console.error(`This script requires GPT_BROWSER_MODE=extension (current: "${config.browserMode}").`);
    process.exitCode = 1;
    return;
  }

  const { keepOpenOnFailure, keepOpen } = parseCliFlags(process.argv.slice(2));

  await rm(FILE_A, { force: true });
  await rm(FILE_B, { force: true });
  await mkdir(WORK_DIR, { recursive: true });

  const workflowId = `wf-live-${randomUUID()}`;
  const persistence = new Persistence(path.join(REPO_ROOT, '.gpt-dev-loop', 'workflows'));
  const supervisorSession = new SupervisorSession(config);
  const gateRunner = createGateRunner({ gitEvidenceCollector: createGitEvidenceCollector(), cwd: REPO_ROOT });
  const windowSession = {
    create: () => createAutomationWindow(config),
    activateTab: (tabId) => activateTabWithoutFocusingWindow(config, tabId),
    close: (windowId) => closeAutomationWindow(config, windowId),
    closeTab: (tabId) => closeTab(config, tabId),
    listTabs: (windowId) => listTabs(config, windowId),
  };

  console.log(`gpt-loop-live: starting workflow ${workflowId} — zero prompts should need copy/pasting from here.`);

  let result;
  try {
    result = await runAutomatedWorkflow({
      workflowId,
      supervisorSession,
      createReviewerSession: () => new ReviewerSession(config),
      createClaudeSessionManager: ({ taskId }) =>
        createClaudeSessionManager({ workflowId, taskId, persistence, cwd: REPO_ROOT }),
      gateRunner,
      windowSession,
      persistence,
      workflowGoal: WORKFLOW_GOAL,
      repositoryContext: await currentRepositoryContext(),
      maxAttemptsPerTask: 3,
      rateLimitRecovery: {
        maxRetries: config.rateLimitMaxRetries,
        cooldownMs: config.rateLimitBackoffMs,
        cooldownJitterMs: config.rateLimitJitterMs,
      },
      keepOpenOnFailure,
      keepOpenOnSuccess: keepOpen,
    });
  } catch (err) {
    if (keepOpenOnFailure) {
      // automatedLoop.js already logged the preserved windowId/tabIds
      // above (its own log() call, "gpt-loop: " prefixed) — this process
      // must now stay alive so the extension's WebSocket connection to
      // those tabs remains available, per --keep-open-on-failure's
      // contract. Deliberately does NOT call closeExtensionServer().
      console.error(`gpt-loop-live: unexpected failure with --keep-open-on-failure set: ${err.stack || err.message}`);
      console.log('gpt-loop-live: staying alive for manual inspection — press Ctrl+C to exit.');
      await hangUntilManuallyExited();
    }
    await closeExtensionServer();
    throw err;
  }

  console.log(`gpt-loop-live: workflow finished with status ${result.status}`);
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== 'WORKFLOW_DONE') {
    await closeExtensionServer();
    process.exitCode = 1;
    return;
  }

  const [contentA, contentB] = await Promise.all([
    readFile(FILE_A, 'utf8').catch(() => null),
    readFile(FILE_B, 'utf8').catch(() => null),
  ]);

  const okA = contentA !== null && contentA.trim() === 'auto-a-ok';
  const okB = contentB !== null && contentB.trim() === 'auto-b-ok';

  console.log(`gpt-loop-live: work/auto-a.txt ${okA ? 'OK' : 'WRONG'} (${JSON.stringify(contentA)})`);
  console.log(`gpt-loop-live: work/auto-b.txt ${okB ? 'OK' : 'WRONG'} (${JSON.stringify(contentB)})`);

  process.exitCode = okA && okB ? 0 : 1;

  if (keepOpen) {
    // automatedLoop.js already logged the preserved windowId/tabIds above.
    // Deliberately does NOT call closeExtensionServer() here either, for
    // the same reason as the failure path above — checked last, after the
    // file verification output, so --keep-open still surfaces the pass/
    // fail result before parking.
    console.log('gpt-loop-live: --keep-open set — staying alive for manual inspection — press Ctrl+C to exit.');
    await hangUntilManuallyExited();
  }

  await closeExtensionServer();
}

// Only run main() when this file is executed directly (`node
// scripts/test-automated-loop-live.js`), not when it's imported for its
// pure parseCliFlags() export (see
// tests/testAutomatedLoopLiveCli.test.js) — that import must never trigger
// the real live workflow as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`gpt-loop-live: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
