import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  runSuperGPT,
  supergptStatus,
  supergptWait,
  supergptStop,
  supergptResume,
  restoreResumableWorkspace,
  workflowRuntimeDirectory,
  supergptFormatProgress,
  WorkflowStateManager,
} from '../src/orchestrator/supergpt.js';

test('supergptStatus: purely local, zero tokens, reads live workflow state', async () => {
  const root = path.join('/tmp', `supergpt-test-status-${Date.now()}`);
  await mkdir(root, { recursive: true });

  try {
    const workflowId = 'wf-test-live-1';
    const manager = new WorkflowStateManager({ workflowId, root });
    manager.startStage('EXECUTOR', {
      taskId: 't-auth',
      taskName: 'Implement Auth',
      taskIndex: 2,
      taskTotal: 5,
      attempt: 1,
    });
    manager.setRouting({ model: 'sonnet', escalated: false });

    const status = supergptStatus({ workflowId, root });
    assert.ok(status);
    assert.equal(status.workflowId, workflowId);
    assert.equal(status.taskId, 't-auth');
    assert.equal(status.taskIndex, 2);
    assert.equal(status.taskTotal, 5);
    assert.equal(status.stage, 'EXECUTOR');
    assert.equal(status.executorModel, 'sonnet');
    assert.equal(status.modelEscalated, false);
    assert.ok(status.heartbeatAt);

    const progressBlock = supergptFormatProgress(status);
    assert.match(progressBlock, /Task       2 \/ 5 — Implement Auth/);
    assert.match(progressBlock, /Stage      EXECUTOR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restoreResumableWorkspace accepts the current persisted workspace metadata shape', () => {
  const restored = restoreResumableWorkspace({
    workflow_id: 'wf-current-metadata',
    source_workspace: '/tmp/invocation-repo',
    repository_identity: '/tmp/invocation-repo/.git',
    source_branch: 'main',
    source_head: 'abc123',
    isolated_worktree_path: '/Users/example/.supergpt/worktrees/invocation-repo-wf-current-metadata',
  });

  assert.deepEqual(restored.worktree, {
    worktree_path: '/Users/example/.supergpt/worktrees/invocation-repo-wf-current-metadata',
    source_workspace: '/tmp/invocation-repo',
    source_repo_root: '/tmp/invocation-repo',
    source_branch: 'main',
    baseline_head: 'abc123',
    isolatedWorktree: true,
  });
  assert.deepEqual(restored.baseline, {
    repo_root: '/tmp/invocation-repo',
    branch: 'main',
    head: 'abc123',
    clean: true,
  });
});

test('workflow runtime persistence is outside an invocation worktree', () => {
  const runtimeDir = workflowRuntimeDirectory('wf-runtime-location');
  assert.match(runtimeDir, /\.supergpt[\\/]worktrees[\\/]wf-runtime-location[\\/]persistence$/);
  assert.doesNotMatch(runtimeDir, /\.gpt-dev-loop/);
});

test('supergptWait: waits locally until predicate matches with zero model tokens', async () => {
  const root = path.join('/tmp', `supergpt-test-wait-${Date.now()}`);
  await mkdir(root, { recursive: true });

  try {
    const workflowId = 'wf-test-wait-1';
    const manager = new WorkflowStateManager({ workflowId, root });
    manager.startStage('INIT');

    // Asynchronously update stage after 100ms
    setTimeout(() => {
      manager.startStage('REVIEWER', { taskId: 't-1', attempt: 1 });
    }, 100);

    const matched = await supergptWait({
      workflowId,
      root,
      predicate: (s) => s.stage === 'REVIEWER',
      timeoutMs: 2000,
      intervalMs: 50,
    });

    assert.equal(matched.stage, 'REVIEWER');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supergptStop: safely persists STOPPED state and terminates active children', async () => {
  const root = path.join('/tmp', `supergpt-test-stop-${Date.now()}`);
  await mkdir(root, { recursive: true });

  try {
    const workflowId = 'wf-test-stop-1';
    const manager = new WorkflowStateManager({ workflowId, root });
    manager.startStage('EXECUTOR', { taskId: 't-1' });

    const stopResult = await supergptStop({
      workflowId,
      reason: 'aborted by user',
      root,
    });

    assert.equal(stopResult.workflowId, workflowId);
    assert.equal(stopResult.status, 'STOPPED');
    assert.equal(stopResult.reason, 'aborted by user');

    const updatedState = supergptStatus({ workflowId, root });
    assert.equal(updatedState.workflowStatus, 'STOPPED');
    assert.equal(updatedState.stoppedReason, 'aborted by user');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HUMAN_REQUIRED and supergptResume flow: preserves state and continues with user answer', async () => {
  const root = path.join('/tmp', `supergpt-test-resume-${Date.now()}`);
  await mkdir(root, { recursive: true });

  try {
    const workflowId = 'wf-test-resume-1';

    // 1. Initial run stops at HUMAN_REQUIRED
    let runCount = 0;
    let receivedAnswer = null;

    const mockPipeline = async ({ workflowId, answer, workflowStateManager }) => {
      runCount += 1;
      if (runCount === 1) {
        workflowStateManager.transitionTerminal('HUMAN_REQUIRED', {
          question: 'Should we use JWT or session cookies?',
          reason: 'Architecture decision needed',
        });
        return {
          status: 'HUMAN_REQUIRED',
          question: 'Should we use JWT or session cookies?',
          reason: 'Architecture decision needed',
        };
      }
      // Resumed run
      receivedAnswer = answer;
      workflowStateManager.transitionTerminal('DONE', { summary: 'Completed using ' + answer });
      return {
        status: 'WORKFLOW_DONE',
        summary: 'Completed using ' + answer,
        deliveredFiles: ['auth.js'],
      };
    };

    // Fake workspace metadata for resume
    await writeFile(
      path.join(root, `${workflowId}.workspace.json`),
      JSON.stringify({
        workflow_id: workflowId,
        source_workspace: '/repo',
        source_repo_root: '/repo',
        source_branch: 'main',
        baseline_head: 'abc',
        worktree_path: path.join(root, 'worktree'),
      })
    );

    // Initial run
    const result1 = await runSuperGPT({
      workflowId,
      goal: 'Add auth',
      _pipeline: mockPipeline,
    });

    assert.equal(result1.status, 'HUMAN_REQUIRED');
    assert.equal(result1.question, 'Should we use JWT or session cookies?');

    // User answers and front agent resumes
    const result2 = await runSuperGPT({
      workflowId,
      isResume: true,
      answer: 'JWT with refresh tokens',
      _pipeline: mockPipeline,
    });

    assert.equal(result2.status, 'WORKFLOW_DONE');
    assert.equal(receivedAnswer, 'JWT with refresh tokens');
    assert.equal(result2.summary, 'Completed using JWT with refresh tokens');
    assert.deepEqual(result2.deliveredFiles, ['auth.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
