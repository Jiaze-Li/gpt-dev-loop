import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  RoleRouter,
  ProviderHealthRegistry,
  supportsProductionRole,
} from '../src/orchestrator/roleRouting.js';

const resolver = (family) => ({
  requestedFamily: family,
  resolvedModel: `${family}-runtime`,
  provider: family.split(':')[0],
  capabilities: { supportsReasoningEffort: true, supportedEfforts: ['medium', 'high'], roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

test('active roles are exactly supervisor + reviewer — no planner, no executor', () => {
  assert.deepEqual(Object.keys(DEFAULT_ROLE_POLICY).sort(), ['reviewer', 'supervisor']);
  assert.equal('planner' in DEFAULT_ROLE_POLICY, false);
  assert.equal('executor' in DEFAULT_ROLE_POLICY, false);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor[0].family, 'agy:gemini');
  assert.equal(DEFAULT_ROLE_POLICY.reviewer[0].family, 'agy:gpt-oss');
});

test('production capabilities declare only supervisor/reviewer protocols', () => {
  for (const [family, roles] of Object.entries(PRODUCTION_ROLE_CAPABILITIES)) {
    assert.deepEqual([...roles].sort(), ['reviewer', 'supervisor'], family);
  }
  assert.equal(supportsProductionRole('codex:default', 'reviewer'), true);
  assert.equal(supportsProductionRole('claude:opus', 'supervisor'), true);
  assert.equal(supportsProductionRole('codex:default', 'executor'), false);
  assert.equal(supportsProductionRole('codex:default', 'planner'), false);
});

test('Gemini cooldown fails supervisor over to codex; reviewer stays on gpt-oss', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordCooldown('agy-gemini');
  const router = new RoleRouter({ quotaRegistry: quota, resolveFamily: resolver });
  assert.equal(router.route('supervisor').requestedFamily, 'codex:default');
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gpt-oss');
});

test('reset expiry becomes UNKNOWN', () => {
  let now = 1000;
  const quota = new QuotaPoolRegistry({ filePath: null, now: () => now });
  quota.recordCooldown('codex', { resetAt: new Date(1100).toISOString() });
  now = 1200;
  assert.equal(quota.get('codex').status, 'UNKNOWN');
});

test('provider health failure removes a family without touching policy', () => {
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({ providerHealth: health, resolveFamily: resolver });
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gpt-oss');
  health.record('agy:gpt-oss', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'codex:default');
});

test('quota topology no longer references claude:sonnet', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('claude:sonnet'), []);
});
