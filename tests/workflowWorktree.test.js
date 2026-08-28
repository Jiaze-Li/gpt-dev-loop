import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createWorkflowWorktree,
  WorkflowWorktreeError,
  WORKFLOW_WORKTREE_ERROR_CODES,
} from '../src/orchestrator/workflowWorktree.js';
import { WorkspaceSnapshotError } from '../src/orchestrator/workspaceSnapshot.js';

// Default injected snapshot collaborator: the invocation workspace was
// pristine, so nothing is applied and the baseline stays the plain HEAD.
const PRISTINE_SNAPSHOT = { captureAndApply: async () => null };

// Scripted `git`, keyed by "<cwd>::<args>" with a bare "<args>" fallback.
function makeFakeGit(responses, { spawnError = null } = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const cwd = opts?.cwd;
    calls.push({ cmd: [command, ...args].join(' '), args: args.join(' '), cwd });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (spawnError) return child.emit('error', spawnError);
      const key = `${cwd}::${args.join(' ')}`;
      const response = responses[key] ?? responses[args.join(' ')];
      if (!response) return child.emit('error', new Error(`unscripted git invocation: git ${args.join(' ')} (cwd=${cwd})`));
      if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit('data', Buffer.from(response.stderr));
      child.emit('close', response.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

const SRC = '/src/repo';
const WT_ROOT = '/managed';
const WT = '/managed/repo-wf-1';
const HEAD = 'base1111111111111111111111111111111111111';

// A source repo whose OWN working tree is deliberately never queried for
// status here — establish() must not care whether the user's tree is dirty.
const SOURCE_OK = {
  [`${SRC}::rev-parse --is-inside-work-tree`]: { stdout: 'true\n' },
  [`${SRC}::rev-parse --show-toplevel`]: { stdout: `${SRC}\n` },
  // Primary checkout: the shared git dir lives under its own root.
  [`${SRC}::rev-parse --git-common-dir`]: { stdout: `${SRC}/.git\n` },
  [`${SRC}::rev-parse HEAD`]: { stdout: `${HEAD}\n` },
  [`${SRC}::rev-parse --abbrev-ref HEAD`]: { stdout: 'main\n' },
  [`${SRC}::worktree add --detach ${WT} ${HEAD}`]: { stdout: `Preparing worktree\n` },
  // Best-effort cleanup path (pre-execution invariant failures only).
  [`${SRC}::worktree remove --force ${WT}`]: { stdout: '' },
  [`${SRC}::worktree prune`]: { stdout: '' },
};

const WT_OK = {
  [`${WT}::rev-parse --show-toplevel`]: { stdout: `${WT}\n` },
  [`${WT}::rev-parse --git-common-dir`]: { stdout: `${SRC}/.git\n` },
  [`${WT}::rev-parse HEAD`]: { stdout: `${HEAD}\n` },
  [`${WT}::status --porcelain=v1`]: { stdout: '' },
};

function subject(responses, opts, { snapshot = PRISTINE_SNAPSHOT } = {}) {
  const { spawn, calls } = makeFakeGit(responses, opts);
  return { wt: createWorkflowWorktree({ spawn, worktreeRoot: WT_ROOT, snapshot }), calls };
}

test('primary checkout invocation: creates a SuperGPT-managed worktree and returns safe metadata', async () => {
  const { wt, calls } = subject({ ...SOURCE_OK, ...WT_OK });
  const meta = await wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' });
  assert.deepEqual(meta, {
    workflow_id: 'wf-1',
    source_workspace: SRC,
    source_repo_root: SRC,
    repository_identity: `${SRC}/.git`,
    source_branch: 'main',
    source_head: HEAD,
    baseline_head: HEAD,
    snapshot_commit: null,
    snapshot_tracked_files: 0,
    snapshot_untracked_files: 0,
    worktree_path: WT,
  });
  assert.ok(calls.some((c) => c.args === `worktree add --detach ${WT} ${HEAD}` && c.cwd === SRC));
  // Success path never tears the worktree down.
  assert.ok(!calls.some((c) => c.args.startsWith('worktree remove')));
});

test('linked worktree invocation: source_workspace stays the linked worktree, not the primary checkout', async () => {
  const PRIMARY = '/src/primary';
  const LINKED = '/src/feature-wt';
  const LWT = '/managed/feature-wt-wf-9';
  const responses = {
    [`${LINKED}::rev-parse --is-inside-work-tree`]: { stdout: 'true\n' },
    [`${LINKED}::rev-parse --show-toplevel`]: { stdout: `${LINKED}\n` },
    // A linked worktree's shared git dir points at the PRIMARY checkout.
    [`${LINKED}::rev-parse --git-common-dir`]: { stdout: `${PRIMARY}/.git\n` },
    [`${LINKED}::rev-parse HEAD`]: { stdout: `${HEAD}\n` },
    [`${LINKED}::rev-parse --abbrev-ref HEAD`]: { stdout: 'phase1-handshake\n' },
    [`${LINKED}::worktree add --detach ${LWT} ${HEAD}`]: { stdout: '' },
    [`${LWT}::rev-parse --show-toplevel`]: { stdout: `${LWT}\n` },
    // The isolated worktree resolves to the SAME shared git dir.
    [`${LWT}::rev-parse --git-common-dir`]: { stdout: `${PRIMARY}/.git\n` },
    [`${LWT}::rev-parse HEAD`]: { stdout: `${HEAD}\n` },
    [`${LWT}::status --porcelain=v1`]: { stdout: '' },
  };
  const { spawn } = makeFakeGit(responses);
  const wt = createWorkflowWorktree({ spawn, worktreeRoot: WT_ROOT, snapshot: PRISTINE_SNAPSHOT });
  const meta = await wt.establish({ sourceCwd: LINKED, workflowId: 'wf-9' });
  assert.equal(meta.source_workspace, LINKED);
  assert.equal(meta.source_repo_root, LINKED);
  assert.equal(meta.repository_identity, `${PRIMARY}/.git`);
  assert.equal(meta.source_branch, 'phase1-handshake');
  assert.equal(meta.source_head, HEAD);
  assert.equal(meta.baseline_head, HEAD);
  assert.equal(meta.worktree_path, LWT);
});

test('multiple linked worktrees of the same repository each isolate against their own HEAD', async () => {
  const PRIMARY = '/src/primary';
  const mk = (linked, managed, head, branch) => ({
    [`${linked}::rev-parse --is-inside-work-tree`]: { stdout: 'true\n' },
    [`${linked}::rev-parse --show-toplevel`]: { stdout: `${linked}\n` },
    [`${linked}::rev-parse --git-common-dir`]: { stdout: `${PRIMARY}/.git\n` },
    [`${linked}::rev-parse HEAD`]: { stdout: `${head}\n` },
    [`${linked}::rev-parse --abbrev-ref HEAD`]: { stdout: `${branch}\n` },
    [`${linked}::worktree add --detach ${managed} ${head}`]: { stdout: '' },
    [`${managed}::rev-parse --show-toplevel`]: { stdout: `${managed}\n` },
    [`${managed}::rev-parse --git-common-dir`]: { stdout: `${PRIMARY}/.git\n` },
    [`${managed}::rev-parse HEAD`]: { stdout: `${head}\n` },
    [`${managed}::status --porcelain=v1`]: { stdout: '' },
  });
  const HEAD_A = 'aaaa111111111111111111111111111111111111';
  const HEAD_B = 'bbbb222222222222222222222222222222222222';

  const a = createWorkflowWorktree({ spawn: makeFakeGit(mk('/src/wt-a', '/managed/wt-a-wf-a', HEAD_A, 'feat-a')).spawn, worktreeRoot: WT_ROOT, snapshot: PRISTINE_SNAPSHOT });
  const b = createWorkflowWorktree({ spawn: makeFakeGit(mk('/src/wt-b', '/managed/wt-b-wf-b', HEAD_B, 'feat-b')).spawn, worktreeRoot: WT_ROOT, snapshot: PRISTINE_SNAPSHOT });

  const ma = await a.establish({ sourceCwd: '/src/wt-a', workflowId: 'wf-a' });
  const mb = await b.establish({ sourceCwd: '/src/wt-b', workflowId: 'wf-b' });

  assert.equal(ma.source_head, HEAD_A);
  assert.equal(ma.source_branch, 'feat-a');
  assert.equal(mb.source_head, HEAD_B);
  assert.equal(mb.source_branch, 'feat-b');
  // Same repository identity for both.
  assert.equal(ma.repository_identity, mb.repository_identity);
});

test('dirty source repo still succeeds: the isolated worktree is created clean from HEAD', async () => {
  // No `${SRC}::status` entry is scripted at all — proving establish() never
  // consults the source tree's cleanliness. The worktree's own status is clean.
  const { wt } = subject({ ...SOURCE_OK, ...WT_OK });
  const meta = await wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' });
  assert.equal(meta.worktree_path, WT);
  assert.equal(meta.baseline_head, HEAD);
});

test('worktree creation failure stops before returning any workspace', async () => {
  const { wt, calls } = subject({
    ...SOURCE_OK,
    [`${SRC}::worktree add --detach ${WT} ${HEAD}`]: { code: 128, stderr: 'fatal: could not create work tree dir\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => {
      assert.ok(err instanceof WorkflowWorktreeError);
      assert.equal(err.code, WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED);
      return true;
    }
  );
  // Fail closed: no verification against the (non-existent) worktree, and
  // nothing is removed.
  assert.ok(!calls.some((c) => c.cwd === WT));
  assert.ok(!calls.some((c) => c.args.startsWith('worktree remove')));
});

test('invariant: worktree HEAD not equal to captured baseline -> WORKTREE_INVARIANT_VIOLATION', async () => {
  const { wt } = subject({
    ...SOURCE_OK,
    ...WT_OK,
    [`${WT}::rev-parse HEAD`]: { stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION && err.details.check === 'baseline_head'
  );
});

test('invariant: worktree not clean immediately after creation -> WORKTREE_INVARIANT_VIOLATION', async () => {
  const { wt } = subject({
    ...SOURCE_OK,
    ...WT_OK,
    [`${WT}::status --porcelain=v1`]: { stdout: ' M some/file.js\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION && err.details.check === 'clean_tree'
  );
});

test('unrelated repository rejected: isolated worktree with a different repository identity -> repo_membership', async () => {
  const { wt, calls } = subject({
    ...SOURCE_OK,
    ...WT_OK,
    [`${WT}::rev-parse --git-common-dir`]: { stdout: '/some/other/repo/.git\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION && err.details.check === 'repo_membership'
  );
  // Pre-execution failure: the partially-created worktree is torn down.
  assert.ok(calls.some((c) => c.args === `worktree remove --force ${WT}` && c.cwd === SRC));
});

test('pre-execution invariant failure (unclean worktree) tears down the partial worktree', async () => {
  const { wt, calls } = subject({
    ...SOURCE_OK,
    ...WT_OK,
    [`${WT}::status --porcelain=v1`]: { stdout: ' M some/file.js\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.details.check === 'clean_tree'
  );
  assert.ok(calls.some((c) => c.args === `worktree remove --force ${WT}` && c.cwd === SRC));
  assert.ok(calls.some((c) => c.args === 'worktree prune' && c.cwd === SRC));
});

test('source is not a git repository: fails closed with NOT_A_REPOSITORY', async () => {
  const { wt } = subject({
    [`${SRC}::rev-parse --is-inside-work-tree`]: { code: 128, stderr: 'fatal: not a git repository\n' },
  });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.NOT_A_REPOSITORY
  );
});

test('missing git binary: fails closed with GIT_UNAVAILABLE', async () => {
  const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { wt } = subject({}, { spawnError });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.GIT_UNAVAILABLE
  );
});

test('dirty invocation workspace: snapshot commit becomes the baseline the worktree is pinned to', async () => {
  const SNAP = 'snap0000000000000000000000000000000000000';
  const { spawn, calls } = makeFakeGit({
    ...SOURCE_OK,
    ...WT_OK,
    // After the snapshot commit the worktree HEAD is the snapshot commit.
    [`${WT}::rev-parse --show-toplevel`]: { stdout: `${WT}\n` },
    [`${WT}::rev-parse --git-common-dir`]: { stdout: `${SRC}/.git\n` },
    [`${WT}::rev-parse HEAD`]: { stdout: `${SNAP}\n` },
    [`${WT}::status --porcelain=v1`]: { stdout: '' },
  });
  let received;
  const snapshot = {
    captureAndApply: async (args) => {
      received = args;
      return { snapshot_commit: SNAP, tracked: 2, untracked: 1, total_bytes: 42 };
    },
  };
  const wt = createWorkflowWorktree({ spawn, worktreeRoot: WT_ROOT, snapshot });
  const meta = await wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' });
  assert.deepEqual(received, { sourceCwd: SRC, worktreePath: WT, baselineHead: HEAD });
  assert.equal(meta.source_head, HEAD);
  assert.equal(meta.baseline_head, SNAP);
  assert.equal(meta.snapshot_commit, SNAP);
  assert.equal(meta.snapshot_tracked_files, 2);
  assert.equal(meta.snapshot_untracked_files, 1);
  assert.ok(!calls.some((c) => c.args.startsWith('worktree remove')));
});

test('snapshot guard failure (oversized file) fails closed and tears the worktree down', async () => {
  const { spawn, calls } = makeFakeGit({ ...SOURCE_OK, ...WT_OK });
  const snapshot = {
    captureAndApply: async () => {
      throw new WorkspaceSnapshotError('EXCESSIVE_FILE_SIZE', 'file too big', { path: 'big.bin' });
    },
  };
  const wt = createWorkflowWorktree({ spawn, worktreeRoot: WT_ROOT, snapshot });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC, workflowId: 'wf-1' }),
    (err) => err instanceof WorkspaceSnapshotError && err.code === 'EXCESSIVE_FILE_SIZE'
  );
  assert.ok(calls.some((c) => c.args === `worktree remove --force ${WT}` && c.cwd === SRC));
});

test('establish() requires a workflow id (no silent default)', async () => {
  const { wt } = subject({ ...SOURCE_OK, ...WT_OK });
  await assert.rejects(
    () => wt.establish({ sourceCwd: SRC }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED
  );
});
