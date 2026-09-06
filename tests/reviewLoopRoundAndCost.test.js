// Phase 2 #7 — Gate FAIL is a repair cycle, not a fresh Reviewer round; and an
// unknown provider dollar cost is never recorded as a real $0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('repeated deterministic Gate FAIL does not consume the objective max review rounds', async () => {
  const { controller, calls } = makeHarness({
    // maxReviewRounds defaults to 3; give 4 gate FAILs on genuinely changing
    // diffs, then a PASS + clean Reviewer.
    deltas: [
      { fingerprint: 'd1', diff: 'a' }, { fingerprint: 'd2', diff: 'b' },
      { fingerprint: 'd3', diff: 'c' }, { fingerprint: 'd4', diff: 'd' },
      { fingerprint: 'd5', diff: 'e' },
    ],
    gates: [
      { verdict: 'PASS', fingerprint: 'g0' }, // baseline Gate run by reviewloop_begin
      { verdict: 'FAIL', fingerprint: 'g1' }, { verdict: 'FAIL', fingerprint: 'g2' },
      { verdict: 'FAIL', fingerprint: 'g3' }, { verdict: 'FAIL', fingerprint: 'g4' },
      { verdict: 'PASS', fingerprint: 'g5' },
    ],
    reviews: [{ findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'REWORK', `gate fail ${i + 1}`);
    assert.equal(r.round, 0, 'a Gate FAIL never advances the fresh-Reviewer round counter');
    assert.equal(r.gateRepairCount, i + 1);
  }
  assert.equal(calls.reviewer, 0, 'the independent Reviewer never ran during the Gate-repair cycles');

  const pass = await controller.review({ loopId });
  assert.equal(pass.status, 'PASS', 'the Gate-repair cycles did not exhaust the review rounds');
  assert.equal(calls.reviewer, 1);
});

test('an unknown provider cost is reported as a lower bound, not a real $0', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'C', persistence, env: { REVIEWLOOP_MAX_COST_USD: '10' } });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 'op', diffHash: 'X' });
  await spend.meteredCall({
    role: 'reviewer', operationId: 'op', attempt: 1, evidenceIds: [ev.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 100, output_tokens: 50 } }), // no costUsd
  });
  const t = await spend.telemetry();
  assert.equal(t.costKnown, false);
  assert.equal(t.unknownCostCalls, 1);
  assert.equal(t.costUsd, 0, 'known cost sum is 0 but flagged as a lower bound, not asserted as the spend');
});

test('cost ceiling denies once known spend passes half the ceiling while unknown-cost calls exist', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_COST_USD: '1', REVIEWLOOP_MAX_USAGE_VOLUME: '9999999', REVIEWLOOP_MAX_REVIEWER_CALLS: '99' };
  const mk = () => createReviewLoopSpend({ loopId: 'D', persistence, env });
  const call = async (spend, hash, costUsd) => {
    const ev = await spend.registerEvidence({ kind: 'diff', taskId: `t${hash}`, diffHash: hash });
    return spend.meteredCall({
      role: 'reviewer', operationId: `o${hash}`, attempt: 1, evidenceIds: [ev.evidenceId],
      call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 }, ...(costUsd == null ? {} : { costUsd }) }),
    });
  };
  await call(mk(), 'a', undefined);   // unknown cost
  await call(mk(), 'b', 0.6);         // known $0.60 -> now > 0.5 * $1 with an unknown-cost call present
  await assert.rejects(() => call(mk(), 'c', 0.1), /unknown cost|cost ceiling/);
});
