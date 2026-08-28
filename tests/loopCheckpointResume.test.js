// Deterministic proof for Codex finding #1: a resumable workflow persists and
// restores enough loop state to continue from the exact suspension point —
// accepted tasks are never repeated, a delivery-blocked resume never re-runs
// Executor/Reviewer, and task/attempt chronology stays stable.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import {
  saveCheckpoint,
  markDeliveryReady,
  readControl,
  clearControl,
} from '../src/orchestrator/workflowControl.js';
import { shouldResumeFromDelivery } from '../src/orchestrator/supergpt.js';

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
    async decide(ctx) { this.decideCalls.push({ ...ctx, history: [...(ctx.history || [])] }); return queue.shift(); },
    async close() {},
  };
}
function fakeReviewerFactory(resultsByTask) {
  const created = [];
  const f = () => {
    const s = { taskId: null, reviewCalls: 0,
      async create(id) { s.taskId = id; return { taskId: id, tabId: 601, conversationId: null }; },
      async review(id) { s.reviewCalls += 1; return resultsByTask[id].shift(); },
      async close() {} };
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

test('accepted tasks are not repeated after resume, and chronology stays stable', async () => {
  // Run 1: tasks a, b accepted, then suspended (HUMAN_REQUIRED).
  let captured = null;
  const sup1 = fakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard('a') },
    { action: 'NEXT_TASK', task_card: taskCard('b') },
    { action: 'HUMAN_REQUIRED', reason: 'need a human', question: 'q?' },
  ]);
  const exec1 = fakeExecutorFactory();
  const res1 = await runAutomatedWorkflow({
    workflowId: 'wf-cp',
    supervisorSession: sup1,
    createReviewerSession: fakeReviewerFactory({ a: [pass('a')], b: [pass('b')] }),
    createClaudeSessionManager: exec1,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    onCheckpoint: (cp) => { captured = cp; },
  });
  assert.equal(res1.status, 'HUMAN_REQUIRED');
  assert.deepEqual(exec1.managers.map((m) => m.taskId), ['a', 'b']);
  assert.deepEqual(captured.history.map((h) => h.task_id), ['a', 'b']);

  // Run 2: resume with the captured checkpoint. Only task c should execute.
  const sup2 = fakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard('c') },
    { action: 'WORKFLOW_DONE', summary: 'all three done' },
  ]);
  const exec2 = fakeExecutorFactory();
  const rev2 = fakeReviewerFactory({ c: [pass('c')] });
  const res2 = await runAutomatedWorkflow({
    workflowId: 'wf-cp',
    supervisorSession: sup2,
    createReviewerSession: rev2,
    createClaudeSessionManager: exec2,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('c').repository_context,
    checkpoint: captured,
  });

  assert.equal(res2.status, 'WORKFLOW_DONE');
  // Executor ran ONLY for task c on resume — a and b were never re-executed.
  assert.deepEqual(exec2.managers.map((m) => m.taskId), ['c']);
  assert.deepEqual(exec2.managers[0].executions, ['c']);
  // The Supervisor was handed the restored history so it continued, not restarted.
  assert.deepEqual(sup2.decideCalls[0].history.map((h) => h.task_id), ['a', 'b']);
  // Final chronology is stable: a, b, then c — in order, each once.
  assert.deepEqual(res2.history.map((h) => h.task_id), ['a', 'b', 'c']);
});

test('a fully-accepted checkpoint + WORKFLOW_DONE re-runs no Executor or Reviewer', async () => {
  const checkpoint = {
    history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }, { task_id: 'b', decision: 'PASS', attempts: 2 }],
    currentTaskCard: null,
    attempt: 0,
    latestReviewResult: null,
  };
  const sup = fakeSupervisor([{ action: 'WORKFLOW_DONE', summary: 'nothing left but delivery' }]);
  const exec = fakeExecutorFactory();
  const rev = fakeReviewerFactory({});
  const res = await runAutomatedWorkflow({
    workflowId: 'wf-cp2',
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    checkpoint,
  });
  assert.equal(res.status, 'WORKFLOW_DONE');
  assert.equal(exec.managers.length, 0, 'no Executor session created on a delivery-only resume');
  assert.equal(rev.created.length, 0, 'no Reviewer session created on a delivery-only resume');
  assert.deepEqual(res.history.map((h) => h.task_id), ['a', 'b']);
});

test('a mid-flight REWORK checkpoint resumes that task without touching accepted tasks', async () => {
  const checkpoint = {
    history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }],
    currentTaskCard: taskCard('b'),
    attempt: 1,
    latestReviewResult: { task_id: 'b', decision: 'REWORK', required_changes: ['fix'], findings: 'x', rationale: 'y' },
  };
  const sup = fakeSupervisor([
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const exec = fakeExecutorFactory();
  const res = await runAutomatedWorkflow({
    workflowId: 'wf-cp3',
    supervisorSession: sup,
    createReviewerSession: fakeReviewerFactory({ b: [pass('b')] }),
    createClaudeSessionManager: exec,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('b').repository_context,
    checkpoint,
    maxAttemptsPerTask: 5,
  });
  assert.equal(res.status, 'WORKFLOW_DONE');
  // Only task b re-executed (one rework attempt); task a untouched.
  assert.deepEqual(exec.managers.map((m) => m.taskId), ['b']);
  assert.deepEqual(res.history.map((h) => h.task_id), ['a', 'b']);
});

test('delivery-ready control marker routes resume straight to delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-cp-'));
  try {
    saveCheckpoint({ root, workflowId: 'wf-d' }, { history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }] });
    assert.equal(shouldResumeFromDelivery(readControl({ root, workflowId: 'wf-d' })), false);

    markDeliveryReady({ root, workflowId: 'wf-d', summary: 'engineering complete' });
    const control = readControl({ root, workflowId: 'wf-d' });
    assert.equal(shouldResumeFromDelivery(control), true);
    assert.equal(control.summary, 'engineering complete');
    assert.equal(control.resumable, true);

    clearControl({ root, workflowId: 'wf-d' });
    assert.equal(readControl({ root, workflowId: 'wf-d' }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
