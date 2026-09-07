// Final Reviewer / Supervisor provider pool: structural completeness + full
// deterministic failover traversal. ZERO real model/provider calls — every
// route is a real RoleRouter decision and every transport is a fake function.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROLE_POLICY,
  DEFAULT_QUOTA_TOPOLOGY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { MODEL_FAMILY_REGISTRY, resolveModelFamily } from '../src/orchestrator/modelFamilyResolver.js';
import { getProviderCapabilities } from '../src/orchestrator/providerCapabilities.js';
import { accountingClassOf } from '../src/reviewloop/reviewSpend.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MINIMAL_AGY_AGENT_NAME } from '../src/reviewloop/adapters/minimalAgyAgent.js';
import { MemoryPersistence, finding } from './helpers/reviewLoopHarness.js';

const REVIEWER_ORDER = ['codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus'];
const SUPERVISOR_ORDER = ['agy:gemini', 'codex:default', 'agy:sonnet', 'claude:opus', 'agy:gpt-oss'];

const resolver = (family) => ({
  requestedFamily: family,
  resolvedModel: resolveModelFamily(family, { env: {}, agyCatalog: null }).resolvedModel,
  provider: MODEL_FAMILY_REGISTRY[family]?.provider ?? family.split(':')[0],
  capabilities: {
    roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [],
    supportsReasoningEffort: false,
    supportedEfforts: ['medium'],
  },
});

// ---- 1. fixed order -----------------------------------------------------

test('final fixed routing order (no risk-based selection)', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), REVIEWER_ORDER);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), SUPERVISOR_ORDER);
});

// ---- 2. pool-completeness invariant -----------------------------------

test('every DEFAULT_ROLE_POLICY candidate is fully wired (no phantom fallback)', () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({ text: '{"findings":[]}' }),
    transportRuntime: {
      'codex:default': { available: true, reason: 'ok' },
      'claude:opus': { available: true, reason: 'ok' },
    },
  });
  for (const role of ['reviewer', 'supervisor']) {
    for (const cand of DEFAULT_ROLE_POLICY[role]) {
      const f = cand.family;
      assert.ok(MODEL_FAMILY_REGISTRY[f], `${f}: in MODEL_FAMILY_REGISTRY`);
      assert.ok(
        (PRODUCTION_ROLE_CAPABILITIES[f] ?? []).includes(role),
        `${f}: PRODUCTION_ROLE_CAPABILITIES declares ${role}`,
      );
      assert.ok(
        (DEFAULT_QUOTA_TOPOLOGY[f] ?? []).length > 0,
        `${f}: has a quota topology`,
      );
      assert.ok(getProviderCapabilities(f), `${f}: has a provider-capability record`);
      assert.equal(accountingClassOf({ family: f }) !== 'unknown', true, `${f}: accounting class known`);
      assert.equal(typeof pool.transports[f], 'function', `${f}: has a wired transport`);
      assert.ok(pool.runtimeStatus[f], `${f}: reports a runtime status`);
      assert.equal(pool.runtimeStatus[f].runtimeAvailable, true, `${f}: runtime available`);
    }
  }
});

test('every AGY policy family runs through the reviewloop-minimal agent', async () => {
  const seen = [];
  const pool = createReviewLoopProviderPool({
    callAgy: async (opts) => { seen.push(opts); return { text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const agyFamilies = [...new Set([...REVIEWER_ORDER, ...SUPERVISOR_ORDER])].filter((f) => f.startsWith('agy:'));
  assert.deepEqual(agyFamilies.sort(), ['agy:gemini', 'agy:gpt-oss', 'agy:sonnet']);
  for (const f of agyFamilies) {
    await pool.transports[f]('P');
  }
  assert.equal(seen.length, agyFamilies.length);
  for (const opts of seen) {
    assert.equal(opts.agent, MINIMAL_AGY_AGENT_NAME);
    assert.equal(opts.disableSlashCommands, true);
  }
});

// ---- 3. route()-level full traversal ---------------------------------

test('route(): Reviewer traverses all 4 candidates', () => {
  const health = new ProviderHealthRegistry();
  const pick = () => new RoleRouter({ providerHealth: health, resolveFamily: resolver }).route('reviewer')?.requestedFamily ?? null;
  for (const expected of REVIEWER_ORDER) {
    assert.equal(pick(), expected);
    health.record(expected, 'UNAVAILABLE');
  }
  assert.equal(pick(), null); // pool exhausted, no phantom
});

test('route(): Supervisor traverses all 5 candidates; 5th is degraded', () => {
  const health = new ProviderHealthRegistry();
  const pick = () => new RoleRouter({ providerHealth: health, resolveFamily: resolver }).route('supervisor');
  for (let i = 0; i < SUPERVISOR_ORDER.length; i += 1) {
    const sel = pick();
    assert.equal(sel.requestedFamily, SUPERVISOR_ORDER[i]);
    if (i === SUPERVISOR_ORDER.length - 1) assert.equal(sel.degraded, true);
    health.record(SUPERVISOR_ORDER[i], 'UNAVAILABLE');
  }
  assert.equal(pick(), null);
});

// ---- 4. execution-level failover through meteredWithFailover ---------

function reviewerController({ persistence, failures, quota = new QuotaPoolRegistry({ filePath: null }) }) {
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const tried = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals) => {
      const s = router.route('reviewer', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => router.recordFailure(
      { role: 'reviewer', requestedFamily: sel.family, provider: sel.provider }, f,
    ),
    reviewerFn: async ({ selection }) => {
      tried.push(selection.family);
      const code = failures[selection.family];
      // A mechanically pre-send-zero failure — the only kind that safely
      // auto-continues to the next provider (see reviewSpend PRE_SEND_ZERO_CODES;
      // unknown post-dispatch spend is a deterministic fail-closed terminal, not
      // a failover).
      if (code) throw Object.assign(new Error(code), { code });
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 }, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  return { controller, tried, quota };
}

test('failover: Codex + Sonnet unavailable -> GPT-OSS delivers the review, no user interaction', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried } = reviewerController({
    persistence,
    failures: { 'codex:default': 'PROVIDER_UNAVAILABLE', 'agy:sonnet': 'PROVIDER_UNAVAILABLE' },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(tried, ['codex:default', 'agy:sonnet', 'agy:gpt-oss']);
});

test('failover: fourth Reviewer candidate is reachable after 3 safe failures (old MAX_PROVIDER_ATTEMPTS=3 regression)', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried } = reviewerController({
    persistence,
    failures: {
      'codex:default': 'PROVIDER_UNAVAILABLE',
      'agy:sonnet': 'PROVIDER_UNAVAILABLE',
      'agy:gpt-oss': 'PROVIDER_UNAVAILABLE',
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(tried, ['codex:default', 'agy:sonnet', 'agy:gpt-oss', 'claude:opus']);
});

test('failover: shared AGY quota cooldown skips the sibling family without a physical call', async () => {
  const persistence = new MemoryPersistence();
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordProviderFailure('agy:sonnet', { code: 'PROVIDER_QUOTA_EXHAUSTED' }); // cools agy-claude-gpt
  const { controller, tried } = reviewerController({
    persistence, quota,
    failures: { 'codex:default': 'PROVIDER_UNAVAILABLE' },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  // agy:sonnet AND agy:gpt-oss share the exhausted pool -> neither physically
  // tried; routing jumps straight to claude:opus.
  assert.deepEqual(tried, ['codex:default', 'claude:opus']);
});

test('safety stop (NOT a failover): unknown post-dispatch spend fails closed, never burns the next provider', async () => {
  const persistence = new MemoryPersistence();
  // PROVIDER_PROTOCOL_ERROR after dispatch with no settleable usage -> the
  // reservation cannot settle -> UNKNOWN != ZERO -> deterministic fail-closed
  // terminal. Automatic failover must NOT continue to agy:sonnet.
  const { controller, tried } = reviewerController({
    persistence,
    failures: { 'codex:default': 'PROVIDER_PROTOCOL_ERROR', 'agy:sonnet': undefined },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /usage could not be reliably settled|unresolved model spend/i);
  assert.deepEqual(tried, ['codex:default']); // second provider never reached
  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].family, 'codex:default');
  assert.equal(reservations[0].status, 'UNRESOLVED');
});

test('failover: Supervisor fifth candidate reachable after 4 safe failures', async () => {
  const persistence = new MemoryPersistence();
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const supervisorTried = [];
  let deltaN = 0;
  const failures = {
    'agy:gemini': 'PROVIDER_UNAVAILABLE',
    'codex:default': 'PROVIDER_UNAVAILABLE',
    'agy:sonnet': 'PROVIDER_UNAVAILABLE',
    'claude:opus': 'PROVIDER_UNAVAILABLE',
  };
  const controller = createReviewLoopController({
    persistence,
    routeSupervisorFn: (signals) => {
      const s = router.route('supervisor', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => router.recordFailure(
      { role: 'supervisor', requestedFamily: sel.family, provider: sel.provider }, f,
    ),
    reviewerFn: async () => ({ value: { findings: [finding('P1')] }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' }),
    supervisorFn: async ({ selection }) => {
      supervisorTried.push(selection.family);
      const code = failures[selection.family];
      if (code) throw Object.assign(new Error(code), { code });
      return { value: { guidance: 'do x', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 }, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      deltaN += 1;
      return { fingerprint: `d${deltaN}`, diff: `x${deltaN}`, changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  await controller.review({ loopId }); // round 1: P1 -> REWORK, no supervisor
  await controller.review({ loopId }); // round 2: same P1 after changed diff -> supervisor
  assert.deepEqual(supervisorTried, SUPERVISOR_ORDER);
});
