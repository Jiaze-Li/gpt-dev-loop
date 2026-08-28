import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatStatusLine,
  formatRoleRoster,
  createCompactStatusLogger,
  formatAdapterErrorDiagnostics,
  formatWorkflowBaselineDiagnostics,
  formatReviewEvidenceDiagnostics,
  formatWorktreeDiagnostics,
  buildWorkspaceMetadata,
  assertWorkspaceInvariants,
  establishIsolatedWorkspace,
} from '../scripts/run-agy-workflow.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { WORKFLOW_WORKTREE_ERROR_CODES } from '../src/orchestrator/workflowWorktree.js';

const SUP = 'gemini-3.7-flash-high';
const REV = 'gpt-oss-120b-medium';

test('formatStatusLine aligns role/tag/arrow', () => {
  assert.match(formatStatusLine('Supervisor', SUP, 'NEXT_TASK'), /^Supervisor\s+\[gemini-3\.7-flash-high\]\s+→ NEXT_TASK$/);
  assert.match(formatStatusLine('Gate', null, 'PASS'), /^Gate\s+→ PASS$/);
});

test('role roster names the exact model id per role, Executor is plain Claude', () => {
  const roster = formatRoleRoster({ supervisorModel: SUP, reviewerModel: REV });
  const lines = roster.split('\n');
  assert.match(lines[0], /^Supervisor\s+\[gemini-3\.7-flash-high\]/);
  assert.match(lines[1], /^Executor\s+\[Claude\]/);
  assert.match(lines[2], /^Reviewer\s+\[gpt-oss-120b-medium\]/);
});

test('reviewer failure diagnostics print only safe fields', () => {
  const err = new AdapterError(
    ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE,
    'agy exited with status 1 — agy stderr: quota exceeded',
    {
      role: 'reviewer',
      model: 'gpt-oss-120b-medium',
      agyErrorName: 'AgyExitError',
      agyCode: 'AGY_NONZERO_EXIT',
      exitCode: 1,
      stderr: 'quota exceeded for this account\ntry again later',
      durationMs: 6870,
    },
  );
  const out = formatAdapterErrorDiagnostics(err).join('\n');

  assert.match(out, /provider\s+reviewer/);
  assert.match(out, /model\s+gpt-oss-120b-medium/);
  assert.match(out, /exit code\s+1/);
  assert.match(out, /duration ms\s+6870/);
  assert.match(out, /quota exceeded for this account/);
  assert.match(out, /try again later/);

  // never leaks prompt / reply / auth material
  assert.equal(out.includes('You are the Reviewer'), false);
  assert.equal(out.toLowerCase().includes('bearer '), false);
  assert.equal(out.toLowerCase().includes('api_key'), false);
});

test('diagnostics are a no-op when the error has no structured details', () => {
  assert.deepEqual(formatAdapterErrorDiagnostics(new Error('plain')), []);
  assert.deepEqual(formatAdapterErrorDiagnostics(new AdapterError('X', 'y')), []);
});

test('diagnostics note when no stderr was captured', () => {
  const err = new AdapterError('REVIEWER_TIMEOUT', 'agy did not respond within 1000ms', {
    role: 'reviewer',
    model: 'gpt-oss-120b-medium',
    exitCode: 124,
    stderr: null,
    durationMs: null,
  });
  const out = formatAdapterErrorDiagnostics(err).join('\n');
  assert.match(out, /stderr:\s+\(none captured\)/);
  assert.equal(out.includes('duration ms'), false);
});

test('compact logger tags Supervisor and Reviewer with their own model id', () => {
  const lines = [];
  const log = createCompactStatusLogger({ supervisorModel: SUP, reviewerModel: REV, write: (s) => lines.push(s) });

  log('supervisor decision: NEXT_TASK');
  log('task selected: auto-a');                                  // dropped
  log('claude attempt started: task=auto-a attempt=1');
  log('claude attempt completed: task=auto-a attempt=1');
  log('gate result: PASS');
  log('review completed: task=auto-a attempt=1 decision=REWORK');
  log('some unrelated diagnostic line');                          // dropped

  assert.deepEqual(lines, [
    formatStatusLine('Supervisor', SUP, 'NEXT_TASK'),
    formatStatusLine('Task', 'auto-a', 'attempt 1'),
    formatStatusLine('Executor', 'Claude', 'RUNNING'),
    formatStatusLine('Executor', 'Claude', 'DONE'),
    formatStatusLine('Gate', null, 'PASS'),
    formatStatusLine('Reviewer', REV, 'REWORK'),
  ]);
  // The executor stream never carries an agy model id.
  assert.ok(!lines.some((l) => l.startsWith('Executor') && (l.includes('gemini') || l.includes('gpt-oss'))));
});

test('workflow baseline diagnostics: metadata only, never contents', () => {
  const lines = formatWorkflowBaselineDiagnostics({
    repo_root: '/repo',
    branch: 'phase1',
    head: 'deadbeefdeadbeef',
    clean: true,
    isolated_worktree: false,
  });
  const out = lines.join('\n');
  assert.match(out, /workflow baseline:/);
  assert.match(out, /branch\s+phase1/);
  assert.match(out, /head\s+deadbeefdeadbeef/);
  assert.match(out, /clean\s+true/);
});

// --- automatic isolated worktree -----------------------------------------

const WT = {
  workflow_id: 'wf-agy-abc',
  source_workspace: '/src/repo',
  source_repo_root: '/src/repo',
  repository_identity: '/src/primary/.git',
  source_branch: 'phase1-handshake',
  source_head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0',
  baseline_head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0',
  worktree_path: '/managed/repo-wf-agy-abc',
};
const CLEAN_BASELINE = {
  repo_root: WT.worktree_path,
  branch: 'HEAD',
  head: WT.baseline_head,
  clean: true,
  isolated_worktree: true,
  dirty_paths: [],
};

test('worktree diagnostics: compact, identifiers + path only, never file contents', () => {
  const lines = formatWorktreeDiagnostics({ worktree: WT });
  assert.deepEqual(lines, [
    'Repository  /src/repo',
    'Baseline    phase1-handshake@deadbeefde',
    'Workspace   isolated',
    'Worktree    /managed/repo-wf-agy-abc',
  ]);
});

test('workspace metadata records source workspace + repository identity as separate fields', () => {
  assert.deepEqual(buildWorkspaceMetadata({ worktree: WT }), {
    workflow_id: 'wf-agy-abc',
    source_workspace: '/src/repo',
    repository_identity: '/src/primary/.git',
    source_branch: 'phase1-handshake',
    source_head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0',
    isolated_worktree_path: '/managed/repo-wf-agy-abc',
  });
});

test('invariants pass when every cwd is the isolated worktree and HEAD matches the baseline', () => {
  assert.doesNotThrow(() =>
    assertWorkspaceInvariants({
      worktree: WT,
      baseline: CLEAN_BASELINE,
      claudeCwd: WT.worktree_path,
      gateCwd: WT.worktree_path,
    })
  );
});

test('invariant fails closed: Claude cwd is the source tree, not the isolated worktree', () => {
  assert.throws(
    () =>
      assertWorkspaceInvariants({
        worktree: WT,
        baseline: CLEAN_BASELINE,
        claudeCwd: '/src/repo',
        gateCwd: WT.worktree_path,
      }),
    (err) => err.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION && err.details.check === 'claude_cwd'
  );
});

test('invariant fails closed: gate/evidence cwd is the source tree', () => {
  assert.throws(
    () =>
      assertWorkspaceInvariants({
        worktree: WT,
        baseline: CLEAN_BASELINE,
        claudeCwd: WT.worktree_path,
        gateCwd: '/src/repo',
      }),
    (err) => err.details.check === 'gate_cwd'
  );
});

test('invariant fails closed: baseline HEAD does not match the captured worktree baseline', () => {
  assert.throws(
    () =>
      assertWorkspaceInvariants({
        worktree: WT,
        baseline: { ...CLEAN_BASELINE, head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' },
        claudeCwd: WT.worktree_path,
        gateCwd: WT.worktree_path,
      }),
    (err) => err.details.check === 'baseline_head'
  );
});

test('invariant fails closed: isolated worktree is not clean', () => {
  assert.throws(
    () =>
      assertWorkspaceInvariants({
        worktree: WT,
        baseline: { ...CLEAN_BASELINE, clean: false, dirty_paths: ['x'] },
        claudeCwd: WT.worktree_path,
        gateCwd: WT.worktree_path,
      }),
    (err) => err.details.check === 'clean_tree'
  );
});

test('establishIsolatedWorkspace: no manual flag/env — always isolated, Claude+gate get the worktree cwd, metadata recorded', async () => {
  const baselineCalls = [];
  const recorded = [];
  const fakeWorktree = { establish: async ({ workflowId }) => ({ ...WT, workflow_id: workflowId }) };
  const fakeBaseline = {
    establish: async (ctx) => {
      baselineCalls.push(ctx);
      return CLEAN_BASELINE;
    },
  };

  const { worktree, baseline } = await establishIsolatedWorkspace({
    sourceCwd: '/src/repo',
    workflowId: 'wf-agy-abc',
    createWorktree: () => fakeWorktree,
    createBaseline: () => fakeBaseline,
    recordMetadata: async (m) => recorded.push(m),
  });

  // The baseline is always re-established INSIDE the worktree, isolated.
  assert.deepEqual(baselineCalls, [{ cwd: WT.worktree_path, isolatedWorktree: true }]);
  assert.equal(worktree.worktree_path, WT.worktree_path);
  assert.equal(baseline, CLEAN_BASELINE);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].isolated_worktree_path, WT.worktree_path);
});

test('establishIsolatedWorkspace: worktree creation failure stops before any baseline/Claude work', async () => {
  const err = new Error('boom');
  err.code = WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED;
  let baselineCalled = false;
  await assert.rejects(
    () =>
      establishIsolatedWorkspace({
        sourceCwd: '/src/repo',
        workflowId: 'wf-agy-abc',
        createWorktree: () => ({ establish: async () => { throw err; } }),
        createBaseline: () => ({ establish: async () => { baselineCalled = true; return CLEAN_BASELINE; } }),
      }),
    (e) => e.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED
  );
  assert.equal(baselineCalled, false);
});

test('establishIsolatedWorkspace: a mismatched baseline aborts before returning (fail closed pre-Claude)', async () => {
  await assert.rejects(
    () =>
      establishIsolatedWorkspace({
        sourceCwd: '/src/repo',
        workflowId: 'wf-agy-abc',
        createWorktree: () => ({ establish: async () => WT }),
        createBaseline: () => ({ establish: async () => ({ ...CLEAN_BASELINE, head: 'mismatch00000000000000000000000000000000' }) }),
      }),
    (e) => e.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION
  );
});

test('establishIsolatedWorkspace: a pre-execution setup failure tears down the just-created worktree', async () => {
  const removed = [];
  await assert.rejects(
    () =>
      establishIsolatedWorkspace({
        sourceCwd: '/src/repo',
        workflowId: 'wf-agy-abc',
        createWorktree: () => ({
          establish: async () => WT,
          remove: async (p, opts) => removed.push({ p, opts }),
        }),
        createBaseline: () => ({ establish: async () => ({ ...CLEAN_BASELINE, head: 'mismatch00000000000000000000000000000000' }) }),
      }),
    (e) => e.code === WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION
  );
  assert.deepEqual(removed, [{ p: WT.worktree_path, opts: { force: true, sourceRepoRoot: '/src/repo' } }]);
});

test('establishIsolatedWorkspace: the success path never tears the worktree down', async () => {
  const removed = [];
  const { worktree } = await establishIsolatedWorkspace({
    sourceCwd: '/src/repo',
    workflowId: 'wf-agy-abc',
    createWorktree: () => ({
      establish: async () => WT,
      remove: async (p) => removed.push(p),
    }),
    createBaseline: () => ({ establish: async () => CLEAN_BASELINE }),
    recordMetadata: async () => {},
  });
  assert.equal(worktree.worktree_path, WT.worktree_path);
  assert.deepEqual(removed, []);
});

test('review evidence diagnostics: only counts and sizes, no diff text or file contents', () => {
  const evidence = {
    diff: 'diff --git a/work/x b/work/x\n+SECRET FILE BODY LINE\n',
    diagnostics: {
      tracked_changed_files: 2,
      untracked_task_files: 1,
      untracked_task_files_included: 1,
      diff_chars: 51,
      diff_bytes: 51,
    },
    untracked_files: [{ path: 'work/x', bytes: 20, included: true, text: 'SECRET FILE BODY LINE' }],
  };
  const out = formatReviewEvidenceDiagnostics(evidence, { promptChars: 1234, promptBytes: 1240 }).join('\n');
  assert.match(out, /review evidence:/);
  assert.match(out, /tracked changed files\s+2/);
  assert.match(out, /untracked task files\s+1 \(1 with contents\)/);
  assert.match(out, /diff chars\/bytes\s+51 \/ 51/);
  assert.match(out, /reviewer prompt chars\/bytes\s+1234 \/ 1240/);
  assert.doesNotMatch(out, /SECRET FILE BODY LINE/);
  assert.doesNotMatch(out, /diff --git/);
});
