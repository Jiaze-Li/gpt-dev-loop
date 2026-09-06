// B3 + B4 — production PR backend is wired, and every review it returns
// (existing or freshly-triggered) passes a strict trust boundary:
//   the REAL GitHub login is in the EXACT allowlist for the configured reviewer
//     (no substring / includes — evil-codex-bot / fake-claude are rejected)
//   the reviewed HEAD is explicitly in the payload (never substituted)
//   the reviewed HEAD == current PR HEAD

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPrReviewTrust,
  TRUST_REJECT_REASONS,
  reviewerLoginAllowlist,
} from '../src/reviewloop/prTrust.js';
import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { normalizeReview } from '../src/reviewloop/reviewPolicy.js';

const CODEX = { login: 'chatgpt-codex-connector' };

test('the allowlist is exact (no substring / includes)', () => {
  const list = reviewerLoginAllowlist('codex', {});
  assert.deepEqual(list, ['chatgpt-codex-connector']);
  // a substring look-alike is not in the list
  assert.equal(list.includes('evil-chatgpt-codex-connector-bot'), false);
});

test('substring look-alike bot logins are rejected', () => {
  for (const login of ['evil-codex-bot', 'chatgpt-codex-connector-evil', 'not-chatgpt-codex-connector', 'codex']) {
    const r = checkPrReviewTrust({ raw: { login, headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
    assert.equal(r.ok, false, login);
    assert.equal(r.reason, TRUST_REJECT_REASONS.WRONG_REVIEWER_IDENTITY, login);
  }
  for (const login of ['fake-claude-reviewer', 'claude-bot', 'claudebot', 'anthropic']) {
    const r = checkPrReviewTrust({ raw: { login, headSha: 'H1', findings: [] }, configuredReviewer: 'claude', currentHead: 'H1' });
    assert.equal(r.ok, false, login);
  }
});

test('a payload pre-labelled with the configured reviewer name but no real login is rejected', () => {
  // the identity check must NOT trust a `reviewer: "codex"` field
  const r = checkPrReviewTrust({ raw: { reviewer: 'codex', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.MISSING_REVIEWER_IDENTITY);
});

test('the exact allowlisted login + exact current HEAD -> accepted', () => {
  const r = checkPrReviewTrust({ raw: { ...CODEX, headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(r.ok, true);
  assert.equal(r.review.headSha, 'H1');
  assert.equal(r.review.reviewer, 'codex');
  assert.equal(r.review.reviewerLogin, 'chatgpt-codex-connector');
});

test('env can override the allowlist but it is still exact', () => {
  const env = { REVIEWLOOP_CODEX_REVIEWER_LOGINS: 'my-org-codex-app , other-bot' };
  const ok = checkPrReviewTrust({ raw: { login: 'my-org-codex-app', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1', env });
  assert.equal(ok.ok, true);
  const bad = checkPrReviewTrust({ raw: { login: 'chatgpt-codex-connector', headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H1', env });
  assert.equal(bad.ok, false);
});

test('missing reviewed HEAD -> reject; wrong reviewed HEAD -> reject', () => {
  const noHead = checkPrReviewTrust({ raw: { ...CODEX, findings: [] }, configuredReviewer: 'codex', currentHead: 'H1' });
  assert.equal(noHead.reason, TRUST_REJECT_REASONS.MISSING_REVIEWED_HEAD);
  const stale = checkPrReviewTrust({ raw: { ...CODEX, headSha: 'H1', findings: [] }, configuredReviewer: 'codex', currentHead: 'H2' });
  assert.equal(stale.reason, TRUST_REJECT_REASONS.WRONG_REVIEWED_HEAD);
});

test('an unknown configured reviewer has no allowlist -> reject', () => {
  const r = checkPrReviewTrust({ raw: { login: 'x', headSha: 'H1' }, configuredReviewer: 'internal', currentHead: 'H1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.UNKNOWN_CONFIGURED_REVIEWER);
});

test('normalizeReview with requireExplicitHead never substitutes the current HEAD', () => {
  const r = normalizeReview({ raw: { login: 'chatgpt-codex-connector', findings: [] }, reviewer: 'codex', provider: 'codex', head: 'H9', requireExplicitHead: true });
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

test('backend returns only a review from an exact allowlisted login on the current HEAD', async () => {
  const backend = createGithubReviewBackend({
    transport: ghTransport({
      head: 'H2',
      reviews: [
        { login: 'chatgpt-codex-connector', state: 'CHANGES_REQUESTED', commitId: 'H1', body: '', submittedAt: '2026-01-01' }, // stale HEAD
        { login: 'evil-codex-bot', state: 'APPROVED', commitId: 'H2', body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-03' }, // impostor
        { login: 'chatgpt-codex-connector', state: 'APPROVED', commitId: 'H2', body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-02' },
      ],
    }),
  });
  const review = await backend.findExistingReview({ prNumber: 4, headSha: 'H2', reviewer: 'codex' });
  assert.ok(review);
  assert.equal(review.reviewerLogin, 'chatgpt-codex-connector');
  assert.equal(review.headSha, 'H2');
});

test('backend rejects a review from an untrusted / look-alike login', async () => {
  for (const login of ['random-user', 'evil-codex-bot', 'chatgpt-codex-connector.evil']) {
    // eslint-disable-next-line no-await-in-loop
    const backend = createGithubReviewBackend({
      transport: ghTransport({ head: 'H1', reviews: [{ login, state: 'CHANGES_REQUESTED', commitId: 'H1', body: '' }] }),
    });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await backend.findExistingReview({ prNumber: 4, headSha: 'H1', reviewer: 'codex' }), null, login);
  }
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
    async findExistingReview() { return { login: 'evil-codex-bot', headSha: 'H2', findings: [] }; },
    async postReviewTrigger() { return { id: 'c' }; },
    async waitForReview() { return null; },
  };
  const controller = createReviewLoopController({ persistence, prBackend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /trust boundary/);
});
