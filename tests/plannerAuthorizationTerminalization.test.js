// Phase 0A regression — a Token Safety AuthorizationError raised at the Full
// Path Planner boundary must terminalize the workflow's DURABLE status as
// HUMAN_REQUIRED, stop before any Supervisor/Executor/Reviewer call, and
// deliver nothing. Exercises the REAL defaultPipeline (via runSuperGPT) with
// a fake `_selectProviders` whose runtime.invoke('planner', ...) throws an
// AuthorizationError — no real model/provider call is ever made.
//
// REAL MODEL CALLS = 0. SUPERGPT MCP TOOLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { runSuperGPT } from '../src/orchestrator/supergpt.js';
import { AuthorizationError, AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { readLiveWorkflowState } from '../src/orchestrator/workflowState.js';
import { nullWindowSession } from '../src/orchestrator/agyProviderSessions.js';

function setupSourceRepo(tmpRoot) {
  const sourceRepo = path.join(tmpRoot, 'source-repo');
  fs.mkdirSync(sourceRepo, { recursive: true });
  execSync('git init -b main', { cwd: sourceRepo, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: sourceRepo, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: sourceRepo, stdio: 'ignore' });
  fs.writeFileSync(path.join(sourceRepo, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: sourceRepo, stdio: 'ignore' });
  return sourceRepo;
}

function cleanupWorkflow(workflowId) {
  if (!fs.existsSync(SUPERGPT_WORKTREE_ROOT)) return;
  for (const name of fs.readdirSync(SUPERGPT_WORKTREE_ROOT)) {
    if (name === workflowId || name.startsWith(`${workflowId}.`) || name === `repo-${workflowId}`) {
      fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, name), { recursive: true, force: true });
    }
  }
}

test('Phase 0A: Planner AuthorizationError terminalizes HUMAN_REQUIRED, zero later role calls, zero delivery', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-authz-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-agy-test-planner-authz-${Date.now()}`;

  let plannerInvoked = 0;
  let supervisorInvoked = 0;
  let executorInvoked = 0;
  let reviewerInvoked = 0;

  const fakeProviders = () => ({
    runtime: {
      invoke: async (role) => {
        if (role === 'planner') {
          plannerInvoked += 1;
          throw new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
            'workflow has an unresolved model spend reservation; further internal model spend is blocked',
          );
        }
        throw new Error(`unexpected role invocation: ${role}`);
      },
    },
    supervisorSession: {
      create: async () => ({ tabId: 's' }),
      decide: async () => { supervisorInvoked += 1; return { action: 'WORKFLOW_DONE', summary: 'x' }; },
      close: async () => {},
    },
    createReviewerSession: () => ({
      create: async () => ({ tabId: 'r' }),
      review: async () => { reviewerInvoked += 1; return { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }; },
      close: async () => {},
    }),
    createExecutorSessionManager: () => ({
      execute: async () => { executorInvoked += 1; return { status: 'DONE' }; },
    }),
    windowSession: nullWindowSession,
    sessionStore: { snapshot: () => ({}) },
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'implement a thing',
      cwd: sourceRepo,
      isResume: false,
      explicitFullPath: true,
      externalReadRoots: [],
      _selectProviders: fakeProviders,
      _createGateRunner: () => ({
        async run(cmds) {
          return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' };
        },
      }),
    });

    assert.equal(plannerInvoked, 1, 'the Planner is attempted exactly once');
    assert.equal(supervisorInvoked, 0, 'no Supervisor call after a Planner AuthorizationError');
    assert.equal(executorInvoked, 0, 'no Executor call after a Planner AuthorizationError');
    assert.equal(reviewerInvoked, 0, 'no Reviewer call after a Planner AuthorizationError');
    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.deepEqual(result.deliveredFiles, [], 'zero delivery');
    assert.equal(result.blockingSafetyEvent?.code, 'PLANNER_AUTHORIZATION_DENIED');
    assert.equal(result.blockingSafetyEvent?.severity, 'BLOCKING');
    assert.match(result.reason, /Token Safety/i);

    // Durable status must ALSO read back as HUMAN_REQUIRED, not RUNNING/FAILED.
    const live = readLiveWorkflowState({ workflowId, root: SUPERGPT_WORKTREE_ROOT });
    assert.equal(live?.workflowStatus, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 0A: a CancellationError at the Planner boundary is NOT reclassified as HUMAN_REQUIRED', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-cancel-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-agy-test-planner-cancel-${Date.now()}`;

  const fakeProviders = () => ({
    runtime: {
      invoke: async (role) => {
        if (role === 'planner') {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        throw new Error(`unexpected role invocation: ${role}`);
      },
    },
    supervisorSession: { create: async () => ({}), decide: async () => ({ action: 'WORKFLOW_DONE', summary: 'x' }), close: async () => {} },
    createReviewerSession: () => ({ create: async () => ({}), review: async () => ({ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }), close: async () => {} }),
    createExecutorSessionManager: () => ({ execute: async () => ({ status: 'DONE' }) }),
    windowSession: nullWindowSession,
    sessionStore: { snapshot: () => ({}) },
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'implement a thing',
      cwd: sourceRepo,
      isResume: false,
      explicitFullPath: true,
      externalReadRoots: [],
      _selectProviders: fakeProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });

    // Preserved existing cancellation semantics: NOT converted to HUMAN_REQUIRED.
    assert.notEqual(result.status, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
