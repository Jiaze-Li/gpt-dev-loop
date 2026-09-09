// B6 — production Reviewer/Supervisor pool is real: RoleRouter -> capability ->
// quota -> health -> selected family, and the CallIntent binds the actually-
// selected family. Only reviewer + supervisor roles. Failover re-authorizes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('reviewer routes to the first eligible family; supervisor to its first', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  // agy:opus is first for reviewer and is wired via reviewloop-minimal.
  assert.equal(pool.route('reviewer').family, 'agy:opus');
  // agy:gemini-supervisor is first for supervisor, likewise wired.
  assert.equal(pool.route('supervisor').family, 'agy:gemini-supervisor');
});

test('reviewer: Opus + Gemini head down + shared Claude&GPT pool in cooldown -> no eligible Reviewer', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordCooldown('agy-claude-gpt'); // the shared agy:opus + agy:sonnet + agy:gpt-oss pool
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini-reviewer', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), quotaRegistry: quota, providerHealth: health });
  // gemini-reviewer down; codex + claude runtime not probed -> UNAVAILABLE;
  // agy:opus, agy:sonnet AND agy:gpt-oss all skipped (shared exhausted pool) -> null.
  assert.equal(pool.route('reviewer'), null);
  // the agy-gemini pool is SEPARATE and healthy: the Supervisor head still routes.
  assert.equal(pool.route('supervisor').family, 'agy:gemini-supervisor');
});

test('supervisor first candidate unavailable -> next eligible selected', () => {
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini-supervisor', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });
  const sel = pool.route('supervisor');
  // agy:gemini-supervisor removed, codex/claude runtime not probed -> agy:sonnet.
  assert.equal(sel.family, 'agy:sonnet');
});

test('the pool never offers a planner or executor role', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  assert.equal(pool.route('planner'), null);
  assert.equal(pool.route('executor'), null);
});

test('the CallIntent family matches the actually-selected family', async () => {
  const persistence = new MemoryPersistence();
  const seenIntents = [];
  const health = new ProviderHealthRegistry();
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });

  const controller = createReviewLoopController({
    persistence,
    // codex/claude runtime not probed -> agy:opus is the selected Reviewer.
    routeReviewerFn: (signals) => pool.route('reviewer', signals),
    reviewerFn: async ({ selection }) => {
      seenIntents.push(selection.family);
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(seenIntents[0], 'agy:opus');

  // the durable reservation ledger recorded the intent against the SAME family
  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.ok(reservations.length >= 1);
  assert.ok(reservations.every((res) => res.family === 'agy:opus'));
});

test('a retryable provider failure fails over and requires a fresh permit', async () => {
  const persistence = new MemoryPersistence();
  let attempt = 0;
  const familiesTried = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => {
      // hand a different family per attempt
      const family = attempt === 0 ? 'agy:gpt-oss' : 'agy:gemini-reviewer';
      return { family, provider: 'agy', model: 'm', transport: async () => ({}) };
    },
    recordProviderFailure: () => {},
    reviewerFn: async ({ selection }) => {
      familiesTried.push(selection.family);
      if (attempt++ === 0) throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' });
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(familiesTried, ['agy:gpt-oss', 'agy:gemini-reviewer']);

  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  // one reservation per physical attempt, each with its own family
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((x) => x.family).sort(), ['agy:gemini-reviewer', 'agy:gpt-oss']);
});

