// ReviewLoop PR trust boundary.
//
// A raw external PR review is only accepted when it can PROVE:
//   reviewer identity   == configured reviewer
//   reviewed HEAD        explicitly present in the payload (never substituted)
//   reviewed HEAD        == current PR HEAD
//
// Missing any of the three -> fail closed (rejected). Reuses the existing V2
// trusted-review primitives; it does not introduce a second, looser trust
// implementation.

import {
  isTrustedReviewer,
  isReviewFresh,
} from '../orchestrator/trustedPrReview.js';

export const TRUST_REJECT_REASONS = Object.freeze({
  MISSING_REVIEWER_IDENTITY: 'MISSING_REVIEWER_IDENTITY',
  WRONG_REVIEWER_IDENTITY: 'WRONG_REVIEWER_IDENTITY',
  MISSING_REVIEWED_HEAD: 'MISSING_REVIEWED_HEAD',
  WRONG_REVIEWED_HEAD: 'WRONG_REVIEWED_HEAD',
  MALFORMED: 'MALFORMED',
});

export function extractReviewedHead(raw) {
  const h = raw?.headSha ?? raw?.reviewedHead ?? raw?.head_sha ?? raw?.commit_id ?? raw?.commitId ?? raw?.reviewedHeadSha;
  const s = typeof h === 'string' ? h.trim() : '';
  return s || null;
}

// Returns { ok: true, review } or { ok: false, reason }. `review` is the raw
// payload with a canonical `headSha` and `reviewer` guaranteed present.
export function checkPrReviewTrust({ raw, configuredReviewer, currentHead } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.MALFORMED };
  }
  const reviewerId = String(raw.reviewer ?? raw.reviewerId ?? '').trim();
  if (!reviewerId) return { ok: false, reason: TRUST_REJECT_REASONS.MISSING_REVIEWER_IDENTITY };
  if (!isTrustedReviewer({ reviewer: reviewerId }, configuredReviewer)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.WRONG_REVIEWER_IDENTITY };
  }
  const reviewedHead = extractReviewedHead(raw);
  if (!reviewedHead) return { ok: false, reason: TRUST_REJECT_REASONS.MISSING_REVIEWED_HEAD };
  if (!isReviewFresh({ headSha: reviewedHead }, currentHead)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.WRONG_REVIEWED_HEAD };
  }
  return {
    ok: true,
    review: { ...raw, reviewer: reviewerId, headSha: reviewedHead, head_sha: reviewedHead },
  };
}
