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
  assert.equal(pool.route('reviewer').family, 'agy:gpt-oss');
  assert.equal(pool.route('supervisor').family, 'agy:gemini');
});

test('reviewer first candidate in cooldown -> next eligible family selected', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  quota.recordCooldown('agy-claude-gpt'); // the pool backing agy:gpt-oss
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), quotaRegistry: quota });
  const sel = pool.route('reviewer');
  assert.equal(sel.family, 'agy:gemini'); // codex:default skipped: runtime not probed -> UNAVAILABLE
});

test('supervisor first candidate unavailable -> next eligible selected', () => {
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });
  const sel = pool.route('supervisor');
  assert.equal(sel.family, 'agy:gpt-oss'); // codex:default + claude:opus: runtime not probed -> UNAVAILABLE
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
  health.record('agy:gpt-oss', 'UNAVAILABLE'); // force reviewer onto agy:gemini
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}), providerHealth: health });

  const controller = createReviewLoopController({
    persistence,
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
  assert.equal(seenIntents[0], 'agy:gemini');

  // the durable reservation ledger recorded the intent against the SAME family
  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.ok(reservations.length >= 1);
  assert.ok(reservations.every((res) => res.family === 'agy:gemini'));
});

test('a retryable provider failure fails over and requires a fresh permit', async () => {
  const persistence = new MemoryPersistence();
  let attempt = 0;
  const familiesTried = [];
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => {
      // hand a different family per attempt
      const family = attempt === 0 ? 'agy:gpt-oss' : 'agy:gemini';
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
  assert.deepEqual(familiesTried, ['agy:gpt-oss', 'agy:gemini']);

  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  // one reservation per physical attempt, each with its own family
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((x) => x.family).sort(), ['agy:gemini', 'agy:gpt-oss']);
});

