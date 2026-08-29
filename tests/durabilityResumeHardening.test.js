// Final durability / resume hardening regressions:
//  1. Authoritative durable writes fail closed (no silent swallow).
//  2. A saved REVIEW_PENDING Gate result is reused for a Reviewer-only resume
//     ONLY on an exact valid fingerprint match; null/unavailable on either
//     side, or a mismatch, routes back through fresh verification.
//  3. A same-process stop whose owner teardown exceeds the timeout does not
//     release ownership; resume stays blocked until the owner really exits.
//  4. A foreign `supergpt stop` never writes control.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import {
  DurableWriteError,
  requestStop,
  recordAdvancedBaselineHead,
  recordDeliveryCompleted,
  recordCloseoutVerificationEvidence,
  saveCheckpoint,
  claimOwner,
  readControl,
  controlPath,
} from '../src/orchestrator/workflowControl.js';

async function tmpRoot(tag) {
  return mkdtemp(path.join(os.tmpdir(), `supergpt-${tag}-`));
}

// ---------------------------------------------------------------------------
// 1. Fail-closed durable writes
// ---------------------------------------------------------------------------

test('authoritative durable writes throw DurableWriteError when persistence cannot land', async () => {
  // A regular file where the control directory should be: every tmp-write
  // under it fails with ENOTDIR.
  const notADir = path.join(await tmpRoot('faildir'), 'blocked');
  await writeFile(notADir, 'not a directory', 'utf8');
  const root = notADir;
  const workflowId = 'wf-fc';

  assert.throws(() => recordAdvancedBaselineHead({ root, workflowId, head: 'abc123' }), DurableWriteError);
  assert.throws(() => requestStop({ root, workflowId, reason: 'x' }), DurableWriteError);
  assert.throws(() => recordDeliveryCompleted({ root, workflowId, changedFiles: ['a'] }), DurableWriteError);
  assert.throws(() => saveCheckpoint({ root, workflowId }, { history: [] }), DurableWriteError);
  assert.throws(() => recordCloseoutVerificationEvidence({
    root, workflowId,
    evidence: { pass: true, worktree_fingerprint: 'fp', workflow_id: workflowId },
  }), DurableWriteError);
});

test('a verified durable write that lands is returned normally', async () => {
  const root = await tmpRoot('okwrite');
  try {
    recordAdvancedBaselineHead({ root, workflowId: 'wf-ok', head: 'deadbeef' });
    assert.equal(readControl({ root, workflowId: 'wf-ok' }).baseline_head, 'deadbeef');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. REVIEW_PENDING fingerprint fail-closed
// ---------------------------------------------------------------------------

function taskCard(id) {
  return {
    task_id: id,
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'c' },
    goal: id, context: id, scope: id,
    allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
}
const pass = (id) => ({ task_id: id, decision: 'PASS', findings: 'ok', required_changes: 'none', rationale: 'ok' });

function fakeSupervisor(decisions) {
  const queue = [...decisions];
  return {
    decideCalls: [],
    async create() { return { tabId: 501, conversationId: null }; },
    async decide(ctx) { this.decideCalls.push({ ...ctx }); return queue.shift(); },
    async close() {},
  };
}
function fakeReviewerFactory(resultsByTask) {
  const created = [];
  const f = () => {
    const s = {
      reviewCalls: 0,
      async create(id) { s.taskId = id; return { taskId: id, tabId: 601, conversationId: null }; },
      async review(id) { s.reviewCalls += 1; return resultsByTask[id].shift(); },
      async close() {},
    };
    created.push(s);
    return s;
  };
  f.created = created;
  return f;
}
function fakeExecutorFactory() {
  const managers = [];
  const f = ({ taskId }) => {
    const m = { taskId, executions: [], async execute(tc) { m.executions.push(tc.task_id); return { task_id: tc.task_id, status: 'DONE', changed_files: [] }; } };
    managers.push(m);
    return m;
  };
  f.managers = managers;
  return f;
}
const fakeGate = () => ({ async run() { return { pass: true, results: [] }; } });
function fakeWindow() {
  return {
    async create() { return { windowId: 900, initialTabId: 999 }; },
    async activateTab(t) { return { tabId: t, active: true, windowId: 900, windowFocused: false }; },
    async closeTab() {},
    async listTabs() { return []; },
    async close() {},
  };
}

function reviewPendingCheckpoint(fp) {
  return {
    history: [],
    currentTaskCard: taskCard('b'),
    currentTaskId: 'b',
    attempt: 1,
    phase: 'REVIEW_PENDING',
    executionReport: { task_id: 'b', status: 'DONE', changed_files: [] },
    gateEvidence: { pass: true, results: [] },
    worktreeFingerprint: fp,
    latestReviewResult: { task_id: 'b', decision: 'REWORK', required_changes: ['x'], findings: 'f', rationale: 'r' },
  };
}

async function runReviewPendingResume({ capturedFp, currentFp, workflowId }) {
  const exec = fakeExecutorFactory();
  const rev = fakeReviewerFactory({ b: [pass('b')] });
  const sup = fakeSupervisor([{ action: 'WORKFLOW_DONE', summary: 'done' }]);
  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('b').repository_context,
    checkpoint: reviewPendingCheckpoint(capturedFp),
    computeGateFingerprint: () => currentFp,
    maxAttemptsPerTask: 5,
  });
  return { res, exec, rev };
}

test('REVIEW_PENDING resume: exact valid fingerprint match reuses saved Gate evidence (Reviewer-only)', async () => {
  const { res, exec } = await runReviewPendingResume({ capturedFp: 'FP-1', currentFp: 'FP-1', workflowId: 'wf-rp-match' });
  assert.equal(res.status, 'WORKFLOW_DONE');
  // No Executor EXECUTION ran — the saved Executor + Gate material fed
  // straight to review (a session manager is rehydrated but never invoked).
  assert.deepEqual(exec.managers.flatMap((m) => m.executions), []);
});

test('REVIEW_PENDING resume: captured fingerprint null -> saved Gate evidence NOT reused, fresh attempt', async () => {
  const { res, exec } = await runReviewPendingResume({ capturedFp: null, currentFp: 'FP-1', workflowId: 'wf-rp-capnull' });
  assert.equal(res.status, 'WORKFLOW_DONE');
  assert.deepEqual(exec.managers.map((m) => m.taskId), ['b']);
  assert.deepEqual(exec.managers[0].executions, ['b']);
});

test('REVIEW_PENDING resume: current fingerprint null -> saved Gate evidence NOT reused, fresh attempt', async () => {
  const { res, exec } = await runReviewPendingResume({ capturedFp: 'FP-1', currentFp: null, workflowId: 'wf-rp-curnull' });
  assert.equal(res.status, 'WORKFLOW_DONE');
  assert.deepEqual(exec.managers.map((m) => m.taskId), ['b']);
});

test('REVIEW_PENDING resume: fingerprint mismatch -> fresh attempt', async () => {
  const { res, exec } = await runReviewPendingResume({ capturedFp: 'FP-1', currentFp: 'FP-2', workflowId: 'wf-rp-drift' });
  assert.equal(res.status, 'WORKFLOW_DONE');
  assert.deepEqual(exec.managers.map((m) => m.taskId), ['b']);
});

test('any checkpoint persistence failure halts the loop (not just REVIEW_PENDING)', async () => {
  const sup = fakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard('a') },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  await assert.rejects(() => runAutomatedWorkflow({
    workflowId: 'wf-cp-fail',
    supervisorSession: sup,
    createReviewerSession: fakeReviewerFactory({ a: [pass('a')] }),
    createClaudeSessionManager: fakeExecutorFactory(),
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    onCheckpoint: () => { throw new Error('disk full'); },
  }), /disk full/);
});

test('onDelivered failure aborts before worktree cleanup (no redelivery path)', async () => {
  const { deliverWorkflowResult } = await import('../src/orchestrator/resultDelivery.js');
  let cleanupCalled = false;
  const delivery = {
    async calculateApprovedDelta() { return { changedPaths: ['src/x.js'], patch: 'p' }; },
    async checkDeliveryConflicts() { return { safe: true, conflicts: [] }; },
    async deliverApprovedDelta() { /* applied to source */ },
    async cleanupDeliveredWorktree() { cleanupCalled = true; },
  };
  await assert.rejects(() => deliverWorkflowResult({
    worktree: { worktree_path: '/wt', baseline_head: 'h', source_workspace: '/src', source_repo_root: '/src' },
    delivery,
    onDelivered: () => { throw new Error('control write lost'); },
  }), /control write lost/);
  assert.equal(cleanupCalled, false, 'worktree must NOT be cleaned up after a lost DELIVERED record');
});

// ---------------------------------------------------------------------------
// 3 & 4. Stop ownership / single-writer control.json
// ---------------------------------------------------------------------------

test('a foreign supergpt stop never writes control.json', async () => {
  const { supergptStop } = await import('../src/orchestrator/supergpt.js');
  const root = await tmpRoot('foreign-stop');
  try {
    const workflowId = 'wf-foreign';
    // Owner = PID 1 (init): reliably alive, never us -> a live foreign owner.
    claimOwner({ root, workflowId, pid: 1 });
    await writeFile(path.join(root, `${workflowId}.workspace.json`), JSON.stringify({ goal: 'g' }), 'utf8');
    await writeFile(path.join(root, `${workflowId}.state.json`), JSON.stringify({ workflowId, workflowStatus: 'RUNNING', activeProcesses: [] }), 'utf8');

    const before = await readFile(controlPath({ root, workflowId }), 'utf8');
    await supergptStop({ workflowId, root, reason: 'foreign stop', waitForOwnerMs: 300, _now: (() => { let t = 0; return () => (t += 400); })(), _sleep: async () => {} });
    const after = await readFile(controlPath({ root, workflowId }), 'utf8');

    assert.equal(after, before, 'control.json must be byte-identical after a foreign stop');
    // The stop request itself is recorded in the standalone stop record.
    assert.equal(readControl({ root, workflowId }).stop.requested, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a same-process stop whose owner teardown exceeds the timeout keeps ownership and blocks resume', async () => {
  const mod = await import('../src/orchestrator/supergpt.js');
  const { supergptStop, supergptResume, __ACTIVE_WORKFLOWS_FOR_TEST } = mod;
  const root = await tmpRoot('sameproc-timeout');
  try {
    const workflowId = 'wf-sp-timeout';
    claimOwner({ root, workflowId, pid: process.pid });
    await writeFile(path.join(root, `${workflowId}.workspace.json`), JSON.stringify({ goal: 'g' }), 'utf8');
    let released = false;
    const neverSettles = new Promise((resolve) => { setTimeout(() => { released = true; resolve(); }, 10_000).unref(); });
    __ACTIVE_WORKFLOWS_FOR_TEST().set(workflowId, {
      abortController: { abort() {} },
      completionPromise: neverSettles,
    });

    const result = await supergptStop({ workflowId, root, waitForOwnerMs: 50 });
    assert.equal(result.failClosed, true);
    assert.equal(result.status, 'STOP_TIMEOUT');
    assert.equal(released, false);
    assert.ok(__ACTIVE_WORKFLOWS_FOR_TEST().has(workflowId), 'ownership entry retained');

    await assert.rejects(
      () => supergptResume({ workflowId }),
      /still shutting down|still active/,
    );
  } finally {
    __ACTIVE_WORKFLOWS_FOR_TEST().delete('wf-sp-timeout');
    await rm(root, { recursive: true, force: true });
  }
});
