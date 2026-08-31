import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGithubReviewThread } from '../src/orchestrator/adapters/githubPrReviewAdapter.js';
import { FINDING_LIFECYCLE, THREAD_RESOLUTION_STATUS } from '../src/orchestrator/adapters/normalizedPrReview.js';

function fixedFinding(overrides = {}) {
  return {
    reviewId: 'review-old',
    threadId: 'PRRT_node_1',
    threadNodeId: 'PRRT_node_1',
    commentId: 'comment-1',
    signature: 'P1:src/a.js:bounds check',
    lifecycle: FINDING_LIFECYCLE.FIXED,
    threadResolutionStatus: THREAD_RESOLUTION_STATUS.PENDING,
    resolvedOnHead: 'head-new',
    verificationReviewId: 'review-new',
    ...overrides,
  };
}

test('resolves the exact original thread node and returns durable evidence', async () => {
  const calls = [];
  const result = await resolveGithubReviewThread({
    github: { async resolveReviewThread(input) { calls.push(input); return { thread: { id: input.threadId, isResolved: true } }; } },
    finding: fixedFinding(),
    clock: { now: () => Date.parse('2026-08-31T01:02:03.000Z') },
  });

  assert.deepEqual(calls, [{ threadId: 'PRRT_node_1' }]);
  assert.equal(result.ok, true);
  assert.equal(result.finding.lifecycle, FINDING_LIFECYCLE.RESOLVED);
  assert.equal(result.finding.threadResolutionStatus, THREAD_RESOLUTION_STATUS.RESOLVED);
  assert.deepEqual(result.evidence, {
    threadId: 'PRRT_node_1', resolvedAt: '2026-08-31T01:02:03.000Z', resolvedBy: 'supergpt',
    resolvedOnHead: 'head-new', verificationReviewId: 'review-new',
  });
});

test('retries a bounded number of times and preserves FIXED on terminal API failure', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await resolveGithubReviewThread({
    github: { async resolveReviewThread() { calls += 1; throw Object.assign(new Error('boom'), { status: 503 }); } },
    finding: fixedFinding(),
    maxAttempts: 3,
    retryDelayMs: 7,
    clock: { async sleep(ms) { sleeps.push(ms); } },
  });

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7, 7]);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.finding.lifecycle, FINDING_LIFECYCLE.FIXED);
  assert.equal(result.finding.threadResolutionStatus, THREAD_RESOLUTION_STATUS.FAILED);
  assert.equal(result.error.status, 503);
});

test('already resolved is idempotent and missing identity never calls GitHub', async () => {
  let calls = 0;
  const github = { async resolveReviewThread() { calls += 1; } };
  const resolved = fixedFinding({ lifecycle: FINDING_LIFECYCLE.RESOLVED,
    threadResolutionStatus: THREAD_RESOLUTION_STATUS.RESOLVED, resolvedAt: 'then' });
  const repeated = await resolveGithubReviewThread({ github, finding: resolved });
  const unreliable = await resolveGithubReviewThread({ github, finding: fixedFinding({ threadNodeId: null, threadId: null }) });

  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.attempts, 0);
  assert.equal(unreliable.ok, false);
  assert.equal(unreliable.attempts, 0);
  assert.equal(unreliable.finding.lifecycle, FINDING_LIFECYCLE.OPEN);
  assert.equal(calls, 0);
});

test('GraphQL fallback uses resolveReviewThread mutation with only node identity', async () => {
  const calls = [];
  const result = await resolveGithubReviewThread({
    github: { async graphql(query, variables) { calls.push({ query, variables }); return { resolveReviewThread: { thread: { id: variables.threadId, isResolved: true } } }; } },
    finding: fixedFinding(),
    clock: { now: () => 0 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].variables, { threadId: 'PRRT_node_1' });
  assert.match(calls[0].query, /resolveReviewThread\(input: \{ threadId: \$threadId \}\)/);
});
