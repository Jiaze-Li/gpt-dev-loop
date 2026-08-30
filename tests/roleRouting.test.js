import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry, RoleRouter, ProviderHealthRegistry, supportsProductionRole } from '../src/orchestrator/roleRouting.js';

const resolver = (family) => ({ requestedFamily: family, resolvedModel: `${family}-runtime`, provider: family.split(':')[0], capabilities: { supportsReasoningEffort: true, supportedEfforts: ['medium', 'high'] } });

test('role policy uses stable families and primary roles distribute pools', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.planner.map((x) => x.family), ['codex:default', 'agy:gemini', 'claude:opus', 'agy:gpt-oss']);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor[0].family, 'agy:gemini');
  assert.equal(DEFAULT_ROLE_POLICY.reviewer[0].family, 'agy:gpt-oss');
  assert.equal(DEFAULT_ROLE_POLICY.executor[0].family, 'claude:sonnet');
});

test('production capability declarations name real role protocol adapters only', () => {
  assert.deepEqual(PRODUCTION_ROLE_CAPABILITIES['codex:default'], ['planner', 'supervisor', 'reviewer', 'executor']);
  assert.deepEqual(PRODUCTION_ROLE_CAPABILITIES['agy:gemini'], ['planner', 'supervisor', 'reviewer']);
  assert.deepEqual(PRODUCTION_ROLE_CAPABILITIES['agy:gpt-oss'], ['planner', 'supervisor', 'reviewer']);
  assert.deepEqual(PRODUCTION_ROLE_CAPABILITIES['claude:sonnet'], ['executor']);
  assert.deepEqual(PRODUCTION_ROLE_CAPABILITIES['claude:opus'], ['planner', 'supervisor', 'reviewer', 'executor']);
  assert.equal(supportsProductionRole('codex:default', 'reviewer'), true);
  assert.equal(supportsProductionRole('claude:opus', 'supervisor'), true);
  assert.equal(supportsProductionRole('claude:sonnet', 'supervisor'), false);
  assert.equal(supportsProductionRole('agy:gemini', 'executor'), false);
});

test('capability filtering skips unsupported candidates before a quota-eligible fallback', () => {
  const events = [];
  const quota = new QuotaPoolRegistry({ filePath: null });
  const router = new RoleRouter({
    rolePolicy: {
      supervisor: [{ family: 'claude:sonnet' }, { family: 'agy:gemini' }],
    },
    quotaRegistry: quota,
    onEvent: (event) => events.push(event),
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.split(':')[0],
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
    }),
  });
  const selected = router.route('supervisor');
  assert.equal(selected.requestedFamily, 'agy:gemini');
  assert.deepEqual(events.filter((event) => event.type === 'ROLE_ROUTE_SKIPPED').map((event) => [event.candidate, event.reason]), [
    ['claude:sonnet', 'capability'],
  ]);
});

test('Gemini cooldown skips Supervisor but not GPT-OSS reviewer', () => {
  const quota = new QuotaPoolRegistry({ filePath: null }); quota.recordCooldown('agy-gemini');
  const router = new RoleRouter({ quotaRegistry: quota, resolveFamily: resolver });
  assert.equal(router.route('supervisor').requestedFamily, 'codex:default');
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gpt-oss');
});

test('Claude shared cooldown skips Sonnet and Opus', () => {
  const quota = new QuotaPoolRegistry({ filePath: null }); quota.recordCooldown('claude');
  const router = new RoleRouter({ quotaRegistry: quota, resolveFamily: resolver });
  assert.equal(router.route('executor').requestedFamily, 'codex:default');
});

test('reset expiry becomes UNKNOWN and can receive a genuine business call', () => {
  let now = 1000; const quota = new QuotaPoolRegistry({ filePath: null, now: () => now });
  quota.recordCooldown('codex', { resetAt: new Date(1100).toISOString() }); now = 1200;
  assert.equal(quota.get('codex').status, 'UNKNOWN');
});

test('quota failure fails over instead of escalating effort; reasoning signals may escalate effort', () => {
  const quota = new QuotaPoolRegistry({ filePath: null }); const router = new RoleRouter({ quotaRegistry: quota, resolveFamily: resolver });
  const selected = router.route('supervisor', { reasoningFailures: 1 });
  assert.equal(selected.effort, 'high');
  router.recordFailure(selected, { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(router.route('supervisor').requestedFamily, 'codex:default');
});

test('resolution changes do not change family policy and health remains independent', () => {
  let concrete = 'sonnet-old'; const health = new ProviderHealthRegistry(); const events = [];
  const router = new RoleRouter({ providerHealth: health, onEvent: (event) => events.push(event), resolveFamily: (family) => ({ requestedFamily: family, resolvedModel: family === 'claude:sonnet' ? concrete : family, provider: family.split(':')[0], capabilities: {} }) });
  assert.equal(router.route('executor').resolvedModel, 'sonnet-old'); concrete = 'sonnet-new';
  assert.equal(router.route('executor').resolvedModel, 'sonnet-new');
  assert.equal(events.some((event) => event.type === 'MODEL_RESOLVED_CHANGED'), true);
  health.record('claude', 'UNAVAILABLE'); assert.equal(router.route('executor').requestedFamily, 'codex:default');
});
