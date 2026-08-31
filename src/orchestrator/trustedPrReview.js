// V2-C — trusted PR review ingestion.
//
// The trusted PR reviewer is a separate, account-wide, read-only trust
// boundary (docs/V2_PLAN.md §V2-C). This module turns a raw review payload
// into a normalized, validated structure the deterministic closeout policy
// can act on. It NEVER mutates repository state and it fails closed:
//   - trust only the configured reviewer identity;
//   - reject review data whose reviewed head no longer matches the PR head;
//   - reject malformed payloads instead of assuming "clean".

import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from './errors.js';
import {
  NORMALIZED_REVIEW_STATUS,
  normalizeProviderReview,
  assertNormalizedReviewUsable,
} from './adapters/normalizedPrReview.js';

export { NORMALIZED_REVIEW_STATUS } from './adapters/normalizedPrReview.js';

export const FINDING_SEVERITIES = Object.freeze(['P1', 'P2', 'P3']);
export const ACTIONABLE_SEVERITIES = Object.freeze(['P1', 'P2']);

export const TRUSTED_REVIEW_VERDICTS = Object.freeze({
  CLEAN: 'CLEAN',
  ACTIONABLE: 'ACTIONABLE',
  NON_ACTIONABLE: 'NON_ACTIONABLE',
});

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSeverity(raw) {
  const text = String(raw ?? '').trim().toUpperCase();
  return FINDING_SEVERITIES.includes(text) ? text : null;
}

// A stable identity for "the same finding". Prefer a reviewer-supplied stable
// id; otherwise derive from severity + file + normalized message so that a
// finding that survives a repair round is recognised on the next review.
export function findingSignature(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const explicit = typeof finding.id === 'string' ? finding.id.trim() : '';
  if (explicit) return `id:${explicit}`;
  const severity = normalizeSeverity(finding.severity) ?? 'NA';
  const file = normalizeText(finding.file);
  const message = normalizeText(finding.message ?? finding.title ?? finding.summary);
  if (!message && !file) return null;
  return `${severity}:${file}:${message}`;
}

export function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'trusted review finding is not an object',
    );
  }
  const severity = normalizeSeverity(raw.severity);
  if (!severity) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      `trusted review finding has unknown severity: ${JSON.stringify(raw.severity)}`,
    );
  }
  const message = String(raw.message ?? raw.title ?? raw.summary ?? '').trim();
  if (!message) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'trusted review finding has no message',
    );
  }
  const normalized = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null,
    severity,
    message,
    file: typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : null,
    line: Number.isInteger(raw.line) ? raw.line : null,
    actionable: ACTIONABLE_SEVERITIES.includes(severity),
  };
  normalized.signature = findingSignature(normalized);
  return normalized;
}

export function classifyFindings(findings) {
  const normalized = (Array.isArray(findings) ? findings : []).map(normalizeFinding);
  const actionable = normalized.filter((f) => f.actionable);
  const nonActionable = normalized.filter((f) => !f.actionable);
  let verdict = TRUSTED_REVIEW_VERDICTS.CLEAN;
  if (actionable.length > 0) verdict = TRUSTED_REVIEW_VERDICTS.ACTIONABLE;
  else if (nonActionable.length > 0) verdict = TRUSTED_REVIEW_VERDICTS.NON_ACTIONABLE;
  return {
    findings: normalized,
    actionable,
    nonActionable,
    verdict,
    actionableSignatures: [...new Set(actionable.map((f) => f.signature).filter(Boolean))].sort(),
  };
}

// Trust only the exact configured reviewer identity. Any mismatch, or an
// unconfigured expectation, fails closed.
export function isTrustedReviewer(review, configuredReviewer) {
  const expected = String(configuredReviewer ?? '').trim().toLowerCase();
  if (!expected) return false;
  const actual = String(review?.reviewer ?? review?.reviewerId ?? '').trim().toLowerCase();
  return Boolean(actual) && actual === expected;
}

// A review is only usable while the head it examined is still the PR head.
export function isReviewFresh(review, currentPrHead) {
  const reviewed = String(review?.headSha ?? review?.reviewedHead ?? '').trim();
  const current = String(currentPrHead ?? '').trim();
  return Boolean(reviewed) && Boolean(current) && reviewed === current;
}

export function isForkWriteAllowed({ isFork = false, safeForkWritePath = false } = {}) {
  if (!isFork) return true;
  return safeForkWritePath === true;
}

// Ingest and validate a raw trusted-review payload. Returns a normalized,
// trusted, fresh review or throws a fail-closed PrCloseoutError.
export function ingestTrustedReview({ review, config = {}, currentPrHead } = {}) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new PrCloseoutError(PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW, 'trusted review payload missing');
  }
  if (!isTrustedReviewer(review, config.configuredReviewer)) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.UNTRUSTED_REVIEWER,
      'trusted review came from an unconfigured reviewer identity',
      { expected: config.configuredReviewer ?? null, actual: review.reviewer ?? review.reviewerId ?? null },
    );
  }
  const head = currentPrHead ?? config.currentPrHead;
  if (!isReviewFresh(review, head)) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.STALE_REVIEW_HEAD,
      'trusted review head no longer matches the PR head; a fresh review is required',
      { reviewedHead: review.headSha ?? review.reviewedHead ?? null, currentPrHead: head ?? null },
    );
  }
  // Provider boundary: build the unified normalized structure the Core
  // consumes. A FAILED normalization fails closed (never treated as CLEAN).
  const normalized = assertNormalizedReviewUsable(normalizeProviderReview({
    raw: review,
    reviewer: String(review.reviewer ?? review.reviewerId).trim(),
    provider: config.provider ?? review.provider,
    currentPrHead: head,
  }));

  const classified = classifyFindings(review.findings);
  return {
    reviewer: String(review.reviewer ?? review.reviewerId).trim(),
    headSha: String(review.headSha ?? review.reviewedHead).trim(),
    reviewedAt: typeof review.reviewedAt === 'string' ? review.reviewedAt : null,
    isFork: Boolean(config.isFork),
    // Unified normalized review (CLEAN | ACTIONABLE | FAILED) + its findings.
    status: normalized.status,
    normalized,
    ...classified,
  };
}
