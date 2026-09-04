// Persistent Model Spend Reservation — final rework: an UNRESOLVED
// reservation is an IMMEDIATE Token Safety blocking outcome for the CURRENT
// workflow, not merely a guard against the NEXT physical call. These tests
// exercise the centralized fix at the ModelSpendAuthority boundary through
// the real deterministic workflow state machine (automatedLoop.js), with
// every provider call routed through the real ModelSpendAuthority /
// ReservationLedger classes — no role-specific handling anywhere in the
// fixtures below, and no real Claude/Codex/AGY/Gemini call.
//
// REAL MODEL CALLS = 0. SUPERGPT STARTS = 0. All mock / deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { RESERVATION_STATUS } from '../src/orchestrator/modelSpendReservation.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';

function taskCard(id) {
  return {
    task_id: id,
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'c' },
    goal: id,
    context: id,
    scope: id,
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['ok'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
  };
}

function fakeSupervisor(decisions) {
  const queue = [...decisions];
  return {
    decideCalls: [],
    async create() { return { tabId: 501, conversationId: null }; },
    async decide(ctx) { this.decideCalls.push({ ...ctx }); return queue.shift(); },
    async close() {},
  };
}

function fakeWindow() {
  return {
    async create() { return { windowId: 900, initialTabId: 999 }; },
    async activateTab(t) { return { tabId: t, active: true, windowId: 900, windowFocused: false }; },
    async closeTab() {},
    async listTabs() { return []; },
    async close() {},
  };
}

// A plain (non-authority) Executor fake — Test B only needs to prove the
// REVIEWER call halts the workflow; the Executor call itself is not the
// subject under test there and must succeed normally.
function plainExecutorFactory() {
  const managers = [];
  const f = ({ taskId }) => {
    const m = { taskId, executions: [], async execute(tc) { m.executions.push(tc.task_id); return { task_id: tc.task_id, status: 'DONE', changed_files: [] }; } };
    managers.push(m);
    return m;
  };
  f.managers = managers;
  return f;
}

// An Executor fake that routes its physical call through the REAL
// ModelSpendAuthority permit/reservation contract — exactly what
// productionRoleRuntime.invoke('executor', ...) does in production, just
// without the RoleRouter/adapter-selection plumbing this test doesn't need.
function reservationBackedExecutorFactory({ spendAuthority, workflowId, businessResult }) {
  const managers = [];
  const f = ({ taskId }) => {
    const m = {
      taskId,
      executions: [],
      async execute(tc) {
        m.executions.push(tc.task_id);
        const intent = {
          role: 'executor', family: 'claude:sonnet', provider: 'claude', operationId: `${workflowId}:${tc.task_id}`, attempt: 1, workflowId,
        };
        const permit = await spendAuthority.authorize(intent);
        return spendAuthority.dispatch(permit, intent, async () => businessResult);
      },
    };
    managers.push(m);
    return m;
  };
  f.managers = managers;
  return f;
}

// Fake Gate with a call counter — Test C proves this stays at 0.
function countingGate() {
  let calls = 0;
  return {
    runCount: () => calls,
    async run() { calls += 1; return { pass: true, results: [] }; },
  };
}

// A Reviewer fake that routes its physical call through the REAL
// ModelSpendAuthority permit/reservation contract, mirroring
// productionRoleRuntime.invoke('reviewer', ...) in production.
function reservationBackedReviewerFactory({ spendAuthority, workflowId, businessResult }) {
  let reviewCalls = 0;
  const factory = () => ({
    async create() { return {}; },
    async review(taskId) {
      reviewCalls += 1;
      const intent = {
        role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy-gpt-oss', operationId: `${workflowId}:${taskId}`, attempt: 1, workflowId,
      };
      const permit = await spendAuthority.authorize(intent);
      return spendAuthority.dispatch(permit, intent, async () => businessResult);
    },
    async close() {},
  });
  factory.reviewCallCount = () => reviewCalls;
  return factory;
}

// Reviewer fake that must NEVER be called (Test C proves this).
function neverCalledReviewerFactory() {
  let reviewCalls = 0;
  const factory = () => ({
    async create() { return {}; },
    async review() { reviewCalls += 1; return { task_id: 'unreachable', decision: 'PASS', findings: 'x', required_changes: 'none', rationale: 'x' }; },
    async close() {},
  });
  factory.reviewCallCount = () => reviewCalls;
  return factory;
}

// ── Test B — a final Reviewer PASS with missing usage cannot lead to DONE ──

test('B: Reviewer PASS with missing usage immediately halts the workflow HUMAN_REQUIRED — never WORKFLOW_DONE', async () => {
  const workflowId = 'wf-halt-b';
  const spendAuthority = new ModelSpendAuthority();
  const exec = plainExecutorFactory();
  const gate = countingGate();
  // A genuinely PASSing business result — the Reviewer's own judgment is not
  // in question here — but with NO usage field at all.
  const rev = reservationBackedReviewerFactory({
    spendAuthority,
    workflowId,
    businessResult: {
      task_id: 'a', decision: 'PASS', findings: 'looks good', required_changes: 'none', rationale: 'meets acceptance criteria',
    },
  });
  const sup = fakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard('a') },
    // Deliberately only one decision queued: if the workflow incorrectly
    // continued past the unresolved Reviewer call, the Supervisor would be
    // asked a SECOND time and the fake would return `undefined`, which
    // would surface as its own (unrelated) crash rather than silently
    // producing WORKFLOW_DONE — an additional tripwire on top of the
    // decideCalls-length assertion below.
  ]);

  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.notEqual(res.status, 'WORKFLOW_DONE');

  // The reservation is durably UNRESOLVED — this is what the halt is FOR.
  const [reservation] = await spendAuthority.reservationLedger.list(workflowId);
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
  assert.equal(reservation.role, 'reviewer');

  // The Reviewer physically ran exactly once (its business PASS is real —
  // this is a spend-accounting halt, not a review-quality halt) and the
  // Supervisor was never consulted a second time to decide WORKFLOW_DONE —
  // i.e. deterministic progression toward DONE/delivery never happened.
  assert.equal(rev.reviewCallCount(), 1);
  assert.equal(sup.decideCalls.length, 1);
  assert.equal(exec.managers[0].executions.length, 1);
});

// ── Test C — Executor DONE with missing usage cannot reach Gate ────────

test('C: Executor DONE with missing usage halts before Gate/Reviewer ever run', async () => {
  const workflowId = 'wf-halt-c';
  const spendAuthority = new ModelSpendAuthority();
  const gate = countingGate();
  const rev = neverCalledReviewerFactory();
  const exec = reservationBackedExecutorFactory({
    spendAuthority,
    workflowId,
    businessResult: { task_id: 'a', status: 'DONE', changed_files: ['src/x.js'] },
  });
  const sup = fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]);

  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.equal(gate.runCount(), 0, 'the deterministic Gate must never run once the Executor call itself is unresolved');
  assert.equal(rev.reviewCallCount(), 0, 'the Reviewer must never run once the Executor call itself is unresolved');

  const [reservation] = await spendAuthority.reservationLedger.list(workflowId);
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
  assert.equal(reservation.role, 'executor');
});

// ── Test D — known-usage happy path is unaffected ───────────────────────

test('D: known-usage success continues normally end to end (regression)', async () => {
  const workflowId = 'wf-halt-d';
  const spendAuthority = new ModelSpendAuthority();
  const gate = countingGate();
  const rev = reservationBackedReviewerFactory({
    spendAuthority,
    workflowId,
    businessResult: {
      task_id: 'a', decision: 'PASS', findings: 'ok', required_changes: 'none', rationale: 'ok', usage: { input_tokens: 10, output_tokens: 5, callId: 'rev-1' },
    },
  });
  const exec = reservationBackedExecutorFactory({
    spendAuthority,
    workflowId,
    businessResult: { task_id: 'a', status: 'DONE', changed_files: ['src/x.js'], usage: { input_tokens: 20, output_tokens: 10, callId: 'exec-1' } },
  });
  const sup = fakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard('a') },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);

  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(res.status, 'WORKFLOW_DONE');
  assert.equal(gate.runCount(), 1);
  assert.equal(rev.reviewCallCount(), 1);
  const reservations = await spendAuthority.reservationLedger.list(workflowId);
  assert.ok(reservations.every((r) => r.status === RESERVATION_STATUS.SETTLED_KNOWN));
});

// ── Test E — an unknown-usage FAILURE also halts immediately, no failover ──

test('E: a Reviewer call that throws with no reliable usage halts immediately, with no retry/failover attempted', async () => {
  const workflowId = 'wf-halt-e';
  const spendAuthority = new ModelSpendAuthority();
  const gate = countingGate();
  let reviewCalls = 0;
  const rev = () => ({
    async create() { return {}; },
    async review(taskId) {
      reviewCalls += 1;
      const intent = {
        role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy-gpt-oss', operationId: `${workflowId}:${taskId}`, attempt: 1, workflowId,
      };
      const permit = await spendAuthority.authorize(intent);
      return spendAuthority.dispatch(permit, intent, async () => { throw new Error('transport failure, no usage'); });
    },
    async close() {},
  });
  const exec = plainExecutorFactory();
  const sup = fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]);

  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.equal(reviewCalls, 1, 'no retry of the same Reviewer call happened');
  const [reservation] = await spendAuthority.reservationLedger.list(workflowId);
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
});

// ── Test F — settlement persistence failure regression (unchanged) ──────

test('F: settlement persistence failure after known usage still halts HUMAN_REQUIRED, not WORKFLOW_DONE, with no retry', async () => {
  const workflowId = 'wf-halt-f';
  const store = {
    load: async () => ({}),
    save: async (wfId, reservations) => {
      const list = Object.values(reservations);
      if (list.some((r) => r.status === RESERVATION_STATUS.SETTLED_KNOWN)) throw new Error('disk full at settlement');
    },
  };
  const { ReservationLedger } = await import('../src/orchestrator/modelSpendReservation.js');
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: new ReservationLedger({ store }) });
  const gate = countingGate();
  let reviewCalls = 0;
  const rev = () => ({
    async create() { return {}; },
    async review(taskId) {
      reviewCalls += 1;
      const intent = {
        role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy-gpt-oss', operationId: `${workflowId}:${taskId}`, attempt: 1, workflowId,
      };
      const permit = await spendAuthority.authorize(intent);
      return spendAuthority.dispatch(permit, intent, async () => ({
        task_id: taskId, decision: 'PASS', findings: 'ok', required_changes: 'none', rationale: 'ok', usage: { input_tokens: 1, output_tokens: 1 },
      }));
    },
    async close() {},
  });
  const exec = plainExecutorFactory();
  const sup = fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]);

  const res = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: sup,
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    persistence: { async writeState() {} },
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.notEqual(res.status, 'WORKFLOW_DONE');
  assert.equal(reviewCalls, 1, 'no failover / retry after a settlement persistence failure');
  assert.equal(res.reason.includes(AUTHORIZATION_ERROR_CODES.MODEL_SPEND_SETTLEMENT_PERSIST_FAILED) || /settlement/i.test(res.reason), true);
});
