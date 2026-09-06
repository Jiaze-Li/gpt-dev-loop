// ReviewLoop PR trust boundary.
//
// A raw external PR review is only accepted when it can PROVE:
//   real GitHub login   is in the EXACT allowlist for the configured reviewer
//                        (exact string equality — never substring / includes,
//                         so `evil-codex-bot` / `fake-claude` are rejected)
//   reviewed HEAD        explicitly present in the payload (never substituted)
//   reviewed HEAD        == current PR HEAD
//
// The identity check is done against the RAW GitHub login, before any
// canonicalisation — the payload is never first rewritten to the configured
// reviewer name and then "verified" against itself. Reuses the existing V2
// trusted-review primitives (isTrustedReviewer with an allowlist array is
// exact membership; isReviewFresh) — no second, looser trust implementation.

import { isTrustedReviewer, isReviewFresh } from '../orchestrator/trustedPrReview.js';

export const TRUST_REJECT_REASONS = Object.freeze({
  MISSING_REVIEWER_IDENTITY: 'MISSING_REVIEWER_IDENTITY',
  WRONG_REVIEWER_IDENTITY: 'WRONG_REVIEWER_IDENTITY',
  MISSING_REVIEWED_HEAD: 'MISSING_REVIEWED_HEAD',
  WRONG_REVIEWED_HEAD: 'WRONG_REVIEWED_HEAD',
  UNKNOWN_CONFIGURED_REVIEWER: 'UNKNOWN_CONFIGURED_REVIEWER',
  MALFORMED: 'MALFORMED',
});

// Exact GitHub bot-account logins per configured PR reviewer. Deployment-
// overridable via env (comma-separated), but ALWAYS exact-match.
export const DEFAULT_REVIEWER_LOGINS = Object.freeze({
  codex: Object.freeze(['chatgpt-codex-connector']),
  claude: Object.freeze(['claude[bot]', 'claude']),
});

function splitEnvList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function reviewerLoginAllowlist(configuredReviewer, env = process.env) {
  const key = String(configuredReviewer ?? '').trim().toLowerCase();
  const envKey = key === 'codex'
    ? 'REVIEWLOOP_CODEX_REVIEWER_LOGINS'
    : key === 'claude'
      ? 'REVIEWLOOP_CLAUDE_REVIEWER_LOGINS'
      : null;
  if (!envKey) return null; // unknown configured reviewer -> no allowlist
  const override = splitEnvList(env?.[envKey]);
  if (override.length) return override;
  return (DEFAULT_REVIEWER_LOGINS[key] ?? []).map((s) => s.toLowerCase());
}

export function extractReviewedHead(raw) {
  const h = raw?.headSha ?? raw?.reviewedHead ?? raw?.head_sha ?? raw?.commit_id ?? raw?.commitId ?? raw?.reviewedHeadSha;
  const s = typeof h === 'string' ? h.trim() : '';
  return s || null;
}

// The raw GitHub login of whoever produced the review — read from a login
// field, NEVER from a `reviewer` field (which may already carry a canonical
// name rather than a real account).
export function extractReviewerLogin(raw) {
  const l = raw?.login
    ?? raw?.reviewerLogin
    ?? raw?.user?.login
    ?? raw?.author?.login;
  const s = typeof l === 'string' ? l.trim() : '';
  return s || null;
}

// Returns { ok: true, review } or { ok: false, reason }. On success `review`
// carries the canonical `reviewer` (configured), the real `reviewerLogin`, and
// a canonical `headSha`/`head_sha`.
export function checkPrReviewTrust({
  raw, configuredReviewer, currentHead, env = process.env,
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.MALFORMED };
  }

  const allowlist = reviewerLoginAllowlist(configuredReviewer, env);
  if (!allowlist || allowlist.length === 0) {
    return { ok: false, reason: TRUST_REJECT_REASONS.UNKNOWN_CONFIGURED_REVIEWER };
  }

  const login = extractReviewerLogin(raw);
  if (!login) return { ok: false, reason: TRUST_REJECT_REASONS.MISSING_REVIEWER_IDENTITY };
  // isTrustedReviewer with an array does EXACT membership (no substring).
  if (!isTrustedReviewer({ reviewer: login }, allowlist)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.WRONG_REVIEWER_IDENTITY, login };
  }

  const reviewedHead = extractReviewedHead(raw);
  if (!reviewedHead) return { ok: false, reason: TRUST_REJECT_REASONS.MISSING_REVIEWED_HEAD };
  if (!isReviewFresh({ headSha: reviewedHead }, currentHead)) {
    return { ok: false, reason: TRUST_REJECT_REASONS.WRONG_REVIEWED_HEAD };
  }

  return {
    ok: true,
    review: {
      ...raw,
      reviewer: String(configuredReviewer).trim().toLowerCase(),
      reviewerLogin: login,
      login,
      headSha: reviewedHead,
      head_sha: reviewedHead,
    },
  };
}
