// ModelSpendAuthority enforces provider/role eligibility as a built-in
// invariant ahead of any injected policy, and REGARDLESS of what rolePolicy
// routed the CallIntent here. Eligibility is decided by an explicit
// `providerCapabilities` source (default: the production Provider
// Capability Policy in providerCapabilities.js — Sonnet-only Executor).
// There is no bypass flag: only test fixtures inject a permissive
// TEST-ONLY source, to exercise the generic multi-provider failover
// mechanism productionRoleRuntime still supports.
//
// All mock / deterministic. REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { AuthorizationError, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { isExecutorEligible } from '../src/orchestrator/providerCapabilities.js';

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

function buildRuntime({ rolePolicy, adapters, onEvent, spendAuthority } = {}) {
  return createProductionRoleRuntime({
    rolePolicy: rolePolicy ?? DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
    adapters,
    onEvent,
    ...(spendAuthority ? { spendAuthority } : {}),
  });
}

// ── A. production default ──────────────────────────────────────────────

test('A: production default — Sonnet Executor authorizes', () => {
  const authority = new ModelSpendAuthority();
  const permit = authority.authorize({ role: 'executor', family: 'claude:sonnet', provider: 'claude', operationId: 'op', attempt: 1 });
  assert.ok(permit);
});

test('A: production default — Codex Executor is denied, 0 physical calls', async () => {
  let dispatched = 0;
  const runtime = buildRuntime({
    rolePolicy: { executor: [{ family: 'codex:default' }] },
    adapters: { executor: { 'codex:default': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf:t1' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
  );
  assert.equal(dispatched, 0);
});

test('A: production default — Claude Opus Executor is denied, 0 physical calls', async () => {
  let dispatched = 0;
  const runtime = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:opus' }] },
    adapters: { executor: { 'claude:opus': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(
    runtime.invoke('executor', {}, { operationId: 'wf:t1' }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
  );
  assert.equal(dispatched, 0);
});

test('A: production default — AGY Executor is denied', () => {
  const authority = new ModelSpendAuthority();
  for (const family of ['agy:gemini', 'agy:gpt-oss']) {
    assert.throws(
      () => authority.authorize({ role: 'executor', family, provider: family.replace(':', '-'), operationId: 'op', attempt: 1 }),
      (err) => err instanceof AuthorizationError && err.code === AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
    );
  }
});

test('A: Planner/Reviewer/Supervisor on codex/agy are unaffected by executor eligibility', () => {
  const authority = new ModelSpendAuthority();
  for (const role of ['planner', 'supervisor', 'reviewer']) {
    for (const family of ['codex:default', 'agy:gemini', 'agy:gpt-oss', 'claude:opus']) {
      const permit = authority.authorize({ role, family, provider: family.split(':')[0], operationId: 'op', attempt: 1 });
      assert.ok(permit, `${role}/${family} should not be denied by executor eligibility`);
    }
  }
});

// ── B. generic runtime with explicit TEST capability policy ────────────

test('B: an explicit TEST-ONLY capability source allows sonnet -> codex -> opus failover, each attempt with a fresh permit', async () => {
  const testOnlyPermissive = { isExecutorEligible: (family) => ['claude:sonnet', 'codex:default', 'claude:opus'].includes(family) };
  const spendAuthority = new ModelSpendAuthority({ providerCapabilities: testOnlyPermissive });
  const attempted = [];
  const runtime = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }, { family: 'claude:opus' }] },
    spendAuthority,
    adapters: {
      executor: {
        'claude:sonnet': async () => { attempted.push('claude:sonnet'); throw Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' }); },
        'codex:default': async () => { attempted.push('codex:default'); throw Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' }); },
        'claude:opus': async () => { attempted.push('claude:opus'); return 'ok'; },
      },
    },
  });
  const result = await runtime.invoke('executor', {}, { operationId: 'wf:t1' });
  assert.equal(result.value, 'ok');
  assert.deepEqual(attempted, ['claude:sonnet', 'codex:default', 'claude:opus']);
  // Fresh authorize + fresh permit per physical attempt — none reused.
  assert.deepEqual(spendAuthority.stats(), { issued: 3, consumed: 3, outstanding: 0 });
});

test('B: production isExecutorEligible is untouched by a TEST-ONLY authority instance elsewhere', () => {
  const testOnlyPermissive = { isExecutorEligible: () => true };
  // eslint-disable-next-line no-unused-vars
  const testAuthority = new ModelSpendAuthority({ providerCapabilities: testOnlyPermissive });
  // The module-level production policy function is a pure, stateless
  // lookup — instantiating a permissive test authority must not mutate it.
  assert.equal(isExecutorEligible('codex:default'), false);
  assert.equal(isExecutorEligible('claude:opus'), false);
  assert.equal(isExecutorEligible('claude:sonnet'), true);
});

// ── C. safety ────────────────────────────────────────────────────────

test('C: a custom rolePolicy alone cannot let Codex Executor bypass eligibility (no capability override)', async () => {
  let dispatched = 0;
  const runtime = buildRuntime({
    rolePolicy: { executor: [{ family: 'codex:default' }] }, // custom rolePolicy, DEFAULT (production) capabilities
    adapters: { executor: { 'codex:default': async () => { dispatched += 1; return 'never'; } } },
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf:t1' }));
  assert.equal(dispatched, 0);
});

test('C: authorization denial performs no failover, no health penalty, no quota mutation, no bypass', async () => {
  const events = [];
  let dispatched = 0;
  const runtime = buildRuntime({
    // Codex is ineligible; Sonnet, listed second, must NEVER be tried
    // automatically after a PROVIDER_NOT_ELIGIBLE_FOR_ROLE denial —
    // authorization failure aborts the whole invocation immediately.
    rolePolicy: { executor: [{ family: 'codex:default' }, { family: 'claude:sonnet' }] },
    adapters: {
      executor: {
        'codex:default': async () => { dispatched += 1; return 'never'; },
        'claude:sonnet': async () => { dispatched += 1; return 'never-either'; },
      },
    },
    onEvent: (e) => events.push(e),
  });
  await assert.rejects(runtime.invoke('executor', {}, { operationId: 'wf:t1' }));
  assert.equal(dispatched, 0);
  assert.equal(runtime.providerHealth.usable('codex:default', 'codex'), true, 'authorization denial must not penalize provider health');
  const failureEvents = events.filter((e) => e.type === 'ROLE_INVOCATION_FAILED' || e.type === 'ROLE_PROVIDER_FAILED');
  assert.equal(failureEvents.length, 0, 'authorization denial is not a provider failure event');
  const deniedEvents = events.filter((e) => e.type === 'ROLE_INVOCATION_DENIED');
  assert.equal(deniedEvents.length, 1);
});

test('C: end-to-end via productionRoleRuntime — Claude Sonnet Executor dispatches normally', async () => {
  let dispatched = 0;
  const runtime = buildRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    adapters: { executor: { 'claude:sonnet': async () => { dispatched += 1; return 'ok'; } } },
  });
  const result = await runtime.invoke('executor', {}, { operationId: 'wf:t1' });
  assert.equal(result.value, 'ok');
  assert.equal(dispatched, 1);
});

test('the eligibility invariant cannot be bypassed by an injected allow-all `policy` callback', () => {
  const authority = new ModelSpendAuthority({ policy: () => ({ allow: true }) });
  assert.throws(
    () => authority.authorize({ role: 'executor', family: 'codex:default', provider: 'codex', operationId: 'op', attempt: 1 }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
  );
});

test('capability records are immutable and deterministic (regression guard for providerCapabilities.js)', () => {
  assert.equal(isExecutorEligible('claude:sonnet'), true);
  assert.equal(isExecutorEligible('codex:default'), false);
  assert.equal(isExecutorEligible('claude:opus'), false);
  assert.equal(isExecutorEligible('made-up:family'), false);
});
