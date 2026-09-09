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

test('fail closed: a renamed pre-existing untracked file is not attributed as brand-new Worker output', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'old-name.txt'), 'PRE_EXISTING_SECRET\nkeep me\n');
    const baseline = await captureBaseline({ cwd: dir });

    // Worker renames it (bytes unchanged) -> destination absent from the
    // baseline untracked set, source now gone.
    fs.renameSync(path.join(dir, 'old-name.txt'), path.join(dir, 'new-name.txt'));

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /byte-identical to a file that was untracked at baseline/i.test(r)));
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('new-name.txt'));
    assert.equal(delta.untrackedChanged.includes('new-name.txt'), false, 'the rename target is never emitted whole');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing content never leaks as Worker evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a pre-existing untracked file that the Worker modifies then git-ignores is not reported deleted', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'scratch.log'), 'PRE_EXISTING_SECRET\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('scratch.log' in baseline.untrackedHashes, true);

    // Worker edits it AND adds it to .gitignore -> `git ls-files --others
    // --exclude-standard` no longer lists it, but the file is still on disk.
    fs.appendFileSync(path.join(dir, 'scratch.log'), 'worker line\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'scratch.log\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails closed rather than PASSing without reviewing it');
    assert.ok(delta.incompleteReasons.some((r) => /git-ignored after baseline/i.test(r)));
    assert.equal(delta.untrackedDeleted.includes('scratch.log'), false, 'a still-present file is not reported deleted');
    assert.ok((delta.modifiedUntrackedBaseline ?? []).includes('scratch.log'));
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pre-existing untracked file that the Worker genuinely deletes is still reported deleted', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'temp\n');
    const baseline = await captureBaseline({ cwd: dir });
    fs.rmSync(path.join(dir, 'gone.txt'));
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, true);
    assert.ok(delta.untrackedDeleted.includes('gone.txt'));
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

test('fail closed: a baseline-untracked file gone from the listing but not confirmed absent (EACCES) is not a deletion', async () => {
  const responses = {
    'rev-parse HEAD': { code: 0, stdout: 'cur0000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff --name-only base000': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: '' }, // now hidden (ignored)
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')] ?? { code: 128 };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'base000', baselineRef: 'base000', untrackedHashes: { 'scratch.log': 'digest-abc' }, evidenceComplete: true },
    spawn,
    lstat: async () => { throw eacces; },
    readFile: async () => Buffer.from(''),
  });
  assert.equal(delta.evidenceComplete, false, 'unreadable != deleted');
  assert.equal(delta.untrackedDeleted.includes('scratch.log'), false);
  assert.ok(delta.incompleteReasons.some((r) => /could not be confirmed absent/i.test(r)));
});

test('fail closed: a rename+edit of a pre-existing untracked file is not split into a clean delete+create', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'notes-old.txt'), 'PRE_EXISTING_SECRET\nline\n');
    const baseline = await captureBaseline({ cwd: dir });
    // rename + append one line -> digest differs, old path gone, new path new.
    fs.renameSync(path.join(dir, 'notes-old.txt'), path.join(dir, 'notes-new.txt'));
    fs.appendFileSync(path.join(dir, 'notes-new.txt'), 'worker line\n');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /rename\+edit cannot be distinguished/i.test(r)));
    assert.equal(delta.untrackedDeleted.includes('notes-old.txt'), false, 'not reported as a clean deletion');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a baseline-untracked file renamed+edited AND staged under the new name does not leak its pre-existing bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'draft-old.txt'), 'PRE_EXISTING_SECRET\nkeep\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal('draft-old.txt' in baseline.untrackedHashes, true);

    // rename + edit + stage the new name. `git diff <baseRef>` renders the
    // destination as a wholly-new file (baseRef has no blob for it) and the
    // untracked listing no longer shows either path.
    fs.renameSync(path.join(dir, 'draft-old.txt'), path.join(dir, 'draft-new.txt'));
    fs.appendFileSync(path.join(dir, 'draft-new.txt'), 'worker line\n');
    git('add', 'draft-new.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /rename\+edit cannot be distinguished/i.test(r)));
    assert.equal(delta.trackedChanged.includes('draft-new.txt'), false, 'not emitted as a tracked change');
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('draft-new.txt'));
    assert.equal(delta.untrackedDeleted.includes('draft-old.txt'), false, 'not a clean deletion');
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/, 'pre-existing bytes never reach the Reviewer');
    assert.doesNotMatch(delta.diff, /worker line/, 'not rendered as a whole-new-file block');

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

test('fail closed: a staged copy of a baseline-untracked file (source left in place) does not leak its bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'PRE_EXISTING_SECRET\ntoken=abc\n');
    const baseline = await captureBaseline({ cwd: dir });

    // Worker copies it to a staged new path WITHOUT deleting the original, so
    // nothing vanishes from the untracked listing.
    fs.copyFileSync(path.join(dir, 'secret.txt'), path.join(dir, 'copy.txt'));
    git('add', 'copy.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false);
    assert.ok(delta.incompleteReasons.some((r) => /byte-identical to a file that was untracked at baseline/i.test(r)));
    assert.equal(delta.trackedChanged.includes('copy.txt'), false);
    assert.ok((delta.renamedUntrackedBaseline ?? []).includes('copy.txt'));
    assert.doesNotMatch(delta.diff, /PRE_EXISTING_SECRET/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: an EDITED copy of a baseline-untracked file (source left in place) does not leak its bytes', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    const secret = Array.from({ length: 12 }, (_, i) => `SECRET_CONFIG_LINE_${i} = value-${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'config.secret'), secret);
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(baseline.untrackedContent['config.secret'], secret, 'baseline retained the text for comparison');

    // Copy, then edit (append) — digest now differs — and stage. Source stays.
    fs.writeFileSync(path.join(dir, 'config.js'), `// generated\n${secret}\nexport default {};\n`);
    git('add', 'config.js');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'fails the evidence closed');
    assert.ok(delta.incompleteReasons.some((r) => /reproduces a substantial contiguous section/i.test(r)));
    assert.equal(delta.trackedChanged.includes('config.js'), false);
    assert.doesNotMatch(delta.diff, /SECRET_CONFIG_LINE_5/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: an edited copy of a LARGE SINGLE-LINE baseline-untracked file (no newlines) does not leak', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // One long line — minified JSON shape, well over the window size, no \n.
    const blob = `{${Array.from({ length: 60 }, (_, i) => `"key_${i}":"secret-value-${i}-xxxxxxxx"`).join(',')}}`;
    assert.equal(blob.includes('\n'), false);
    fs.writeFileSync(path.join(dir, 'creds.min.json'), blob);
    const baseline = await captureBaseline({ cwd: dir });

    // Copy it into a new tracked file, change ONE byte in the middle, stage it.
    const edited = `${blob.slice(0, 400)}X${blob.slice(401)}`;
    fs.writeFileSync(path.join(dir, 'bundled-config.json'), edited);
    git('add', 'bundled-config.json');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });

    assert.equal(delta.evidenceComplete, false, 'a one-line file is compared like any other');
    assert.ok(delta.incompleteReasons.some((r) => /reproduces a substantial contiguous section/i.test(r)));
    assert.equal(delta.trackedChanged.includes('bundled-config.json'), false);
    assert.doesNotMatch(delta.diff, /secret-value-40/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a new file copying a NON-ALIGNED window-length slice of a baseline-untracked file is caught', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // Distinct characters so any 96-char slice is unambiguous.
    const secret = Array.from({ length: 500 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    fs.writeFileSync(path.join(dir, 'vault.txt'), secret);
    const baseline = await captureBaseline({ cwd: dir });

    // Copy EXACTLY 96 chars starting at baseline offset 1 (not a stride boundary)
    // into an otherwise-unrelated new file.
    const lifted = secret.slice(1, 97);
    assert.equal(lifted.length, 96);
    fs.writeFileSync(path.join(dir, 'helper.js'), `const noise = "aaaaaaaaaa";\n// ${lifted}\nmodule.exports = {};\n`);
    git('add', 'helper.js');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false, 'a 96-char non-aligned copy is still detected');
    assert.ok(delta.incompleteReasons.some((r) => /reproduces a substantial contiguous section/i.test(r)));
    assert.equal(delta.trackedChanged.includes('helper.js'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: a baseline-untracked BINARY file copied to a new text file (NUL bytes stripped) does not leak', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    // A "binary" blob: a long readable secret string with NUL bytes interleaved.
    const secretRun = Array.from({ length: 30 }, (_, i) => `EMBEDDED_SECRET_TOKEN_${i}_abcdef`).join('|');
    const withNuls = Buffer.from(secretRun.split('').join('\0'), 'latin1');
    fs.writeFileSync(path.join(dir, 'blob.bin'), withNuls);
    const baseline = await captureBaseline({ cwd: dir });
    assert.equal(baseline.evidenceComplete, true, 'a binary untracked file is still retained for comparison');

    // Worker copies the blob into a new text file with the NUL bytes removed —
    // digest differs, source stays on disk and stays "binary".
    fs.writeFileSync(path.join(dir, 'extracted.txt'), secretRun);
    git('add', 'extracted.txt');

    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, false, 'the de-NUL-ed copy is caught');
    assert.ok(delta.incompleteReasons.some((r) => /reproduces a substantial contiguous section|cannot be cleared/i.test(r)));
    assert.equal(delta.trackedChanged.includes('extracted.txt'), false);
    assert.doesNotMatch(delta.diff, /EMBEDDED_SECRET_TOKEN_15/, 'pre-existing bytes never reach the Reviewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a small coincidental overlap with a baseline-untracked file is NOT flagged', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'old.env'), 'DATABASE_URL=postgres://localhost/app\nAPI_KEY=zzzzzzzzzzzzzzzzzzzz\n');
    const baseline = await captureBaseline({ cwd: dir });
    // Shares only the short common token "DATABASE_URL=" (< 96 chars).
    fs.writeFileSync(path.join(dir, 'config.example'), 'DATABASE_URL=postgres://example/db\n');
    git('add', 'config.example');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, true);
    assert.ok(delta.trackedChanged.includes('config.example'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely new tracked file is still normal Worker output even with an unrelated baseline-untracked file present', async () => {
  const dir = initRepo();
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'scratch.notes'), 'my unrelated todo list\n- item one\n- item two\n');
    const baseline = await captureBaseline({ cwd: dir });
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    git('add', 'feature.js');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.equal(delta.evidenceComplete, true);
    assert.ok(delta.trackedChanged.includes('feature.js'));
    assert.match(delta.diff, /export const x = 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
