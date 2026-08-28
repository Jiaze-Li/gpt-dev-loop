import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createResultDelivery,
  deliverWorkflowResult,
  ResultDeliveryError,
  RESULT_DELIVERY_ERROR_CODES,
} from '../src/orchestrator/resultDelivery.js';

const WT = '/managed/repo-wf-1';
const SRC = '/src/repo';
const BASE = 'base1111111111111111111111111111111111111';
const PATCH = 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';

// Fake `git` driven by handler(args, cwd) -> { code?, stdout?, stderr? }.
function makeFakeGit(handler, { spawnError = null } = {}) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const cwd = opts?.cwd;
    calls.push({ args, argstr: args.join(' '), cwd });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (spawnError) return child.emit('error', spawnError);
      let res;
      try {
        res = handler(args, cwd) ?? {};
      } catch (err) {
        return child.emit('error', err);
      }
      if (res.stdout) child.stdout.emit('data', Buffer.from(res.stdout));
      if (res.stderr) child.stderr.emit('data', Buffer.from(res.stderr));
      child.emit('close', res.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

function makeFakeFs({ existing = [] } = {}) {
  const writes = [];
  const copies = [];
  const removed = [];
  const existingSet = new Set(existing);
  return {
    fs: {
      existsSync(p) {
        return existingSet.has(p);
      },
      writeFileSync(p, data) {
        writes.push({ p, data });
      },
      copyFileSync(src, dst) {
        copies.push({ src, dst });
      },
      mkdirSync() {},
      rmSync(p) {
        removed.push(p);
      },
    },
    writes,
    copies,
    removed,
  };
}

function subject({ handler, fsStub, opts } = {}) {
  const { spawn, calls } = makeFakeGit(handler, opts);
  const delivery = createResultDelivery({
    spawn,
    fs: fsStub ?? makeFakeFs().fs,
    now: () => 123,
  });
  return { delivery, calls };
}

// --- calculateApprovedDelta -------------------------------------------------

test('calculateApprovedDelta: collects tracked patch, untracked files, changed paths', async () => {
  const { delivery } = subject({
    handler: (args, cwd) => {
      assert.equal(cwd, WT);
      const a = args.join(' ');
      if (a === `diff --name-status --no-renames ${BASE} -- .`) {
        return { stdout: 'M\tsrc/a.js\nA\tsrc/b.js\n' };
      }
      if (a === `diff --full-index --binary --no-renames ${BASE} -- .`) return { stdout: PATCH };
      if (a === 'ls-files --others --exclude-standard') return { stdout: 'notes/new.md\n' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const delta = await delivery.calculateApprovedDelta({ worktreePath: WT, baselineHead: BASE });
  assert.equal(delta.patch, PATCH);
  assert.deepEqual(delta.untrackedFiles, ['notes/new.md']);
  assert.deepEqual(delta.trackedChanges, [
    { status: 'M', path: 'src/a.js' },
    { status: 'A', path: 'src/b.js' },
  ]);
  assert.deepEqual(delta.changedPaths, ['src/a.js', 'src/b.js', 'notes/new.md']);
  assert.equal(delta.isEmpty, false);
});

test('calculateApprovedDelta: empty when the workflow produced nothing', async () => {
  const { delivery } = subject({
    handler: (args) => {
      const a = args.join(' ');
      if (a.startsWith('diff --name-status')) return { stdout: '' };
      if (a.startsWith('diff --full-index')) return { stdout: '' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const delta = await delivery.calculateApprovedDelta({ worktreePath: WT, baselineHead: BASE });
  assert.equal(delta.isEmpty, true);
  assert.deepEqual(delta.changedPaths, []);
});

test('calculateApprovedDelta: a failing git command fails closed', async () => {
  const { delivery } = subject({
    handler: () => ({ code: 128, stderr: 'fatal: bad object' }),
  });
  await assert.rejects(
    () => delivery.calculateApprovedDelta({ worktreePath: WT, baselineHead: BASE }),
    (err) => err instanceof ResultDeliveryError && err.code === RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED
  );
});

// --- checkDeliveryConflicts -----------------------------------------------

const DELTA = {
  worktreePath: WT,
  baselineHead: BASE,
  patch: PATCH,
  untrackedFiles: ['notes/new.md'],
  trackedChanges: [{ status: 'M', path: 'src/a.js' }],
  changedPaths: ['src/a.js', 'notes/new.md'],
};

test('checkDeliveryConflicts: safe when the workspace is dirty only in unrelated files', async () => {
  const { delivery, calls } = subject({
    fsStub: makeFakeFs().fs,
    handler: (args, cwd) => {
      assert.equal(cwd, SRC);
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'README.md\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: 'scratch.txt\n' };
      if (args[0] === 'apply') return { code: 0 };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const report = await delivery.checkDeliveryConflicts({ delta: DELTA, sourceWorkspace: SRC });
  assert.deepEqual(report, { safe: true, conflicts: [] });
  assert.ok(calls.some((c) => c.args[0] === 'apply' && c.args.includes('--check')));
});

test('checkDeliveryConflicts: overlapping edit on a delta path is a conflict', async () => {
  const { delivery } = subject({
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'src/a.js\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (args[0] === 'apply') return { code: 0 };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const report = await delivery.checkDeliveryConflicts({ delta: DELTA, sourceWorkspace: SRC });
  assert.equal(report.safe, false);
  assert.ok(report.conflicts.some((c) => c.reason === 'overlapping-edit' && c.path === 'src/a.js'));
});

test('checkDeliveryConflicts: a new file that already exists on disk is a creation collision', async () => {
  const { delivery } = subject({
    fsStub: makeFakeFs({ existing: [`${SRC}/notes/new.md`] }).fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: '' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (args[0] === 'apply') return { code: 0 };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const report = await delivery.checkDeliveryConflicts({ delta: DELTA, sourceWorkspace: SRC });
  assert.equal(report.safe, false);
  assert.ok(report.conflicts.some((c) => c.reason === 'creation-collision' && c.path === 'notes/new.md'));
});

test('checkDeliveryConflicts: a patch that will not apply cleanly is a conflict', async () => {
  const { delivery } = subject({
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: '' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (args[0] === 'apply') return { code: 1, stderr: 'error: patch failed' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const report = await delivery.checkDeliveryConflicts({ delta: DELTA, sourceWorkspace: SRC });
  assert.equal(report.safe, false);
  assert.ok(report.conflicts.some((c) => c.reason === 'patch-does-not-apply'));
});

// --- deliverApprovedDelta ------------------------------------------------

test('deliverApprovedDelta: applies the patch and copies new files, never commits', async () => {
  const { fs, copies, writes } = makeFakeFs();
  const { delivery, calls } = subject({
    fsStub: fs,
    handler: (args, cwd) => {
      assert.equal(cwd, SRC);
      if (args[0] === 'apply') {
        assert.ok(!args.includes('--check'));
        return { code: 0 };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  });
  const result = await delivery.deliverApprovedDelta({ delta: DELTA, sourceWorkspace: SRC });
  assert.deepEqual(result.delivered, ['src/a.js', 'notes/new.md']);
  assert.equal(writes.length, 1);
  assert.deepEqual(copies, [{ src: `${WT}/notes/new.md`, dst: `${SRC}/notes/new.md` }]);
  assert.ok(!calls.some((c) => c.args.includes('commit')));
});

test('deliverApprovedDelta: a failed apply fails closed', async () => {
  const { delivery } = subject({
    handler: (args) => (args[0] === 'apply' ? { code: 1, stderr: 'conflict' } : {}),
  });
  await assert.rejects(
    () => delivery.deliverApprovedDelta({ delta: DELTA, sourceWorkspace: SRC }),
    (err) => err.code === RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED
  );
});

// --- cleanupDeliveredWorktree ------------------------------------------

test('cleanupDeliveredWorktree: force-removes and prunes from the source repo root', async () => {
  const { delivery, calls } = subject({
    handler: (args, cwd) => {
      assert.equal(cwd, SRC);
      return { code: 0 };
    },
  });
  const result = await delivery.cleanupDeliveredWorktree({ worktreePath: WT, sourceRepoRoot: SRC });
  assert.deepEqual(result, { removed: WT });
  assert.deepEqual(
    calls.map((c) => c.argstr),
    [`worktree remove --force ${WT}`, 'worktree prune']
  );
});

test('cleanupDeliveredWorktree: a failed removal fails closed', async () => {
  const { delivery } = subject({
    handler: (args) => (args.includes('remove') ? { code: 1, stderr: 'locked' } : { code: 0 }),
  });
  await assert.rejects(
    () => delivery.cleanupDeliveredWorktree({ worktreePath: WT, sourceRepoRoot: SRC }),
    (err) => err.code === RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED
  );
});

// --- deliverWorkflowResult (policy) -----------------------------------

const WORKTREE = {
  workflow_id: 'wf-1',
  source_workspace: SRC,
  source_repo_root: SRC,
  baseline_head: BASE,
  worktree_path: WT,
};

test('deliverWorkflowResult: safe delta is delivered then the worktree is cleaned up', async () => {
  const seq = [];
  const fakeDelivery = {
    calculateApprovedDelta: async () => ({ ...DELTA }),
    checkDeliveryConflicts: async () => ({ safe: true, conflicts: [] }),
    deliverApprovedDelta: async () => seq.push('deliver'),
    cleanupDeliveredWorktree: async ({ worktreePath, sourceRepoRoot }) => {
      seq.push('cleanup');
      assert.equal(worktreePath, WT);
      assert.equal(sourceRepoRoot, SRC);
    },
  };
  const report = await deliverWorkflowResult({ worktree: WORKTREE, delivery: fakeDelivery });
  assert.equal(report.status, 'DELIVERED');
  assert.equal(report.worktree_preserved, false);
  assert.deepEqual(report.changed_files, DELTA.changedPaths);
  assert.deepEqual(seq, ['deliver', 'cleanup']);
});

test('deliverWorkflowResult: a conflict aborts with HUMAN_REQUIRED and preserves the worktree', async () => {
  const seq = [];
  const fakeDelivery = {
    calculateApprovedDelta: async () => ({ ...DELTA }),
    checkDeliveryConflicts: async () => ({
      safe: false,
      conflicts: [{ path: 'src/a.js', reason: 'overlapping-edit' }],
    }),
    deliverApprovedDelta: async () => seq.push('deliver'),
    cleanupDeliveredWorktree: async () => seq.push('cleanup'),
  };
  const report = await deliverWorkflowResult({ worktree: WORKTREE, delivery: fakeDelivery });
  assert.equal(report.status, 'HUMAN_REQUIRED');
  assert.equal(report.worktree_preserved, true);
  assert.deepEqual(report.conflicts, [{ path: 'src/a.js', reason: 'overlapping-edit' }]);
  assert.deepEqual(seq, [], 'neither delivery nor cleanup runs on conflict');
});

test('deliverWorkflowResult: preserves unrelated dirty changes (conflict check sees only delta paths)', async () => {
  let checkedDelta;
  const fakeDelivery = {
    calculateApprovedDelta: async () => ({ ...DELTA }),
    checkDeliveryConflicts: async ({ delta, sourceWorkspace }) => {
      checkedDelta = delta;
      assert.equal(sourceWorkspace, SRC);
      return { safe: true, conflicts: [] };
    },
    deliverApprovedDelta: async () => {},
    cleanupDeliveredWorktree: async () => {},
  };
  await deliverWorkflowResult({ worktree: WORKTREE, delivery: fakeDelivery });
  assert.deepEqual(checkedDelta.changedPaths, ['src/a.js', 'notes/new.md']);
});
