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

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { ReviewerSession } from '../src/bridge/reviewerSession.js';
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

async function main() {
  const config = loadConfig();
  if (config.browserMode !== 'extension') {
    console.error(`This script requires GPT_BROWSER_MODE=extension (current: "${config.browserMode}").`);
    process.exitCode = 1;
    return;
  }

  await rm(FILE_A, { force: true });
  await rm(FILE_B, { force: true });
  await mkdir(WORK_DIR, { recursive: true });

  const workflowId = `wf-live-${randomUUID()}`;
  const persistence = new Persistence(path.join(REPO_ROOT, '.gpt-dev-loop', 'workflows'));
  const supervisorSession = new SupervisorSession(config);
  const gateRunner = createGateRunner({ gitEvidenceCollector: createGitEvidenceCollector(), cwd: REPO_ROOT });

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
      persistence,
      workflowGoal: WORKFLOW_GOAL,
      repositoryContext: await currentRepositoryContext(),
      maxAttemptsPerTask: 3,
    });
  } finally {
    await closeExtensionServer();
  }

  console.log(`gpt-loop-live: workflow finished with status ${result.status}`);
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== 'WORKFLOW_DONE') {
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
}

main().catch((err) => {
  console.error(`gpt-loop-live: ${err.stack || err.message}`);
  process.exitCode = 1;
});
