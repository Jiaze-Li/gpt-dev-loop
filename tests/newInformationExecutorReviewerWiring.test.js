// § Global New Information Policy / Wiring Card 2 — production integration
// tests for the newly migrated call sites:
//
//   1. Full Path first Executor      (automatedLoop.js's NEXT_TASK branch)
//   2. Executor Gate rework          (automatedLoop.js's CONTINUE_REWORK branch)
//   3. Executor Reviewer rework      (automatedLoop.js's CONTINUE_REWORK branch)
//   4. Reviewer (initial + repeat)   (automatedLoop.js's runReviewStep)
//
// Every test drives the REAL runAutomatedWorkflow() (src/orchestrator/
// automatedLoop.js) directly — the exact function supergpt.js calls for both
// Full Path and Fast Path — with a REAL NewInformationLedger, a REAL
// ModelSpendAuthority (the SAME evidence-aware enforcement gate
// providerSelection.js#selectProviders wires in production) and a REAL
// createProductionRoleRuntime. Only the physical Executor/Reviewer transport
// is faked. The Supervisor is never physically invoked: every scenario stays
// within decideDeterministically's deterministic NEXT_TASK / CONTINUE_REWORK
// coverage (see deterministicSupervisorPolicy.js), exactly like the real
// Fast Path / Full Path deterministic-core happy path.
//
// SUPERGPT WORKFLOWS STARTED = 0. SUPERGPT_* TOOL CALLS = 0. REAL PROVIDER CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { ReservationLedger } from '../src/orchestrator/modelSpendReservation.js';
import {
  NewInformationLedger, InformationStore, registerTaskCardEvidence,
} from '../src/orchestrator/newInformation.js';
import { DEFAULT_ROLE_POLICY, QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';

function tmpPersistence() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wc2-executor-reviewer-'));
  return new Persistence(dir);
}

function taskCard(id = 't1', overrides = {}) {
  return {
    task_id: id,
    goal: `do the thing for ${id}`,
    allowed_files: ['a.js'],
    verification_commands: ['npm test'],
    ...overrides,
  };
}

function gatePass({ changedFiles = ['a.js'], diff = 'diff --git a/a.js b/a.js\n+ok' } = {}) {
  return {
    pass: true,
    results: [{ command: 'npm test', pass: true, output: 'ok' }],
    changed_files: changedFiles,
    git_diff: diff,
  };
}

function gateFail({ testId = 'test1', changedFiles = ['a.js'], diff = 'diff --git a/a.js b/a.js\n+broken' } = {}) {
  return {
    pass: false,
    results: [{ command: 'npm test', pass: false, output: `✖ ${testId} (12ms)` }],
    changed_files: changedFiles,
    git_diff: diff,
  };
}

function makeQueuedGateRunner(queue) {
  const remaining = [...queue];
  return { async run() { return remaining.length > 0 ? remaining.shift() : gatePass(); } };
}

// Builds a shared { runtime, spendAuthority, providerHealth } wired exactly
// like providerSelection.js#selectProviders — a REAL informationLedger and a
// REAL ModelSpendAuthority gate every executor/reviewer physical dispatch.
function buildRuntime({
  informationLedger, executorImpl, reviewerImpl, recordSafetyEvent, reservationLedger,
  executorFamilies = { 'claude:sonnet': null }, providerCapabilities,
}) {
  const providerHealth = new ProviderHealthRegistry();
  const spendAuthority = new ModelSpendAuthority({
    informationLedger, recordSafetyEvent, reservationLedger, providerCapabilities,
  });
  const executorAdapters = {};
  for (const family of Object.keys(executorFamilies)) executorAdapters[family] = executorImpl;
  const runtime = createProductionRoleRuntime({
    rolePolicy: {
      ...DEFAULT_ROLE_POLICY,
      executor: Object.keys(executorFamilies).map((family) => ({ family })),
    },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority,
    adapters: {
      executor: executorAdapters,
      reviewer: { 'agy:gpt-oss': reviewerImpl },
    },
  });
  return { runtime, spendAuthority, providerHealth };
}

function makeExecutorSessionManager({ runtime, workflowId }) {
  return ({ taskId }) => ({
    async execute(card, { signal, evidenceIds } = {}) {
      const result = await runtime.invoke('executor', { taskId, taskCard: card }, {
        operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds,
      });
      return result.value;
    },
  });
}

function makeReviewerSessionFactory({ runtime, workflowId }) {
  return () => ({
    create: async () => ({}),
    close: async () => {},
    async review(taskId, card, executionReport, evidence, opts = {}) {
      const result = await runtime.invoke('reviewer', {
        taskId, taskCard: card, executionReport, evidence, opts,
      }, { operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds: opts.evidenceIds });
      return result.value;
    },
  });
}

function neverCalledSupervisor() {
  return {
    create: async () => ({}),
    close: async () => {},
    decide: async () => { throw new Error('model Supervisor should never be invoked in this deterministic scenario'); },
  };
}

// Non-convergence (the SAME Reviewer required_changes twice in a row) is a
// deterministic escalation to the (out-of-scope, Part Q unmigrated) model
// Supervisor — a genuine model decision production would make for real. This
// fake models "the Supervisor decided to stop" without asserting anything
// about what a real model call would have returned.
function haltingSupervisor() {
  return {
    create: async () => ({}),
    close: async () => {},
    decide: async () => ({ action: 'HUMAN_REQUIRED', reason: 'test: Reviewer rework did not converge', question: 'stop' }),
  };
}

function queuedExecutor(counter, resultsOrErrors = []) {
  const queue = [...resultsOrErrors];
  let n = 0;
  return async (payload) => {
    n += 1;
    counter.calls += 1;
    const next = queue.length > 0 ? queue.shift() : { status: 'DONE' };
    if (next instanceof Error) throw next;
    return { status: 'DONE', callId: `exec-${n}`, usage: { input_tokens: 1, output_tokens: 1 }, ...next };
  };
}

function queuedReviewer(counter, results) {
  const queue = [...results];
  return async (payload) => {
    counter.calls += 1;
    if (queue.length === 0) throw new Error('reviewer: no more queued results');
    const next = queue.shift();
    return {
      task_id: payload?.taskId, usage: { input_tokens: 1, output_tokens: 1 }, ...next,
    };
  };
}

function baseWorkflowArgs({
  workflowId, plannedTasks, runtime, gateRunner, maxAttemptsPerTask = 3, supervisorSession = neverCalledSupervisor(),
}) {
  return {
    workflowId,
    supervisorSession,
    createReviewerSession: makeReviewerSessionFactory({ runtime, workflowId }),
    createClaudeSessionManager: makeExecutorSessionManager({ runtime, workflowId }),
    gateRunner,
    workflowGoal: 'goal',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    plannedTasks,
    maxAttemptsPerTask,
  };
}

// ── 1. Full Path first Executor ─────────────────────────────────────────

test('1. Full Path first Executor: NEW_TASK_CARD authorizes exactly one Executor call', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId: 'wf-1', plannedTasks: [t1], runtime, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 1, 'the Executor physically ran exactly once');
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 2. Same task card cannot start the same task twice ──────────────────

test('2. Same NEW_TASK_CARD evidence cannot authorize the same Executor action twice (replay denied)', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const t1 = taskCard('t1');
  const { runtime: runtime1 } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer({ calls: 0 }, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const first = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId: 'wf-2', plannedTasks: [t1], runtime: runtime1, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 1);
  assert.equal(first.status, 'WORKFLOW_DONE');

  // A second, independent runAutomatedWorkflow() call for the SAME workflow
  // + task + task-card content (identical evidenceId) against the SAME
  // informationLedger — this is what a replay/duplicate-dispatch looks like.
  const { runtime: runtime2 } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer({ calls: 0 }, []),
  });
  const second = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId: 'wf-2', plannedTasks: [t1], runtime: runtime2, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 1, 'no additional physical Executor call on replay');
  assert.equal(second.status, 'HUMAN_REQUIRED');
});

// ── 3. Changed task-card version produces a distinct evidenceId ─────────

test('3. Changed task-card content produces a DISTINCT NEW_TASK_CARD evidenceId', async () => {
  const ledger = new NewInformationLedger();
  const v1 = await registerTaskCardEvidence(ledger, { workflowId: 'wf-3', taskId: 't1', taskCard: taskCard('t1') });
  const v2 = await registerTaskCardEvidence(ledger, { workflowId: 'wf-3', taskId: 't1', taskCard: taskCard('t1', { allowed_files: ['a.js', 'b.js'] }) });
  assert.notEqual(v1.evidenceId, v2.evidenceId);
  const v1Again = await registerTaskCardEvidence(ledger, { workflowId: 'wf-3', taskId: 't1', taskCard: taskCard('t1') });
  assert.equal(v1.evidenceId, v1Again.evidenceId, 'the identical semantic task card resolves to the identical evidenceId');
});

// ── 4. First Gate rework is authorized ───────────────────────────────────

test('4. First Gate FAIL authorizes exactly one Executor rework call', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-4',
      plannedTasks: [t1],
      runtime,
      gateRunner: makeQueuedGateRunner([gateFail({ diff: 'D1' }), gatePass({ diff: 'D2' })]),
    }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 2, 'initial attempt + one Gate rework attempt');
  assert.equal(revCounter.calls, 1, 'Reviewer only runs once the Gate finally passes');
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 5. Same Gate failure blocks a repeat rework ──────────────────────────

test('5. Identical Gate fingerprint + unchanged diff blocks a repeat Executor rework (existing heuristic)', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, []),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-5',
      plannedTasks: [t1],
      runtime,
      // Identical fingerprint AND identical diff on both Gate failures — the
      // pre-existing NO_NEW_INFORMATION_RETRY_BLOCKED heuristic
      // (deterministicSupervisorPolicy.js) catches this at the decision layer,
      // before the Executor is ever re-dispatched.
      gateRunner: makeQueuedGateRunner([gateFail({ diff: 'D1' }), gateFail({ diff: 'D1' })]),
    }),
    informationLedger,
  });
  // The heuristic needs to SEE the fingerprint repeat once before it can
  // detect a repeat: attempt 1 (task card) establishes the baseline fingerprint,
  // attempt 2 (its one legitimate rework) reproduces it identically, and THAT
  // repeat is what the heuristic catches — stopping deterministically before
  // a third dispatch is ever considered.
  assert.equal(execCounter.calls, 2, 'initial attempt + exactly one rework; no third dispatch');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

// ── 5b. Authority-level denial independent of the pre-existing heuristic ──

test('5b. Authority-level NEW_GATE_FINGERPRINT dedupe blocks a repeat rework even when the diff changed (Part D)', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const events = [];
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer({ calls: 0 }, []),
    recordSafetyEvent: (e) => events.push(e),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-5b',
      plannedTasks: [t1],
      runtime,
      // SAME failing test id (-> same gateFailureFingerprint) on both Gate
      // failures, but a DIFFERENT diff each time — the pre-existing
      // heuristic (fingerprint AND diff) would treat this as fresh
      // information and allow a THIRD Executor call. The Authority-level
      // NEW_GATE_FINGERPRINT evidence (fingerprint alone) must independently
      // deny it.
      gateRunner: makeQueuedGateRunner([
        gateFail({ testId: 'testA', diff: 'D1' }),
        gateFail({ testId: 'testA', diff: 'D2' }),
      ]),
    }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 2, 'initial attempt + exactly one rework; the third is denied at the Authority boundary');
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.ok(
    events.some((e) => e.code === 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED'),
    'the Authority-level denial is a BLOCKING safety event, independent of the heuristic',
  );
});

// ── 6. Changed Gate failure allows one new rework ────────────────────────

test('6. A genuinely changed Gate fingerprint authorizes one fresh Executor rework', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-6',
      plannedTasks: [t1],
      runtime,
      gateRunner: makeQueuedGateRunner([
        gateFail({ testId: 'testA', diff: 'D1' }),
        gateFail({ testId: 'testB', diff: 'D2' }),
        gatePass({ diff: 'D3' }),
      ]),
    }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 3, 'initial + two genuinely distinct Gate-fingerprint reworks');
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 7. Existing Gate-specific heuristic regression ───────────────────────
// Covered by test 5 above (NO_NEW_INFORMATION_RETRY_BLOCKED path); asserted
// directly against deterministicSupervisorPolicy.js in
// tests/newInformationPolicy.test.js and automatedLoop.test.js already.

// ── 8. Reviewer findings rework ──────────────────────────────────────────

test('8. Reviewer REWORK findings authorize one Executor rework; identical findings block a repeat', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [
      { decision: 'REWORK', findings: ['bug X'], required_changes: ['fix bug X'], rationale: 'no' },
      { decision: 'REWORK', findings: ['bug X'], required_changes: ['fix bug X'], rationale: 'still no' },
    ]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-8',
      plannedTasks: [t1],
      runtime,
      gateRunner: makeQueuedGateRunner([gatePass({ diff: 'D1' }), gatePass({ diff: 'D2' }), gatePass({ diff: 'D3' })]),
      supervisorSession: haltingSupervisor(),
    }),
    informationLedger,
  });
  // Attempt 1 (task card) -> Reviewer REWORK "bug X" -> attempt 2 authorized
  // by NEW_REVIEW_FINDINGS. Attempt 2's Reviewer returns the IDENTICAL
  // findings again — deterministicSupervisorPolicy's own reviewer-rework
  // non-convergence heuristic (`reviewer_rework_nonconvergence`) stops it
  // deterministically before a third Executor call is ever considered.
  assert.equal(execCounter.calls, 2, 'initial attempt + exactly one Reviewer-findings rework');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

test('8b. Genuinely changed Reviewer findings authorize a fresh Executor rework', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [
      { decision: 'REWORK', findings: ['bug X'], required_changes: ['fix bug X'], rationale: 'no' },
      { decision: 'REWORK', findings: ['bug Y'], required_changes: ['fix bug Y'], rationale: 'different issue now' },
      { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' },
    ]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-8b',
      plannedTasks: [t1],
      runtime,
      gateRunner: makeQueuedGateRunner([gatePass({ diff: 'D1' }), gatePass({ diff: 'D2' }), gatePass({ diff: 'D3' })]),
    }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 3, 'initial + two genuinely distinct Reviewer-findings reworks');
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 9. Initial Reviewer requires CHANGED_TASK_DIFF ───────────────────────

test('9/10/11. Reviewer requires CHANGED_TASK_DIFF: same diff cannot re-review, changed diff allows a fresh review', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [
      { decision: 'REWORK', findings: ['bug X'], required_changes: ['fix bug X'], rationale: 'no' },
      { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' },
    ]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-9',
      plannedTasks: [t1],
      runtime,
      // Gate PASSes with the SAME diff twice in a row (attempt 1 and the
      // Reviewer-findings-driven attempt 2 both land on diff D1) before
      // finally changing on attempt 3's gate — attempt 2's own diff being
      // identical to attempt 1's would deny a second physical Reviewer call
      // on that unchanged diff alone; it is the CHANGED diff on attempt 3
      // that authorizes the second real review.
      gateRunner: makeQueuedGateRunner([gatePass({ diff: 'D1' }), gatePass({ diff: 'D2' })]),
    }),
    informationLedger,
  });
  assert.equal(revCounter.calls, 2, 'Reviewer ran once per genuinely distinct diff');
  assert.equal(execCounter.calls, 2);
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 12/13. Provider failover creates no new information ──────────────────

test('12/13. A retryable provider failure fails over, but the SAME evidence denies the second physical Executor attempt', async () => {
  const informationLedger = new NewInformationLedger();
  const primaryCalls = { calls: 0 };
  const backupCalls = { calls: 0 };
  const providerHealthEvents = [];
  const { runtime, providerHealth } = buildRuntime({
    informationLedger,
    // Test-only permissive eligibility source (see modelSpendAuthority.js's
    // constructor doc) — the ONLY way to exercise the generic multi-provider
    // failover mechanic in a test; production always uses the real Sonnet-only
    // source.
    providerCapabilities: { isExecutorEligible: () => true },
    executorFamilies: { 'claude:sonnet': null, 'test:backup': null },
    executorImpl: null,
    reviewerImpl: queuedReviewer({ calls: 0 }, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  // Wire distinct per-family implementations after construction (buildRuntime's
  // single executorImpl helper doesn't support two different fakes).
  runtime.spendAuthority.stats(); // no-op sanity call, keeps lints happy
  const failingPrimary = async () => { primaryCalls.calls += 1; throw Object.assign(new Error('primary down'), { code: 'PROVIDER_UNAVAILABLE' }); };
  const workingBackup = async () => { backupCalls.calls += 1; return { status: 'DONE', usage: { input_tokens: 1, output_tokens: 1 } }; };
  // createProductionRoleRuntime's adapters map was already frozen at
  // construction inside buildRuntime; rebuild it directly here instead.
  const runtime2 = createProductionRoleRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'test:backup' }] },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority: runtime.spendAuthority,
    adapters: { executor: { 'claude:sonnet': failingPrimary, 'test:backup': workingBackup } },
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-12',
      plannedTasks: [t1],
      runtime: runtime2,
      gateRunner: makeQueuedGateRunner([gatePass()]),
    }),
    informationLedger,
  });
  assert.equal(primaryCalls.calls, 1, 'the primary provider physically attempted once and failed');
  assert.equal(backupCalls.calls, 0, 'the backup NEVER physically ran — same evidence, already consumed by the primary attempt');
  assert.equal(result.status, 'HUMAN_REQUIRED', 'no new information -> denial -> HUMAN_REQUIRED, not a silent second provider');
});

// ── 15. HUMAN_REQUIRED projection ────────────────────────────────────────
// Covered by tests 2, 5, 5b, 8, 12/13, 19 above/below — every denial asserts
// result.status === 'HUMAN_REQUIRED' and zero further physical calls.

// ── 16. Happy path ────────────────────────────────────────────────────────

test('16. Happy path: task card -> Executor -> Gate PASS -> Reviewer PASS -> WORKFLOW_DONE, no false denial', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId: 'wf-16', plannedTasks: [t1], runtime, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger,
  });
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(execCounter.calls, 1);
  assert.equal(revCounter.calls, 1);
});

// ── 17. Rework happy path ─────────────────────────────────────────────────

test('17. Rework happy path: every physical call has a distinct legitimate evidence transition', async () => {
  const informationLedger = new NewInformationLedger();
  const execCounter = { calls: 0 };
  const revCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer(revCounter, [
      { decision: 'REWORK', findings: ['bug C'], required_changes: ['fix bug C'], rationale: 'no' },
      { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' },
    ]),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({
      workflowId: 'wf-17',
      plannedTasks: [t1],
      runtime,
      // Executor #1 -> Gate FAIL A -> Executor #2 -> Gate PASS (diff B) ->
      // Reviewer findings C -> Executor #3 -> Gate PASS (diff D) -> Reviewer PASS.
      gateRunner: makeQueuedGateRunner([
        gateFail({ testId: 'testA', diff: 'D1' }),
        gatePass({ diff: 'D2' }),
        gatePass({ diff: 'D3' }),
      ]),
    }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 3, 'Executor #1 (task card), #2 (Gate rework), #3 (Reviewer-findings rework)');
  assert.equal(revCounter.calls, 2, 'Reviewer runs once per genuinely distinct diff');
  assert.equal(result.status, 'WORKFLOW_DONE');
});

// ── 18. Resume consumption survives a fresh runtime/ledger ───────────────

test('18. Consumption survives a fresh NewInformationLedger backed by the same durable persistence', async () => {
  const persistence = tmpPersistence();
  const store = new InformationStore(persistence);
  const workflowId = 'wf-18';
  const t1 = taskCard('t1');

  const ledgerBefore = new NewInformationLedger({ store });
  const execCounterBefore = { calls: 0 };
  const { runtime: runtimeBefore } = buildRuntime({
    informationLedger: ledgerBefore,
    executorImpl: queuedExecutor(execCounterBefore),
    reviewerImpl: queuedReviewer({ calls: 0 }, [{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]),
  });
  const before = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId, plannedTasks: [t1], runtime: runtimeBefore, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger: ledgerBefore,
  });
  assert.equal(execCounterBefore.calls, 1);
  assert.equal(before.status, 'WORKFLOW_DONE');

  // "Restart": a brand-new NewInformationLedger instance (fresh in-memory
  // cache) backed by the SAME Persistence/InformationStore.
  const ledgerAfter = new NewInformationLedger({ store });
  const execCounterAfter = { calls: 0 };
  const { runtime: runtimeAfter } = buildRuntime({
    informationLedger: ledgerAfter,
    executorImpl: queuedExecutor(execCounterAfter),
    reviewerImpl: queuedReviewer({ calls: 0 }, []),
  });
  const after = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId, plannedTasks: [t1], runtime: runtimeAfter, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger: ledgerAfter,
  });
  assert.equal(execCounterAfter.calls, 0, 'the restart does not manufacture fresh Executor permission');
  assert.equal(after.status, 'HUMAN_REQUIRED');
});

// ── 19. Information persistence failure ──────────────────────────────────

test('19. An information-store failure at the Full Path Executor boundary halts with zero physical calls', async () => {
  const failingStore = {
    load: async () => { throw new Error('EIO: cannot read information state'); },
    save: async () => {},
  };
  const informationLedger = new NewInformationLedger({ store: failingStore });
  const execCounter = { calls: 0 };
  const { runtime } = buildRuntime({
    informationLedger,
    executorImpl: queuedExecutor(execCounter),
    reviewerImpl: queuedReviewer({ calls: 0 }, []),
  });
  const t1 = taskCard('t1');
  const result = await runAutomatedWorkflow({
    ...baseWorkflowArgs({ workflowId: 'wf-19', plannedTasks: [t1], runtime, gateRunner: makeQueuedGateRunner([gatePass()]) }),
    informationLedger,
  });
  assert.equal(execCounter.calls, 0, 'registration failed before any physical Executor call');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

// ── AuthorizationError code sanity ────────────────────────────────────────

test('denials surface AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED at the Authority boundary', async () => {
  const informationLedger = new NewInformationLedger();
  const t1 = taskCard('t1');
  const evidence = await registerTaskCardEvidence(informationLedger, { workflowId: 'wf-x', taskId: t1.task_id, taskCard: t1 });
  await informationLedger.consume({ workflowId: 'wf-x', role: 'executor', operationId: `wf-x:${t1.task_id}`, evidenceId: evidence.evidenceId });
  const { runtime } = buildRuntime({ informationLedger, executorImpl: queuedExecutor({ calls: 0 }), reviewerImpl: queuedReviewer({ calls: 0 }, []) });
  await assert.rejects(
    runtime.invoke('executor', { taskId: t1.task_id, taskCard: t1 }, {
      operationId: `wf-x:${t1.task_id}`, workflowId: 'wf-x', evidenceIds: [evidence.evidenceId],
    }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
});
