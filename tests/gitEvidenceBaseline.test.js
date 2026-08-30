import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGitEvidenceCollector, DIFF_STATUS } from '../src/adapters/gate/git-evidence/index.js';
import { renderReviewInputs } from '../src/orchestrator/adapters/agyReviewerProvider.js';

function makeFakeGit(responses) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
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

// In-memory fs for untracked-file reads. Keys are absolute paths.
function makeFakeFs(files) {
  const typeFlags = (type) => ({
    isSymbolicLink: () => type === 'symlink',
    isFile: () => type === undefined || type === 'file',
    isFIFO: () => type === 'fifo',
    isSocket: () => type === 'socket',
    isBlockDevice: () => type === 'block',
    isCharacterDevice: () => type === 'char',
    isDirectory: () => type === 'dir',
  });
  return {
    async lstat(p) {
      const entry = files[p];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: entry.size ?? entry.buffer?.length ?? 0, ...typeFlags(entry.type) };
    },
    async stat(p) {
      const entry = files[p];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: entry.size ?? entry.buffer.length, ...typeFlags(entry.type === 'symlink' ? 'file' : entry.type) };
    },
    async readFile(p) {
      const entry = files[p];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entry.buffer;
    },
  };
}

const BASELINE = { repo_root: '/repo', branch: 'phase1', head: 'base000', clean: true, isolated_worktree: false };
const REPO_CTX = { repository_name: 'gpt-dev-loop', repository_url: null, branch: 'phase1' };
const REPO_HEAD = {
  'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' },
  'rev-parse HEAD': { code: 0, stdout: 'base000\n' },
};

function collector(responses, files = {}) {
  const { spawn, calls } = makeFakeGit(responses);
  const fs = makeFakeFs(files);
  return { collector: createGitEvidenceCollector({ spawn, readFile: fs.readFile, stat: fs.stat, lstat: fs.lstat }), calls };
}

test('clean baseline + modified tracked file: diff is taken against baseline.head, no untracked files', async () => {
  const { collector: c, calls } = collector({
    ...REPO_HEAD,
    'diff base000': { code: 0, stdout: 'diff --git a/src/x.js b/src/x.js\n@@\n+tracked change\n' },
    'diff base000 --name-only': { code: 0, stdout: 'src/x.js\n' },
    'ls-files --others --exclude-standard -z': { code: 0, stdout: '' },
    'status --porcelain=v1': { code: 0, stdout: ' M src/x.js\n' },
  });

  const evidence = await c.collect_evidence({ cwd: '/repo', baseline: BASELINE, repositoryContext: REPO_CTX });

  assert.ok(calls.includes('git diff base000'));
  assert.ok(!calls.some((call) => call === 'git diff HEAD'));
  assert.equal(evidence.status, DIFF_STATUS.CHANGED);
  assert.deepEqual(evidence.changed_files, ['src/x.js']);
  assert.deepEqual(evidence.untracked_files, []);
  assert.match(evidence.diff, /\+tracked change/);
  assert.equal(evidence.diagnostics.tracked_changed_files, 1);
  assert.equal(evidence.diagnostics.untracked_task_files, 0);
});

test('clean baseline + new untracked file: path + full text contents are folded into the evidence', async () => {
  const { collector: c } = collector(
    {
      ...REPO_HEAD,
      'diff base000': { code: 0, stdout: '' },
      'diff base000 --name-only': { code: 0, stdout: '' },
      'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/agy-e2e.txt\0' },
      'status --porcelain=v1': { code: 0, stdout: '?? work/agy-e2e.txt\n' },
    },
    { '/repo/work/agy-e2e.txt': { buffer: Buffer.from('agy-e2e-ok\n') } }
  );

  const evidence = await c.collect_evidence({ cwd: '/repo', baseline: BASELINE, repositoryContext: REPO_CTX });

  assert.equal(evidence.status, DIFF_STATUS.CHANGED);
  assert.deepEqual(evidence.changed_files, ['work/agy-e2e.txt']);
  assert.equal(evidence.untracked_files.length, 1);
  assert.equal(evidence.untracked_files[0].path, 'work/agy-e2e.txt');
  assert.equal(evidence.untracked_files[0].included, true);
  assert.equal(evidence.untracked_files[0].text, 'agy-e2e-ok\n');
  assert.match(evidence.diff, /work\/agy-e2e\.txt/);
  assert.match(evidence.diff, /\+agy-e2e-ok/);
  assert.equal(evidence.diagnostics.untracked_task_files_included, 1);
});

test('clean baseline + tracked and untracked together', async () => {
  const { collector: c } = collector(
    {
      ...REPO_HEAD,
      'diff base000': { code: 0, stdout: 'diff --git a/README.md b/README.md\n+docs\n' },
      'diff base000 --name-only': { code: 0, stdout: 'README.md\n' },
      'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/new.txt\0' },
      'status --porcelain=v1': { code: 0, stdout: ' M README.md\n?? work/new.txt\n' },
    },
    { '/repo/work/new.txt': { buffer: Buffer.from('hello') } }
  );

  const evidence = await c.collect_evidence({ cwd: '/repo', baseline: BASELINE, repositoryContext: REPO_CTX });

  assert.deepEqual(evidence.changed_files, ['README.md', 'work/new.txt']);
  assert.match(evidence.diff, /\+docs/);
  assert.match(evidence.diff, /\+hello/);
  assert.equal(evidence.diagnostics.tracked_changed_files, 1);
  assert.equal(evidence.diagnostics.untracked_task_files, 1);
});

test('Reviewer payload contains the task-produced file and excludes unrelated pre-existing changes', async () => {
  // The scripted `git diff base000` returns ONLY the task change — this is
  // what a clean baseline guarantees: unrelated worktree dirt from
  // development (extension/, tests/, …) is NOT in a diff against the
  // pre-task commit, and the collector never runs a bare `git diff HEAD`.
  const { collector: c } = collector(
    {
      ...REPO_HEAD,
      'diff base000': { code: 0, stdout: '' },
      'diff base000 --name-only': { code: 0, stdout: '' },
      'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/agy-e2e.txt\0' },
      'status --porcelain=v1': { code: 0, stdout: '?? work/agy-e2e.txt\n M extension/background.js\n' },
    },
    { '/repo/work/agy-e2e.txt': { buffer: Buffer.from('agy-e2e-ok\n') } }
  );

  const evidence = await c.collect_evidence({ cwd: '/repo', baseline: BASELINE, repositoryContext: REPO_CTX });
  const taskCard = { repository_context: REPO_CTX, goal: 'g', context: 'c', scope: 's', allowed_files: ['work/**'], forbidden_files: [], acceptance_criteria: ['work/agy-e2e.txt exists'], verification_commands: ['test -f work/agy-e2e.txt'], task_id: 't', completion_signal: 'DONE' };
  const executionReport = { task_id: 't', repository_context: REPO_CTX, status: 'DONE', changed_files: ['work/agy-e2e.txt'], tests_run: [], test_results: [], issues: 'none', next_recommendation: 'review' };

  const rendered = renderReviewInputs(taskCard, executionReport, evidence);

  assert.match(rendered, /work\/agy-e2e\.txt/);
  assert.match(rendered, /agy-e2e-ok/);
  assert.doesNotMatch(rendered, /extension\/background\.js/);
});

test('oversized untracked file: safe metadata only, no contents, no throw', async () => {
  const { collector: c } = collector(
    {
      ...REPO_HEAD,
      'diff base000': { code: 0, stdout: '' },
      'diff base000 --name-only': { code: 0, stdout: '' },
      'ls-files --others --exclude-standard -z': { code: 0, stdout: 'work/big.bin\0work/pic.png\0' },
      'status --porcelain=v1': { code: 0, stdout: '?? work/big.bin\n?? work/pic.png\n' },
    },
    {
      '/repo/work/big.bin': { size: 5_000_000, buffer: Buffer.alloc(0) },
      '/repo/work/pic.png': { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01, 0x02]) },
    }
  );

  const evidence = await c.collect_evidence({ cwd: '/repo', baseline: BASELINE, repositoryContext: REPO_CTX });

  const big = evidence.untracked_files.find((f) => f.path === 'work/big.bin');
  const pic = evidence.untracked_files.find((f) => f.path === 'work/pic.png');
  assert.equal(big.included, false);
  assert.equal(big.reason, 'oversized');
  assert.equal(big.bytes, 5_000_000);
  assert.equal('text' in big, false);
  assert.equal(pic.included, false);
  assert.equal(pic.reason, 'binary');
  assert.equal('text' in pic, false);
  assert.match(evidence.diff, /contents omitted from evidence/);
  assert.doesNotMatch(evidence.diff, / /);
});

test('no baseline given: legacy `git diff HEAD` behavior is unchanged and no untracked collection happens', async () => {
  const { collector: c, calls } = collector({
    ...REPO_HEAD,
    'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'phase1\n' },
    'remote get-url origin': { code: 128, stderr: 'no remote\n' },
    'diff HEAD': { code: 0, stdout: '+legacy\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'a.js\n' },
    'status --porcelain=v1': { code: 0, stdout: ' M a.js\n' },
  });

  const evidence = await c.collect_evidence({ cwd: '/repo' });
  assert.ok(calls.includes('git diff HEAD'));
  assert.ok(!calls.some((call) => call.includes('ls-files')));
  assert.equal(evidence.untracked_files.length, 0);
  assert.equal(evidence.baseline, null);
});
