// B2 — the ReviewLoop aggregate budget (call counts, usageVolume, costUsd) is
// durable and accumulates across review rounds, the Supervisor call, and a
// process restart. A crash after provider settlement can never reset it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend, usageVolumeOf } from '../src/reviewloop/reviewSpend.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function freshSpend(persistence, env) {
  return createReviewLoopSpend({ loopId: 'LOOP', persistence, env });
}

async function oneReviewerCall(spend, hash, usage = { input_tokens: 100, output_tokens: 50 }, costUsd = 0.01) {
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: `t-${hash}`, diffHash: hash });
  return spend.meteredCall({
    role: 'reviewer', operationId: `op-${hash}`, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: {}, usage, costUsd }),
  });
}

test('usageVolumeOf sums input + output + cache creation + cache read', () => {
  assert.equal(usageVolumeOf({
    input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3,
  }), 20);
  assert.equal(usageVolumeOf(null), 0);
});

test('reviewer call ceiling is enforced across a NEW spend instance (round 2)', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_REVIEWER_CALLS: '1' };
  await oneReviewerCall(freshSpend(persistence, env), 'r1');
  // round 2 == a brand-new createReviewLoopSpend, same loopId + persistence
  await assert.rejects(() => oneReviewerCall(freshSpend(persistence, env), 'r2'), /reviewer call ceiling/);
});

test('the ceiling still holds after a simulated restart', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_REVIEWER_CALLS: '2' };
  await oneReviewerCall(freshSpend(persistence, env), 'a');
  await oneReviewerCall(freshSpend(persistence, env), 'b');
  // "restart": construct a completely fresh spend surface over the same store
  const afterRestart = createReviewLoopSpend({ loopId: 'LOOP', persistence, env });
  await assert.rejects(() => oneReviewerCall(afterRestart, 'c'), /reviewer call ceiling/);
});

test('usageVolume and cost accumulate across rounds', async () => {
  const persistence = new MemoryPersistence();
  await oneReviewerCall(freshSpend(persistence), 'a', { input_tokens: 100, output_tokens: 100 }, 0.02);
  await oneReviewerCall(freshSpend(persistence), 'b', { input_tokens: 100, output_tokens: 100 }, 0.03);
  const t = await freshSpend(persistence).telemetry();
  assert.equal(t.usageVolume, 400);
  assert.ok(Math.abs(t.costUsd - 0.05) < 1e-9);
  assert.equal(t.reviewerCalls, 2);
});

test('usage-volume ceiling accumulates across rounds', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_USAGE_VOLUME: '300' };
  await oneReviewerCall(freshSpend(persistence, env), 'a', { input_tokens: 150, output_tokens: 150 });
  await assert.rejects(
    () => oneReviewerCall(freshSpend(persistence, env), 'b', { input_tokens: 10, output_tokens: 10 }),
    /usage-volume ceiling/,
  );
});

test('cache tokens count toward the aggregate', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_USAGE_VOLUME: '100' };
  // First call is entirely cache tokens and hits the ceiling exactly.
  await oneReviewerCall(freshSpend(persistence, env), 'a', {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 60, cache_read_input_tokens: 40,
  });
  const t = await freshSpend(persistence, env).telemetry();
  assert.equal(t.usageVolume, 100);
  await assert.rejects(
    () => oneReviewerCall(freshSpend(persistence, env), 'b', { input_tokens: 1, output_tokens: 0 }),
    /usage-volume ceiling/,
  );
});

test('crash-after-SETTLED_KNOWN with an unrecoverable spend record -> fail closed', async () => {
  const persistence = new MemoryPersistence();
  // high call ceiling, generous usage ceiling: the block is purely because
  // the real usage/cost of the crashed call cannot be recovered.
  const env = { REVIEWLOOP_MAX_REVIEWER_CALLS: '99', REVIEWLOOP_MAX_USAGE_VOLUME: '9999999', REVIEWLOOP_MAX_COST_USD: '999' };
  await persistence.updateWorkflowState('LOOP', {
    modelSpendReservations: {
      'res-1': { reservationId: 'res-1', status: 'SETTLED_KNOWN', role: 'reviewer', intent: { role: 'reviewer' } },
    },
  });
  const afterRestart = createReviewLoopSpend({ loopId: 'LOOP', persistence, env });
  const totals = await afterRestart.currentTotals();
  assert.equal(totals.reviewerCalls, 1, 'the crashed call is still counted');
  assert.equal(totals.unknownUsageCalls, 1, 'its usage is UNKNOWN, never zero');
  assert.equal(totals.unaccountedSpendCalls, 1);
  await assert.rejects(
    () => oneReviewerCall(afterRestart, 'h2'),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED && /could not be recovered/.test(err.message),
  );
});

test('crash-after-SETTLED_KNOWN also blocks when the usage ceiling is already exhausted', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_REVIEWER_CALLS: '99', REVIEWLOOP_MAX_USAGE_VOLUME: '100' };
  // one real recorded call that already exhausts the usage ceiling
  await oneReviewerCall(freshSpend(persistence, env), 'logged', { input_tokens: 100, output_tokens: 20 });
  // plus a SETTLED_KNOWN reservation whose spend record was lost
  const cur = await persistence.readWorkflowState('LOOP');
  await persistence.updateWorkflowState('LOOP', {
    modelSpendReservations: {
      ...(cur.modelSpendReservations ?? {}),
      'res-crashed': { reservationId: 'res-crashed', status: 'SETTLED_KNOWN', role: 'reviewer', intent: { role: 'reviewer' } },
    },
  });
  const afterRestart = createReviewLoopSpend({ loopId: 'LOOP', persistence, env });
  await assert.rejects(() => oneReviewerCall(afterRestart, 'next'), (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED);
});

test('a human can acknowledge unrecoverable spend to unblock (REVIEWLOOP_ACK_UNACCOUNTED_SPEND)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('LOOP', {
    modelSpendReservations: {
      'res-1': { reservationId: 'res-1', status: 'SETTLED_KNOWN', role: 'reviewer', intent: { role: 'reviewer' } },
    },
  });
  const env = { REVIEWLOOP_ACK_UNACCOUNTED_SPEND: 'LOOP' };
  const spend = createReviewLoopSpend({ loopId: 'LOOP', persistence, env });
  const v = await oneReviewerCall(spend, 'ok');
  assert.deepEqual(v, {});
});

test('an UNRESOLVED reservation after restart blocks all spend (via the reservation ledger)', async () => {
  const persistence = new MemoryPersistence();
  await persistence.updateWorkflowState('LOOP', {
    modelSpendReservations: {
      'res-x': { reservationId: 'res-x', status: 'UNRESOLVED', role: 'reviewer', taskId: 'x', physicalAttempt: 1, intent: { role: 'reviewer' } },
    },
  });
  const spend = createReviewLoopSpend({ loopId: 'LOOP', persistence });
  await assert.rejects(() => oneReviewerCall(spend, 'z'), (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED);
});
