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
  // Final fixed deterministic routing.
  assert.deepEqual(
    DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family),
    ['codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus'],
  );
  assert.deepEqual(
    DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family),
    ['agy:gemini', 'codex:default', 'agy:sonnet', 'claude:opus'],
  );
  // No family is high-context any more (all AGY families run reviewloop-minimal).
  for (const role of ['reviewer', 'supervisor']) {
    for (const c of DEFAULT_ROLE_POLICY[role]) assert.notEqual(c.highContext, true);
  }
  // GPT-OSS is a deliberate low-cost 3rd Reviewer fallback (not degraded). It is
  // NOT a Supervisor candidate: its live certification passed transport /
  // accounting / isolation but its decision output violated the Supervisor
  // schema, so it was removed from the Supervisor production pool.
  assert.notEqual(DEFAULT_ROLE_POLICY.reviewer.find((c) => c.family === 'agy:gpt-oss').degraded, true);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.some((c) => c.family === 'agy:gpt-oss'), false);
});

test('production capabilities declare only supervisor/reviewer protocols', () => {
  for (const [family, roles] of Object.entries(PRODUCTION_ROLE_CAPABILITIES)) {
    // agy:gpt-oss is Reviewer-only (Supervisor decision-schema failure).
    const expected = family === 'agy:gpt-oss' ? ['reviewer'] : ['reviewer', 'supervisor'];
    assert.deepEqual([...roles].sort(), expected, family);
  }
  assert.equal(supportsProductionRole('codex:default', 'reviewer'), true);
  assert.equal(supportsProductionRole('claude:opus', 'supervisor'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'reviewer'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'supervisor'), false);
  assert.equal(supportsProductionRole('codex:default', 'executor'), false);
  assert.equal(supportsProductionRole('codex:default', 'planner'), false);
});

test('fixed routing: every candidate is reachable when each earlier one fails', () => {
  // Reviewer: codex -> agy:sonnet -> agy:gpt-oss -> claude:opus
  const rHealth = new ProviderHealthRegistry();
  const r = () => new RoleRouter({ providerHealth: rHealth, resolveFamily: resolver }).route('reviewer').requestedFamily;
  assert.equal(r(), 'codex:default');
  rHealth.record('codex:default', 'UNAVAILABLE');
  assert.equal(r(), 'agy:sonnet');
  rHealth.record('agy:sonnet', 'UNAVAILABLE');
  assert.equal(r(), 'agy:gpt-oss');
  rHealth.record('agy:gpt-oss', 'UNAVAILABLE');
  assert.equal(r(), 'claude:opus');

  // Supervisor: agy:gemini -> codex -> agy:sonnet -> claude:opus (then exhausted)
  const sHealth = new ProviderHealthRegistry();
  const s = () => new RoleRouter({ providerHealth: sHealth, resolveFamily: resolver }).route('supervisor');
  assert.equal(s().requestedFamily, 'agy:gemini');
  sHealth.record('agy:gemini', 'UNAVAILABLE');
  assert.equal(s().requestedFamily, 'codex:default');
  sHealth.record('codex:default', 'UNAVAILABLE');
  assert.equal(s().requestedFamily, 'agy:sonnet');
  sHealth.record('agy:sonnet', 'UNAVAILABLE');
  assert.equal(s().requestedFamily, 'claude:opus');
  sHealth.record('claude:opus', 'UNAVAILABLE');
  assert.equal(s(), null); // pool exhausted — agy:gpt-oss is NOT a Supervisor candidate
});

test('agy:gpt-oss is never routed as Supervisor even when every other family is down', () => {
  const sHealth = new ProviderHealthRegistry();
  for (const f of ['agy:gemini', 'codex:default', 'agy:sonnet', 'claude:opus']) sHealth.record(f, 'UNAVAILABLE');
  const sel = new RoleRouter({ providerHealth: sHealth, resolveFamily: resolver }).route('supervisor');
  assert.equal(sel, null);
  // but it IS still the third Reviewer candidate
  const rHealth = new ProviderHealthRegistry();
  rHealth.record('codex:default', 'UNAVAILABLE');
  rHealth.record('agy:sonnet', 'UNAVAILABLE');
  assert.equal(
    new RoleRouter({ providerHealth: rHealth, resolveFamily: resolver }).route('reviewer').requestedFamily,
    'agy:gpt-oss',
  );
});

test('agy:sonnet + agy:gpt-oss share one quota pool; agy:gemini is separate', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('agy:sonnet'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gpt-oss'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gemini'), ['agy-gemini']);

  // A quota-exhaustion cooldown on agy:sonnet takes agy:gpt-oss out of routing
  // too — no wasted probe call on the sibling that shares the exhausted pool.
  quota.recordProviderFailure('agy:sonnet', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(quota.usable('agy:sonnet'), false);
  assert.equal(quota.usable('agy:gpt-oss'), false);
  assert.equal(quota.usable('agy:gemini'), true);

  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  health.record('codex:default', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'claude:opus');
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
  assert.equal(router.route('reviewer').requestedFamily, 'codex:default');
  health.record('codex:default', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'agy:sonnet');
});

test('quota topology no longer references claude:sonnet', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('claude:sonnet'), []);
});
