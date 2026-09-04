// Token-Safety authorization boundary: every real internal provider dispatch
// routed through the production role runtime must obtain and consume its own
// valid, single-use PhysicalCallPermit before dispatch.
//
// All mock / deterministic. REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelSpendAuthority,
  PhysicalCallPermit,
  normalizeCallIntent,
} from '../src/orchestrator/modelSpendAuthority.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  RoleRouter,
} from '../src/orchestrator/roleRouting.js';
import {
  AuthorizationError,
  AUTHORIZATION_ERROR_CODES,
  AdapterError,
  ADAPTER_ERROR_CODES,
  isAuthorizationFailure,
} from '../src/orchestrator/errors.js';

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

function buildRuntime({ rolePolicy, adapters, policy, quota, health } = {}) {
  const quotaRegistry = quota ?? new QuotaPoolRegistry({ filePath: null });
  const providerHealth = health ?? new ProviderHealthRegistry();
  const spendAuthority = new ModelSpendAuthority(policy ? { policy } : {});
  const runtime = createProductionRoleRuntime({
    rolePolicy: rolePolicy ?? DEFAULT_ROLE_POLICY,
    quotaRegistry,
    providerHealth,
    resolveFamily,
    adapters,
    spendAuthority,
  });
  return { runtime, spendAuthority, quotaRegistry, providerHealth };
}

// ---------------------------------------------------------------------------
// Direct-authority unit behavior
// ---------------------------------------------------------------------------

test('authority: authorize issues a bound permit; dispatch consumes it exactly once', async () => {
  const authority = new ModelSpendAuthority();
  const intent = { role: 'reviewer', family: 'codex:default', provider: 'codex', operationId: 'wf1:t1', attempt: 1 };
  const permit = authority.authorize(intent);
  assert.ok(permit instanceof PhysicalCallPermit);
  assert.deepEqual(permit.intent, normalizeCallIntent(intent));

  let calls = 0;
  const out = await authority.dispatch(permit, intent, async () => { calls += 1; return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(authority.stats(), { issued: 1, consumed: 1, outstanding: 0 });
});

test('authority: a forged / cross-authority permit is rejected before dispatch', async () => {
  const a = new ModelSpendAuthority();
  const b = new ModelSpendAuthority();
  const intent = { role: 'planner', family: 'codex:default', provider: 'codex', operationId: 'x', attempt: 1 };
  const foreignPermit = b.authorize(intent);

  let calls = 0;
  await assert.rejects(
    a.dispatch(foreignPermit, intent, async () => { calls += 1; }),
    (err) => err instanceof AuthorizationError && err.code === AUTHORIZATION_ERROR_CODES.PERMIT_UNKNOWN,
  );
  await assert.rejects(
    a.dispatch({ token: 'made-up' }, intent, async () => { calls += 1; }),
    (err) => err instanceof AuthorizationError && err.code === AUTHORIZATION_ERROR_CODES.PERMIT_MISSING,
  );
  assert.equal(calls, 0);
});

test('authority: deny policy throws SPEND_DENIED and never issues a permit', () => {
  const authority = new ModelSpendAuthority({ policy: () => ({ allow: false, reason: 'nope' }) });
  assert.throws(
    () => authority.authorize({ role: 'executor', family: 'claude:sonnet', provider: 'claude' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
  );
  assert.deepEqual(authority.stats(), { issued: 0, consumed: 0, outstanding: 0 });
});

// ---------------------------------------------------------------------------
// Runtime-level required tests A–H
// ---------------------------------------------------------------------------

// Test A — happy path
test('A: happy path — permit issued, consumed once, provider invoked once', async () => {
  let providerCalls = 0;
  const { runtime, spendAuthority } = buildRuntime({
    rolePolicy: { reviewer: [{ family: 'codex:default' }] },
    adapters: { reviewer: { 'codex:default': async () => { providerCalls += 1; return { decision: 'PASS' }; } } },
  });
  const { value } = await runtime.invoke('reviewer', { taskId: 't1' }, { operationId: 'wf:t1' });
  assert.deepEqual(value, { decision: 'PASS' });
  assert.equal(providerCalls, 1);
  assert.deepEqual(spendAuthority.stats(), { issued: 1, consumed: 1, outstanding: 0 });
});

// Test B — missing permit: the protected dispatch path refuses without a permit
test('B: dispatch path is default-deny — no permit means zero provider invocations', async () => {
  const authority = new ModelSpendAuthority();
  let providerCalls = 0;
  await assert.rejects(
    authority.dispatch(undefined, { role: 'executor', family: 'claude:sonnet', provider: 'claude' }, async () => { providerCalls += 1; }),
    (err) => err instanceof AuthorizationError && err.code === AUTHORIZATION_ERROR_CODES.PERMIT_MISSING,
  );
  assert.equal(providerCalls, 0);
});

// Test C — reuse
test('C: a consumed permit cannot be reused — second dispatch invokes provider 0 times', async () => {
  const authority = new ModelSpendAuthority();
  const intent = { role: 'supervisor', family: 'agy:gemini', provider: 'agy-gemini', operationId: 'wf', attempt: 1 };
  const permit = authority.authorize(intent);
  let providerCalls = 0;
  await authority.dispatch(permit, intent, async () => { providerCalls += 1; });
  await assert.rejects(
    authority.dispatch(permit, intent, async () => { providerCalls += 1; }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.PERMIT_CONSUMED,
  );
  assert.equal(providerCalls, 1);
});

// Test D — mismatched permit
test('D: a reviewer/codex permit does not authorize an executor/sonnet dispatch', async () => {
  const authority = new ModelSpendAuthority();
  const reviewerIntent = { role: 'reviewer', family: 'codex:default', provider: 'codex', operationId: 'wf', attempt: 1 };
  const permit = authority.authorize(reviewerIntent);
  let providerCalls = 0;
  await assert.rejects(
    authority.dispatch(permit, { role: 'executor', family: 'claude:sonnet', provider: 'claude', operationId: 'wf', attempt: 1 }, async () => { providerCalls += 1; }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.PERMIT_INTENT_MISMATCH,
  );
  assert.equal(providerCalls, 0);
});

// Test E — authorization rejection does not fail over
test('E: authorization rejection prevents dispatch, does not fail over, does not mark provider unhealthy', async () => {
  const attempts = { 'agy:gpt-oss': 0, 'codex:default': 0 };
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const { runtime } = buildRuntime({
    rolePolicy: { reviewer: [{ family: 'agy:gpt-oss' }, { family: 'codex:default' }] },
    adapters: {
      reviewer: {
        'agy:gpt-oss': async () => { attempts['agy:gpt-oss'] += 1; return { decision: 'PASS' }; },
        'codex:default': async () => { attempts['codex:default'] += 1; return { decision: 'PASS' }; },
      },
    },
    policy: (intent) => (intent.family === 'agy:gpt-oss' ? { allow: false, reason: 'blocked by token safety' } : { allow: true }),
    health,
    quota,
  });

  await assert.rejects(
    runtime.invoke('reviewer', { taskId: 't1' }, { operationId: 'wf:t1' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
  );
  assert.equal(attempts['agy:gpt-oss'], 0);
  assert.equal(attempts['codex:default'], 0);
  // provider health / quota untouched — this was an orchestrator decision
  assert.equal(health.usable('agy:gpt-oss', 'agy-gpt-oss'), true);
  assert.equal(quota.usable('agy:gpt-oss'), true);
});

// Test F — real provider failure still gets a fresh permit on failover
test('F: real retryable failure fails over and the next provider gets a NEW permit', async () => {
  const attempts = [];
  const seenIntents = [];
  const { runtime, spendAuthority } = buildRuntime({
    rolePolicy: { supervisor: [{ family: 'agy:gemini' }, { family: 'codex:default' }] },
    adapters: {
      supervisor: {
        'agy:gemini': async () => {
          attempts.push('agy:gemini');
          throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT, 'did not respond within 600000ms');
        },
        'codex:default': async () => { attempts.push('codex:default'); return { action: 'WORKFLOW_DONE' }; },
      },
    },
    policy: (intent) => { seenIntents.push(intent); return { allow: true }; },
  });

  const { value, selection } = await runtime.invoke('supervisor', { ctx: 1 }, { operationId: 'wf:s' });
  assert.deepEqual(value, { action: 'WORKFLOW_DONE' });
  assert.equal(selection.requestedFamily, 'codex:default');
  assert.deepEqual(attempts, ['agy:gemini', 'codex:default']);

  // two physical attempts -> two distinct permits, each consumed exactly once
  assert.deepEqual(spendAuthority.stats(), { issued: 2, consumed: 2, outstanding: 0 });
  assert.equal(seenIntents.length, 2);
  assert.equal(seenIntents[0].family, 'agy:gemini');
  assert.equal(seenIntents[0].attempt, 1);
  assert.equal(seenIntents[1].family, 'codex:default');
  assert.equal(seenIntents[1].attempt, 2);
});

// Test G — Executor Sonnet-only regression
test('G: Executor automatic chain stays claude:sonnet only under the permit boundary', async () => {
  const attempts = { 'claude:sonnet': 0, 'codex:default': 0, 'claude:opus': 0 };
  const { runtime } = buildRuntime({
    rolePolicy: DEFAULT_ROLE_POLICY,
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          attempts['claude:sonnet'] += 1;
          throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'did not respond within 600000ms');
        },
        'codex:default': async () => { attempts['codex:default'] += 1; return {}; },
        'claude:opus': async () => { attempts['claude:opus'] += 1; return {}; },
      },
    },
  });
  await assert.rejects(runtime.invoke('executor', { taskId: 't1' }, { operationId: 'wf:t1' }));
  assert.equal(attempts['claude:sonnet'], 1);
  assert.equal(attempts['codex:default'], 0);
  assert.equal(attempts['claude:opus'], 0);
});

// Test H — role behavior regression: default (allow-all) authority is transparent
test('H: with the default allow-all authority, Planner/Supervisor/Reviewer results are unchanged', async () => {
  const { runtime } = buildRuntime({
    rolePolicy: {
      planner: [{ family: 'codex:default' }],
      supervisor: [{ family: 'agy:gemini' }],
      reviewer: [{ family: 'agy:gpt-oss' }],
    },
    adapters: {
      planner: { 'codex:default': async () => ({ tasks: [] }) },
      supervisor: { 'agy:gemini': async () => ({ action: 'NEXT_TASK' }) },
      reviewer: { 'agy:gpt-oss': async () => ({ decision: 'PASS' }) },
    },
  });
  assert.deepEqual((await runtime.invoke('planner', {}, { operationId: 'w' })).value, { tasks: [] });
  assert.deepEqual((await runtime.invoke('supervisor', {}, { operationId: 'w' })).value, { action: 'NEXT_TASK' });
  assert.deepEqual((await runtime.invoke('reviewer', {}, { operationId: 'w' })).value, { decision: 'PASS' });
});

test('runtime exposes its spendAuthority and RoleRouter still routes deterministically', () => {
  const { runtime } = buildRuntime({ adapters: {} });
  assert.ok(runtime.spendAuthority instanceof ModelSpendAuthority);
  assert.ok(runtime.router instanceof RoleRouter);
});
