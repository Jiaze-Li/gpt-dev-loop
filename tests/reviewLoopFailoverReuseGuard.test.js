// Independent re-verification #1 — bounded failover may reuse the ONE New
// Information claim that authorized attempt 1 of an operation ONLY when every
// earlier physical attempt is mechanically proven to have spent zero. Once an
// attempt has actually reached the provider (known non-zero usage, e.g. a
// post-send PROVIDER_PROTOCOL_ERROR), "no new information" means no further
// physical call — exactly as for a first attempt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('known-usage PROVIDER_PROTOCOL_ERROR then no new information -> attempt 2 physical dispatch is DENIED', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  // attempt 1 reaches the provider and fails AFTER the tokens were spent.
  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      const e = new Error('post-send protocol error');
      e.code = 'PROVIDER_PROTOCOL_ERROR';
      e.details = { usage: { input_tokens: 100, output_tokens: 3 } };
      throw e;
    },
  }), /post-send protocol error/);

  // attempt 2 with the SAME evidence and no new information: refused.
  let denied = null;
  await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 5, output_tokens: 5 } }),
  }).catch((e) => { denied = e; });

  assert.ok(denied, 'attempt 2 threw');
  assert.ok(isAuthorizationFailure(denied), `authorization failure, got ${denied?.code}`);
  assert.match(String(denied.message), /new information|unresolved/i);
});

test('mechanically proven pre-send zero -> bounded failover reuse remains allowed', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'Z', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { const e = new Error('binary missing'); e.code = 'AGY_ENOENT'; throw e; },
  }), /binary missing/);

  const out = await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 9, output_tokens: 4 } }),
  });
  assert.deepEqual(out, { findings: [] });
});

// --- Independent re-verification (final P1): usage == 0 is NOT pre-send proof ---
//
//   UNKNOWN != ZERO   ZERO USAGE != PRE-SEND   NO NEW INFORMATION -> NO NEW MODEL CALL
//
// Failover reuse of the one New Information claim is permitted ONLY when every
// earlier physical attempt is DURABLY proven to have never reached the provider
// (RESERVED / CANCELLED_PRE_DISPATCH, or SETTLED_KNOWN with settlementReason
// PROVEN_PRE_SEND_ZERO — set solely from an explicit orchestrator pre-send
// provenance flag, never inferred from a zero token count).

test('1. PROVIDER_PROTOCOL_ERROR with usage {0,0} -> attempt 2 DENIED, physical call count stays 1', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'P1', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });
  let physicalCalls = 0;

  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      physicalCalls += 1;
      const e = new Error('protocol error after send');
      e.code = 'PROVIDER_PROTOCOL_ERROR';
      e.details = { usage: { input_tokens: 0, output_tokens: 0 } };
      throw e;
    },
  }), /protocol error after send/);
  assert.equal(physicalCalls, 1);

  let denied = null;
  await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => { physicalCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  }).catch((e) => { denied = e; });

  assert.ok(denied && isAuthorizationFailure(denied), `attempt 2 denied, got ${denied?.code}`);
  assert.equal(physicalCalls, 1, 'no second physical dispatch');
});

test('2. PROVIDER_RATE_LIMITED with usage {0,0} past the DISPATCHING boundary -> attempt 2 DENIED', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'P2', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });
  let physicalCalls = 0;

  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      physicalCalls += 1;
      const e = new Error('rate limited mid-stream');
      e.code = 'PROVIDER_RATE_LIMITED';
      e.details = { usage: { input_tokens: 0, output_tokens: 0 } };
      throw e;
    },
  }), /rate limited mid-stream/);

  let denied = null;
  await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => { physicalCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  }).catch((e) => { denied = e; });

  assert.ok(denied && isAuthorizationFailure(denied), `attempt 2 denied, got ${denied?.code}`);
  assert.equal(physicalCalls, 1);
});

test('3. AGY_ENOENT (explicit pre-send) -> attempt 2 ALLOWED', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'P3', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { const e = new Error('agy enoent'); e.code = 'AGY_ENOENT'; throw e; },
  }), /agy enoent/);

  const out = await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 3, output_tokens: 2 } }),
  });
  assert.deepEqual(out, { findings: [] });
});

test('4. AGY_SPAWN_FAILED (explicit pre-send) -> attempt 2 ALLOWED', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'P4', persistence });
  const ev = await spend.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { const e = new Error('spawn failed'); e.code = 'AGY_SPAWN_FAILED'; throw e; },
  }), /spawn failed/);

  const out = await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 3, output_tokens: 2 } }),
  });
  assert.deepEqual(out, { findings: [] });
});

test('5. RESTART: durable SETTLED_KNOWN + usage {0,0} + ordinary failure reason -> attempt 2 DENIED', async () => {
  const persistence = new MemoryPersistence();
  const spend1 = createReviewLoopSpend({ loopId: 'P5', persistence });
  const ev = await spend1.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  await assert.rejects(() => spend1.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => {
      const e = new Error('ordinary provider failure, zero usage reported');
      e.code = 'PROVIDER_PROTOCOL_ERROR';
      e.details = { usage: { input_tokens: 0, output_tokens: 0 } };
      throw e;
    },
  }), /ordinary provider failure/);

  // "restart": a brand-new spend surface over the same durable store.
  const spend2 = createReviewLoopSpend({ loopId: 'P5', persistence });
  const ev2 = await spend2.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  let denied = null;
  await spend2.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev2.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  }).catch((e) => { denied = e; });

  assert.ok(denied && isAuthorizationFailure(denied), `attempt 2 denied after restart, got ${denied?.code}`);
});

test('6. RESTART: durable settlementReason PROVEN_PRE_SEND_ZERO -> attempt 2 ALLOWED', async () => {
  const persistence = new MemoryPersistence();
  const spend1 = createReviewLoopSpend({ loopId: 'P6', persistence });
  const ev = await spend1.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });

  await assert.rejects(() => spend1.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => { const e = new Error('spawn failed pre-send'); e.code = 'AGY_SPAWN_FAILED'; throw e; },
  }), /spawn failed pre-send/);

  // The durable reservation records the pre-send provenance.
  const reservations = await persistence.readWorkflowState('P6');
  const rec = Object.values(reservations.modelSpendReservations)[0];
  assert.equal(rec.status, 'SETTLED_KNOWN');
  assert.equal(rec.settlementReason, 'PROVEN_PRE_SEND_ZERO');

  const spend2 = createReviewLoopSpend({ loopId: 'P6', persistence });
  const ev2 = await spend2.registerEvidence({ kind: 'reviewstate', taskId: 'op', diffHash: 'D::G' });
  const out = await spend2.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 2, evidenceIds: [ev2.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.deepEqual(out, { findings: [] });
});
