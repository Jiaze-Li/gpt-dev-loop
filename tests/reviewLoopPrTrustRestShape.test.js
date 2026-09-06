// Phase 1 — the default reviewer allowlist matches the LITERAL `user.login`
// string the GitHub REST reviews API returns for the review author. A GitHub
// App on a PR always appears as "<slug>[bot]". Real REST-shaped fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPrReviewTrust,
  TRUST_REJECT_REASONS,
  reviewerLoginAllowlist,
} from '../src/reviewloop/prTrust.js';

// Exactly the shape of one element of
// GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
function restReview({ login, commitId = 'H1', state = 'APPROVED', body = '' }) {
  return {
    id: 123456,
    user: { login, id: 999, type: 'Bot' },
    body,
    state,
    commit_id: commitId,
    submitted_at: '2026-09-06T00:00:00Z',
    html_url: 'https://github.com/o/r/pull/4#pullrequestreview-123456',
  };
}

test('default allowlists are the exact REST bot logins', () => {
  assert.deepEqual(reviewerLoginAllowlist('codex', {}), ['chatgpt-codex-connector[bot]']);
  assert.deepEqual(reviewerLoginAllowlist('claude', {}), ['claude[bot]']);
});

test('REST-shaped codex review with the exact bot login + exact HEAD is accepted', () => {
  const r = checkPrReviewTrust({
    raw: restReview({ login: 'chatgpt-codex-connector[bot]', commitId: 'HEAD_SHA_1' }),
    configuredReviewer: 'codex',
    currentHead: 'HEAD_SHA_1',
  });
  assert.equal(r.ok, true);
  assert.equal(r.review.reviewerLogin, 'chatgpt-codex-connector[bot]');
  assert.equal(r.review.headSha, 'HEAD_SHA_1');
});

test('REST-shaped claude review with the exact bot login is accepted', () => {
  const r = checkPrReviewTrust({
    raw: restReview({ login: 'claude[bot]', commitId: 'HEAD_SHA_1' }),
    configuredReviewer: 'claude',
    currentHead: 'HEAD_SHA_1',
  });
  assert.equal(r.ok, true);
  assert.equal(r.review.reviewerLogin, 'claude[bot]');
});

test('look-alike bot logins on a REST-shaped payload are all rejected', () => {
  const lookAlikes = [
    'chatgpt-codex-connector',          // bare slug — never what REST returns
    'chatgpt-codex-connector[bot]evil',
    'evil-chatgpt-codex-connector[bot]',
    'chatgpt-codex-connector(bot)',
    'chatgpt-codex-connector-bot',
    'chatgpt-codex-connectorbot',
    'ChatGPT-Codex-Connector',          // case-only would be fine; this has no [bot]
  ];
  for (const login of lookAlikes) {
    const r = checkPrReviewTrust({
      raw: restReview({ login, commitId: 'H1' }),
      configuredReviewer: 'codex',
      currentHead: 'H1',
    });
    assert.equal(r.ok, false, login);
    assert.equal(r.reason, TRUST_REJECT_REASONS.WRONG_REVIEWER_IDENTITY, login);
  }
  for (const login of ['claude', 'claude-bot', 'claudebot', 'anthropic[bot]', 'claude[bot]x']) {
    const r = checkPrReviewTrust({
      raw: restReview({ login, commitId: 'H1' }),
      configuredReviewer: 'claude',
      currentHead: 'H1',
    });
    assert.equal(r.ok, false, login);
  }
});

test('exact login but stale reviewed HEAD is still rejected', () => {
  const r = checkPrReviewTrust({
    raw: restReview({ login: 'chatgpt-codex-connector[bot]', commitId: 'OLD' }),
    configuredReviewer: 'codex',
    currentHead: 'NEW',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, TRUST_REJECT_REASONS.WRONG_REVIEWED_HEAD);
});
