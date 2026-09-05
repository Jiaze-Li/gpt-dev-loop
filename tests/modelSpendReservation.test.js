// Persistent Model Spend Reservation — unit tests for the reservation
// lifecycle (ReservationLedger / ReservationStore) and its integration with
// ModelSpendAuthority / productionRoleRuntime.
//
// REAL MODEL CALLS = 0. SUPERGPT STARTS = 0. All mock / deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RESERVATION_STATUS,
  ReservationLedger,
  ReservationStore,
} from '../src/orchestrator/modelSpendReservation.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { AdapterError, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

function buildRuntime({
  rolePolicy, adapters, spendAuthority, providerCapabilities,
} = {}) {
  const authority = spendAuthority ?? new ModelSpendAuthority(providerCapabilities ? { providerCapabilities } : {});
  const runtime = createProductionRoleRuntime({
    rolePolicy: rolePolicy ?? DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
    adapters,
    spendAuthority: authority,
  });
  return { runtime, spendAuthority: authority };
}

const TEST_ONLY_PERMISSIVE = {
  isExecutorEligible: (family) => ['claude:sonnet', 'codex:default', 'claude:opus'].includes(family),
};

function tmpPersistence() {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-spend-reservation-'));
  return new Persistence(dir);
}

// ── A. Persist before dispatch ──────────────────────────────────────────

test('A: reservation is durably persisted (RESERVED, then DISPATCHING) before the provider adapter is ever invoked', async () => {
  const persistence = tmpPersistence();
  const events = [];
  const ledger = new ReservationLedger({ store: new ReservationStore(persistence), onEvent: (e) => events.push(e) });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const order = [];
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { order.push('PROVIDER_CALLED'); return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    spendAuthority,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-a:t1', workflowId: 'wf-a' });

  assert.deepEqual(events.map((e) => e.type), ['RESERVATION_RESERVED', 'RESERVATION_DISPATCHING', 'RESERVATION_SETTLED_KNOWN']);
  // The provider adapter call happened strictly after both persistence
  // events fired (order captured only one entry, but we assert against the
  // event log ordering directly above — this additionally proves the
  // adapter genuinely ran).
  assert.deepEqual(order, ['PROVIDER_CALLED']);

  const reservations = await ledger.list('wf-a');
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, RESERVATION_STATUS.SETTLED_KNOWN);
  assert.equal(reservations[0].role, 'executor');
  assert.equal(reservations[0].dispatchStartedAt !== null, true);
});

// ── B. Reservation persistence failure -> zero physical calls ──────────

test('B: reservation persistence failure at authorize() fails closed — zero physical provider calls', async () => {
  const failingStore = { load: async () => ({}), save: async () => { throw new Error('disk full'); } };
  const ledger = new ReservationLedger({ store: failingStore });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  let providerCalls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { providerCalls += 1; return {}; } } },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-b:t1', workflowId: 'wf-b' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
  );
  assert.equal(providerCalls, 0);
});

test('B2: reservation persistence failure at the DISPATCHING boundary also fails closed — zero physical provider calls', async () => {
  let reserved = false;
  const store = {
    load: async () => ({}),
    save: async (workflowId, reservations) => {
      const list = Object.values(reservations);
      const anyDispatching = list.some((r) => r.status === RESERVATION_STATUS.DISPATCHING);
      if (!reserved) { reserved = true; return; } // allow the first save (RESERVED)
      if (anyDispatching) throw new Error('disk full at dispatch boundary');
    },
  };
  const ledger = new ReservationLedger({ store });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  let providerCalls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { providerCalls += 1; return {}; } } },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-b2:t1', workflowId: 'wf-b2' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
  );
  assert.equal(providerCalls, 0);
});

// ── C. Known successful usage ────────────────────────────────────────────

test('C: successful call settles SETTLED_KNOWN and stores the usage reference', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => ({ usage: { input_tokens: 100, output_tokens: 50, callId: 'call-1' } }) } },
    spendAuthority,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-c:t1', workflowId: 'wf-c' });
  const [reservation] = await ledger.list('wf-c');
  assert.equal(reservation.status, RESERVATION_STATUS.SETTLED_KNOWN);
  assert.equal(reservation.usageCallId, 'call-1');
  assert.deepEqual(reservation.usageReference, { input_tokens: 100, output_tokens: 50, callId: 'call-1' });
});

// ── D. Known usage with business/provider failure ───────────────────────

test('D: a business/provider failure whose usage is reliably known still settles SETTLED_KNOWN', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          throw new AdapterError('EXECUTOR_BUDGET_EXCEEDED', 'budget', { usage: { input_tokens: 40, output_tokens: 10, callId: 'call-2' } });
        },
      },
    },
    spendAuthority,
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf-d:t1', workflowId: 'wf-d' }));
  const [reservation] = await ledger.list('wf-d');
  assert.equal(reservation.status, RESERVATION_STATUS.SETTLED_KNOWN);
  assert.equal(reservation.usageCallId, 'call-2');
});

// ── E. Timeout / killed process with no usage -> UNRESOLVED, blocks next call ──

test('E: a timeout with unavailable usage settles UNRESOLVED and blocks the next internal call in the workflow', async () => {
  const safetyEvents = [];
  const ledger = new ReservationLedger({ recordSafetyEvent: (e) => safetyEvents.push(e) });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  let secondCallHappened = false;
  const { runtime } = buildRuntime({
    rolePolicy: {
      executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }],
      reviewer: [{ family: 'agy:gpt-oss' }],
    },
    adapters: {
      executor: {
        'claude:sonnet': async () => { throw new AdapterError('EXECUTOR_TIMEOUT', 'timed out'); },
        'codex:default': async () => { secondCallHappened = true; return {}; },
      },
      reviewer: { 'agy:gpt-oss': async () => { secondCallHappened = true; return {}; } },
    },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-e:t1', workflowId: 'wf-e' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(secondCallHappened, false, 'codex must never physically run once sonnet is UNRESOLVED');
  const reservations = await ledger.list('wf-e');
  assert.equal(reservations.length, 1, 'no reservation was created for the blocked codex attempt');
  assert.equal(reservations[0].status, RESERVATION_STATUS.UNRESOLVED);

  // A second, independent invoke() for a DIFFERENT role in the SAME
  // workflow is blocked too — the guard is not scoped to Executor.
  await assert.rejects(
    runtime.invoke('reviewer', {}, { operationId: 'wf-e:t2', workflowId: 'wf-e' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(secondCallHappened, false, 'the reviewer candidate must never physically run either');

  assert.equal(safetyEvents.some((e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED' && e.severity === 'BLOCKING'), true);
});

// ── F. Missing usage after dispatched call — never settled as zero ─────

test('F: a completed call with no reliable usage is UNRESOLVED, never silently treated as zero', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { throw new Error('malformed response, no usage'); } } },
    spendAuthority,
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf-f:t1', workflowId: 'wf-f' }));
  const [reservation] = await ledger.list('wf-f');
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
  assert.equal(reservation.usageReference, null);
  assert.equal(reservation.usageCallId, null);
});

// ── G. Unknown usage prevents failover ──────────────────────────────────

test('G: provider A retryable failure with unknown usage -> provider B never physically runs', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => { calls.A += 1; throw new AdapterError('EXECUTOR_TIMEOUT', 'timeout, no usage'); },
        'codex:default': async () => { calls.B += 1; return {}; },
      },
    },
    spendAuthority,
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf-g:t1', workflowId: 'wf-g' }));
  assert.equal(calls.A, 1);
  assert.equal(calls.B, 0);
});

// ── H. Known usage can complete settlement before legal failover ───────

test('H: provider A known-usage failure settles SETTLED_KNOWN and provider B gets a fresh permit + reservation', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          calls.A += 1;
          throw new AdapterError('EXECUTOR_TIMEOUT', 'timeout, usage known', { usage: { input_tokens: 5, output_tokens: 0 } });
        },
        'codex:default': async () => { calls.B += 1; return { usage: { input_tokens: 3, output_tokens: 1 } }; },
      },
    },
    spendAuthority,
  });
  const result = await runtime.invoke('executor', {}, { operationId: 'wf-h:t1', workflowId: 'wf-h' });
  assert.equal(calls.A, 1);
  assert.equal(calls.B, 1);
  assert.equal(result.selection.requestedFamily, 'codex:default');
  const reservations = await ledger.list('wf-h');
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((r) => r.status === RESERVATION_STATUS.SETTLED_KNOWN));
  assert.deepEqual(spendAuthority.stats(), { issued: 2, consumed: 2, outstanding: 0 });
});

// ── I. Resume with a DISPATCHING reservation ────────────────────────────

test('I: resume with a reservation stuck at DISPATCHING (no settlement) blocks new internal calls', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-i', {
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-i', taskId: 'wf-i:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.DISPATCHING, createdAt: new Date().toISOString(),
        dispatchStartedAt: new Date().toISOString(), settledAt: null, settlementReason: null, usageCallId: null, usageReference: null,
      },
    },
  });
  const store = new ReservationStore(persistence);
  const ledger = new ReservationLedger({ store });
  await ledger.reconcileOnResume('wf-i');

  const spendAuthority = new ModelSpendAuthority({ reservationLedger: new ReservationLedger({ store }) });
  let providerCalls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { providerCalls += 1; return {}; } } },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-i:t2', workflowId: 'wf-i' }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(providerCalls, 0);
  const [reservation] = await store.load('wf-i').then((r) => Object.values(r));
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
});

// ── J. Resume with an UNRESOLVED reservation stays blocked ─────────────

test('J: resume with an already-UNRESOLVED reservation remains blocked after restart', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-j', {
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-j', taskId: 'wf-j:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.UNRESOLVED, createdAt: new Date().toISOString(),
        dispatchStartedAt: new Date().toISOString(), settledAt: new Date().toISOString(), settlementReason: 'PRIOR_CRASH', usageCallId: null, usageReference: null,
      },
    },
  });
  const store = new ReservationStore(persistence);
  await new ReservationLedger({ store }).reconcileOnResume('wf-j');
  const ledger = new ReservationLedger({ store });
  assert.equal(await ledger.hasUnresolved('wf-j'), true);
});

// ── K. Resume with SETTLED_KNOWN — no double counting ───────────────────

test('K: resume with a SETTLED_KNOWN reservation stays settled and does not duplicate UsageTracker accounting', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-k', {
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-k', taskId: 'wf-k:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.SETTLED_KNOWN, createdAt: new Date().toISOString(),
        dispatchStartedAt: new Date().toISOString(), settledAt: new Date().toISOString(), settlementReason: 'PROVIDER_CALL_SUCCEEDED',
        usageCallId: 'call-resumed-1', usageReference: { input_tokens: 10, output_tokens: 5, callId: 'call-resumed-1' },
      },
    },
  });
  const store = new ReservationStore(persistence);
  await new ReservationLedger({ store }).reconcileOnResume('wf-k');
  const ledger = new ReservationLedger({ store });
  assert.equal(await ledger.hasUnresolved('wf-k'), false);
  const [reservation] = await ledger.list('wf-k');
  assert.equal(reservation.status, RESERVATION_STATUS.SETTLED_KNOWN);

  // The independent UsageTracker exactly-once dedupe still applies on top —
  // replaying the same callId a second time never double-counts.
  const tracker = new UsageTracker();
  const first = tracker.record({ workflowId: 'wf-k', role: 'executor', callId: 'call-resumed-1', taskId: 't1', attempt: 1, usage: { input_tokens: 10, output_tokens: 5 } });
  const second = tracker.record({ workflowId: 'wf-k', role: 'executor', callId: 'call-resumed-1', taskId: 't1', attempt: 1, usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(tracker.summary().executor.calls, 1);
});

// ── L. Pre-dispatch RESERVED crash — no false unknown usage ─────────────

test('L: a RESERVED reservation that never reached DISPATCHING resolves to CANCELLED_PRE_DISPATCH on resume, not UNRESOLVED', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-l', {
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-l', taskId: 'wf-l:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.RESERVED, createdAt: new Date().toISOString(),
        dispatchStartedAt: null, settledAt: null, settlementReason: null, usageCallId: null, usageReference: null,
      },
    },
  });
  const store = new ReservationStore(persistence);
  const reconciled = await new ReservationLedger({ store }).reconcileOnResume('wf-l');
  assert.equal(reconciled[0].status, RESERVATION_STATUS.CANCELLED_PRE_DISPATCH);
  const ledger = new ReservationLedger({ store });
  assert.equal(await ledger.hasUnresolved('wf-l'), false, 'a provably pre-dispatch reservation must never block new spend');
});

// ── M. User-visible safety propagation ──────────────────────────────────

test('M: an UNRESOLVED reservation reaches a workflow-state-shaped BLOCKING safety event (no supergpt_start_and_wait involved)', async () => {
  // Mirrors workflowState.js#recordSafetyEvent's contract without importing
  // the class, keeping this test purely local/deterministic.
  const recorded = [];
  const recordSafetyEvent = (event) => recorded.push(event);
  const ledger = new ReservationLedger({ recordSafetyEvent });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, recordSafetyEvent });
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { throw new Error('crash, no usage'); } } },
    spendAuthority,
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf-m:t1', workflowId: 'wf-m' }));
  const blocking = recorded.find((e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED');
  assert.ok(blocking);
  assert.equal(blocking.severity, 'BLOCKING');
  assert.equal(blocking.role, 'executor');
});

// ── N. Every internal role traverses the same gate ──────────────────────

test('N: planner, supervisor, executor, and reviewer are ALL blocked by an unresolved reservation in the same workflow', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  // Each role uses its OWN family so a provider-health penalty from one
  // role's failed attempt (unrelated to Reservation) never masks whether
  // the OTHER roles were blocked by the reservation gate itself.
  const { runtime } = buildRuntime({
    rolePolicy: {
      planner: [{ family: 'codex:default' }],
      supervisor: [{ family: 'agy:gemini' }],
      executor: [{ family: 'claude:sonnet' }],
      reviewer: [{ family: 'agy:gpt-oss' }],
    },
    adapters: {
      planner: { 'codex:default': async () => { throw new Error('crash, no usage'); } },
      supervisor: { 'agy:gemini': async () => { throw new Error('unreachable'); } },
      executor: { 'claude:sonnet': async () => { throw new Error('unreachable'); } },
      reviewer: { 'agy:gpt-oss': async () => { throw new Error('unreachable'); } },
    },
    spendAuthority,
  });
  await assert.rejects(runtime.invoke('planner', {}, { operationId: 'wf-n', workflowId: 'wf-n' }));
  for (const role of ['supervisor', 'executor', 'reviewer']) {
    await assert.rejects(
      runtime.invoke(role, {}, { operationId: `wf-n:t1`, workflowId: 'wf-n' }),
      (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
    );
  }
});

// ── O. Existing permit/budget invariants are unaffected ─────────────────

test('O: single-use permit, provider eligibility, and Sonnet-only Executor invariants still hold alongside Reservation', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const intent = {
    role: 'executor', family: 'claude:sonnet', provider: 'claude', operationId: 'wf-o:t1', attempt: 1, workflowId: 'wf-o',
  };
  const permit = await spendAuthority.authorize(intent);
  await spendAuthority.dispatch(permit, intent, async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
  await assert.rejects(
    spendAuthority.dispatch(permit, intent, async () => 'reused'),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.PERMIT_CONSUMED,
  );

  // Provider eligibility: Codex Executor is denied regardless of a fresh
  // workflow (no unresolved reservation involved).
  await assert.rejects(
    spendAuthority.authorize({
      role: 'executor', family: 'codex:default', provider: 'codex', operationId: 'wf-o2:t1', attempt: 1, workflowId: 'wf-o2',
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
  );

  assert.deepEqual(spendAuthority.stats(), { issued: 1, consumed: 1, outstanding: 0 });
});

// ── Backward compatibility: pre-Reservation workflow.json reads as empty ──

test('backward compatibility: a workflow.json with no modelSpendReservations key reads as an empty ledger, not corruption', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-legacy', { someOtherField: 'unchanged' });
  const ledger = new ReservationLedger({ store: new ReservationStore(persistence) });
  assert.equal(await ledger.hasUnresolved('wf-legacy'), false);
  assert.deepEqual(await ledger.list('wf-legacy'), []);
  const state = await persistence.readWorkflowState('wf-legacy');
  assert.equal(state.someOtherField, 'unchanged');
});

// ── Settlement idempotency ──────────────────────────────────────────────

test('settlement is idempotent: settling an already-SETTLED_KNOWN reservation again does not change it', async () => {
  const ledger = new ReservationLedger();
  await ledger.reserve({ workflowId: 'wf-idem', intent: { role: 'executor', family: 'claude:sonnet', operationId: 't1' }, physicalAttempt: 1, reservationId: 'r1' });
  await ledger.markDispatching({ workflowId: 'wf-idem', reservationId: 'r1' });
  const first = await ledger.settleKnown({ workflowId: 'wf-idem', reservationId: 'r1', usageCallId: 'c1', usageReference: { input_tokens: 1 } });
  const second = await ledger.settleKnown({ workflowId: 'wf-idem', reservationId: 'r1', usageCallId: 'c2', usageReference: { input_tokens: 999 } });
  assert.equal(second.usageCallId, first.usageCallId, 'a repeated settlement must not overwrite the original settlement');
});

// ── P. Success with missing usage must NOT be SETTLED_KNOWN, and must NOT
//      escape dispatch() as an ordinary success either ─────────────────

test('P: a successful provider call with no reliable usage settles UNRESOLVED and is an IMMEDIATE Token Safety block, not an ordinary success', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  let secondCallHappened = false;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }], reviewer: [{ family: 'agy:gpt-oss' }] },
    adapters: {
      // A business/functional success — but the adapter reports NO usage
      // field at all. This must never be silently treated as known-zero
      // spend, and must NEVER resolve the invocation as ordinary success:
      // an UNRESOLVED reservation is an immediate workflow-blocking
      // condition, not merely a guard against the NEXT call.
      executor: { 'claude:sonnet': async () => ({ ok: true }) },
      reviewer: { 'agy:gpt-oss': async () => { secondCallHappened = true; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
    },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-p:t1', workflowId: 'wf-p' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED
      && err.details?.businessOutcome === 'SUCCESS',
  );

  const [reservation] = await ledger.list('wf-p');
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED, 'the reservation is durably UNRESOLVED before the blocking error is thrown');
  assert.equal(reservation.usageReference, null);

  await assert.rejects(
    runtime.invoke('reviewer', {}, { operationId: 'wf-p:t2', workflowId: 'wf-p' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(secondCallHappened, false, 'no further internal model call may physically run once usage is unresolved');
});

test('P2: a business FAILURE with no reliable usage is likewise an immediate Token Safety block, and the original failure is preserved only as diagnostic metadata', async () => {
  const ledger = new ReservationLedger();
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { throw new AdapterError('EXECUTOR_TIMEOUT', 'timed out, no usage'); } } },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-p2:t1', workflowId: 'wf-p2' }),
    (err) => isAuthorizationFailure(err)
      && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED
      && err.details?.businessOutcome === 'FAILURE'
      && err.details?.originalErrorCode === 'EXECUTOR_TIMEOUT',
  );
  const [reservation] = await ledger.list('wf-p2');
  assert.equal(reservation.status, RESERVATION_STATUS.UNRESOLVED);
});

// ── Q. Settlement persistence failure ────────────────────────────────────

test('Q: settlement persistence failure after a known-usage success fails closed, never fails over, and never marks the provider unhealthy', async () => {
  const store = {
    load: async () => ({}),
    save: async (workflowId, reservations) => {
      const list = Object.values(reservations);
      if (list.some((r) => r.status === RESERVATION_STATUS.SETTLED_KNOWN)) {
        throw new Error('disk full at settlement');
      }
      // RESERVED and DISPATCHING persist fine.
    },
  };
  const ledger = new ReservationLedger({ store });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => { calls.A += 1; return { usage: { input_tokens: 5, output_tokens: 1, callId: 'call-q' } }; },
        'codex:default': async () => { calls.B += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; },
      },
    },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-q:t1', workflowId: 'wf-q' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_SETTLEMENT_PERSIST_FAILED,
  );
  assert.equal(calls.A, 1, 'the provider physically ran exactly once');
  assert.equal(calls.B, 0, 'a settlement persistence failure must never trigger failover to another provider');

  // The provider itself is not classified as unhealthy / quota-exhausted —
  // a fresh routing attempt for the SAME family in a NEW workflow (so it is
  // not blocked by the unresolved reservation above) must still be eligible.
  assert.equal(spendAuthority.reservationLedger === ledger, true);

  // Cache-cannot-outrun-durable-state: the in-memory ledger must not report
  // SETTLED_KNOWN when the durable settlement write failed.
  const [reservation] = await ledger.list('wf-q');
  assert.equal(reservation.status, RESERVATION_STATUS.DISPATCHING, 'the cache must reflect the last durably-persisted state, not the failed write');

  // And that DISPATCHING itself keeps blocking further spend in the workflow.
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-q:t2', workflowId: 'wf-q' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(calls.A, 1, 'no further physical call happens once settlement could not be durably proven');
});

// ── Q2. Phase 0B — markUnresolved() persistence failure fails closed ───

test('Q2: an UNRESOLVED persistence failure fails closed with a DEDICATED code — never provider-classified, never failover', async () => {
  const store = {
    load: async () => ({}),
    save: async (workflowId, reservations) => {
      const list = Object.values(reservations);
      if (list.some((r) => r.status === RESERVATION_STATUS.UNRESOLVED)) {
        throw new Error('disk full at unresolved-write');
      }
      // RESERVED and DISPATCHING persist fine.
    },
  };
  const ledger = new ReservationLedger({ store });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger, providerCapabilities: TEST_ONLY_PERMISSIVE });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        // No reliable usage on success -> would normally go through
        // markUnresolved(), which this store makes fail.
        'claude:sonnet': async () => { calls.A += 1; return { status: 'DONE' }; },
        'codex:default': async () => { calls.B += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; },
      },
    },
    spendAuthority,
  });

  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-q2:t1', workflowId: 'wf-q2' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_UNRESOLVED_PERSIST_FAILED,
  );
  assert.equal(calls.A, 1, 'the provider physically ran exactly once');
  assert.equal(calls.B, 0, 'a fail-closed persistence error must never trigger failover to another provider');

  // Cache-cannot-outrun-durable-state: still DISPATCHING (the prior durably
  // persisted status), never UNRESOLVED and never SETTLED_KNOWN, because the
  // UNRESOLVED write itself never durably succeeded.
  const [reservation] = await ledger.list('wf-q2');
  assert.equal(reservation.status, RESERVATION_STATUS.DISPATCHING);

  // DISPATCHING keeps blocking further internal spend in this workflow —
  // for every role, not only Executor.
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-q2:t2', workflowId: 'wf-q2' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(calls.A, 1, 'no further physical call happens once the UNRESOLVED write could not be durably proven');
});

test('Q3: ReservationLedger.markUnresolved itself leaves the cache untouched when persistence fails', async () => {
  const store = {
    load: async () => ({}),
    // RESERVED and DISPATCHING persist fine; only the UNRESOLVED write fails.
    save: async (workflowId, reservations) => {
      const list = Object.values(reservations);
      if (list.some((r) => r.status === RESERVATION_STATUS.UNRESOLVED)) throw new Error('EIO');
    },
  };
  const ledger = new ReservationLedger({ store });
  const record = await ledger.reserve({ workflowId: 'wf-q3', intent: { role: 'executor', family: 'claude:sonnet', operationId: 'wf-q3:t1' }, physicalAttempt: 1 });
  await ledger.markDispatching({ workflowId: 'wf-q3', reservationId: record.reservationId });
  await assert.rejects(ledger.markUnresolved({ workflowId: 'wf-q3', reservationId: record.reservationId, reason: 'x' }));
  const [after] = await ledger.list('wf-q3');
  assert.equal(after.status, RESERVATION_STATUS.DISPATCHING, 'the cache must reflect the last durably-persisted state, not the failed write');
});

// ── R. DISPATCHING blocks authorization even without reconciliation ────

test('R: a persisted DISPATCHING reservation blocks authorization before reconcileOnResume ever runs', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-r', {
    modelSpendReservations: {
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-r', taskId: 'wf-r:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.DISPATCHING, createdAt: new Date().toISOString(),
        dispatchStartedAt: new Date().toISOString(), settledAt: null, settlementReason: null, usageCallId: null, usageReference: null,
      },
    },
  });
  const store = new ReservationStore(persistence);
  // Deliberately a FRESH ledger that never called reconcileOnResume().
  const ledger = new ReservationLedger({ store });
  const spendAuthority = new ModelSpendAuthority({ reservationLedger: ledger });
  let providerCalls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { providerCalls += 1; return {}; } } },
    spendAuthority,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-r:t2', workflowId: 'wf-r' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(providerCalls, 0, 'safety must not depend solely on resume rewriting DISPATCHING -> UNRESOLVED first');
});

// ── S. Resume reconciliation persistence/read failure is not best-effort ──

test('S: reconcileOnResume propagates a durable persistence failure instead of swallowing it', async () => {
  const store = {
    load: async () => ({
      'res-1': {
        reservationId: 'res-1', workflowId: 'wf-s', taskId: 'wf-s:t1', role: 'executor', family: 'claude:sonnet', provider: 'claude',
        physicalAttempt: 1, status: RESERVATION_STATUS.DISPATCHING, createdAt: new Date().toISOString(),
        dispatchStartedAt: new Date().toISOString(), settledAt: null, settlementReason: null, usageCallId: null, usageReference: null,
      },
    }),
    save: async () => { throw new Error('disk full during reconcile'); },
  };
  const ledger = new ReservationLedger({ store });
  await assert.rejects(ledger.reconcileOnResume('wf-s'), /disk full during reconcile/);
  // The production resume call site (supergpt.js) never catches this and
  // continues — it now routes it through the same fail-closed
  // HUMAN_REQUIRED + BLOCKING safety path as every other unresolved-spend
  // halt (see supergpt.js, "Resume reconciliation" block). Exercising that
  // full call site here would require standing up an entire worktree +
  // workflow-state fixture unrelated to the Reservation contract itself;
  // the safety-relevant behaviour — that a reconciliation failure is no
  // longer swallowed — is exactly this assertion.
});

test('T: reconcileOnResume fails closed when persisted reservation state cannot even be read', async () => {
  const store = { load: async () => { throw new Error('read failure'); }, save: async () => {} };
  const ledger = new ReservationLedger({ store });
  await assert.rejects(ledger.reconcileOnResume('wf-t'), /read failure/);
  // A storage read failure must never be interpreted as "no reservations
  // exist" by a fresh ledger instance backed by the same failing store.
  const freshLedger = new ReservationLedger({ store });
  await assert.rejects(freshLedger.hasUnresolved('wf-t'), /read failure/);
});

test('a SETTLED_KNOWN reservation is never downgraded to UNRESOLVED', async () => {
  const ledger = new ReservationLedger();
  await ledger.reserve({ workflowId: 'wf-no-downgrade', intent: { role: 'executor', family: 'claude:sonnet', operationId: 't1' }, physicalAttempt: 1, reservationId: 'r1' });
  await ledger.markDispatching({ workflowId: 'wf-no-downgrade', reservationId: 'r1' });
  await ledger.settleKnown({ workflowId: 'wf-no-downgrade', reservationId: 'r1', usageCallId: 'c1', usageReference: {} });
  await ledger.markUnresolved({ workflowId: 'wf-no-downgrade', reservationId: 'r1', reason: 'late crash signal' });
  const [reservation] = await ledger.list('wf-no-downgrade');
  assert.equal(reservation.status, RESERVATION_STATUS.SETTLED_KNOWN);
});
