// Stage 5 — the review-transport benchmark harness is deterministic and makes
// ZERO real provider calls. It exists so a narrowness regression in the CLI
// transports is caught mechanically, without any model spend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewTransportBenchmark } from '../scripts/benchmark-review-transports.js';

test('benchmark harness: deterministic, zero provider calls, both CLI families narrow', async () => {
  const a = await runReviewTransportBenchmark();
  const b = await runReviewTransportBenchmark();
  assert.deepEqual(a.rows, b.rows, 'harness output is deterministic');

  assert.equal(a.zeroProviderCalls, true);
  assert.deepEqual(a.rows.map((r) => r.transport), ['codex:default', 'claude:opus']);

  for (const row of a.rows) {
    assert.equal(row.realSpawns, 0, `${row.transport} used a real spawn`);
    assert.equal(row.narrowFlagsPresent, true, `${row.transport} lost a narrow flag`);
    assert.equal(row.resumesConversation, false, `${row.transport} resumed a conversation`);
    assert.equal(row.runsFromIsolatedScratchCwd, true, `${row.transport} left the scratch cwd`);
    assert.ok(row.contextOverheadTokens >= 0, `${row.transport} overhead proxy negative`);
    assert.ok(Number.isFinite(row.estimatedPayloadTokens));
  }
});
