import test from 'node:test';
import assert from 'node:assert/strict';

import { runPrCloseoutLoop, PR_CLOSEOUT_LOOP_STATUS } from '../src/orchestrator/prCloseoutLoop.js';

const reviewer = 'trusted-reviewer';
const finding = (id, message) => ({
  id, reviewId: 'review-old', threadNodeId: `thread-${id}`,
  commentId: `comment-${id}`, severity: 'P1', file: 'src/a.js', message,
});
const review = (headSha, findings, reviewId) => ({ reviewer, headSha, reviewId, findings });

function closeout(reviews, resolution) {
  let head = 'h1';
  return runPrCloseoutLoop({
    init: { prNumber: 1, configuredReviewer: reviewer },
    config: { configuredReviewer: reviewer },
    adapters: {
      getPrHead: async () => head,
      requestTrustedReview: async () => reviews[head],
      runRepairTask: async () => ({ status: 'COMPLETE', gateResult: 'PASS' }),
      pushRepair: async () => { head = 'h2'; return head; },
      resolveReviewThread: resolution,
    },
  });
}

test('fresh same-reviewer clean review resolves a confirmed fixed thread', async () => {
  const calls = [];
  const out = await closeout({
    h1: review('h1', [finding('1', 'bug')], 'r1'),
    h2: review('h2', [], 'r2'),
  }, async (item) => {
    calls.push(item.threadNodeId);
    return { ok: true, finding: { ...item, lifecycle: 'RESOLVED', threadResolutionStatus: 'RESOLVED' } };
  });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.deepEqual(calls, ['thread-1']);
  assert.equal(out.state.reviewFindings[0].verificationReviewId, 'r2');
});

test('only absent signatures resolve; surviving finding continues repair loop', async () => {
  const calls = [];
  let head = 'h1';
  const reviews = {
    h1: review('h1', [finding('1', 'first'), finding('2', 'second')], 'r1'),
    h2: review('h2', [finding('2', 'second')], 'r2'),
  };
  const out = await runPrCloseoutLoop({
    init: { configuredReviewer: reviewer, maxRepairRounds: 1 },
    config: { configuredReviewer: reviewer },
    adapters: {
      getPrHead: async () => head,
      requestTrustedReview: async () => reviews[head],
      runRepairTask: async () => ({ status: 'COMPLETE', gateResult: 'PASS' }),
      pushRepair: async () => { head = 'h2'; return head; },
      resolveReviewThread: async (item) => {
        calls.push(item.threadNodeId);
        return { ok: true, finding: { ...item, lifecycle: 'RESOLVED', threadResolutionStatus: 'RESOLVED' } };
      },
      escalateSupervisor: async () => ({ outcome: 'HUMAN_REQUIRED', reason: 'still present' }),
    },
  });
  assert.deepEqual(calls, ['thread-1']);
  assert.equal(out.state.reviewFindings.find((item) => item.threadNodeId === 'thread-2').lifecycle, 'OPEN');
});

test('resolution failure produces clean-with-unresolved terminal state', async () => {
  const out = await closeout({
    h1: review('h1', [finding('1', 'bug')], 'r1'),
    h2: review('h2', [], 'r2'),
  }, async (item) => ({ ok: false, finding: { ...item, threadResolutionStatus: 'FAILED' } }));
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.CLEAN_WITH_UNRESOLVED_THREADS);
  assert.equal(out.state.reviewFindings[0].lifecycle, 'FIXED');
});
