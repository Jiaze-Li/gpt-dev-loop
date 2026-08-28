import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createWorkflowBaseline,
  WorkflowBaselineError,
  WORKFLOW_BASELINE_ERROR_CODES,
} from '../src/orchestrator/workflowBaseline.js';

// Scripted `git` — keyed by the exact `git <args>` invocation, like
// tests/gitEvidenceCollector.test.js's makeFakeGit.
function makeFakeGit(responses, { spawnError = null } = {}) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (spawnError) return child.emit('error', spawnError);
      const response = responses[args.join(' ')];
      if (!response) return child.emit('error', new Error(`unscripted git invocation: git ${args.join(' ')}`));
      if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit('data', Buffer.from(response.stderr));
      child.emit('close', response.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

const CLEAN = {
  'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
  'rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
  'rev-parse HEAD': { code: 0, stdout: 'deadbeef\n' },
  'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'phase1\n' },
  'status --porcelain=v1': { code: 0, stdout: '' },
};

test('clean worktree: establishes baseline with repo root, branch, head, clean=true', async () => {
  const { spawn } = makeFakeGit(CLEAN);
  const baseline = await createWorkflowBaseline({ spawn }).establish({ cwd: '/repo' });
  assert.deepEqual(baseline, {
    repo_root: '/repo',
    branch: 'phase1',
    head: 'deadbeef',
    clean: true,
    isolated_worktree: false,
    dirty_paths: [],
  });
});

test('dirty worktree + not isolated: fails closed with REPOSITORY_NOT_CLEAN before any execution', async () => {
  const { spawn } = makeFakeGit({
    ...CLEAN,
    'status --porcelain=v1': { code: 0, stdout: ' M extension/background.js\n?? src/agy/\n' },
  });
  await assert.rejects(
    () => createWorkflowBaseline({ spawn }).establish({ cwd: '/repo' }),
    (err) => {
      assert.ok(err instanceof WorkflowBaselineError);
      assert.equal(err.code, WORKFLOW_BASELINE_ERROR_CODES.REPOSITORY_NOT_CLEAN);
      assert.deepEqual(err.details.dirty_paths, ['extension/background.js', 'src/agy/']);
      return true;
    }
  );
});

test('dirty worktree + isolatedWorktree: allowed, clean=false is reported', async () => {
  const { spawn } = makeFakeGit({
    ...CLEAN,
    'status --porcelain=v1': { code: 0, stdout: ' M work/agy-e2e.txt\n' },
  });
  const baseline = await createWorkflowBaseline({ spawn }).establish({ cwd: '/repo', isolatedWorktree: true });
  assert.equal(baseline.clean, false);
  assert.equal(baseline.isolated_worktree, true);
  assert.deepEqual(baseline.dirty_paths, ['work/agy-e2e.txt']);
});

test('not a git repository: fails closed with NOT_A_REPOSITORY', async () => {
  const { spawn } = makeFakeGit({
    'rev-parse --is-inside-work-tree': { code: 128, stderr: 'fatal: not a git repository\n' },
  });
  await assert.rejects(
    () => createWorkflowBaseline({ spawn }).establish({ cwd: '/nope' }),
    (err) => err.code === WORKFLOW_BASELINE_ERROR_CODES.NOT_A_REPOSITORY
  );
});

test('missing git binary: fails closed with GIT_UNAVAILABLE', async () => {
  const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { spawn } = makeFakeGit({}, { spawnError });
  await assert.rejects(
    () => createWorkflowBaseline({ spawn }).establish({ cwd: '/repo' }),
    (err) => err.code === WORKFLOW_BASELINE_ERROR_CODES.GIT_UNAVAILABLE
  );
});
