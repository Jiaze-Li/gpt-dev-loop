import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFinding,
  findingSignature,
  classifyFindings,
  isTrustedReviewer,
  isReviewFresh,
  isForkWriteAllowed,
  ingestTrustedReview,
  TRUSTED_REVIEW_VERDICTS,
} from '../src/orchestrator/trustedPrReview.js';
import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from '../src/orchestrator/errors.js';

const CONFIG = { configuredReviewer: 'trusted-claude-reviewer', currentPrHead: 'sha-1' };

function review(overrides = {}) {
  return {
    reviewer: 'trusted-claude-reviewer',
    headSha: 'sha-1',
    findings: [],
    ...overrides,
  };
}

test('normalizeFinding rejects unknown severity and empty message', () => {
  assert.throws(() => normalizeFinding({ severity: 'P9', message: 'x' }), PrCloseoutError);
  assert.throws(() => normalizeFinding({ severity: 'P1', message: '   ' }), PrCloseoutError);
});

test('P1/P2 are actionable, P3 is not', () => {
  assert.equal(normalizeFinding({ severity: 'P1', message: 'a' }).actionable, true);
  assert.equal(normalizeFinding({ severity: 'p2', message: 'a' }).actionable, true);
  assert.equal(normalizeFinding({ severity: 'P3', message: 'a' }).actionable, false);
});

test('findingSignature is stable across whitespace/case and prefers explicit id', () => {
  const a = normalizeFinding({ severity: 'P1', file: 'src/a.js', message: 'Null   deref HERE' });
  const b = normalizeFinding({ severity: 'p1', file: 'src/a.js', message: 'null deref here' });
  assert.equal(a.signature, b.signature);
  assert.equal(findingSignature({ id: 'RULE-7', severity: 'P1', message: 'x' }), 'id:RULE-7');
});

test('classifyFindings verdicts: clean / non-actionable / actionable', () => {
  assert.equal(classifyFindings([]).verdict, TRUSTED_REVIEW_VERDICTS.CLEAN);
  assert.equal(
    classifyFindings([{ severity: 'P3', message: 'nit' }]).verdict,
    TRUSTED_REVIEW_VERDICTS.NON_ACTIONABLE,
  );
  const c = classifyFindings([
    { severity: 'P3', message: 'nit' },
    { severity: 'P1', file: 'x.js', message: 'bug' },
  ]);
  assert.equal(c.verdict, TRUSTED_REVIEW_VERDICTS.ACTIONABLE);
  assert.equal(c.actionable.length, 1);
  assert.equal(c.actionableSignatures.length, 1);
});

test('isTrustedReviewer only accepts the exact configured identity', () => {
  assert.equal(isTrustedReviewer({ reviewer: 'trusted-claude-reviewer' }, 'trusted-claude-reviewer'), true);
  assert.equal(isTrustedReviewer({ reviewer: 'someone-else' }, 'trusted-claude-reviewer'), false);
  assert.equal(isTrustedReviewer({ reviewer: 'trusted-claude-reviewer' }, ''), false);
  assert.equal(isTrustedReviewer({}, 'trusted-claude-reviewer'), false);
});

test('isReviewFresh compares reviewed head to current PR head', () => {
  assert.equal(isReviewFresh({ headSha: 'sha-1' }, 'sha-1'), true);
  assert.equal(isReviewFresh({ headSha: 'sha-1' }, 'sha-2'), false);
  assert.equal(isReviewFresh({}, 'sha-1'), false);
});

test('isForkWriteAllowed: fork needs an explicit safe write path', () => {
  assert.equal(isForkWriteAllowed({ isFork: false }), true);
  assert.equal(isForkWriteAllowed({ isFork: true, safeForkWritePath: false }), false);
  assert.equal(isForkWriteAllowed({ isFork: true, safeForkWritePath: true }), true);
});

test('ingestTrustedReview fails closed on untrusted identity', () => {
  try {
    ingestTrustedReview({ review: review({ reviewer: 'evil' }), config: CONFIG });
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error instanceof PrCloseoutError);
    assert.equal(error.code, PR_CLOSEOUT_ERROR_CODES.UNTRUSTED_REVIEWER);
  }
});

test('ingestTrustedReview fails closed on stale head', () => {
  try {
    ingestTrustedReview({ review: review({ headSha: 'old' }), config: CONFIG, currentPrHead: 'sha-1' });
    assert.fail('should throw');
  } catch (error) {
    assert.equal(error.code, PR_CLOSEOUT_ERROR_CODES.STALE_REVIEW_HEAD);
  }
});

test('ingestTrustedReview fails closed on missing payload', () => {
  assert.throws(() => ingestTrustedReview({ review: null, config: CONFIG }), PrCloseoutError);
});

test('ingestTrustedReview returns a normalized trusted review', () => {
  const out = ingestTrustedReview({
    review: review({ findings: [{ severity: 'P2', file: 'a.js', message: 'fix me' }] }),
    config: { configuredReviewer: 'trusted-claude-reviewer', isFork: true },
    currentPrHead: 'sha-1',
  });
  assert.equal(out.verdict, TRUSTED_REVIEW_VERDICTS.ACTIONABLE);
  assert.equal(out.headSha, 'sha-1');
  assert.equal(out.isFork, true);
  assert.equal(out.actionable.length, 1);
});
