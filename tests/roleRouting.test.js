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

const REVIEWER_ORDER = ['agy:gemini-reviewer', 'codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus'];
const SUPERVISOR_ORDER = ['agy:gemini-supervisor', 'codex:default', 'agy:sonnet', 'claude:opus'];

test('active roles are exactly supervisor + reviewer — no planner, no executor', () => {
  assert.deepEqual(Object.keys(DEFAULT_ROLE_POLICY).sort(), ['reviewer', 'supervisor']);
  assert.equal('planner' in DEFAULT_ROLE_POLICY, false);
  assert.equal('executor' in DEFAULT_ROLE_POLICY, false);
  // Final fixed deterministic routing.
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), REVIEWER_ORDER);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), SUPERVISOR_ORDER);
  // The Reviewer Gemini head carries the fixed low effort; the Supervisor head medium.
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.find((c) => c.family === 'agy:gemini-reviewer').effort, 'low');
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.find((c) => c.family === 'agy:gemini-supervisor').effort, 'medium');
  // No family is high-context any more (all AGY families run reviewloop-minimal).
  for (const role of ['reviewer', 'supervisor']) {
    for (const c of DEFAULT_ROLE_POLICY[role]) assert.notEqual(c.highContext, true);
  }
  // GPT-OSS is a deliberate low-cost Reviewer fallback (not degraded). It is
  // NOT a Supervisor candidate: its live certification passed transport /
  // accounting / isolation but its decision output violated the Supervisor
  // schema, so it was removed from the Supervisor production pool.
  assert.notEqual(DEFAULT_ROLE_POLICY.reviewer.find((c) => c.family === 'agy:gpt-oss').degraded, true);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.some((c) => c.family === 'agy:gpt-oss'), false);
  // Neither Gemini head appears in the other role's pool.
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.some((c) => c.family === 'agy:gemini-supervisor'), false);
  assert.equal(DEFAULT_ROLE_POLICY.supervisor.some((c) => c.family === 'agy:gemini-reviewer'), false);
});

test('production capabilities are role-scoped as declared', () => {
  const ROLE_SCOPED = {
    'agy:gpt-oss': ['reviewer'],
    'agy:gemini-reviewer': ['reviewer'],
    'agy:gemini-supervisor': ['supervisor'],
  };
  for (const [family, roles] of Object.entries(PRODUCTION_ROLE_CAPABILITIES)) {
    const expected = ROLE_SCOPED[family] ?? ['reviewer', 'supervisor'];
    assert.deepEqual([...roles].sort(), [...expected].sort(), family);
  }
  assert.equal(supportsProductionRole('codex:default', 'reviewer'), true);
  assert.equal(supportsProductionRole('claude:opus', 'supervisor'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'reviewer'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'supervisor'), false);
  assert.equal(supportsProductionRole('agy:gemini-reviewer', 'supervisor'), false);
  assert.equal(supportsProductionRole('agy:gemini-supervisor', 'reviewer'), false);
  assert.equal(supportsProductionRole('codex:default', 'executor'), false);
  assert.equal(supportsProductionRole('codex:default', 'planner'), false);
});

test('fixed routing: every candidate is reachable when each earlier one fails', () => {
  const rHealth = new ProviderHealthRegistry();
  const r = () => new RoleRouter({ providerHealth: rHealth, resolveFamily: resolver }).route('reviewer')?.requestedFamily ?? null;
  for (const expected of REVIEWER_ORDER) {
    assert.equal(r(), expected);
    rHealth.record(expected, 'UNAVAILABLE');
  }
  assert.equal(r(), null);

  const sHealth = new ProviderHealthRegistry();
  const s = () => new RoleRouter({ providerHealth: sHealth, resolveFamily: resolver }).route('supervisor')?.requestedFamily ?? null;
  for (const expected of SUPERVISOR_ORDER) {
    assert.equal(s(), expected);
    sHealth.record(expected, 'UNAVAILABLE');
  }
  assert.equal(s(), null); // pool exhausted — agy:gpt-oss is NOT a Supervisor candidate
});

test('agy:gpt-oss is never routed as Supervisor even when every other family is down', () => {
  const sHealth = new ProviderHealthRegistry();
  for (const f of SUPERVISOR_ORDER) sHealth.record(f, 'UNAVAILABLE');
  const sel = new RoleRouter({ providerHealth: sHealth, resolveFamily: resolver }).route('supervisor');
  assert.equal(sel, null);
  // but it IS still a Reviewer candidate
  const rHealth = new ProviderHealthRegistry();
  rHealth.record('agy:gemini-reviewer', 'UNAVAILABLE');
  rHealth.record('codex:default', 'UNAVAILABLE');
  rHealth.record('agy:sonnet', 'UNAVAILABLE');
  assert.equal(
    new RoleRouter({ providerHealth: rHealth, resolveFamily: resolver }).route('reviewer').requestedFamily,
    'agy:gpt-oss',
  );
});

test('the two Gemini heads share one agy-gemini quota pool; agy:sonnet + agy:gpt-oss share another', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('agy:sonnet'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gpt-oss'), ['agy-claude-gpt']);
  assert.deepEqual(quota.poolsFor('agy:gemini-reviewer'), ['agy-gemini']);
  assert.deepEqual(quota.poolsFor('agy:gemini-supervisor'), ['agy-gemini']);

  // A Gemini quota-exhaustion cooldown on either role head takes BOTH out of
  // routing — one shared pool, one shared cooldown.
  quota.recordProviderFailure('agy:gemini-reviewer', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(quota.usable('agy:gemini-reviewer'), false);
  assert.equal(quota.usable('agy:gemini-supervisor'), false);
  assert.equal(quota.usable('agy:sonnet'), true);

  // conversely, a Claude&GPT cooldown does not touch the Gemini pool
  const quota2 = new QuotaPoolRegistry({ filePath: null });
  quota2.recordProviderFailure('agy:sonnet', { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  assert.equal(quota2.usable('agy:sonnet'), false);
  assert.equal(quota2.usable('agy:gpt-oss'), false);
  assert.equal(quota2.usable('agy:gemini-reviewer'), true);
  assert.equal(quota2.usable('agy:gemini-supervisor'), true);
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
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gemini-reviewer');
  health.record('agy:gemini-reviewer', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'codex:default');
});

test('quota topology no longer references claude:sonnet', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  assert.deepEqual(quota.poolsFor('claude:sonnet'), []);
});
