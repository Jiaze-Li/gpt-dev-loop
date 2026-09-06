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
