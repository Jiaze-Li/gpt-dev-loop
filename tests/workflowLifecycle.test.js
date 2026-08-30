import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  WorkflowLifecycleManager,
  isSuperGptOwnedWorktree,
  isSuperGptOwnedBranch,
  gcSuperGptResources,
} from '../src/orchestrator/workflowLifecycle.js';

test('workflowLifecycle: protects non-SuperGPT worktrees and branches', () => {
  const root = '/Users/jack/.supergpt/worktrees';

  // SuperGPT-owned
  assert.ok(isSuperGptOwnedWorktree('/Users/jack/.supergpt/worktrees/gpt-dev-loop-wf-agy-12345', root));
  assert.ok(isSuperGptOwnedWorktree('/Users/jack/.supergpt/worktrees/repo-wf-abcd-task-1', root));
  assert.ok(isSuperGptOwnedBranch('supergpt/wf-agy-12345'));

  // NOT SuperGPT-owned
  assert.equal(isSuperGptOwnedWorktree('/Users/jack/Downloads/scripts/dev/gpt-dev-loop', root), false);
  assert.equal(isSuperGptOwnedWorktree('/Users/jack/.supergpt/worktrees', root), false);
  assert.equal(isSuperGptOwnedWorktree('/tmp/my-worktree', root), false);
  assert.equal(isSuperGptOwnedBranch('main'), false);
  assert.equal(isSuperGptOwnedBranch('feature/my-branch'), false);
  assert.equal(isSuperGptOwnedBranch('phase1-handshake'), false);
});

test('WorkflowLifecycleManager: tracks resources and cleans them on delivery or init failure', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'supergpt-lifecycle-test-'));
  const gitCommands = [];

  const fakeSpawn = (command, args) => {
    gitCommands.push({ command, args });
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => cb(0));
      },
    };
  };

  const manager = new WorkflowLifecycleManager({
    workflowId: 'wf-agy-unit-test-1',
    root: tmpRoot,
    sourceCwd: '/fake/source/repo',
    spawn: fakeSpawn,
  });

  const wtPath = path.join(tmpRoot, 'repo-wf-agy-unit-test-1');
  await mkdir(wtPath, { recursive: true });

  manager.trackWorktree(wtPath, { taskId: 'task-1', branch: 'supergpt/wf-agy-unit-test-1' });

  assert.equal(manager.resources.worktrees.length, 1);
  assert.equal(manager.resources.branches.length, 1);
  assert.equal(manager.resources.sandboxes['task-1'], wtPath);

  // Delivered cleanup
  await manager.onWorkflowDelivered();
  assert.equal(manager.resources.status, 'CLEANED');
  assert.ok(gitCommands.some((c) => c.args.includes('worktree') && c.args.includes('remove')));
  assert.ok(gitCommands.some((c) => c.args.includes('branch') && c.args.includes('-D')));
  assert.ok(gitCommands.some((c) => c.args.includes('worktree') && c.args.includes('prune')));

  await rm(tmpRoot, { recursive: true, force: true });
});

test('WorkflowLifecycleManager: preserves resources on suspension', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'supergpt-lifecycle-test-'));
  const manager = new WorkflowLifecycleManager({
    workflowId: 'wf-agy-unit-test-2',
    root: tmpRoot,
  });

  const wtPath = path.join(tmpRoot, 'repo-wf-agy-unit-test-2');
  await mkdir(wtPath, { recursive: true });
  manager.trackWorktree(wtPath);

  await manager.onWorkflowSuspended('human_required');
  assert.equal(manager.resources.status, 'PRESERVED');

  await rm(tmpRoot, { recursive: true, force: true });
});

test('gcSuperGptResources: cleans only abandoned stale SuperGPT worktrees', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'supergpt-gc-test-'));
  const gitCommands = [];

  const fakeSpawn = (command, args) => {
    gitCommands.push({ command, args });
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => cb(0));
      },
    };
  };

  // 1. Stale SuperGPT worktree with DONE state
  const staleWfId = 'wf-agy-stale-111';
  const staleDir = path.join(tmpRoot, `repo-${staleWfId}`);
  await mkdir(staleDir, { recursive: true });
  await writeFile(
    path.join(tmpRoot, `${staleWfId}.state.json`),
    JSON.stringify({ workflowId: staleWfId, workflowStatus: 'DONE', activeProcesses: [] }),
    'utf8',
  );

  // 2. Active SuperGPT worktree with running PID (current process)
  const activeWfId = 'wf-agy-active-222';
  const activeDir = path.join(tmpRoot, `repo-${activeWfId}`);
  await mkdir(activeDir, { recursive: true });
  await writeFile(
    path.join(tmpRoot, `${activeWfId}.state.json`),
    JSON.stringify({ workflowId: activeWfId, workflowStatus: 'RUNNING', activeProcesses: [{ pid: process.pid }] }),
    'utf8',
  );

  // 3. User directory (should never be touched!)
  const userDir = path.join(tmpRoot, 'my-user-feature');
  await mkdir(userDir, { recursive: true });

  const gcResult = await gcSuperGptResources({
    root: tmpRoot,
    maxAgeMs: 0, // stale immediately for test
    spawn: fakeSpawn,
  });

  assert.ok(gcResult.cleanedWorktrees.includes(staleDir));
  assert.equal(gcResult.cleanedWorktrees.includes(activeDir), false);
  assert.equal(gcResult.cleanedWorktrees.includes(userDir), false);
  assert.ok(existsSync(activeDir));
  assert.ok(existsSync(userDir));

  await rm(tmpRoot, { recursive: true, force: true });
});
