import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGitEvidenceCollector, DIFF_STATUS } from '../src/adapters/gate/git-evidence/index.js';
import { GitEvidenceError, GIT_EVIDENCE_ERROR_CODES } from '../src/adapters/gate/git-evidence/errors.js';
import { createGptReviewerAdapter } from '../src/orchestrator/adapters/gptReviewerAdapter.js';

// Fake child_process.spawn keyed by the exact `git <args>` invocation, like
// a scripted git binary. Each entry can be { code, stdout, stderr } or
// omitted to fall back to `notFound` (spawn error, e.g. an unhandled/
// unexpected git subcommand).
function makeFakeGit(responses, { spawnError = null } = {}) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      if (spawnError) {
        child.emit('error', spawnError);
        return;
      }
      const key = args.join(' ');
      const response = responses[key];
      if (!response) {
        child.emit('error', new Error(`unscripted git invocation: git ${key}`));
        return;
      }
      if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit('data', Buffer.from(response.stderr));
      child.emit('close', response.code ?? 0);
    });

    return child;
  };
  return { spawn, calls };
}

const REPO_OK = { 'rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n' } };
const HEAD_OK = { 'rev-parse HEAD': { code: 0, stdout: 'abc123def\n' } };
// Resolved automatically by collect_evidence whenever the caller doesn't
// pass an explicit context.repositoryContext override.
const REPO_CONTEXT_OK = {
  'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main\n' },
  'remote get-url origin': { code: 0, stdout: 'https://github.com/example/gpt-dev-loop.git\n' },
};

test('git evidence collector: collects working-tree evidence via git diff HEAD when no base_commit given', async () => {
  const { spawn, calls } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 0, stdout: '--- a/foo.js\n+++ b/foo.js\n+added\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'foo.js\nbar.js\n' },
    'status --porcelain=v1': { code: 0, stdout: ' M foo.js\n?? bar.js\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  const evidence = await collector.collect_evidence({ cwd: '/repo', testResults: { pass: true, results: [{ command: 'npm test', pass: true, output: 'ok' }] } });

  assert.equal(evidence.current_commit, 'abc123def');
  assert.equal(evidence.base_commit, null);
  assert.deepEqual(evidence.changed_files, ['foo.js', 'bar.js']);
  assert.match(evidence.git_diff, /\+added/);
  assert.match(evidence.git_status, /M foo\.js/);
  assert.equal(evidence.status, DIFF_STATUS.CHANGED);
  assert.deepEqual(evidence.repository_context, {
    repository_name: 'gpt-dev-loop',
    repository_url: 'https://github.com/example/gpt-dev-loop.git',
    branch: 'main',
    commit_sha: 'abc123def',
  });
  assert.deepEqual(evidence.test_results, { pass: true, results: [{ command: 'npm test', pass: true, output: 'ok' }] });

  // Reviewer-Adapter-consumable aliases.
  assert.equal(evidence.head, 'abc123def');
  assert.equal(evidence.base, null);
  assert.equal(evidence.diff, evidence.git_diff);
  assert.deepEqual(evidence.results, [{ command: 'npm test', pass: true, output: 'ok' }]);
  assert.equal(evidence.pass, true);

  assert.ok(calls.some((c) => c === 'git diff HEAD'));
});

test('git evidence collector: uses base_commit..current_commit range when base_commit is given', async () => {
  const { spawn, calls } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff base1..abc123def': { code: 0, stdout: 'diff --git a/x b/x\n+changed\n' },
    'diff base1..abc123def --name-only': { code: 0, stdout: 'x\n' },
    'status --porcelain=v1': { code: 0, stdout: '' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  const evidence = await collector.collect_evidence({ cwd: '/repo', baseCommit: 'base1' });

  assert.equal(evidence.base_commit, 'base1');
  assert.equal(evidence.base, 'base1');
  assert.deepEqual(evidence.changed_files, ['x']);
  assert.ok(calls.includes('git diff base1..abc123def'));
});

test('git evidence collector: an explicit repositoryContext override skips branch/remote lookups', async () => {
  const { spawn, calls } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    'diff HEAD': { code: 0, stdout: '+x\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'x\n' },
    'status --porcelain=v1': { code: 0, stdout: '' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  const evidence = await collector.collect_evidence({
    cwd: '/repo',
    repositoryContext: { repository_name: 'override-repo', repository_url: 'https://example.com/override.git', branch: 'feature-x' },
  });

  assert.deepEqual(evidence.repository_context, {
    repository_name: 'override-repo',
    repository_url: 'https://example.com/override.git',
    branch: 'feature-x',
    commit_sha: 'abc123def',
  });
  assert.ok(!calls.some((c) => c.includes('abbrev-ref')));
  assert.ok(!calls.some((c) => c.includes('remote get-url')));
});

test('git evidence collector: missing git binary throws GIT_UNAVAILABLE', async () => {
  const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const { spawn } = makeFakeGit({}, { spawnError });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.ok(err instanceof GitEvidenceError);
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.GIT_UNAVAILABLE);
    return true;
  });
});

test('git evidence collector: not inside a repository throws NOT_A_REPOSITORY', async () => {
  const { spawn } = makeFakeGit({
    'rev-parse --is-inside-work-tree': { code: 128, stderr: 'fatal: not a git repository\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/not-a-repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.NOT_A_REPOSITORY);
    return true;
  });
});

test('git evidence collector: unresolvable HEAD throws NOT_A_REPOSITORY', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    'rev-parse HEAD': { code: 128, stderr: 'fatal: ambiguous argument HEAD\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.NOT_A_REPOSITORY);
    return true;
  });
});

test('git evidence collector: unresolvable branch throws DIFF_COMMAND_FAILED', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    'rev-parse --abbrev-ref HEAD': { code: 128, stderr: 'fatal: could not resolve branch\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED);
    return true;
  });
});

test('git evidence collector: a missing origin remote is not an error — repository_url falls back to null', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main\n' },
    'remote get-url origin': { code: 128, stderr: 'fatal: No such remote\n' },
    'diff HEAD': { code: 0, stdout: '+x\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'x\n' },
    'status --porcelain=v1': { code: 0, stdout: '' },
  });
  const collector = createGitEvidenceCollector({ spawn, gitBin: 'git' });

  const evidence = await collector.collect_evidence({ cwd: '/local-only-repo' });

  assert.equal(evidence.repository_context.repository_url, null);
  assert.equal(evidence.repository_context.repository_name, 'local-only-repo');
});

test('git evidence collector: a failing diff command throws DIFF_COMMAND_FAILED', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 129, stderr: 'fatal: bad revision\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED);
    return true;
  });
});

test('git evidence collector: an empty diff is a valid NO_CHANGES evidence state, not an error', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 0, stdout: '' },
    'diff HEAD --name-only': { code: 0, stdout: '' },
    'status --porcelain=v1': { code: 0, stdout: '' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  const evidence = await collector.collect_evidence({ cwd: '/repo' });

  assert.equal(evidence.status, DIFF_STATUS.NO_CHANGES);
  assert.equal(evidence.git_diff, '');
  assert.deepEqual(evidence.changed_files, []);
});

test('git evidence collector: a failing --name-only lookup throws DIFF_COMMAND_FAILED', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 0, stdout: '+something\n' },
    'diff HEAD --name-only': { code: 1, stderr: 'boom\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED);
    return true;
  });
});

test('git evidence collector: a failing status lookup throws DIFF_COMMAND_FAILED', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 0, stdout: '+something\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'foo.js\n' },
    'status --porcelain=v1': { code: 1, stderr: 'boom\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });

  await assert.rejects(() => collector.collect_evidence({ cwd: '/repo' }), (err) => {
    assert.equal(err.code, GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED);
    return true;
  });
});

test('git evidence collector output is directly consumable by the GPT Reviewer Adapter', async () => {
  const { spawn } = makeFakeGit({
    ...REPO_OK,
    ...HEAD_OK,
    ...REPO_CONTEXT_OK,
    'diff HEAD': { code: 0, stdout: '+added line\n' },
    'diff HEAD --name-only': { code: 0, stdout: 'foo.js\n' },
    'status --porcelain=v1': { code: 0, stdout: ' M foo.js\n' },
  });
  const collector = createGitEvidenceCollector({ spawn });
  const evidence = await collector.collect_evidence({
    cwd: '/repo',
    testResults: { pass: true, results: [{ command: 'npm test', pass: true, output: 'ok' }] },
  });

  let capturedPrompt;
  const reviewer = createGptReviewerAdapter({
    askGptFn: async (prompt) => {
      capturedPrompt = prompt;
      return `@@ task_id
demo-task

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop.git
branch: main
commit_sha: abc123def

@@ decision
PASS

@@ findings
- looks fine

@@ required_changes
none

@@ rationale
matches acceptance_criteria`;
    },
    config: {},
  });

  const taskCard = {
    task_id: 'demo-task',
    repository_context: evidence.repository_context,
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
  };
  const executionReport = {
    task_id: 'demo-task',
    repository_context: evidence.repository_context,
    status: 'DONE',
    changed_files: ['foo.js'],
    tests_run: ['npm test'],
    test_results: ['npm test: pass'],
    issues: 'none',
    next_recommendation: 'proceed',
  };

  const result = await reviewer.review(taskCard, executionReport, evidence);

  assert.equal(result.decision, 'PASS');
  assert.match(capturedPrompt, /head: abc123def/);
  assert.match(capturedPrompt, /\+added line/);
  assert.match(capturedPrompt, /`npm test`: pass/);
  assert.match(capturedPrompt, /Commit:\nabc123def/);
  assert.match(capturedPrompt, /diff status\nCHANGED/);
});
