// V2-C — GitHub PR Closeout review adapter.
//
// PR Closeout only. This layer triggers the dedicated Codex / Claude GitHub
// PR reviewer, waits for its result with bounded local polling, and hands the
// deterministic closeout loop (prCloseoutLoop.js / prCloseoutPolicy.js) either
// a raw review payload or a CLASSIFIED failure that drives reviewer failover.
//
// It never touches the ordinary Task Reviewer, never edits .github/workflows,
// never force-pushes, merges, or deletes comments. Every wait is local polling
// against an injected GitHub client + injected clock — no model call, no
// network in tests, no repair-round consumption.
//
// Trigger contract (confirmed from repository evidence, not invented here):
//   - Claude: PR issue comment body must contain "@claude review".
//     Source: .github/workflows/claude-code-review.yml on branch
//     `claude-global-review` gates the review job on
//     `contains(github.event.comment.body, '@claude review')`.
//   - Codex: PR issue comment body "@codex review" (Codex PR review action
//     convention; same `@<bot> review` issue-comment shape as Claude).
//
// Result filtering: a poll only accepts a review/comment that is (a) newer
// than our trigger (id or timestamp strictly after), (b) authored by the
// target reviewer identity, and (c) provably bound to the CURRENT PR head
// SHA. Anything older, from another author, or bound to a superseded head is
// ignored. An external head change during the wait invalidates the pending
// review, rebinds to the new head, de-dupes, and re-triggers.

import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from '../errors.js';
import {
  FINDING_LIFECYCLE,
  THREAD_RESOLUTION_STATUS,
  hasReliableThreadIdentity,
  recordThreadResolution,
} from './normalizedPrReview.js';

// Every "@codex review" / "@claude review" comment this adapter posts is an
// External Model Trigger (see externalModelTriggerAuthority.js) — it spends
// model quota in a system OUTSIDE this process. `triggerAuthority` is
// therefore a REQUIRED production collaborator, not an optional one: there
// is no allow-all default here. Production wiring
// (supergpt.js#createRealGithubPrCloseoutAdapters) always constructs a real
// ExternalModelTriggerAuthority; only tests may inject an explicit,
// clearly-named test authority/fake.

// Canonical, evidence-backed trigger comment bodies. `resolveTriggerText`
// allows a tested injection override (metadata / config) but never silently
// invents an alternate format.
export const PR_REVIEW_TRIGGER_TEXT = Object.freeze({
  codex: '@codex review',
  claude: '@claude review',
});

// Default mapping from PR reviewer key -> the GitHub author login that its
// review/comment is expected to come from. Injectable for tests / real bots.
export const PR_REVIEWER_IDENTITIES = Object.freeze({
  codex: Object.freeze(['codex', 'chatgpt-codex-connector[bot]', 'chatgpt-codex-connector', 'codex[bot]', 'codex-bot']),
  claude: Object.freeze(['claude', 'claude[bot]', 'claude-code-review[bot]']),
});

export const PR_REVIEWER_IDENTITY = Object.freeze({
  codex: 'codex',
  claude: 'claude',
});

// Classified, non-repair-round failure reasons. The closeout loop maps each of
// these to reviewer failover (Codex -> Claude -> internal); it must never
// treat them as a repair attempt.
export const GITHUB_REVIEW_FAILURES = Object.freeze({
  UNAVAILABLE: 'REVIEWER_UNAVAILABLE',
  TRIGGER_FAILED: 'TRIGGER_FAILED',
  TIMEOUT: 'REVIEW_TIMEOUT',
  INFRASTRUCTURE: 'GITHUB_INFRASTRUCTURE',
  // The External Model Trigger Authority denied this trigger deterministically
  // (duplicate / ceiling / wall-clock / unresolved / unreadable state) — see
  // externalModelTriggerAuthority.js. Distinct from an ordinary GitHub-side
  // TRIGGER_FAILED/INFRASTRUCTURE failure: this is an orchestrator safety
  // decision, never a reviewer/provider outage, and must never be converted
  // into a cross-reviewer failover attempt for the SAME head.
  AUTHORITY_BLOCKED: 'EXTERNAL_TRIGGER_AUTHORITY_BLOCKED',
});

// GitHub polling bounds. The interval is deliberately clamped into the
// 15–30s band the plan mandates; backoff grows within the band only.
export const MIN_POLL_INTERVAL_MS = 15_000;
export const MAX_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
export const DEFAULT_THREAD_RESOLUTION_MAX_ATTEMPTS = 3;
export const DEFAULT_THREAD_RESOLUTION_RETRY_MS = 1_000;

const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolutionError(error) {
  return {
    code: String(error?.code ?? error?.name ?? 'GITHUB_THREAD_RESOLUTION_FAILED'),
    message: String(error?.message ?? 'GitHub review thread resolution failed'),
    status: Number.isFinite(Number(error?.status ?? error?.statusCode))
      ? Number(error.status ?? error.statusCode) : null,
  };
}

function resolvedThreadFrom(response) {
  return response?.resolveReviewThread?.thread
    ?? response?.data?.resolveReviewThread?.thread
    ?? response?.thread
    ?? response;
}

async function invokeThreadResolution(github, threadId) {
  if (typeof github?.resolveReviewThread === 'function') {
    return github.resolveReviewThread({ threadId });
  }
  if (typeof github?.graphql === 'function') {
    return github.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  }
  throw new PrCloseoutError(
    PR_CLOSEOUT_ERROR_CODES.THREAD_RESOLUTION_UNAVAILABLE,
    'GitHub client does not support resolveReviewThread or graphql',
  );
}

// Resolve only the original GitHub node identity carried by a confirmed-fixed
// finding. File, line and body are never accepted as fallback identities.
export async function resolveGithubReviewThread({
  github,
  finding,
  maxAttempts = DEFAULT_THREAD_RESOLUTION_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_THREAD_RESOLUTION_RETRY_MS,
  clock = {},
} = {}) {
  const original = finding && typeof finding === 'object' ? { ...finding } : {};
  const threadId = String(original.threadNodeId ?? original.threadId ?? '').trim();

  if (original.lifecycle === FINDING_LIFECYCLE.RESOLVED
    || original.threadResolutionStatus === THREAD_RESOLUTION_STATUS.RESOLVED) {
    return { ok: true, idempotent: true, attempts: 0, finding: original, evidence: {
      threadId: threadId || null,
      resolvedAt: original.resolvedAt ?? null,
      resolvedBy: original.resolvedBy ?? 'supergpt',
      resolvedOnHead: original.resolvedOnHead ?? null,
      verificationReviewId: original.verificationReviewId ?? null,
    } };
  }

  if (original.lifecycle !== FINDING_LIFECYCLE.FIXED || !hasReliableThreadIdentity(original)) {
    const open = { ...original, lifecycle: FINDING_LIFECYCLE.OPEN,
      threadResolutionStatus: THREAD_RESOLUTION_STATUS.NOT_ATTEMPTED };
    return { ok: false, idempotent: false, attempts: 0, finding: open,
      error: { code: 'UNRELIABLE_THREAD_IDENTITY', message: 'finding lacks reliable original thread identity', status: null } };
  }

  const attemptsLimit = positiveInteger(maxAttempts, DEFAULT_THREAD_RESOLUTION_MAX_ATTEMPTS);
  const sleep = typeof clock.sleep === 'function'
    ? (ms) => clock.sleep(ms)
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
  let lastError;

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    try {
      const response = await invokeThreadResolution(github, threadId);
      const thread = resolvedThreadFrom(response);
      const returnedId = String(thread?.id ?? threadId).trim();
      if (returnedId !== threadId || thread?.isResolved === false) {
        throw Object.assign(new Error('GitHub returned an unresolved or different review thread'), {
          code: 'THREAD_IDENTITY_MISMATCH',
        });
      }
      const resolvedAt = new Date(now()).toISOString();
      const updated = recordThreadResolution(original, { success: true, threadId, resolvedAt });
      return { ok: true, idempotent: false, attempts: attempt, finding: updated, evidence: {
        threadId,
        resolvedAt: updated.resolvedAt,
        resolvedBy: 'supergpt',
        resolvedOnHead: updated.resolvedOnHead,
        verificationReviewId: updated.verificationReviewId,
      } };
    } catch (error) {
      lastError = resolutionError(error);
      if (attempt < attemptsLimit) await sleep(Math.max(0, Number(retryDelayMs) || 0));
    }
  }

  return {
    ok: false,
    idempotent: false,
    attempts: attemptsLimit,
    finding: recordThreadResolution(original, { success: false }),
    error: lastError,
  };
}

function clampInterval(ms) {
  const n = Number.isFinite(ms) ? Math.round(ms) : DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, n));
}

// Resolve the trigger comment body for a reviewer. `overrides` (from testable
// injected GitHub metadata / repo config) may replace a value, but an unknown
// reviewer with no override is a hard, fail-closed error rather than a guess.
export function resolveTriggerText(reviewer, { overrides = {} } = {}) {
  const key = String(reviewer ?? '').trim().toLowerCase();
  const override = overrides && typeof overrides === 'object' ? overrides[key] : null;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const canonical = PR_REVIEW_TRIGGER_TEXT[key];
  if (canonical) return canonical;
  throw new PrCloseoutError(
    PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
    `no confirmed GitHub trigger contract for reviewer "${reviewer}"`,
  );
}

function failure(reason, extra = {}) {
  return { ok: false, failure: reason, ...extra };
}

function classifyClientError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const status = Number(error?.status ?? error?.statusCode);
  if (code === 'REVIEWER_UNAVAILABLE' || code === 'NOT_FOUND' || status === 404) {
    return GITHUB_REVIEW_FAILURES.UNAVAILABLE;
  }
  return GITHUB_REVIEW_FAILURES.INFRASTRUCTURE;
}

function headShaOf(result) {
  return String(result?.headSha ?? result?.head_sha ?? result?.commitId ?? '').trim();
}

function authorOf(result) {
  return String(result?.reviewer ?? result?.author ?? result?.user?.login ?? '').trim().toLowerCase();
}

function authorMatchesReviewer(author, identity, reviewerKey, identitiesOverride = {}) {
  const normAuthor = String(author ?? '').trim().toLowerCase();
  if (!normAuthor) return false;

  // Exact configured identity match
  if (normAuthor === String(identity).trim().toLowerCase()) return true;

  // Injected / configured identities override
  const customList = identitiesOverride?.[reviewerKey];
  if (Array.isArray(customList) && customList.some((id) => String(id).trim().toLowerCase() === normAuthor)) {
    return true;
  }
  if (typeof customList === 'string' && customList.trim().toLowerCase() === normAuthor) {
    return true;
  }

  // Canonical well-known bot identities
  const canonicalList = PR_REVIEWER_IDENTITIES[reviewerKey];
  if (Array.isArray(canonicalList) && canonicalList.some((id) => id.toLowerCase() === normAuthor)) {
    return true;
  }

  return false;
}

// A monotonic ">"; prefer numeric id ordering, fall back to ISO timestamp.
function isAfterTrigger(result, trigger) {
  const rid = Number(result?.id);
  const tid = Number(trigger.commentId);
  if (Number.isFinite(rid) && Number.isFinite(tid)) return rid > tid;
  const rts = Date.parse(result?.submittedAt ?? result?.createdAt ?? result?.reviewedAt ?? '');
  const tts = Date.parse(trigger.triggeredAt ?? '');
  if (Number.isFinite(rts) && Number.isFinite(tts)) return rts > tts;
  return true;
}

// Build a PR Closeout GitHub review adapter.
//
// github (injected, all async, may throw):
//   getPrHead({ prNumber })                       -> current head SHA
//   isReviewerAvailable?({ reviewer })            -> boolean (optional gate)
//   postReviewTrigger({ prNumber, body })         -> { id, createdAt } | throws
//   listReviewResults({ prNumber, sinceId, since }) -> [{ id, reviewer|author,
//                                                        headSha, submittedAt,
//                                                        findings }]
//
// clock (injected): now() -> ms epoch; sleep(ms) -> Promise
//
// triggerAuthority (REQUIRED, injected — see externalModelTriggerAuthority.js):
//   authorize(triggerIntent) -> { outcome: 'ALLOW', permit } | { outcome: 'REUSE', trigger }
//                              | throws ExternalTriggerError (fail closed)
//   dispatch(permit, triggerIntent, dispatchFn) -> { commentId, triggeredAt }
//                              | throws ExternalTriggerError
//   recordResult?({ workflowId, prNumber, headSha, triggerKind, resultMeta }) -> void (best effort)
// Every physical postReviewTrigger() call crosses this authority first —
// there is no bypass path. A duplicate-blocked / limit / round / wall-clock
// denial classifies as GITHUB_REVIEW_FAILURES.AUTHORITY_BLOCKED, distinct
// from an ordinary GitHub-side TRIGGER_FAILED/INFRASTRUCTURE failure.
//
// workflowId (REQUIRED, forwarded verbatim into every TriggerIntent) scopes
// the authority's durable ledger — the SAME workflowId the rest of the
// workflow's persistence already uses.
//
// persist?(pendingSnapshot) is called after every trigger / head rebind so a
// restart resumes the same pending reviewer/head without a second comment.
export function createGithubPrReviewAdapter({
  github,
  clock = {},
  reviewer,
  workflowId = null,
  triggerAuthority,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  backoffFactor = 1.5,
  triggerOverrides = {},
  reviewerIdentities = {},
  pending: restoredPending = null,
  persist,
} = {}) {
  if (!github || typeof github.getPrHead !== 'function'
    || typeof github.postReviewTrigger !== 'function'
    || typeof github.listReviewResults !== 'function') {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'createGithubPrReviewAdapter requires a github client with getPrHead/postReviewTrigger/listReviewResults',
    );
  }
  if (!triggerAuthority || typeof triggerAuthority.authorize !== 'function'
    || typeof triggerAuthority.dispatch !== 'function') {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'createGithubPrReviewAdapter requires a triggerAuthority (ExternalModelTriggerAuthority) with '
        + 'authorize/dispatch — every @codex/@claude review trigger must cross the External Model Trigger Authority',
    );
  }
  const reviewerKey = String(reviewer ?? '').trim().toLowerCase();
  const now = typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
  const sleep = typeof clock.sleep === 'function'
    ? (ms) => clock.sleep(ms)
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const identity = String(
    reviewerIdentities[reviewerKey] ?? PR_REVIEWER_IDENTITY[reviewerKey] ?? reviewerKey,
  ).trim().toLowerCase();
  const baseInterval = clampInterval(pollIntervalMs);

  // In-memory pending record: one trigger per (reviewer, head). Survives a
  // restart via `restoredPending` + `persist`.
  let pendingState = restoredPending && restoredPending.reviewer === reviewerKey
    ? { ...restoredPending }
    : null;

  const snapshot = () => (pendingState ? { ...pendingState } : null);
  const savePending = async () => {
    if (typeof persist === 'function') await persist(snapshot());
  };

  async function ensureTrigger(prNumber, head) {
    // De-dupe: a live pending trigger for this exact reviewer+head is reused,
    // never re-posted.
    if (pendingState
      && pendingState.reviewer === reviewerKey
      && pendingState.headSha === head
      && pendingState.commentId != null) {
      return pendingState;
    }

    // Zero-spend mechanical availability probe FIRST, before the authority is
    // ever touched. Proving a reviewer unavailable here never creates a
    // reservation and never consumes a trigger slot (§ Part E) — a different
    // reviewer may still authorize the SAME head afterward. This makes the
    // documented invariant ("availability failure is zero-spend") literally
    // true rather than aspirational: nothing below this point runs for an
    // unavailable reviewer.
    if (typeof github.isReviewerAvailable === 'function') {
      let available;
      try {
        available = await github.isReviewerAvailable({ reviewer: reviewerKey });
      } catch (error) {
        throw Object.assign(new Error('reviewer availability probe failed'), {
          _classified: classifyClientError(error),
          _dispatched: false,
        });
      }
      if (!available) {
        throw Object.assign(new Error(`reviewer ${reviewerKey} unavailable`), {
          _classified: GITHUB_REVIEW_FAILURES.UNAVAILABLE,
          _dispatched: false,
        });
      }
    }

    const triggerIntent = {
      workflowId, prNumber, headSha: head, triggerKind: 'PR_REVIEW', reviewer: reviewerKey, semanticAction: 'EXTERNAL_PR_REVIEW',
    };

    // Every trigger — new or re-triggered on a head change — crosses the
    // External Model Trigger Authority FIRST. This is what makes "one
    // external trigger per semantic HEAD state" hold across reviewers: a
    // duplicate/ceiling/wall-clock denial here is a fail-closed orchestrator
    // decision, never a reviewer/provider failure. Once authorize() has been
    // called, the physical dispatch boundary MAY have been crossed — every
    // failure from here on is classified `_dispatched: true` so the caller
    // never treats it as a zero-spend reviewer failure eligible for
    // cross-reviewer failover.
    let authorization;
    try {
      authorization = await triggerAuthority.authorize(triggerIntent);
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? 'external trigger authorization denied'), {
        _classified: GITHUB_REVIEW_FAILURES.AUTHORITY_BLOCKED,
        _authorityCode: error?.code ?? null,
        _dispatched: true,
      });
    }

    if (authorization.outcome === 'REUSE') {
      // A durably TRIGGERED record for this exact head — posted by ANY
      // reviewer, in this or a prior process — is reused, never re-posted.
      // Preserve the ORIGINAL reviewer identity from the persisted trigger;
      // never reinterpret it as belonging to whichever reviewer happens to
      // be asking now (§ REUSE reviewer semantics). `matchResult` below polls
      // for a result authored by this ORIGINAL identity, not by whichever
      // reviewer's adapter happens to be reusing the trigger — a Claude
      // adapter reusing a Codex-posted trigger keeps polling for Codex's
      // result, and never mistakes silence for its own timeout identity.
      const originalReviewer = String(authorization.trigger.reviewer ?? '').trim().toLowerCase();
      pendingState = {
        reviewer: originalReviewer || reviewerKey,
        headSha: head,
        commentId: authorization.trigger.commentId,
        triggeredAt: authorization.trigger.triggeredAt,
        body: resolveTriggerText(reviewerKey, { overrides: triggerOverrides }),
        reused: true,
        reusedFromDifferentReviewer: Boolean(originalReviewer && originalReviewer !== reviewerKey),
      };
      await savePending();
      return pendingState;
    }

    // ALLOW — availability was already proven above, so the physical post
    // runs unconditionally from here.
    const body = resolveTriggerText(reviewerKey, { overrides: triggerOverrides });
    let trigger;
    try {
      trigger = await triggerAuthority.dispatch(
        authorization.permit,
        triggerIntent,
        () => github.postReviewTrigger({ prNumber, body }),
      );
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? 'failed to post review trigger comment'), {
        _classified: GITHUB_REVIEW_FAILURES.AUTHORITY_BLOCKED,
        _authorityCode: error?.code ?? null,
        _dispatched: true,
      });
    }
    pendingState = {
      reviewer: reviewerKey,
      headSha: head,
      commentId: trigger.commentId,
      triggeredAt: trigger.triggeredAt,
      body,
    };
    await savePending();
    return pendingState;
  }

  // Match against the ORIGINAL reviewer identity that dispatched `trigger`
  // (§ REUSE reviewer semantics) — this reviewerKey's own `identity` only when
  // the trigger is genuinely ours; a reused trigger from another reviewer
  // polls for THAT reviewer's authored result, never ours.
  function matchResult(results, trigger, head) {
    if (!Array.isArray(results)) return null;
    const matchReviewerKey = String(trigger?.reviewer ?? reviewerKey).trim().toLowerCase();
    const matchIdentity = String(
      reviewerIdentities[matchReviewerKey] ?? PR_REVIEWER_IDENTITY[matchReviewerKey] ?? matchReviewerKey,
    ).trim().toLowerCase();
    for (const result of results) {
      if (!authorMatchesReviewer(authorOf(result), matchIdentity, matchReviewerKey, reviewerIdentities)) continue;
      if (headShaOf(result) !== head) continue; // provably bound to current head
      if (!isAfterTrigger(result, trigger)) continue; // ignore stale reviews
      return result;
    }
    return null;
  }

  // Trigger (or reuse a pending trigger) and wait for the target reviewer's
  // result for the CURRENT head. Returns { ok:true, review } or a classified
  // { ok:false, failure }.
  async function requestReview({ prNumber, prHead } = {}) {
    let head = String(prHead ?? '').trim();
    if (!head) {
      try {
        head = String(await github.getPrHead({ prNumber }) ?? '').trim();
      } catch (error) {
        // No trigger has been attempted yet — mechanically zero-spend.
        return failure(classifyClientError(error), { reviewer: reviewerKey, externalTriggerDispatched: false });
      }
    }
    if (!head) {
      return failure(GITHUB_REVIEW_FAILURES.INFRASTRUCTURE, { reviewer: reviewerKey, externalTriggerDispatched: false });
    }

    const deadline = now() + maxWaitMs;
    let interval = baseInterval;
    let trigger;
    try {
      trigger = await ensureTrigger(prNumber, head);
    } catch (error) {
      return failure(error?._classified ?? GITHUB_REVIEW_FAILURES.TRIGGER_FAILED, {
        reviewer: reviewerKey,
        head,
        authorityCode: error?._authorityCode ?? null,
        externalTriggerDispatched: error?._dispatched === true,
        triggerReused: error?._reused === true,
        originalReviewer: error?._originalReviewer ?? null,
      });
    }

    while (now() < deadline) {
      // External head change: the pending review is void. Rebind, de-dupe,
      // re-trigger against the new head; a late result for the old head can
      // never match (matchResult filters on head).
      let liveHead;
      try {
        liveHead = String(await github.getPrHead({ prNumber }) ?? '').trim();
      } catch (error) {
        // A trigger already exists for `head` at this point — never zero-spend.
        return failure(classifyClientError(error), { reviewer: reviewerKey, head, externalTriggerDispatched: true });
      }
      if (liveHead && liveHead !== head) {
        head = liveHead;
        pendingState = null;
        await savePending();
        interval = baseInterval;
        try {
          trigger = await ensureTrigger(prNumber, head);
        } catch (error) {
          return failure(error?._classified ?? GITHUB_REVIEW_FAILURES.TRIGGER_FAILED, {
            reviewer: reviewerKey,
            head,
            authorityCode: error?._authorityCode ?? null,
            externalTriggerDispatched: error?._dispatched === true,
            triggerReused: error?._reused === true,
            originalReviewer: error?._originalReviewer ?? null,
          });
        }
      }

      let results;
      try {
        results = await github.listReviewResults({
          prNumber,
          sinceId: trigger.commentId,
          since: trigger.triggeredAt,
        });
      } catch (error) {
        return failure(classifyClientError(error), { reviewer: reviewerKey, head, externalTriggerDispatched: true });
      }

      const hit = matchResult(results, trigger, head);
      if (hit) {
        pendingState = null;
        await savePending();
        // Best-effort audit transition (TRIGGERED -> RESULT_RECEIVED). Never
        // makes this head triggerable again either way — a persistence
        // hiccup here must not mask an otherwise-successful review result.
        await triggerAuthority.recordResult?.({
          workflowId, prNumber, headSha: head, triggerKind: 'PR_REVIEW',
          resultMeta: { reviewId: hit.id ?? null, reviewer: hit.reviewer ?? hit.author ?? null },
        });
        return {
          ok: true,
          review: {
            reviewer: hit.reviewer ?? hit.author ?? identity,
            headSha: head,
            reviewedAt: hit.submittedAt ?? hit.reviewedAt ?? hit.createdAt ?? null,
            reviewId: hit.id ?? null,
            triggerCommentId: trigger.commentId,
            findings: Array.isArray(hit.findings) ? hit.findings : [],
          },
        };
      }

      await sleep(interval);
      interval = clampInterval(interval * backoffFactor);
    }

    return failure(GITHUB_REVIEW_FAILURES.TIMEOUT, {
      reviewer: reviewerKey,
      head,
      // A trigger for this head was posted/reused before this wait began —
      // never eligible for cross-reviewer failover or a synthetic clean
      // fallback; the external review may still be running.
      externalTriggerDispatched: true,
      triggerState: 'TRIGGERED',
      triggerReused: trigger?.reused === true,
      originalReviewer: trigger?.reused ? (trigger.reviewer ?? null) : null,
      // The trigger stays pending so a later retry / resume de-dupes instead
      // of re-commenting.
      pending: snapshot(),
    });
  }

  return {
    reviewer: reviewerKey,
    identity,
    triggerText: PR_REVIEW_TRIGGER_TEXT[reviewerKey] ?? null,
    requestReview,
    resolveReviewThread: (finding, options = {}) => resolveGithubReviewThread({
      github,
      finding,
      clock,
      ...options,
    }),
    get pending() { return snapshot(); },
  };
}
