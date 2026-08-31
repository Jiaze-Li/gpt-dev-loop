// V2-C — unified normalized PR review schema + provider-boundary parser.
//
// PR Closeout only. Codex, Claude and internal reviewers all emit different
// raw payloads. This module converts any of them, AT THE PROVIDER BOUNDARY,
// into one normalized structure the deterministic closeout Core consumes:
//
//   {
//     reviewer,            // configured trusted-reviewer identity string
//     provider,            // 'codex' | 'claude' | 'internal'
//     head_sha,            // the PR head the review examined
//     review_id,           // provider review/comment id, or null
//     status,              // 'CLEAN' | 'ACTIONABLE' | 'FAILED'
//     findings: [ {
//       severity,          // 'P1' | 'P2' | 'OTHER'
//       file, line,        // location, or null
//       title,             // short finding headline
//       description,       // full finding body
//       signature,         // stable identity across repair rounds
//     } ],
//     blocking,            // findings with severity P1 / P2 (subset of findings)
//     error,               // { reason, message } when status === 'FAILED', else null
//   }
//
// Only P1 / P2 block closeout. Everything else (P3, nit, suggestion, info,
// style, ...) normalizes to OTHER and never blocks. The Core never inspects a
// raw provider payload again — it only reads this structure.

import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from '../errors.js';

export const NORMALIZED_REVIEW_STATUS = Object.freeze({
  CLEAN: 'CLEAN',
  ACTIONABLE: 'ACTIONABLE',
  FAILED: 'FAILED',
});

export const NORMALIZED_FINDING_SEVERITIES = Object.freeze(['P1', 'P2', 'OTHER']);
export const BLOCKING_SEVERITIES = Object.freeze(['P1', 'P2']);

export const FINDING_LIFECYCLE = Object.freeze({
  OPEN: 'OPEN',
  FIXED: 'FIXED',
  RESOLVED: 'RESOLVED',
});

export const THREAD_RESOLUTION_STATUS = Object.freeze({
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  FAILED: 'FAILED',
});

export const REVIEW_PROVIDERS = Object.freeze(['codex', 'claude', 'internal']);

// Reasons a provider result normalizes to FAILED (drives reviewer failover in
// the loop; never a repair round).
export const NORMALIZED_REVIEW_FAILURE_REASONS = Object.freeze({
  MALFORMED: 'MALFORMED_PAYLOAD',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NO_FINDINGS_CHANNEL: 'NO_FINDINGS_CHANNEL',
});

function collapse(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Map an arbitrary provider severity token onto the normalized ladder.
// Exact P1 / P2 (any case) plus a small, well-known synonym set are blocking;
// everything else — P3, nit, suggestion, info, style, minor, low, "" — is
// OTHER and does not block closeout.
export function normalizeFindingSeverity(raw) {
  const text = collapse(raw);
  if (text === 'p1' || text === 'blocker' || text === 'critical') return 'P1';
  if (text === 'p2' || text === 'major') return 'P2';
  return 'OTHER';
}

export function isBlockingSeverity(severity) {
  return BLOCKING_SEVERITIES.includes(String(severity ?? '').trim().toUpperCase());
}

// A stable identity for "the same finding" so a finding that survives a repair
// round is recognised on the next review. Prefer a provider-supplied stable id;
// otherwise derive from severity + file + normalized title/description.
export function normalizedFindingSignature(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const explicit = typeof finding.id === 'string' ? finding.id.trim()
    : (typeof finding.signature === 'string' && finding.signature.startsWith('id:')
      ? finding.signature.slice(3)
      : '');
  if (explicit) return `id:${explicit}`;
  const severity = normalizeFindingSeverity(finding.severity);
  const file = collapse(finding.file ?? finding.path);
  const body = collapse(
    finding.title ?? finding.message ?? finding.summary ?? finding.description ?? finding.body,
  );
  if (!body && !file) return null;
  return `${severity}:${file}:${body}`;
}

function identity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Resolution is deliberately fail-closed. A location or matching body is not
// a GitHub thread identity and must never be used as one.
export function hasReliableThreadIdentity(finding) {
  return Boolean(
    identity(finding?.reviewId ?? finding?.review_id)
    && identity(finding?.threadNodeId ?? finding?.threadId ?? finding?.thread_node_id ?? finding?.thread_id)
    && identity(finding?.commentId ?? finding?.comment_id)
    && identity(finding?.signature),
  );
}

export const isFindingIdentityReliable = hasReliableThreadIdentity;

export function markFindingFixed(finding, { verificationReviewId, resolvedOnHead } = {}) {
  const copy = { ...finding };
  if (!hasReliableThreadIdentity(copy) || !identity(verificationReviewId) || !identity(resolvedOnHead)) {
    return { ...copy, lifecycle: FINDING_LIFECYCLE.OPEN };
  }
  return {
    ...copy,
    lifecycle: FINDING_LIFECYCLE.FIXED,
    threadResolutionStatus: THREAD_RESOLUTION_STATUS.PENDING,
    verificationReviewId: identity(verificationReviewId),
    resolvedOnHead: identity(resolvedOnHead),
  };
}

export function recordThreadResolution(finding, {
  success,
  resolvedAt,
  threadId,
} = {}) {
  const copy = { ...finding };
  if (copy.lifecycle === FINDING_LIFECYCLE.RESOLVED) return copy;
  if (copy.lifecycle !== FINDING_LIFECYCLE.FIXED || !hasReliableThreadIdentity(copy)) {
    return { ...copy, lifecycle: FINDING_LIFECYCLE.OPEN };
  }
  if (!success) {
    return { ...copy, threadResolutionStatus: THREAD_RESOLUTION_STATUS.FAILED };
  }
  const originalThreadId = identity(copy.threadNodeId ?? copy.threadId);
  const exactThreadId = identity(threadId ?? originalThreadId);
  if (!exactThreadId || exactThreadId !== originalThreadId || !identity(resolvedAt)) {
    return { ...copy, threadResolutionStatus: THREAD_RESOLUTION_STATUS.FAILED };
  }
  return {
    ...copy,
    threadId: exactThreadId,
    threadNodeId: exactThreadId,
    lifecycle: FINDING_LIFECYCLE.RESOLVED,
    threadResolutionStatus: THREAD_RESOLUTION_STATUS.RESOLVED,
    resolvedAt: identity(resolvedAt),
    resolvedBy: 'supergpt',
  };
}

function toInt(value) {
  return Number.isInteger(value) ? value
    : (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Math.trunc(Number(value)) : null);
}

// Normalize one raw finding. Returns null for structurally empty entries so a
// provider that pads its list with blanks does not create phantom findings.
export function normalizeReviewFinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const severity = normalizeFindingSeverity(raw.severity ?? raw.level ?? raw.priority);
  const title = String(raw.title ?? raw.message ?? raw.summary ?? raw.headline ?? '').trim();
  const description = String(
    raw.description ?? raw.body ?? raw.detail ?? raw.details ?? raw.message ?? raw.summary ?? title ?? '',
  ).trim();
  const file = typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim()
    : (typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null);
  if (!title && !description && !file) return null;
  const normalized = {
    reviewId: identity(raw.reviewId ?? raw.review_id ?? raw.review?.id),
    threadId: identity(raw.threadId ?? raw.thread_id ?? raw.threadNodeId ?? raw.thread_node_id),
    threadNodeId: identity(raw.threadNodeId ?? raw.thread_node_id ?? raw.threadId ?? raw.thread_id),
    commentId: identity(raw.commentId ?? raw.comment_id ?? raw.id),
    severity,
    file,
    line: toInt(raw.line ?? raw.lineNumber ?? raw.start_line),
    title: title || description,
    description: description || title,
  };
  normalized.signature = normalizedFindingSignature({ id: raw.id, ...normalized });
  normalized.lifecycle = Object.values(FINDING_LIFECYCLE).includes(raw.lifecycle)
    ? raw.lifecycle : FINDING_LIFECYCLE.OPEN;
  normalized.threadResolutionStatus = Object.values(THREAD_RESOLUTION_STATUS).includes(raw.threadResolutionStatus)
    ? raw.threadResolutionStatus : THREAD_RESOLUTION_STATUS.NOT_ATTEMPTED;
  normalized.resolvedAt = identity(raw.resolvedAt);
  normalized.resolvedBy = identity(raw.resolvedBy);
  normalized.resolvedOnHead = identity(raw.resolvedOnHead);
  normalized.verificationReviewId = identity(raw.verificationReviewId);
  normalized.identityReliable = hasReliableThreadIdentity(normalized);
  if (!normalized.identityReliable && normalized.lifecycle !== FINDING_LIFECYCLE.OPEN) {
    normalized.lifecycle = FINDING_LIFECYCLE.OPEN;
    normalized.threadResolutionStatus = THREAD_RESOLUTION_STATUS.NOT_ATTEMPTED;
  }
  return normalized;
}

// Per-provider extraction of the raw finding list + review id. Each provider
// speaks a slightly different dialect; this is the only place that knows it.
const PROVIDER_PARSERS = {
  codex(raw) {
    const list = raw.findings ?? raw.comments ?? raw.review?.findings ?? raw.results;
    return { findings: list, reviewId: raw.review_id ?? raw.reviewId ?? raw.id ?? null };
  },
  claude(raw) {
    const list = raw.findings ?? raw.review?.findings ?? raw.comments ?? raw.annotations;
    return { findings: list, reviewId: raw.review_id ?? raw.reviewId ?? raw.id ?? null };
  },
  internal(raw) {
    const list = raw.findings ?? raw.issues ?? raw.results;
    return { findings: list, reviewId: raw.review_id ?? raw.reviewId ?? raw.id ?? null };
  },
};

export function resolveReviewProvider({ provider, reviewer, raw } = {}) {
  const explicit = collapse(provider ?? raw?.provider);
  if (REVIEW_PROVIDERS.includes(explicit)) return explicit;
  const fromReviewer = collapse(reviewer ?? raw?.reviewer ?? raw?.reviewerId);
  for (const key of REVIEW_PROVIDERS) {
    if (fromReviewer === key || fromReviewer.includes(key)) return key;
  }
  return 'internal';
}

function failed({ reviewer, provider, headSha, reviewId, reason, message }) {
  return {
    reviewer: reviewer ?? null,
    provider,
    head_sha: headSha ?? null,
    review_id: reviewId ?? null,
    status: NORMALIZED_REVIEW_STATUS.FAILED,
    findings: [],
    blocking: [],
    error: { reason, message },
  };
}

function looksLikeFailure(raw) {
  if (raw.ok === false || raw.success === false) return raw.failure ?? raw.error ?? 'reviewer reported failure';
  const status = collapse(raw.status ?? raw.state);
  if (status === 'failed' || status === 'error' || status === 'errored') {
    return raw.error ?? raw.failure ?? raw.message ?? `reviewer status ${status}`;
  }
  if (raw.error) return raw.error;
  return null;
}

// Convert a raw provider review payload into the normalized structure. This is
// the provider boundary: everything downstream consumes only the return value.
//
// - malformed / non-object payload            -> FAILED (MALFORMED_PAYLOAD)
// - explicit provider failure marker          -> FAILED (PROVIDER_ERROR)
// - no recognisable findings channel at all   -> FAILED (NO_FINDINGS_CHANNEL)
// - findings list present, some P1/P2         -> ACTIONABLE
// - findings list present, none blocking      -> CLEAN
export function normalizeProviderReview({
  raw,
  reviewer,
  provider,
  currentPrHead,
} = {}) {
  const resolvedProvider = resolveReviewProvider({ provider, reviewer, raw });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return failed({
      reviewer: reviewer ?? null,
      provider: resolvedProvider,
      headSha: currentPrHead ?? null,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.MALFORMED,
      message: 'review payload is missing or not an object',
    });
  }

  const headSha = String(
    raw.head_sha ?? raw.headSha ?? raw.reviewedHead ?? raw.commitId ?? currentPrHead ?? '',
  ).trim() || null;
  const resolvedReviewer = (reviewer != null && String(reviewer).trim())
    ? String(reviewer).trim()
    : (String(raw.reviewer ?? raw.reviewerId ?? '').trim() || null);

  const failureMarker = looksLikeFailure(raw);
  const parser = PROVIDER_PARSERS[resolvedProvider] ?? PROVIDER_PARSERS.internal;
  const { findings: rawFindings, reviewId } = parser(raw);

  if (failureMarker) {
    return failed({
      reviewer: resolvedReviewer,
      provider: resolvedProvider,
      headSha,
      reviewId,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.PROVIDER_ERROR,
      message: typeof failureMarker === 'string' ? failureMarker : JSON.stringify(failureMarker),
    });
  }

  if (!Array.isArray(rawFindings)) {
    return failed({
      reviewer: resolvedReviewer,
      provider: resolvedProvider,
      headSha,
      reviewId,
      reason: NORMALIZED_REVIEW_FAILURE_REASONS.NO_FINDINGS_CHANNEL,
      message: 'review payload exposes no findings array',
    });
  }

  const findings = rawFindings.map((finding) => normalizeReviewFinding({
    ...finding,
    reviewId: finding?.reviewId ?? finding?.review_id ?? reviewId ?? null,
  })).filter(Boolean);
  const blocking = findings.filter((f) => isBlockingSeverity(f.severity));

  return {
    reviewer: resolvedReviewer,
    provider: resolvedProvider,
    head_sha: headSha,
    review_id: reviewId ?? null,
    status: blocking.length > 0
      ? NORMALIZED_REVIEW_STATUS.ACTIONABLE
      : NORMALIZED_REVIEW_STATUS.CLEAN,
    findings,
    blocking,
    error: null,
  };
}

// Unique, sorted blocking-finding signatures — the Core compares these across
// repair rounds to detect non-convergence.
export function blockingSignatures(normalizedReview) {
  const blocking = Array.isArray(normalizedReview?.blocking) ? normalizedReview.blocking : [];
  return [...new Set(blocking.map((f) => f.signature).filter(Boolean))].sort();
}

// Fail-closed assertion used by the Core: a FAILED normalized review must never
// be mistaken for a clean one.
export function assertNormalizedReviewUsable(normalizedReview) {
  if (!normalizedReview || typeof normalizedReview !== 'object') {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'normalized review is missing',
    );
  }
  if (normalizedReview.status === NORMALIZED_REVIEW_STATUS.FAILED) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      `normalized review FAILED: ${normalizedReview.error?.message ?? normalizedReview.error?.reason ?? 'unknown'}`,
      { error: normalizedReview.error ?? null },
    );
  }
  return normalizedReview;
}
