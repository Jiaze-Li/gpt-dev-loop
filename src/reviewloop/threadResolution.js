// ReviewLoop PR review-thread resolution lifecycle.
//
// ReviewLoop may mutate GitHub review-thread *resolution* state — resolve a
// thread whose blocking finding has been independently cleared by a later
// trusted review. It still NEVER writes business code, commits, pushes,
// merges, or force-pushes.
//
// A prior-round managed thread becomes eligible for Resolve ONLY when ALL of:
//   1. the Worker pushed a DIFFERENT HEAD, and
//   2. ReviewLoop ingested a TRUSTED review bound to that EXACT newer HEAD, and
//   3. that newer review no longer reports the same finding (same signature).
// A clean Codex 👍 on the exact newer-HEAD trigger is a valid form of (2)+(3):
// it is a trusted review with an empty finding set.
//
// If the same blocking finding is still present on the newer HEAD, the prior
// thread stays unresolved and the recurrence is handled as a normal finding.
//
// Scope safety: only threads ReviewLoop itself recorded from a trusted
// reviewer's inline finding (full durable identity) are ever touched. Human
// threads, outdated threads, and historical threads are never resolved.

export const MANAGED_THREAD_STATUS = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  RESOLVE_FAILED: 'RESOLVE_FAILED',
});

function str(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// Durable thread identity is reliable only with ALL of: GraphQL review-thread
// node id, review submission id, review comment id, reviewed HEAD, reviewer
// login, and a stable finding signature.
export function threadIdentityReliable(id) {
  return Boolean(
    id
    && str(id.threadNodeId)
    && str(id.reviewId)
    && str(id.commentId)
    && str(id.head ?? id.reviewedHead)
    && str(id.reviewerLogin)
    && str(id.signature),
  );
}

// Register / refresh managed threads from an accepted trusted review bound to
// `head`. Every blocking finding with reliable durable identity that we are not
// already tracking (keyed by thread node id) becomes an OPEN managed thread.
// Returns a NEW array; never mutates the input.
export function registerManagedThreads({
  managedThreads = [], review, head, reviewer, round,
} = {}) {
  const next = (managedThreads ?? []).map((mt) => ({ ...mt }));
  const known = new Set(next.map((mt) => str(mt.threadNodeId)).filter(Boolean));
  for (const f of review?.blockingFindings ?? []) {
    const id = f.threadIdentity;
    if (!id) continue;
    const candidate = {
      threadNodeId: str(id.threadNodeId),
      reviewId: str(id.reviewId),
      commentId: str(id.commentId),
      head: str(id.reviewedHead) ?? str(head),
      reviewerLogin: str(id.reviewerLogin),
      signature: str(f.signature),
    };
    if (!threadIdentityReliable(candidate)) continue;
    if (known.has(candidate.threadNodeId)) continue;
    known.add(candidate.threadNodeId);
    next.push({
      ...candidate,
      reviewer: reviewer ?? null,
      round: Number.isInteger(round) ? round : null,
      status: MANAGED_THREAD_STATUS.OPEN,
      resolvedOnHead: null,
      verificationReviewId: null,
      resolvedAt: null,
      resolveAttempts: 0,
      lastResolveError: null,
    });
  }
  return next;
}

// OPEN managed threads raised on a PRIOR head whose finding signature is NOT
// present on `head` (per `review`, a trusted review bound to `head`). A thread
// whose finding is still present stays OPEN and is not returned.
export function clearedPriorThreads({ managedThreads = [], review, head } = {}) {
  const current = new Set((review?.findingSignatures ?? []).map(String));
  return (managedThreads ?? []).filter((mt) => (
    mt.status === MANAGED_THREAD_STATUS.OPEN
    && str(mt.threadNodeId)
    && str(mt.head) && str(mt.head) !== str(head)
    && !current.has(str(mt.signature))
  ));
}

// Managed threads from a prior head that SHOULD be resolved by now (their
// finding is cleared) but are not RESOLVED. Used to withhold PASS — an
// infrastructure / retry condition, never a silent PASS.
export function unresolvedClearedThreads({ managedThreads = [], review, head } = {}) {
  const current = new Set((review?.findingSignatures ?? []).map(String));
  return (managedThreads ?? []).filter((mt) => (
    str(mt.threadNodeId)
    && str(mt.head) && str(mt.head) !== str(head)
    && !current.has(str(mt.signature))
    && mt.status !== MANAGED_THREAD_STATUS.RESOLVED
  ));
}

// Mutating: fold one resolve attempt's result into a managed-thread record.
export function applyResolutionResult(mt, {
  success, head, verificationReviewId, at, error,
} = {}) {
  mt.resolveAttempts = (mt.resolveAttempts ?? 0) + 1;
  if (success) {
    mt.status = MANAGED_THREAD_STATUS.RESOLVED;
    mt.resolvedOnHead = str(head);
    mt.verificationReviewId = str(verificationReviewId);
    mt.resolvedAt = at ?? new Date().toISOString();
    mt.lastResolveError = null;
  } else {
    mt.status = MANAGED_THREAD_STATUS.RESOLVE_FAILED;
    mt.lastResolveError = String(error ?? 'unknown resolve failure');
  }
  return mt;
}

// Fail-closed scope check against a live thread enumeration. ReviewLoop resolves
// a managed thread ONLY when it can positively verify, right now, that the
// thread still carries nothing but trusted-reviewer comments. `liveThreads` is
// the transport's listReviewThreads() output, or null when the enumeration was
// unavailable / failed / returned an unverifiable shape.
//   - enumeration unavailable (null / not an array) -> fail closed (do NOT resolve)
//   - thread absent from the live enumeration        -> fail closed
//   - thread reported outdated (isOutdated) by GitHub -> fail closed (the line
//     has moved; the module never resolves historical review state)
//   - thread's comments connection was truncated      -> fail closed (a later
//     human reply past the first page cannot be ruled out)
//   - thread present, but ANY comment author is not an allowlisted reviewer
//     login (e.g. a later human reply)               -> fail closed
//   - thread present, identity matches, every comment author allowlisted ->
//     resolve is permitted; an already-resolved thread counts as success with
//     no further mutation
export function scopeCheckThread(mt, liveThreads, { allowlist = [] } = {}) {
  if (!str(mt.threadNodeId)) return { ok: false, reason: 'no thread node id' };
  if (!Array.isArray(liveThreads)) {
    return { ok: false, reason: 'live thread enumeration unavailable' };
  }
  const allow = new Set((allowlist ?? []).map((s) => String(s).toLowerCase()).filter(Boolean));
  const thread = liveThreads.find((t) => str(t.threadNodeId) === str(mt.threadNodeId));
  if (!thread) return { ok: false, reason: 'thread not found in live enumeration' };
  if (thread.isOutdated === true) return { ok: false, reason: 'thread is outdated' };
  if (thread.commentsTruncated === true) {
    return { ok: false, reason: 'thread comment list is truncated — cannot rule out a human reply' };
  }
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  if (comments.length === 0) return { ok: false, reason: 'thread has no comments to attribute' };
  for (const c of comments) {
    const login = String(c.authorLogin ?? '').toLowerCase();
    if (!login || !allow.has(login)) {
      return { ok: false, reason: `thread carries a non-reviewer comment (${c.authorLogin ?? 'unknown'})` };
    }
  }
  if (thread.isResolved === true) return { ok: true, alreadyResolved: true };
  return { ok: true };
}
