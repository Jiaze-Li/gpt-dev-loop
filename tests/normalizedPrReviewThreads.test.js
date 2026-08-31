import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINDING_LIFECYCLE,
  THREAD_RESOLUTION_STATUS,
  hasReliableThreadIdentity,
  markFindingFixed,
  normalizeProviderReview,
  normalizeReviewFinding,
  recordThreadResolution,
} from '../src/orchestrator/adapters/normalizedPrReview.js';

const complete = {
  reviewId: 'review-1',
  threadNodeId: 'thread-1',
  commentId: 'comment-1',
  severity: 'P1',
  file: 'src/a.js',
  line: 12,
  title: 'Null dereference',
};

test('normalized finding carries exact thread identity and defaults OPEN', () => {
  const finding = normalizeReviewFinding(complete);
  assert.equal(finding.reviewId, 'review-1');
  assert.equal(finding.threadId, 'thread-1');
  assert.equal(finding.threadNodeId, 'thread-1');
  assert.equal(finding.commentId, 'comment-1');
  assert.equal(finding.lifecycle, FINDING_LIFECYCLE.OPEN);
  assert.equal(finding.threadResolutionStatus, THREAD_RESOLUTION_STATUS.NOT_ATTEMPTED);
  assert.equal(finding.identityReliable, true);
});

test('provider review id is inherited by each finding', () => {
  const review = normalizeProviderReview({
    provider: 'codex',
    raw: { reviewId: 'review-2', findings: [{ ...complete, reviewId: undefined }] },
  });
  assert.equal(review.findings[0].reviewId, 'review-2');
});

test('incomplete identity remains OPEN even if persisted input claims fixed', () => {
  const finding = normalizeReviewFinding({ ...complete, threadNodeId: null, lifecycle: 'FIXED' });
  assert.equal(hasReliableThreadIdentity(finding), false);
  assert.equal(finding.lifecycle, FINDING_LIFECYCLE.OPEN);
  assert.equal(markFindingFixed(finding, {
    verificationReviewId: 'review-2', resolvedOnHead: 'head-2',
  }).lifecycle, FINDING_LIFECYCLE.OPEN);
});

test('FIXED and RESOLVED transitions retain verification and resolution evidence', () => {
  const open = normalizeReviewFinding(complete);
  const fixed = markFindingFixed(open, {
    verificationReviewId: 'review-2', resolvedOnHead: 'head-2',
  });
  assert.equal(fixed.lifecycle, FINDING_LIFECYCLE.FIXED);
  assert.equal(fixed.threadResolutionStatus, THREAD_RESOLUTION_STATUS.PENDING);
  const resolved = recordThreadResolution(fixed, {
    success: true, threadId: 'thread-1', resolvedAt: '2026-08-31T00:00:00.000Z',
  });
  assert.equal(resolved.lifecycle, FINDING_LIFECYCLE.RESOLVED);
  assert.equal(resolved.resolvedBy, 'supergpt');
  assert.equal(resolved.resolvedOnHead, 'head-2');
  assert.equal(resolved.verificationReviewId, 'review-2');
  assert.deepEqual(recordThreadResolution(resolved, { success: false }), resolved);
});

test('failed or mismatched exact-thread resolution does not masquerade as resolved', () => {
  const fixed = markFindingFixed(normalizeReviewFinding(complete), {
    verificationReviewId: 'review-2', resolvedOnHead: 'head-2',
  });
  for (const result of [
    recordThreadResolution(fixed, { success: false }),
    recordThreadResolution(fixed, { success: true, threadId: 'other', resolvedAt: 'now' }),
  ]) {
    assert.equal(result.lifecycle, FINDING_LIFECYCLE.FIXED);
    assert.equal(result.threadResolutionStatus, THREAD_RESOLUTION_STATUS.FAILED);
  }
});
