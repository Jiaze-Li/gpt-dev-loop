// Stage 5 — deterministic, ZERO-provider benchmark coverage for both transport
// narrowness and the ReviewLoop controller's required E2E-A/B/C paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewTransportBenchmark } from '../scripts/benchmark-review-transports.js';

test('benchmark harness: deterministic, zero provider calls, narrow transports + E2E-A/B/C', async () => {
  const a = await runReviewTransportBenchmark();
  const b = await runReviewTransportBenchmark();
  assert.deepEqual(a.rows, b.rows, 'transport benchmark output is deterministic');
  assert.deepEqual(a.e2e, b.e2e, 'controller E2E benchmark output is deterministic');

  assert.equal(a.zeroProviderCalls, true);
  assert.equal(a.e2e.zeroProviderCalls, true);
  assert.deepEqual(a.rows.map((r) => r.transport), ['codex:default', 'claude:opus']);

  for (const row of a.rows) {
    assert.equal(row.realSpawns, 0, `${row.transport} used a real spawn`);
    assert.equal(row.narrowFlagsPresent, true, `${row.transport} lost a narrow flag`);
    assert.equal(row.resumesConversation, false, `${row.transport} resumed a conversation`);
    assert.equal(row.runsFromIsolatedScratchCwd, true, `${row.transport} left the scratch cwd`);
    assert.ok(row.contextOverheadTokens >= 0, `${row.transport} overhead proxy negative`);
    assert.ok(Number.isFinite(row.estimatedPayloadTokens));
  }
  assert.equal(a.rows.find((r) => r.transport === 'codex:default').modelArg, null);
  assert.equal(a.rows.find((r) => r.transport === 'claude:opus').modelArg, 'opus');

  assert.deepEqual(a.e2e.A.statuses, ['PASS']);
  assert.equal(a.e2e.A.reviewerCalls, 1);
  assert.equal(a.e2e.A.supervisorCalls, 0);

  assert.deepEqual(a.e2e.B.statuses, ['REWORK', 'PASS']);
  assert.equal(a.e2e.B.reviewerCalls, 2);
  assert.equal(a.e2e.B.supervisorCalls, 0);

  assert.deepEqual(a.e2e.C.statuses, ['REWORK', 'REWORK']);
  assert.equal(a.e2e.C.reviewerCalls, 2);
  assert.equal(a.e2e.C.supervisorCalls, 1);
  assert.equal(a.e2e.C.supervisorGuidance, 'use a different repair strategy');
});
