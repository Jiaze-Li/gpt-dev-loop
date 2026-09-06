// B3 + B4 — production PR backend is wired, and every review it returns
// (existing or freshly-triggered) passes a strict trust boundary:
//   reviewer identity == configured  AND
//   reviewed HEAD explicitly present AND
//   reviewed HEAD == current PR HEAD

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrReviewTrust, TRUST_REJECT_REASONS } from '../src/reviewloop/prTrust.js';
import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { normalizeReview } from '../src/reviewloop/reviewPolicy.js';

test('checkPrReviewTrust: missing reviewed HEAD -> reject', () => {
  const r = checkPrReviewTrust({ raw: { reviewer: 'codex', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.MISSING_REVIEWED_HEAD);
});

test('checkPrReviewTrust: wrong reviewed HEAD -> reject (old HEAD cannot approve new HEAD)', () => {
  const r = checkPrReviewTrust({ raw: { reviewer: 'codex', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.WRONG_REVIEWED_HEAD);
});

test('checkPrReviewTrust: missing reviewer identity -> reject', () => {
  const r = checkPrReviewTrust({ raw: { headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.MISSING_REVIEWER_IDENTITY);
});

test('checkPrReviewTrust: wrong reviewer identity -> reject', () => {
  const r = checkPrReviewTrust({ raw: { reviewer: 'randobot', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.WRONG_REVIEWER_IDENTITY);
});

test('checkPrReviewTrust: correct reviewer + exact current HEAD -> accepted', () => {
  const r = checkPrReviewTrust({ raw: { reviewer: 'codex', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, true);
  assert.equal(r.review.headSha, 'H1');
});

test('normalizeReview with requireExplicitHead never substitutes the current HEAD', () => {
  const r = normalizeReview({ raw: { reviewer: 'codex', findings: [] }, reviewer: 'codex', provider: 'codex', head: 'H9', requireExplicitHead: true });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.error.reason, 'MISSING_REVIEWED_HEAD');
  assert.equal(r.reviewedHead, null);
});

// ---- production GitHub backend (injected transport, no real gh) ----------

function ghTransport({ head = 'H1', reviews = [] } = {}) {
  return {
    async getPrHead() { return head; },
    async listReviews() { return reviews; },
    async postComment() { return { id: 'https://github.com/x/y/pull/4#issuecomment-1' }; },
  };
}

test('backend.findExistingReview returns only a trusted, current-HEAD review', async () => {
  const backend = createGithubReviewBackend({
    transport: ghTransport({
      head: 'H2',
      reviews: [
        { login: 'chatgpt-codex-connector', state: 'CHANGES_REQUESTED', commitId: 'H1', body: '', submittedAt: '2026-01-01' }, // stale HEAD
        { login: 'chatgpt-codex-connector', state: 'APPROVED', commitId: 'H2', body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-02' },
      ],
    }),
  });
  const review = await backend.findExistingReview({ prNumber: 4, headSha: 'H2', reviewer: 'codex' });
  assert.ok(review);
  assert.equal(review.headSha, 'H2');
  assert.equal(review.findings.length, 0);
});

test('backend.findExistingReview rejects a review from an untrusted login', async () => {
  const backend = createGithubReviewBackend({
    transport: ghTransport({ head: 'H1', reviews: [{ login: 'random-user', state: 'CHANGES_REQUESTED', commitId: 'H1', body: '' }] }),
  });
  assert.equal(await backend.findExistingReview({ prNumber: 4, headSha: 'H1', reviewer: 'codex' }), null);
});

test('backend.waitForReview returns null (detach) when no trusted review appears within budget', async () => {
  const backend = createGithubReviewBackend({
    transport: ghTransport({ head: 'H1', reviews: [] }),
    maxWaitMs: 5,
    pollIntervalMs: 1,
    sleep: () => Promise.resolve(),
  });
  let heartbeats = 0;
  const res = await backend.waitForReview({ prNumber: 4, headSha: 'H1', reviewer: 'codex', onHeartbeat: () => { heartbeats += 1; } });
  assert.equal(res, null);
  assert.ok(heartbeats >= 1);
});

test('controller PR mode rejects an existing review that fails the trust boundary', async () => {
  const persistence = new MemoryPersistence();
  const prBackend = {
    async getPrHead() { return 'H2'; },
    // backend bug / spoof: returns a review whose reviewed HEAD is stale
    async findExistingReview() { return { reviewer: 'codex', headSha: 'H1', findings: [] }; },
    async postReviewTrigger() { return { id: 'c' }; },
    async waitForReview() { return null; },
  };
  const controller = createReviewLoopController({ persistence, prBackend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /trust boundary/);
});
