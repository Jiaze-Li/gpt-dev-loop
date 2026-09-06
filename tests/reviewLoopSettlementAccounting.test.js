// Phase 2 #4 — every SETTLED_KNOWN physical attempt (success, known-usage
// failure, OR mechanically-zero pre-send failure) writes a durable accounting
// record tagged with its reservationId. A NORMAL failover therefore never
// produces a false "unaccounted spend" block after a restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend, isMechanicallyZeroPreSend, PRE_SEND_ZERO_CODES } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('AGY_ENOENT / AGY_SPAWN_FAILED are classified as mechanically-zero pre-send', () => {
  assert.ok(PRE_SEND_ZERO_CODES.has('AGY_ENOENT'));
  assert.ok(PRE_SEND_ZERO_CODES.has('AGY_SPAWN_FAILED'));
  assert.equal(isMechanicallyZeroPreSend({ code: 'AGY_SPAWN_FAILED' }), true);
  assert.equal(isMechanicallyZeroPreSend({ code: 'AGY_SPAWN_FAILED', usage: { input_tokens: 5 } }), false);
  assert.equal(isMechanicallyZeroPreSend({ code: 'PROVIDER_TIMEOUT' }), false);
});

test('known-zero pre-send failure -> failover -> success -> restart stays accounted and unblocked', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  // attempt 1: the agy binary is missing -> mechanically-zero pre-send failure.
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
      call: async () => { const e = new Error('agy not found'); e.code = 'AGY_ENOENT'; throw e; },
    }),
    /agy not found/,
  );

  // attempt 2 (failover): a healthy family succeeds.
  const out = await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 20, output_tokens: 8 } }),
  });
  assert.deepEqual(out, { findings: [] });

  // "restart": brand-new spend surface over the same durable store.
  const afterRestart = createReviewLoopSpend({ loopId: 'L', persistence });
  assert.equal(await afterRestart.hasUnaccountedSpend(), false, 'a normal failover is not unaccounted spend');
  const t = await afterRestart.telemetry();
  assert.equal(t.unaccountedSpendCalls, 0);
  assert.equal(t.spendBlocked, false);
  assert.equal(t.usageVolume, 28, 'only the successful attempt contributed real usage volume');

  // a subsequent metered call with genuinely new evidence is NOT blocked.
  const ev2 = await afterRestart.registerEvidence({ kind: 'reviewstate', taskId: 'op2', diffHash: 'D2::G2' });
  const out2 = await afterRestart.meteredCall({
    role: 'reviewer', operationId: 'op2', attempt: 1, evidenceIds: [ev2.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.ok(out2);
});

test('a known-usage provider failure still writes a durable FAILURE record', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'K', persistence });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 'op', diffHash: 'D' });
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
      call: async () => {
        const e = new Error('post-send guard fired');
        e.code = 'PROVIDER_PROTOCOL_ERROR';
        e.details = { usage: { input_tokens: 100, output_tokens: 0 } };
        throw e;
      },
    }),
    /post-send guard/,
  );
  const afterRestart = createReviewLoopSpend({ loopId: 'K', persistence });
  const t = await afterRestart.telemetry();
  assert.equal(t.unaccountedSpendCalls, 0);
  assert.equal(t.usageVolume, 100, 'the failed call\'s known usage is still accounted');
});
