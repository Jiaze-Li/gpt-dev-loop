import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { createGitEvidenceCollector } from '../src/adapters/gate/git-evidence/index.js';
import { GitEvidenceError, GIT_EVIDENCE_ERROR_CODES } from '../src/adapters/gate/git-evidence/errors.js';

// P1-3: a post-execution untracked symlink (created by the Executor/Gate
// AFTER the invocation snapshot) must never be stat()/readFile()'d — both
// follow the link and would fold the target's bytes into Reviewer evidence.
// lstat() first, fail closed with a typed GitEvidenceError.

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-p1-3-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init', '--no-verify', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}

test('P1-3. Executor creates leak -> external-secret.txt: symlink rejected, target bytes never read', async () => {
  const dir = initRepo();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-p1-3-secret-'));
  try {
    const secretFile = path.join(secretDir, 'external-secret.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET_TOKEN_ABC123');

    // Executor produces an untracked symlink after execution.
    fs.symlinkSync(secretFile, path.join(dir, 'leak'));

    let statCalls = 0;
    let readCalls = 0;
    let lstatCalls = 0;
    const collector = createGitEvidenceCollector({
      lstat: async (p) => { lstatCalls += 1; return fs.promises.lstat(p); },
      stat: async (p) => { statCalls += 1; return fs.promises.stat(p); },
      readFile: async (p) => { readCalls += 1; return fs.promises.readFile(p); },
    });

    let thrown;
    try {
      await collector.collect_evidence({ cwd: dir, baseline: { head: headSha(dir), repo_root: dir } });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof GitEvidenceError, 'collection fails closed');
    assert.equal(thrown.code, GIT_EVIDENCE_ERROR_CODES.UNTRACKED_SYMLINK_NOT_ALLOWED);
    assert.ok(lstatCalls >= 1, 'lstat was used');
    assert.equal(statCalls, 0, 'stat() on the symlink target was never called');
    assert.equal(readCalls, 0, 'readFile() on the symlink target was never called');
    assert.doesNotMatch(String(thrown.message), /TOP_SECRET_TOKEN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test('P1-3. untracked symlink pointing INSIDE the repo is rejected by the same rule', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'in-repo content');
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'inside-link'));

    const collector = createGitEvidenceCollector();
    await assert.rejects(
      collector.collect_evidence({ cwd: dir, baseline: { head: headSha(dir), repo_root: dir } }),
      (err) => {
        assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.UNTRACKED_SYMLINK_NOT_ALLOWED);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-3. a normal untracked regular text file is still folded into evidence', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'new-note.txt'), 'ordinary untracked file\n');

    const collector = createGitEvidenceCollector();
    const evidence = await collector.collect_evidence({
      cwd: dir,
      baseline: { head: headSha(dir), repo_root: dir },
    });

    const entry = evidence.untracked_files.find((f) => f.path === 'new-note.txt');
    assert.ok(entry);
    assert.equal(entry.included, true);
    assert.match(evidence.git_diff, /ordinary untracked file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-3. an untracked special filesystem object (FIFO/socket/device) fails closed', async () => {
  // git ls-files does not surface FIFOs/sockets/devices, so drive the
  // collector with a scripted git + a fake lstat reporting a FIFO for a
  // git-listed untracked path.
  const responses = {
    'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
    'rev-parse HEAD': { code: 0, stdout: 'base000\n' },
    'diff base000': { code: 0, stdout: '' },
    'diff base000 --name-only': { code: 0, stdout: '' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/pipe\0' },
    'status --porcelain=v1': { code: 0, stdout: '?? work/pipe\n' },
  };
  const spawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = responses[args.join(' ')];
      if (!r) return child.emit('error', new Error(`unscripted: git ${args.join(' ')}`));
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  const fifoFlags = {
    isSymbolicLink: () => false,
    isFile: () => false,
    isFIFO: () => true,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    size: 0,
  };
  let readCalls = 0;
  const collector = createGitEvidenceCollector({
    spawn,
    lstat: async () => fifoFlags,
    readFile: async () => { readCalls += 1; return Buffer.from(''); },
  });

  await assert.rejects(
    collector.collect_evidence({
      cwd: '/repo',
      baseline: { head: 'base000', repo_root: '/repo' },
      repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main' },
    }),
    (err) => {
      assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.UNTRACKED_SPECIAL_FILE_NOT_ALLOWED);
      return true;
    }
  );
  assert.equal(readCalls, 0);
});
