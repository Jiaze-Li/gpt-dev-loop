// Deterministic proof for Codex finding #5: advancing a task baseline must
// distinguish an expected clean-tree no-op from a real git failure, and a
// real failure must surface (typed) instead of silently leaving the old
// baseline in place — otherwise the next task's evidence includes prior
// accepted task changes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceTaskBaseline, TaskBaselineError } from '../src/orchestrator/taskBaseline.js';
import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';

function scriptedExec(steps) {
  // steps: array of { match: (args)=>bool, result } consumed in order-independent
  // match; falls through to a default.
  const calls = [];
  return {
    calls,
    exec: async (args) => {
      calls.push(args.join(' '));
      for (const s of steps) {
        if (s.match(args)) return s.result;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('clean tree is a tolerated no-op: baseline is not advanced', async () => {
  const baseline = { head: 'OLD' };
  const { exec } = scriptedExec([
    { match: (a) => a[0] === 'status', result: { code: 0, stdout: '', stderr: '' } },
  ]);
  const out = await advanceTaskBaseline({ repoRoot: '/r', taskId: 't1', baseline, exec });
  assert.deepEqual(out, { advanced: false, reason: 'clean-tree' });
  assert.equal(baseline.head, 'OLD');
});

test('real changes: baseline advances to the new commit', async () => {
  const baseline = { head: 'OLD' };
  const { exec, calls } = scriptedExec([
    { match: (a) => a[0] === 'status', result: { code: 0, stdout: ' M src/x.js\n', stderr: '' } },
    { match: (a) => a[0] === 'rev-parse', result: { code: 0, stdout: 'NEWHEAD\n', stderr: '' } },
  ]);
  const out = await advanceTaskBaseline({ repoRoot: '/r', taskId: 't2', baseline, exec });
  assert.equal(out.advanced, true);
  assert.equal(out.head, 'NEWHEAD');
  assert.equal(baseline.head, 'NEWHEAD');
  assert.ok(calls.includes('add -A'));
  assert.ok(calls.some((c) => c.startsWith('commit -m')));
});

test('a rejecting pre-commit hook is a typed failure, not a clean-tree no-op', async () => {
  const baseline = { head: 'OLD' };
  const { exec } = scriptedExec([
    { match: (a) => a[0] === 'status', result: { code: 0, stdout: ' M src/x.js\n', stderr: '' } },
    { match: (a) => a[0] === 'add', result: { code: 0, stdout: '', stderr: '' } },
    { match: (a) => a[0] === 'commit', result: { code: 1, stdout: '', stderr: 'pre-commit hook rejected the commit' } },
  ]);
  await assert.rejects(
    () => advanceTaskBaseline({ repoRoot: '/r', taskId: 't3', baseline, exec }),
    (err) => {
      assert.ok(err instanceof TaskBaselineError);
      assert.equal(err.code, 'TASK_BASELINE_COMMIT_FAILED');
      assert.match(err.message, /pre-commit hook rejected/);
      return true;
    },
  );
  // The stale baseline was NOT advanced — so the caller must halt rather than
  // let the next task's evidence absorb this task's changes.
  assert.equal(baseline.head, 'OLD');
});

test('a git add failure also surfaces as a typed failure', async () => {
  const baseline = { head: 'OLD' };
  const { exec } = scriptedExec([
    { match: (a) => a[0] === 'status', result: { code: 0, stdout: '?? new.js\n', stderr: '' } },
    { match: (a) => a[0] === 'add', result: { code: 128, stdout: '', stderr: 'fatal: unable to write' } },
  ]);
  await assert.rejects(() => advanceTaskBaseline({ repoRoot: '/r', taskId: 't4', baseline, exec }), TaskBaselineError);
  assert.equal(baseline.head, 'OLD');
});

test('a baseline-advance failure aborts the automated loop instead of being swallowed', async () => {
  const tc = {
    task_id: 'task-1',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'c' },
    goal: 'g', context: 'g', scope: 'g', allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
  const supervisor = {
    async create() { return { tabId: 501 }; },
    async decide() { return { action: 'NEXT_TASK', task_card: tc }; },
    async close() {},
  };
  const createReviewerSession = () => ({
    async create(id) { this.taskId = id; return { taskId: id, tabId: 601 }; },
    async review() { return { task_id: 'task-1', decision: 'PASS', findings: 'ok', required_changes: 'none', rationale: 'ok' }; },
    async close() {},
  });
  const createClaudeSessionManager = () => ({ async execute() { return { task_id: 'task-1', status: 'DONE', changed_files: [] }; } });
  const windowSession = {
    async create() { return { windowId: 900, initialTabId: 999 }; },
    async activateTab(t) { return { tabId: t, active: true, windowId: 900, windowFocused: false }; },
    async closeTab() {}, async listTabs() { return []; }, async close() {},
  };

  const res = await runAutomatedWorkflow({
    workflowId: 'wf-bl',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner: { async run() { return { pass: true, results: [] }; } },
    windowSession,
    workflowGoal: 'g',
    repositoryContext: tc.repository_context,
    onTaskCompleted: async () => { throw new TaskBaselineError('git commit failed for task "task-1": disk full', { taskId: 'task-1' }); },
  }).then((r) => ({ ok: r }), (e) => ({ err: e }));

  assert.ok(res.err, 'the loop rejected instead of swallowing the baseline failure');
  assert.match(res.err.message, /git commit failed/);
});
