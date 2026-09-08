// Post-settlement single-call Token Sentinel + the agy:gpt-oss Supervisor-pool
// removal. ZERO real provider calls — every metered call is a fake function and
// every route is a real deterministic RoleRouter decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewLoopSpend,
  resolveReviewLoopLimits,
  detectSingleCallTokenAnomaly,
  REVIEWLOOP_DEFAULTS,
} from '../src/reviewloop/reviewSpend.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  supportsProductionRole,
} from '../src/orchestrator/roleRouting.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { resolveModelFamily } from '../src/orchestrator/modelFamilyResolver.js';
import { MODEL_FAMILY_REGISTRY } from '../src/orchestrator/modelFamilyResolver.js';
import { MemoryPersistence, finding } from './helpers/reviewLoopHarness.js';

// ---- A. Supervisor pool: agy:gpt-oss removed ---------------------------

test('Supervisor production pool is EXACTLY the 4 certified candidates', () => {
  assert.deepEqual(
    DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family),
    ['agy:gemini', 'codex:default', 'agy:sonnet', 'claude:opus'],
  );
  const eligible = DEFAULT_ROLE_POLICY.supervisor
    .filter((c) => (PRODUCTION_ROLE_CAPABILITIES[c.family] ?? []).includes('supervisor'))
    .map((c) => c.family);
  assert.equal(eligible.length, 4);
});

test('agy:gpt-oss is not Supervisor-eligible and never routes as Supervisor', () => {
  assert.equal(supportsProductionRole('agy:gpt-oss', 'supervisor'), false);
  assert.equal(PRODUCTION_ROLE_CAPABILITIES['agy:gpt-oss'].includes('supervisor'), false);

  const resolver = (family) => ({
    requestedFamily: family,
    resolvedModel: resolveModelFamily(family, { env: {}, agyCatalog: null }).resolvedModel,
    provider: MODEL_FAMILY_REGISTRY[family]?.provider ?? family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: false, supportedEfforts: ['medium'] },
  });
  const health = new ProviderHealthRegistry();
  for (const f of ['agy:gemini', 'codex:default', 'agy:sonnet', 'claude:opus']) health.record(f, 'UNAVAILABLE');
  assert.equal(new RoleRouter({ providerHealth: health, resolveFamily: resolver }).route('supervisor'), null);
});

test('agy:gpt-oss is still the third Reviewer candidate', () => {
  assert.equal(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family).includes('agy:gpt-oss'), true);
  assert.equal(supportsProductionRole('agy:gpt-oss', 'reviewer'), true);
});

test('MAX_SUPERVISOR_CALLS matches the 4-candidate pool', () => {
  assert.equal(REVIEWLOOP_DEFAULTS.MAX_SUPERVISOR_CALLS, 4);
  assert.equal(resolveReviewLoopLimits({}).maxSupervisorCalls, 4);
});

// ---- B. Token Sentinel unit behaviour ---------------------------------

const persistenceOf = () => new MemoryPersistence();

async function meterOnce(spend, {
  usage, meta = null, family = 'agy:gpt-oss', provider = 'agy', role = 'reviewer',
  op = `op-${Math.random().toString(36).slice(2)}`, throwErr = null, onCall = null,
} = {}) {
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: op, diffHash: `${op}::G` });
  return spend.meteredCall({
    role, family, provider, operationId: op, attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      if (onCall) onCall();
      if (throwErr) throw throwErr;
      return { value: { findings: [] }, usage, model: 'm', meta };
    },
  });
}

test('single-call usage 39999 -> no anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await meterOnce(spend, { usage: { input_tokens: 39999, output_tokens: 0 } });
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined);
  assert.equal((await spend.telemetry()).tokenAnomalyBlocked, false);
});

test('single-call usage 40001 -> BLOCKING anomaly, call still accounted', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED' && e.authorizationFailure === true,
  );
  const state = await persistence.readWorkflowState('L');
  // (9) the anomalous call is fully, durably accounted — never treated as 0
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 40001);
  assert.equal(state.reviewLoopSpend.records.at(-1).usageKnown, true);
  // durable latch
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(state.reviewLoopTokenAnomaly.trigger, 'SINGLE_CALL_USAGE');
  assert.equal(state.reviewLoopTokenAnomaly.usageVolume, 40001);
  assert.equal(state.reviewLoopTokenAnomaly.threshold, 40000);
  const t = await spend.telemetry();
  assert.equal(t.tokenAnomalyBlocked, true);
  assert.equal(t.usageVolume, 40001);
});

test('context overhead 29999 -> no anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  // input 30000, est payload tokens round(4/4)=1 -> overhead 29999; volume 30000
  await meterOnce(spend, { usage: { input_tokens: 30000, output_tokens: 0 }, meta: { promptChars: 4 } });
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined);
});

test('context overhead 30001 -> BLOCKING anomaly', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    // input 30002, est 1 -> overhead 30001 (> 30000); volume 30002 (< 40000)
    () => meterOnce(spend, { usage: { input_tokens: 30002, output_tokens: 0 }, meta: { promptChars: 4 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly.trigger, 'CONTEXT_OVERHEAD');
  assert.equal(state.reviewLoopTokenAnomaly.contextOverheadTokens, 30001);
  assert.equal(state.reviewLoopTokenAnomaly.threshold, 30000);
});

test('after an anomaly the next physical call is refused at the authorization stage (0 dispatch)', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(() => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }));
  const recordsAfterAnomaly = (await persistence.readWorkflowState('L')).reviewLoopSpend.records.length;

  let dispatched = false;
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false, 'the provider call must never run');
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopSpend.records.length, recordsAfterAnomaly, 'no new spend record');
  // no new reservation was minted for the refused call
  assert.equal(Object.keys(state.modelSpendReservations ?? {}).length, 1);
});

test('a fresh process (restart/resume) stays blocked by the durable anomaly latch', async () => {
  const persistence = persistenceOf();
  const s1 = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(() => meterOnce(s1, { usage: { input_tokens: 40001, output_tokens: 0 } }));

  const s2 = createReviewLoopSpend({ loopId: 'L', persistence });
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(s2, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
  assert.equal((await s2.telemetry()).tokenAnomalyBlocked, true);
});

test('a clean read is never cached — a latch written after the first read still blocks', async () => {
  const persistence = persistenceOf();
  const a = createReviewLoopSpend({ loopId: 'L', persistence });
  const b = createReviewLoopSpend({ loopId: 'L', persistence });
  // b observes clean state first...
  assert.equal(await b.loadTokenAnomaly(), null);
  // ...then a trips + durably latches the anomaly
  await assert.rejects(() => meterOnce(a, { usage: { input_tokens: 40001, output_tokens: 0 } }));
  // b's next metered call re-reads the durable latch and is blocked
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(b, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
});

test('unknown / unresolved usage keeps the existing UNRESOLVED path, NOT the Token Sentinel', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: null }),
    (e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED',
  );
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopTokenAnomaly, undefined, 'never latched as a token anomaly');
  assert.equal(Object.values(state.modelSpendReservations)[0].status, 'UNRESOLVED');
});

test('detectSingleCallTokenAnomaly ignores calls whose volume did not resolve', () => {
  const limits = resolveReviewLoopLimits({});
  assert.equal(
    detectSingleCallTokenAnomaly({
      accounting: { volumeResolved: false, usageVolume: 999999 }, contextOverhead: 999999, limits,
    }),
    null,
  );
});

// ---- env overrides -----------------------------------------------------

test('env override raises the ceilings', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '100000' },
  });
  await meterOnce(spend, { usage: { input_tokens: 50000, output_tokens: 0 } }); // 50k < 100k -> fine
  assert.equal((await persistence.readWorkflowState('L')).reviewLoopTokenAnomaly, undefined);
});

test('env override lowers the ceiling and still trips', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '20000' },
  });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 25000, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
});

test('an illegal threshold NEVER disables the sentinel (falls back to default)', () => {
  for (const bad of ['0', '-1', '-999', 'abc', '', 'NaN', 'Infinity', 'null']) {
    const l = resolveReviewLoopLimits({
      REVIEWLOOP_MAX_SINGLE_CALL_USAGE: bad, REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS: bad,
    });
    assert.equal(l.maxSingleCallUsage, 40000, `bad=${JSON.stringify(bad)}`);
    assert.equal(l.maxContextOverheadTokens, 30000, `bad=${JSON.stringify(bad)}`);
  }
});

test('a huge env value is clamped to the hard cap (cannot be inflated to infinity)', async () => {
  const l = resolveReviewLoopLimits({ REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '999999999' });
  assert.equal(l.maxSingleCallUsage, 250000);
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({
    loopId: 'L', persistence, env: { REVIEWLOOP_MAX_SINGLE_CALL_USAGE: '999999999' },
  });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 300000, output_tokens: 0 } }), // > 250k cap
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
});

test('a latch READ failure fails closed — never read as "no anomaly"', async () => {
  const persistence = persistenceOf();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'op::G' });
  // only the anomaly-latch read is broken
  const realRead = persistence.readWorkflowState.bind(persistence);
  let armed = false;
  persistence.readWorkflowState = async (id) => {
    if (armed) throw new Error('disk gone');
    return realRead(id);
  };
  armed = true;
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: 'op', attempt: 1,
      evidenceIds: [ev.evidenceId], call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
});

test('a latch WRITE failure is surfaced (not swallowed) and still fully accounts the call', async () => {
  const persistence = persistenceOf();
  const realUpdate = persistence.updateWorkflowState.bind(persistence);
  persistence.updateWorkflowState = async (id, patch) => {
    if (patch && 'reviewLoopTokenAnomaly' in patch) throw new Error('latch write failed');
    return realUpdate(id, patch);
  };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
  // the anomalous call was still fully, durably accounted
  const state = await persistence.readWorkflowState('L');
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 40001);
});

test('a persistence that cannot store durable workflow state -> anomaly fails closed (STATE_UNAVAILABLE)', async () => {
  const brokenPersistence = { note: 'no readWorkflowState / updateWorkflowState' };
  const spend = createReviewLoopSpend({ loopId: 'L', persistence: brokenPersistence });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE',
  );
});

test('a bare in-memory surface (no persistence) still blocks the next call in-process', async () => {
  const spend = createReviewLoopSpend({ loopId: 'L' });
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 40001, output_tokens: 0 } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  let dispatched = false;
  await assert.rejects(
    () => meterOnce(spend, { usage: { input_tokens: 1, output_tokens: 1 }, onCall: () => { dispatched = true; } }),
    (e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY_BLOCKED',
  );
  assert.equal(dispatched, false);
});

// ---- C. controller: no failover / no health mutation on anomaly -------

function anomalyController({ persistence, reviewerUsage }) {
  const health = new ProviderHealthRegistry();
  const quota = new QuotaPoolRegistry({ filePath: null });
  const resolver = (family) => ({
    requestedFamily: family,
    resolvedModel: `${family}-rt`,
    provider: family.split(':')[0],
    capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: false, supportedEfforts: ['medium'] },
  });
  const router = new RoleRouter({ quotaRegistry: quota, providerHealth: health, resolveFamily: resolver });
  const tried = [];
  const providerFailures = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: (signals) => {
      const s = router.route('reviewer', signals);
      return s ? { family: s.requestedFamily, provider: s.provider, model: s.resolvedModel, transport: async () => ({}) } : null;
    },
    recordProviderFailure: (sel, f) => { providerFailures.push([sel.family, f.code]); router.recordFailure({ role: 'reviewer', requestedFamily: sel.family, provider: sel.provider }, f); },
    reviewerFn: async ({ selection }) => {
      tried.push(selection.family);
      return { value: { findings: [finding('P3')] }, usage: reviewerUsage, model: selection.model };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  return { controller, tried, providerFailures, health, quota };
}

test('controller: a single-call token anomaly is a safety stop — no failover, no health/quota mutation', async () => {
  const persistence = new MemoryPersistence();
  const { controller, tried, providerFailures, health, quota } = anomalyController({
    persistence, reviewerUsage: { input_tokens: 200000, output_tokens: 0 },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });

  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /token anomaly|MODEL_SPEND_TOKEN_ANOMALY/i);
  // (12) no auto-failover to the next Reviewer candidate
  assert.deepEqual(tried, ['codex:default']);
  // (13) provider health / quota untouched
  assert.deepEqual(providerFailures, []);
  assert.equal(health.get('codex:default').status, 'UNKNOWN');
  assert.equal(quota.usable('codex:default'), true);
  // BLOCKING safety event surfaced
  assert.equal(r.safetyEvents.some((e) => e.code === 'MODEL_SPEND_TOKEN_ANOMALY' && e.severity === 'BLOCKING'), true);
  // durable latch + full accounting of the anomalous call
  const state = await persistence.readWorkflowState(loopId);
  assert.equal(state.reviewLoopTokenAnomaly.tripped, true);
  assert.equal(state.reviewLoopSpend.records.at(-1).usageVolume, 200000);
});
