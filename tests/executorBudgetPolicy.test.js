// Card 3: every new Physical Model Call re-checks the CURRENT deterministic
// budget state before dispatch — not just once per logical invoke(). This
// re-uses the existing workflowCostGuard.js primitives via
// ModelSpendAuthority's `policy` callback; no new budget logic, no
// Reservation. All mock / deterministic. REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { createExecutorBudgetPolicy } from '../src/orchestrator/executorBudgetPolicy.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { isAuthorizationFailure, AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';

// Permissive executor eligibility so multi-candidate failover scenarios
// (E) can be exercised — this is the SAME test-only seam used by Card 2's
// generic-runtime tests, orthogonal to the budget policy under test here.
const permissiveEligibility = { isExecutorEligible: () => true };

function record(usageTracker, { taskId, callId, usageVolume = 0, costUsd = 0 }) {
  usageTracker.record({
    workflowId: 'wf-budget-recheck', role: 'executor', callId, taskId,
    provider: 'claude', model: 'sonnet',
    usage: { input_tokens: usageVolume, output_tokens: 0, num_turns: 1 },
    costUsd,
  });
}

function buildRuntime({ usageTracker, ceilings = {}, rolePolicy, adapters, eligibility = permissiveEligibility }) {
  const policy = createExecutorBudgetPolicy({ usageTracker, ...ceilings });
  const spendAuthority = new ModelSpendAuthority({ policy, providerCapabilities: eligibility });
  return createProductionRoleRuntime({
    rolePolicy,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily: (family) => ({ requestedFamily: family, resolvedModel: family, provider: family.split(':')[0], capabilities: { roles: ['executor'] } }),
    adapters,
    spendAuthority,
  });
}

// A. physical call #1 pushes usage to the task limit -> call #2 authorize DENY, 0 dispatch
test('A: task usage at the limit after call #1 denies call #2 before dispatch', async () => {
  const usageTracker = new UsageTracker();
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { taskExecutorUsageVolumeCeiling: 100 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          dispatched += 1;
          record(usageTracker, { taskId: 't1', callId: `c${dispatched}`, usageVolume: 100 });
          // The reliable usage evidence dispatch() itself needs to settle
          // SETTLED_KNOWN (distinct from the manual usageTracker.record()
          // above, which simulates this Card's own budget accounting).
          return { value: 'ok', usage: { input_tokens: 100, output_tokens: 0 } };
        },
      },
    },
  });
  await runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' });
  assert.equal(dispatched, 1);
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  assert.equal(dispatched, 1, 'second physical call must not dispatch');
});

// B. workflow volume ceiling reached -> next physical call = 0
test('B: workflow usage-volume ceiling reached denies the next physical call', async () => {
  const usageTracker = new UsageTracker();
  record(usageTracker, { taskId: 't0', callId: 'c0', usageVolume: 1000 });
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { workflowUsageVolumeCeiling: 1000 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  assert.equal(dispatched, 0);
});

// C. workflow cost ceiling exceeded -> next physical call = 0
test('C: workflow cost ceiling exceeded denies the next physical call', async () => {
  const usageTracker = new UsageTracker();
  record(usageTracker, { taskId: 't0', callId: 'c0', costUsd: 10 });
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { workflowCostCeilingUsd: 5 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  assert.equal(dispatched, 0);
});

// D. Executor physical call count reaches 4 -> next call = 0
test('D: executor physical-call-count ceiling reached denies the next call', async () => {
  const usageTracker = new UsageTracker();
  for (let i = 1; i <= 4; i += 1) record(usageTracker, { taskId: 't1', callId: `c${i}`, usageVolume: 1 });
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { executorPhysicalCallCeiling: 4 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  assert.equal(dispatched, 0);
});

// E. failover: provider A's usage settles, provider B must re-authorize
// against the fresh state and cannot inherit A's permit/budget decision.
test('E: a second failover candidate re-authorizes against usage the first candidate just recorded', async () => {
  const usageTracker = new UsageTracker();
  const attempted = [];
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { taskExecutorUsageVolumeCeiling: 50 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          attempted.push('claude:sonnet');
          // Provider A's call settles usage that alone crosses the ceiling,
          // then fails with a retryable transport error to trigger failover.
          record(usageTracker, { taskId: 't1', callId: 'c-a', usageVolume: 50 });
          throw Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' });
        },
        'codex:default': async () => {
          attempted.push('codex:default');
          return 'never — must be denied before this runs';
        },
      },
    },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  // Candidate A physically ran and recorded usage; candidate B's authorize()
  // re-read that fresh state and was denied BEFORE its adapter ran.
  assert.deepEqual(attempted, ['claude:sonnet']);
});

// F. resume: rehydrated usage already over the limit -> first physical call = 0
test('F: usage rehydrated from a resumed state that is already over budget denies the first call', async () => {
  // Simulates a PRIOR process's UsageTracker having persisted its records
  // (toJSON()), and this resumed process folding them back in via
  // rehydrateUsageFromState() BEFORE any new dispatch it makes.
  const priorProcessTracker = new UsageTracker();
  record(priorProcessTracker, { taskId: 't1', callId: 'prior-1', usageVolume: 999 });
  const usageTracker = new UsageTracker();
  usageTracker.merge(priorProcessTracker.toJSON());
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { taskExecutorUsageVolumeCeiling: 100 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }),
    (err) => isAuthorizationFailure(err),
  );
  assert.equal(dispatched, 0);
});

// G. a budget authorization failure is not a provider failure: no failover,
// no health-state pollution.
test('G: budget denial is not classified as provider failure and does not pollute health state', async () => {
  const usageTracker = new UsageTracker();
  record(usageTracker, { taskId: 't1', callId: 'c1', usageVolume: 100 });
  let dispatched = 0;
  const runtimeWithEvents = buildRuntime({
    usageTracker,
    ceilings: { taskExecutorUsageVolumeCeiling: 100 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }] },
    adapters: {
      executor: {
        'claude:sonnet': async () => { dispatched += 1; return 'never'; },
        'codex:default': async () => { dispatched += 1; return 'never-either'; },
      },
    },
  });
  await assert.rejects(runtimeWithEvents.invoke('executor', {}, { operationId: 'wf-budget-recheck:t1' }), (err) => {
    assert.equal(err.code, AUTHORIZATION_ERROR_CODES.SPEND_DENIED);
    return true;
  });
  assert.equal(dispatched, 0);
  assert.equal(runtimeWithEvents.providerHealth.usable('claude:sonnet', 'claude'), true, 'budget denial must not penalize provider health');
});

// H. a missing/malformed operationId must fail the task-level ceiling
// CLOSED (DENY, 0 dispatch) — it must never fall through as if the
// per-task ceiling simply did not apply.
test('H: an Executor call whose operationId carries no reliable taskId is denied before dispatch', async () => {
  const malformedOperationIds = [null, '', 'no-colon', ':', 'workflow:', 'undefined:undefined'];
  for (const operationId of malformedOperationIds) {
    const usageTracker = new UsageTracker();
    let dispatched = 0;
    const runtime = buildRuntime({
      usageTracker,
      ceilings: { taskExecutorUsageVolumeCeiling: 100 },
      rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
      adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'never'; } } },
    });
    await assert.rejects(
      runtime.invoke('executor', {}, { operationId }),
      (err) => isAuthorizationFailure(err),
      `operationId ${JSON.stringify(operationId)} must be denied`,
    );
    assert.equal(dispatched, 0, `operationId ${JSON.stringify(operationId)} must not dispatch`);
  }
});

// I. a well-formed operationId still passes when under the ceiling —
// the fail-closed fix above must not have collaterally denied valid calls.
test('I: a well-formed operationId still passes under the ceiling', async () => {
  const usageTracker = new UsageTracker();
  let dispatched = 0;
  const runtime = buildRuntime({
    usageTracker,
    ceilings: { taskExecutorUsageVolumeCeiling: 100 },
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return { label: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }; } } },
  });
  const result = await runtime.invoke('executor', {}, { operationId: 'wf-123:task-1' });
  assert.equal(result.value.label, 'ok');
  assert.equal(dispatched, 1);
});
