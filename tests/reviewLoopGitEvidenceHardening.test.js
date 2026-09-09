// Phase 1 — the ACTIVE ReviewLoop evidence path (src/reviewloop/gitEvidence.js)
// must:
//   * lstat an untracked path before reading it; never follow a symlink or read
//     a special file; fail the evidence closed instead;
//   * treat any non-zero git exit that feeds baseline / diff / HEAD / untracked
//     attribution as fail-closed, never as an empty diff / empty set / fallback
//     HEAD.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  captureBaseline,
  collectWorkerDelta,
} from '../src/reviewloop/gitEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-git-hard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

test('active path: Worker untracked symlink to an external secret is rejected before readFile; target bytes never enter evidence', async () => {
  const dir = initRepo();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-secret-'));
  try {
    const secretFile = path.join(secretDir, 'external-secret.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_TOKEN_ABC123');

    const baseline = await captureBaseline({ cwd: dir });

    // Worker produces an untracked symlink pointing outside the repo.
    fs.symlinkSync(secretFile, path.join(dir, 'leak'));

    let readCalls = 0;
    const delta = await collectWorkerDelta({
      cwd: dir,
      baseline,
      readFile: async (p) => { readCalls += 1; return fs.promises.readFile(p); },
    });

    assert.equal(delta.evidenceComplete, false, 'symlink fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /symlink/i.test(r)));
    assert.doesNotMatch(delta.diff, /TOP_SECRET_TOKEN/, 'target bytes never entered the diff');
    assert.equal(delta.changedFiles.includes('leak'), false, 'the symlink is not attributed as Worker output');
    assert.equal(readCalls, 0, 'readFile was never called on the symlink target');

    // And the controller fails closed rather than reviewing.
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => baseline,
      reviewerFn: async () => { throw new Error('reviewer must not be called'); },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test('active path: a pre-existing untracked symlink makes the baseline evidence incomplete', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'pre-existing-link'));
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(baseline.evidenceComplete, false);
    assert.ok(baseline.incompleteReasons.some((r) => /symlink/i.test(r)));
    assert.equal('pre-existing-link' in baseline.untrackedHashes, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a pre-existing untracked file modified but still untracked cannot be attributed to the Worker', async () => {
  const dir = initRepo();
  try {
    // Pre-existing untracked file present at baseline — only a digest is kept.
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'PRE_EXISTING_SECRET line 1\nline 2\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('scratch.txt' in baseline.untrackedHashes, true);

    // Worker edits it but never `git add`s it — stays untracked, so it never
    // reaches the trackedChanged / modifiedStagedBaseline guard.
    fs.appendFileSync(path.join(dir, 'scratch.txt'), 'worker added line\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /modified after baseline/i.test(r)));
    assert.ok((delta.modifiedUntrackedBaseline ?? []).includes('scratch.txt'));
    assert.equal(delta.untrackedChanged.includes('scratch.txt'), false, 'never attributed as Worker output');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing content never emitted as Worker evidence');
    assert.doesNotMatch(delta.diff, /worker added line/, 'the file is not rendered as a whole-new-file block');

    // The controller fails closed rather than reviewing.
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => baseline,
      reviewerFn: async () => { throw new Error('reviewer must not be called'); },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    assert.equal((await controller.review({ loopId })).status, 'HUMAN_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('active path: an untracked special file (FIFO) fails the evidence closed', async () => {
  const responses = {
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/pipe\0' },
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')];
      if (!r) { child.emit('error', new Error(`unscripted git ${args.join(' ')}`)); return; }
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  let readCalls = 0;
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: {}, evidenceComplete: true },
    spawn,
    lstat: async () => ({
      isSymbolicLink: () => false,
      isFile: () => false,
      isFIFO: () => true,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => false,
      size: 0,
    }),
    readFile: async () => { readCalls += 1; return Buffer.from(''); },
  });
  assert.equal(delta.evidenceComplete, false);
  assert.ok(delta.incompleteReasons.some((r) => /FIFO/i.test(r)));
  assert.equal(readCalls, 0);
});

function scriptedSpawn(responses) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')] ?? { code: 128, stdout: '', stderr: 'unscripted' };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
}

test('fail closed: git diff non-zero exit -> evidenceComplete=false, no empty-diff spoof', async () => {
  const spawn = scriptedSpawn({
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 128, stderr: 'fatal: bad revision' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: '' },
  });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: {}, evidenceComplete: true },
    spawn,
  });
  assert.equal(delta.evidenceComplete, false);
  assert.ok(delta.incompleteReasons.some((r) => /git diff base000.*exited 128/.test(r)));
  assert.equal(delta.noWorkerChangeYet, false, 'a diff failure never reads as "no change"');
});

test('fail closed: git ls-files non-zero exit -> evidenceComplete=false and no phantom untracked deletions', async () => {
  const spawn = scriptedSpawn({
    'rev-parse HEAD': { code: 0, stdout: 'base000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 129, stderr: 'error' },
  });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: { 'user.txt': 'abc' }, evidenceComplete: true },
    spawn,
  });
  assert.equal(delta.evidenceComplete, false);
  assert.deepEqual(delta.untrackedDeleted, [], 'a failed listing must not claim every baseline untracked file was deleted');
});

test('fail closed: captureBaseline throws when git rev-parse HEAD fails', async () => {
  const spawn = scriptedSpawn({
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    'rev-parse HEAD': { code: 128, stderr: 'fatal: not a valid ref' },
  });
  await assert.rejects(captureBaseline({ cwd: '/repo', spawn }), /rev-parse HEAD.*exited 128/);
});

test('fail closed: captureBaseline throws when git stash create fails', async () => {
  const spawn = scriptedSpawn({
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    'rev-parse HEAD': { code: 0, stdout: 'head000\n' },
    'stash create reviewloop-baseline': { code: 1, stderr: 'fatal: could not write stash' },
  });
  await assert.rejects(captureBaseline({ cwd: '/repo', spawn }), /stash create/);
});
