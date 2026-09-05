// Global deterministic New Information Policy — unit tests for the
// NewInformationLedger (newInformation.js) and its integration with
// ModelSpendAuthority.authorize() / productionRoleRuntime.invoke().
//
//   NO NEW INFORMATION -> NO NEW INTERNAL MODEL CALL
//
// Mirrors the letter-lettered scenarios (A-T) from the task spec. Every test
// constructs an isolated ModelSpendAuthority + NewInformationLedger and
// drives productionRoleRuntime.invoke() directly — no full pipeline, no
// SuperGPT workflow start, no real provider call.
//
// REAL MODEL CALLS = 0. SUPERGPT STARTS = 0. SUPERGPT_* TOOL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  NewInformationLedger,
  InformationStore,
  NEW_INFORMATION_EVENT_TYPES,
  computeEvidenceId,
  computeConsumptionKey,
} from '../src/orchestrator/newInformation.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { ReservationLedger } from '../src/orchestrator/modelSpendReservation.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry, ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { Persistence } from '../src/orchestrator/persistence.js';

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

const TEST_ONLY_PERMISSIVE = {
  isExecutorEligible: (family) => ['claude:sonnet', 'codex:default', 'claude:opus'].includes(family),
};

function buildRuntime({
  rolePolicy, adapters, informationLedger, spendAuthority,
} = {}) {
  const authority = spendAuthority ?? new ModelSpendAuthority({
    informationLedger,
    providerCapabilities: TEST_ONLY_PERMISSIVE,
  });
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

function tmpPersistence() {
  const dir = mkdtempSync(path.join(tmpdir(), 'new-information-'));
  return new Persistence(dir);
}

// ── A. First legitimate call ────────────────────────────────────────────

test('A: registering legitimate new evidence authorizes exactly one physical call', async () => {
  const ledger = new NewInformationLedger();
  const evidence = await ledger.registerEvidence({
    workflowId: 'wf-a', type: NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD, subject: 't1', fingerprint: 'card-v1',
  });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  const result = await runtime.invoke('executor', {}, {
    operationId: 'wf-a:t1', workflowId: 'wf-a', evidenceIds: [evidence.evidenceId],
  });
  assert.ok(result.value.usage);
  assert.equal(calls, 1);
});

// ── B. Same evidence cannot justify same role/action twice ──────────────

test('B: the SAME evidence cannot authorize the SAME (role, operationId) twice', async () => {
  const ledger = new NewInformationLedger();
  const evidence = await ledger.registerEvidence({
    workflowId: 'wf-b', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'fp-1',
  });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-b:t1', workflowId: 'wf-b', evidenceIds: [evidence.evidenceId] });
  assert.equal(calls, 1);

  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-b:t1', workflowId: 'wf-b', evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1, 'no second physical call on the same evidence');
});

// ── C. Same evidence may justify a DIFFERENT role where policy allows ───

test('C: the same NEW_TASK_CARD evidence authorizes Supervisor once AND Executor once — consumption is per-role, not global', async () => {
  const ledger = new NewInformationLedger();
  const evidence = await ledger.registerEvidence({
    workflowId: 'wf-c', type: NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD, subject: 't1', fingerprint: 'card-1',
  });
  const calls = { supervisor: 0, executor: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }], supervisor: [{ family: 'agy:gemini' }] },
    adapters: {
      supervisor: { 'agy:gemini': async () => { calls.supervisor += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
      executor: { 'claude:sonnet': async () => { calls.executor += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
    },
    informationLedger: ledger,
  });
  await runtime.invoke('supervisor', {}, { operationId: 'wf-c', workflowId: 'wf-c', evidenceIds: [evidence.evidenceId] });
  await runtime.invoke('executor', {}, { operationId: 'wf-c:t1', workflowId: 'wf-c', evidenceIds: [evidence.evidenceId] });
  assert.equal(calls.supervisor, 1);
  assert.equal(calls.executor, 1);

  // But NOT a second time for either role.
  await assert.rejects(
    runtime.invoke('supervisor', {}, { operationId: 'wf-c', workflowId: 'wf-c', evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-c:t1', workflowId: 'wf-c', evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls.supervisor, 1);
  assert.equal(calls.executor, 1);
});

// ── D. Provider failover does not create new information ────────────────

test('D: provider A retryable failure with SETTLED_KNOWN usage -> provider B is denied on the SAME evidence (no new information)', async () => {
  const ledger = new NewInformationLedger();
  const evidence = await ledger.registerEvidence({
    workflowId: 'wf-d', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'fp-d',
  });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          calls.A += 1;
          const err = new Error('rate limited');
          err.details = { providerFailure: 'PROVIDER_RATE_LIMITED', usage: { input_tokens: 3, output_tokens: 0, callId: 'a-1' } };
          throw err;
        },
        'codex:default': async () => { calls.B += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; },
      },
    },
    informationLedger: ledger,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-d:t1', workflowId: 'wf-d', evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls.A, 1, 'provider A physically ran once (its usage settled SETTLED_KNOWN)');
  assert.equal(calls.B, 0, 'provider B never physically ran — no fresh evidence for the same (role, operationId)');
});

// ── E. Timeout does not create new information ───────────────────────────

test('E: a timeout on provider A is denied on provider B for the same evidence; no timeout event is ever registered as evidence', async () => {
  const ledger = new NewInformationLedger();
  const evidence = await ledger.registerEvidence({
    workflowId: 'wf-e', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'fp-e',
  });
  const calls = { A: 0, B: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          calls.A += 1;
          const err = new Error('timed out');
          err.code = 'EXECUTOR_TIMEOUT'; // no usage evidence -> UNRESOLVED, not SETTLED_KNOWN
          throw err;
        },
        'codex:default': async () => { calls.B += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; },
      },
    },
    informationLedger: ledger,
  });
  // A timeout with no usage evidence is UNRESOLVED and itself blocks
  // (MODEL_SPEND_USAGE_UNRESOLVED) before New Information is even reached
  // for a second attempt — proving timeout never manufactures an evidence
  // event that could let provider B run.
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-e:t1', workflowId: 'wf-e', evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  assert.equal(calls.A, 1);
  assert.equal(calls.B, 0);
  const { events } = await ledger.list('wf-e');
  assert.equal(events.length, 1, 'only the ONE evidence event this test explicitly registered exists — no timeout-derived event was created');
});

// ── F/G. Gate fingerprint: same -> blocked, changed -> new authorization ─

test('F: the same Gate fingerprint evidence does not authorize a second Executor rework call', async () => {
  const ledger = new NewInformationLedger();
  const evFp1 = await ledger.registerEvidence({
    workflowId: 'wf-fg', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'gate-fp-1',
  });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-fg:t1', workflowId: 'wf-fg', evidenceIds: [evFp1.evidenceId] });
  assert.equal(calls, 1);
  // Rework retry presents the IDENTICAL fingerprint again (same evidenceId).
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-fg:t1', workflowId: 'wf-fg', evidenceIds: [evFp1.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1);
});

test('G: a CHANGED Gate fingerprint registers a NEW evidenceId and authorizes one new Executor rework call', async () => {
  const ledger = new NewInformationLedger();
  const evFp1 = await ledger.registerEvidence({
    workflowId: 'wf-fg2', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'gate-fp-1',
  });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-fg2:t1', workflowId: 'wf-fg2', evidenceIds: [evFp1.evidenceId] });
  assert.equal(calls, 1);

  const evFp2 = await ledger.registerEvidence({
    workflowId: 'wf-fg2', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'gate-fp-2-DIFFERENT',
  });
  assert.notEqual(evFp1.evidenceId, evFp2.evidenceId);
  await runtime.invoke('executor', {}, { operationId: 'wf-fg2:t1', workflowId: 'wf-fg2', evidenceIds: [evFp2.evidenceId] });
  assert.equal(calls, 2, 'a genuinely changed fingerprint authorizes exactly one new physical call');
});

// ── H/I. Reviewer findings: same -> blocked, changed -> new authorization ─

test('H: identical, normalized Reviewer findings resolve to the SAME evidenceId and do not re-authorize Executor', async () => {
  const ledger = new NewInformationLedger();
  const idA = computeEvidenceId({ workflowId: 'wf-hi', type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS, subject: 't1', fingerprint: 'findings-sig-1' });
  const idB = computeEvidenceId({ workflowId: 'wf-hi', type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS, subject: 't1', fingerprint: 'findings-sig-1' });
  assert.equal(idA, idB, 'same semantic findings signature -> same deterministic evidenceId');
  const ev = await ledger.registerEvidence({ workflowId: 'wf-hi', type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS, subject: 't1', fingerprint: 'findings-sig-1' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-hi:t1', workflowId: 'wf-hi', evidenceIds: [ev.evidenceId] });
  assert.equal(calls, 1);
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-hi:t1', workflowId: 'wf-hi', evidenceIds: [ev.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1);
});

test('I: a changed Reviewer finding signature authorizes exactly one new Executor action', async () => {
  const ledger = new NewInformationLedger();
  const ev1 = await ledger.registerEvidence({ workflowId: 'wf-i', type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS, subject: 't1', fingerprint: 'sig-1' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-i:t1', workflowId: 'wf-i', evidenceIds: [ev1.evidenceId] });
  const ev2 = await ledger.registerEvidence({ workflowId: 'wf-i', type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS, subject: 't1', fingerprint: 'sig-2-DIFFERENT' });
  await runtime.invoke('executor', {}, { operationId: 'wf-i:t1', workflowId: 'wf-i', evidenceIds: [ev2.evidenceId] });
  assert.equal(calls, 2);
});

// ── J. Changed task diff authorizes Reviewer ─────────────────────────────

test('J: same task diff denies a second Reviewer call; a genuinely different diff authorizes one new Reviewer call', async () => {
  const ledger = new NewInformationLedger();
  const diffA = await ledger.registerEvidence({ workflowId: 'wf-j', type: NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF, subject: 't1', fingerprint: 'diff-A' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { reviewer: [{ family: 'agy:gpt-oss' }] },
    adapters: { reviewer: { 'agy:gpt-oss': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('reviewer', {}, { operationId: 'wf-j:t1', workflowId: 'wf-j', evidenceIds: [diffA.evidenceId] });
  assert.equal(calls, 1);
  await assert.rejects(
    runtime.invoke('reviewer', {}, { operationId: 'wf-j:t1', workflowId: 'wf-j', evidenceIds: [diffA.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1);
  const diffB = await ledger.registerEvidence({ workflowId: 'wf-j', type: NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF, subject: 't1', fingerprint: 'diff-B-DIFFERENT' });
  await runtime.invoke('reviewer', {}, { operationId: 'wf-j:t1', workflowId: 'wf-j', evidenceIds: [diffB.evidenceId] });
  assert.equal(calls, 2);
});

// ── K/L/M. User input identity ────────────────────────────────────────────

test('K: the initial user goal authorizes exactly one Planner physical call', async () => {
  const ledger = new NewInformationLedger();
  const ev = await ledger.registerEvidence({ workflowId: 'wf-k', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'initial-input', fingerprint: 'goal-text-hash' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { planner: [{ family: 'agy:gemini' }] },
    adapters: { planner: { 'agy:gemini': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('planner', {}, { operationId: 'wf-k', workflowId: 'wf-k', evidenceIds: [ev.evidenceId] });
  assert.equal(calls, 1);
});

test('L: a resume that re-presents the SAME persisted user goal (same evidenceId) cannot re-authorize Planner', async () => {
  // Simulates restart: a NEW NewInformationLedger instance backed by the
  // SAME durable store, exactly like a fresh process resuming a workflow.
  const persistence = tmpPersistence();
  const store = new InformationStore(persistence);
  const ledgerBeforeRestart = new NewInformationLedger({ store });
  const ev = await ledgerBeforeRestart.registerEvidence({
    workflowId: 'wf-l', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'initial-input', fingerprint: 'same-goal-text',
  });
  let calls = 0;
  const { runtime: runtimeBefore } = buildRuntime({
    rolePolicy: { planner: [{ family: 'agy:gemini' }] },
    adapters: { planner: { 'agy:gemini': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledgerBeforeRestart,
  });
  await runtimeBefore.invoke('planner', {}, { operationId: 'wf-l', workflowId: 'wf-l', evidenceIds: [ev.evidenceId] });
  assert.equal(calls, 1);

  // "Restart": a brand-new ledger instance, same durable store.
  const ledgerAfterRestart = new NewInformationLedger({ store });
  const evAgain = await ledgerAfterRestart.registerEvidence({
    workflowId: 'wf-l', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'initial-input', fingerprint: 'same-goal-text',
  });
  assert.equal(evAgain.evidenceId, ev.evidenceId, 're-registering the same semantic input resolves to the same evidenceId, not a fresh one');
  const { runtime: runtimeAfter } = buildRuntime({
    rolePolicy: { planner: [{ family: 'agy:gemini' }] },
    adapters: { planner: { 'agy:gemini': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledgerAfterRestart,
  });
  await assert.rejects(
    runtimeAfter.invoke('planner', {}, { operationId: 'wf-l', workflowId: 'wf-l', evidenceIds: [evAgain.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1, 'restart does not manufacture fresh Planner permission');
});

test('M: a genuinely new user clarification (different fingerprint) authorizes the relevant role once', async () => {
  const ledger = new NewInformationLedger();
  const ev1 = await ledger.registerEvidence({ workflowId: 'wf-m', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'initial-input', fingerprint: 'initial-goal' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { planner: [{ family: 'agy:gemini' }] },
    adapters: { planner: { 'agy:gemini': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await runtime.invoke('planner', {}, { operationId: 'wf-m', workflowId: 'wf-m', evidenceIds: [ev1.evidenceId] });
  assert.equal(calls, 1);
  const ev2 = await ledger.registerEvidence({ workflowId: 'wf-m', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'clarification-1', fingerprint: 'new clarification text' });
  await runtime.invoke('planner', {}, { operationId: 'wf-m', workflowId: 'wf-m', evidenceIds: [ev2.evidenceId] });
  assert.equal(calls, 2);
});

// ── N. Consumption survives restart ──────────────────────────────────────

test('N: E consumed, restart (new ledger + runtime, same durable store), E presented again -> denied', async () => {
  const persistence = tmpPersistence();
  const store = new InformationStore(persistence);
  const ledger1 = new NewInformationLedger({ store });
  const ev = await ledger1.registerEvidence({ workflowId: 'wf-n', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'fp-n' });
  let calls = 0;
  const { runtime: r1 } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger1,
  });
  await r1.invoke('executor', {}, { operationId: 'wf-n:t1', workflowId: 'wf-n', evidenceIds: [ev.evidenceId] });
  assert.equal(calls, 1);

  const ledger2 = new NewInformationLedger({ store }); // fresh process
  const { runtime: r2 } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger2,
  });
  await assert.rejects(
    r2.invoke('executor', {}, { operationId: 'wf-n:t1', workflowId: 'wf-n', evidenceIds: [ev.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1, 'restart does not reset evidence consumption');
});

// ── O. Information-store read failure -> fail closed ────────────────────

test('O: an information-store read failure fails closed — zero physical provider calls', async () => {
  const failingStore = { load: async () => { throw new Error('EIO: cannot read information state'); }, save: async () => {} };
  const ledger = new NewInformationLedger({ store: failingStore });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-o:t1', workflowId: 'wf-o', evidenceIds: ['whatever'] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
  );
  assert.equal(calls, 0);
});

// ── P. Information-consumption persistence failure -> fail closed ───────

test('P: a claim/consume persistence failure fails closed — permit is never issued, zero physical calls', async () => {
  const store = {
    load: async () => ({}),
    save: async (workflowId, data) => {
      if (Object.keys(data.consumptions ?? {}).length > 0) throw new Error('disk full at consumption write');
    },
  };
  const ledger = new NewInformationLedger({ store });
  const ev = await ledger.registerEvidence({ workflowId: 'wf-p', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'fp-p' });
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    informationLedger: ledger,
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-p:t1', workflowId: 'wf-p', evidenceIds: [ev.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
  );
  assert.equal(calls, 0, 'the physical call must never dispatch when evidence consumption could not be durably persisted');
});

// ── S. Normal happy path remains roomy ───────────────────────────────────

test('S: a realistic converging happy path (user input -> Planner -> task card -> Executor -> diff/gate -> Reviewer) never false-blocks on legitimate FIRST calls for each role', async () => {
  const ledger = new NewInformationLedger();
  const calls = { planner: 0, executor: 0, reviewer: 0 };
  const { runtime } = buildRuntime({
    rolePolicy: {
      planner: [{ family: 'agy:gemini' }], executor: [{ family: 'claude:sonnet' }], reviewer: [{ family: 'agy:gpt-oss' }],
    },
    adapters: {
      planner: { 'agy:gemini': async () => { calls.planner += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
      executor: { 'claude:sonnet': async () => { calls.executor += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
      reviewer: { 'agy:gpt-oss': async () => { calls.reviewer += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } },
    },
    informationLedger: ledger,
  });

  const userInput = await ledger.registerEvidence({ workflowId: 'wf-s', type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, subject: 'initial-input', fingerprint: 'goal text' });
  await runtime.invoke('planner', {}, { operationId: 'wf-s', workflowId: 'wf-s', evidenceIds: [userInput.evidenceId] });

  const taskCard = await ledger.registerEvidence({ workflowId: 'wf-s', type: NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD, subject: 't1', fingerprint: 'card v1' });
  await runtime.invoke('executor', {}, { operationId: 'wf-s:t1', workflowId: 'wf-s', evidenceIds: [taskCard.evidenceId] });

  const diff = await ledger.registerEvidence({ workflowId: 'wf-s', type: NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF, subject: 't1', fingerprint: 'diff v1' });
  const gateFp = await ledger.registerEvidence({ workflowId: 'wf-s', type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, subject: 't1', fingerprint: 'gate v1' });
  await runtime.invoke('reviewer', {}, { operationId: 'wf-s:t1', workflowId: 'wf-s', evidenceIds: [diff.evidenceId, gateFp.evidenceId] });

  assert.equal(calls.planner, 1);
  assert.equal(calls.executor, 1);
  assert.equal(calls.reviewer, 1);
});

// ── consumption key shape (documentation-level regression) ───────────────

test('computeConsumptionKey deliberately excludes provider family and physical attempt', () => {
  const key = computeConsumptionKey({ role: 'executor', operationId: 'wf:t1', evidenceId: 'abc123' });
  assert.equal(key, 'executor::wf:t1::abc123');
});

test('computeEvidenceId is a pure function of (type, workflowId, subject, fingerprint) only', () => {
  const a = computeEvidenceId({
    type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, workflowId: 'w', subject: 't1', fingerprint: 'x',
  });
  const b = computeEvidenceId({
    type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, workflowId: 'w', subject: 't1', fingerprint: 'x',
  });
  assert.equal(a, b);
  const c = computeEvidenceId({
    type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT, workflowId: 'w', subject: 't1', fingerprint: 'y',
  });
  assert.notEqual(a, c);
});

// ── backward compatibility ────────────────────────────────────────────────

test('backward compatibility: an Authority constructed WITHOUT an informationLedger performs no evidence check at all', async () => {
  let calls = 0;
  const { runtime } = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { calls += 1; return { usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    // informationLedger intentionally omitted
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-back:t1', workflowId: 'wf-back' });
  assert.equal(calls, 1, 'no informationLedger wired -> pre-existing allow-all-subject-to-other-checks behavior, unaffected');
});

test('backward compatibility: a workflow.json with no modelSpendInformation key reads as an empty ledger, not corruption', async () => {
  const persistence = tmpPersistence();
  await persistence.updateWorkflowState('wf-legacy', { someOtherKey: true });
  const store = new InformationStore(persistence);
  const ledger = new NewInformationLedger({ store });
  const { events, consumptions } = await ledger.list('wf-legacy');
  assert.deepEqual(events, []);
  assert.deepEqual(consumptions, []);
});
