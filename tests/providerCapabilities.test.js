// Deterministic, zero-model Provider Capability Policy. REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_CAPABILITIES,
  CAPABILITY_TIERS,
  getProviderCapabilities,
  isExecutorEligible,
} from '../src/orchestrator/providerCapabilities.js';
import { RoleRouter, QuotaPoolRegistry, ProviderHealthRegistry, DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES } from '../src/orchestrator/roleRouting.js';

test('Sonnet is executor-eligible', () => {
  assert.equal(isExecutorEligible('claude:sonnet'), true);
  assert.equal(getProviderCapabilities('claude:sonnet').executorEligible, true);
});

test('Codex is not executor-eligible', () => {
  assert.equal(isExecutorEligible('codex:default'), false);
  assert.equal(getProviderCapabilities('codex:default').executorEligible, false);
});

test('Claude Opus is not executor-eligible', () => {
  assert.equal(isExecutorEligible('claude:opus'), false);
  assert.equal(getProviderCapabilities('claude:opus').executorEligible, false);
});

test('an unknown/unregistered family fails closed: never auto-eligible', () => {
  assert.equal(isExecutorEligible('made-up:family'), false);
  assert.equal(isExecutorEligible(undefined), false);
  assert.equal(isExecutorEligible(''), false);
  assert.equal(getProviderCapabilities('made-up:family'), null);
});

test('a SOFT capability is never reported under a hard-enforcement tier', () => {
  const codex = getProviderCapabilities('codex:default');
  assert.equal(codex.soft.reasoningEffort.tier, CAPABILITY_TIERS.SOFT);
  // The same control must not also appear as HARD_LIVE / PRE_DISPATCH / POST_RUN.
  assert.notEqual(codex.live.maxTurns.tier, CAPABILITY_TIERS.SOFT);
  for (const [key, f] of Object.entries(codex.live)) {
    if (key === 'runtimeLimit') continue; // provably HARD_LIVE for codex
    assert.equal(f.tier, CAPABILITY_TIERS.UNAVAILABLE, `${key} must not be claimed as a hard limit without proof`);
  }
});

test('unprovable Claude membership/subscription budget protection is UNAVAILABLE, not a hard guarantee', () => {
  for (const family of ['claude:sonnet', 'claude:opus']) {
    const record = getProviderCapabilities(family);
    assert.equal(record.live.providerBudget.tier, CAPABILITY_TIERS.UNAVAILABLE);
  }
});

test('capability records are immutable', () => {
  const sonnet = getProviderCapabilities('claude:sonnet');
  assert.throws(() => { sonnet.executorEligible = false; });
  assert.throws(() => { sonnet.live.maxTurns = { tier: 'HARD_LIVE', value: 1 }; });
  assert.ok(Object.isFrozen(sonnet));
  assert.ok(Object.isFrozen(sonnet.live));
  assert.ok(Object.isFrozen(sonnet.live.maxTurns));
  assert.ok(Object.isFrozen(PROVIDER_CAPABILITIES));
});

test('capability lookups are deterministic across repeated calls', () => {
  const a = getProviderCapabilities('claude:sonnet');
  const b = getProviderCapabilities('claude:sonnet');
  assert.deepEqual(a, b);
  assert.equal(isExecutorEligible('codex:default'), isExecutorEligible('codex:default'));
});

test('existing routing behaviour for decision roles (planner/supervisor/reviewer) does not regress', () => {
  // The capability policy module is additive: RoleRouter still routes
  // planner/supervisor/reviewer purely off DEFAULT_ROLE_POLICY /
  // PRODUCTION_ROLE_CAPABILITIES, unaffected by executorEligible.
  const resolveFamily = (family) => ({
    requestedFamily: family,
    resolvedModel: null,
    provider: family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
  });
  const router = new RoleRouter({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
  });
  const planner = router.route('planner');
  assert.equal(planner.requestedFamily, 'codex:default');
  const supervisor = router.route('supervisor');
  assert.equal(supervisor.requestedFamily, 'agy:gemini');
  const reviewer = router.route('reviewer');
  assert.equal(reviewer.requestedFamily, 'agy:gpt-oss');
  const executor = router.route('executor');
  assert.equal(executor.requestedFamily, 'claude:sonnet');
});
