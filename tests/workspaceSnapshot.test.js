import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createWorkspaceSnapshot,
  WorkspaceSnapshotError,
  WORKSPACE_SNAPSHOT_ERROR_CODES,
} from '../src/orchestrator/workspaceSnapshot.js';

const SRC = '/src/repo';
const WT = '/managed/repo-wf-1';
const BASE = 'base1111111111111111111111111111111111111';
const SNAP = 'snap2222222222222222222222222222222222222';

// Fake `git` driven by a handler(args, cwd) -> { code?, stdout?, stderr? }.
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

// Minimal in-memory fs stub.
function makeFakeFs(sizes = {}) {
  const writes = [];
  const copies = [];
  const removed = [];
  return {
    fs: {
      statSync(p) {
        if (!(p in sizes)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return { size: sizes[p], isFile: () => true };
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
  const snap = createWorkspaceSnapshot({
    spawn,
    fs: fsStub,
    maxFileBytes: 1000,
    maxTotalBytes: 2500,
    now: () => 123,
  });
  return { snap, calls };
}

test('pristine invocation workspace: returns null, no commit', async () => {
  const { fs } = makeFakeFs();
  const { snap, calls } = subject({
    fsStub: fs,
    handler: (args) => {
      if (args.join(' ') === 'diff --name-only HEAD') return { stdout: '' };
      if (args.join(' ') === 'ls-files --others --exclude-standard') return { stdout: '' };
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  });
  const result = await snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE });
  assert.equal(result, null);
  assert.ok(!calls.some((c) => c.args.includes('commit')));
});

test('tracked + untracked changes: applies patch, copies untracked, commits snapshot', async () => {
  const { fs, copies, writes } = makeFakeFs({
    [`${SRC}/src/a.js`]: 200,
    [`${SRC}/new.txt`]: 50,
  });
  const { snap, calls } = subject({
    fsStub: fs,
    handler: (args, cwd) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'src/a.js\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: 'new.txt\n' };
      if (a === 'diff --full-index --binary HEAD') return { stdout: 'PATCH-BODY\n' };
      if (a === 'apply --whitespace=nowarn --3way /tmp/x' || args[0] === 'apply') return { code: 0 };
      if (a === 'add -A') return { code: 0 };
      if (a === 'status --porcelain=v1') return { stdout: ' M src/a.js\nA  new.txt\n' };
      if (args.includes('commit')) {
        assert.equal(cwd, WT);
        return { code: 0 };
      }
      if (a === 'rev-parse HEAD') return { stdout: `${SNAP}\n` };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const result = await snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE });
  assert.deepEqual(result, {
    snapshot_commit: SNAP,
    tracked: 1,
    untracked: 1,
    total_bytes: 250,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(copies, [{ src: `${SRC}/new.txt`, dst: `${WT}/new.txt` }]);
  assert.ok(calls.some((c) => c.args[0] === 'apply' && c.cwd === WT));
});

test('oversized single file fails closed with EXCESSIVE_FILE_SIZE before any commit', async () => {
  const { fs } = makeFakeFs({ [`${SRC}/big.bin`]: 5000 });
  const { snap, calls } = subject({
    fsStub: fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'big.bin\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  await assert.rejects(
    () => snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE }),
    (err) =>
      err instanceof WorkspaceSnapshotError &&
      err.code === WORKSPACE_SNAPSHOT_ERROR_CODES.EXCESSIVE_FILE_SIZE &&
      err.details.path === 'big.bin'
  );
  assert.ok(!calls.some((c) => c.args.includes('commit')));
});

test('aggregate payload over the total limit fails closed with EXCESSIVE_SNAPSHOT_SIZE', async () => {
  const { fs } = makeFakeFs({
    [`${SRC}/a`]: 900,
    [`${SRC}/b`]: 900,
    [`${SRC}/c`]: 900,
  });
  const { snap } = subject({
    fsStub: fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'a\nb\nc\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  await assert.rejects(
    () => snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE }),
    (err) => err.code === WORKSPACE_SNAPSHOT_ERROR_CODES.EXCESSIVE_SNAPSHOT_SIZE
  );
});

test('patch that will not apply in the worktree fails closed with SNAPSHOT_APPLY_FAILED', async () => {
  const { fs } = makeFakeFs({ [`${SRC}/a.js`]: 100 });
  const { snap, calls } = subject({
    fsStub: fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'a.js\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (a === 'diff --full-index --binary HEAD') return { stdout: 'PATCH\n' };
      if (args[0] === 'apply') return { code: 1, stderr: 'patch does not apply' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  await assert.rejects(
    () => snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE }),
    (err) => err.code === WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_APPLY_FAILED
  );
  assert.ok(!calls.some((c) => c.args.includes('commit')));
});

test('deleted tracked file (gone from disk) does not count against the budget and still snapshots', async () => {
  const { fs } = makeFakeFs({}); // statSync throws ENOENT for everything
  const { snap } = subject({
    fsStub: fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'gone.js\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (a === 'diff --full-index --binary HEAD') return { stdout: 'PATCH\n' };
      if (args[0] === 'apply') return { code: 0 };
      if (a === 'add -A') return { code: 0 };
      if (a === 'status --porcelain=v1') return { stdout: ' D gone.js\n' };
      if (args.includes('commit')) return { code: 0 };
      if (a === 'rev-parse HEAD') return { stdout: `${SNAP}\n` };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const result = await snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE });
  assert.equal(result.snapshot_commit, SNAP);
  assert.equal(result.total_bytes, 0);
});

test('changes identical to baseline (nothing staged) returns null instead of an empty commit', async () => {
  const { fs } = makeFakeFs({ [`${SRC}/a.js`]: 10 });
  const { snap, calls } = subject({
    fsStub: fs,
    handler: (args) => {
      const a = args.join(' ');
      if (a === 'diff --name-only HEAD') return { stdout: 'a.js\n' };
      if (a === 'ls-files --others --exclude-standard') return { stdout: '' };
      if (a === 'diff --full-index --binary HEAD') return { stdout: 'PATCH\n' };
      if (args[0] === 'apply') return { code: 0 };
      if (a === 'add -A') return { code: 0 };
      if (a === 'status --porcelain=v1') return { stdout: '' };
      throw new Error(`unexpected git ${a}`);
    },
  });
  const result = await snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE });
  assert.equal(result, null);
  assert.ok(!calls.some((c) => c.args.includes('commit')));
});

test('missing git binary fails closed with GIT_UNAVAILABLE', async () => {
  const { fs } = makeFakeFs();
  const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { snap } = subject({ fsStub: fs, handler: () => ({}), opts: { spawnError } });
  await assert.rejects(
    () => snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE }),
    (err) => err.code === WORKSPACE_SNAPSHOT_ERROR_CODES.GIT_UNAVAILABLE
  );
});

test('a failing git plumbing command surfaces SNAPSHOT_COMMAND_FAILED', async () => {
  const { fs } = makeFakeFs();
  const { snap } = subject({
    fsStub: fs,
    handler: (args) => {
      if (args.join(' ') === 'diff --name-only HEAD') return { code: 128, stderr: 'fatal: bad revision' };
      throw new Error('unexpected');
    },
  });
  await assert.rejects(
    () => snap.captureAndApply({ sourceCwd: SRC, worktreePath: WT, baselineHead: BASE }),
    (err) => err.code === WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_COMMAND_FAILED
  );
});
