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

// Canonical, evidence-backed trigger comment bodies. `resolveTriggerText`
// allows a tested injection override (metadata / config) but never silently
// invents an alternate format.
export const PR_REVIEW_TRIGGER_TEXT = Object.freeze({
  codex: '@codex review',
  claude: '@claude review',
});

// Default mapping from PR reviewer key -> the GitHub author login that its
// review/comment is expected to come from. Injectable for tests / real bots.
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
});

// GitHub polling bounds. The interval is deliberately clamped into the
// 15–30s band the plan mandates; backoff grows within the band only.
export const MIN_POLL_INTERVAL_MS = 15_000;
export const MAX_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 20_000;
export const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

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
// persist?(pendingSnapshot) is called after every trigger / head rebind so a
// restart resumes the same pending reviewer/head without a second comment.
export function createGithubPrReviewAdapter({
  github,
  clock = {},
  reviewer,
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
  const reviewerKey = String(reviewer ?? '').trim().toLowerCase();
  const now = typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
  const sleep = typeof clock.sleep === 'function'
    ? (ms) => clock.sleep(ms)
    : () => Promise.resolve();
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
    if (typeof github.isReviewerAvailable === 'function') {
      let available;
      try {
        available = await github.isReviewerAvailable({ reviewer: reviewerKey });
      } catch (error) {
        throw Object.assign(new Error('reviewer availability probe failed'), {
          _classified: classifyClientError(error),
        });
      }
      if (!available) {
        throw Object.assign(new Error(`reviewer ${reviewerKey} unavailable`), {
          _classified: GITHUB_REVIEW_FAILURES.UNAVAILABLE,
        });
      }
    }
    const body = resolveTriggerText(reviewerKey, { overrides: triggerOverrides });
    let comment;
    try {
      comment = await github.postReviewTrigger({ prNumber, body });
    } catch (error) {
      throw Object.assign(new Error('failed to post review trigger comment'), {
        _classified: error?._classified ?? GITHUB_REVIEW_FAILURES.TRIGGER_FAILED,
      });
    }
    if (!comment || comment.id == null) {
      throw Object.assign(new Error('review trigger comment returned no id'), {
        _classified: GITHUB_REVIEW_FAILURES.TRIGGER_FAILED,
      });
    }
    pendingState = {
      reviewer: reviewerKey,
      headSha: head,
      commentId: comment.id,
      triggeredAt: comment.createdAt ?? new Date(now()).toISOString(),
      body,
    };
    await savePending();
    return pendingState;
  }

  function matchResult(results, trigger, head) {
    if (!Array.isArray(results)) return null;
    for (const result of results) {
      if (authorOf(result) !== identity) continue;
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
        return failure(classifyClientError(error), { reviewer: reviewerKey });
      }
    }
    if (!head) return failure(GITHUB_REVIEW_FAILURES.INFRASTRUCTURE, { reviewer: reviewerKey });

    const deadline = now() + maxWaitMs;
    let interval = baseInterval;
    let trigger;
    try {
      trigger = await ensureTrigger(prNumber, head);
    } catch (error) {
      return failure(error?._classified ?? GITHUB_REVIEW_FAILURES.TRIGGER_FAILED, {
        reviewer: reviewerKey,
        head,
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
        return failure(classifyClientError(error), { reviewer: reviewerKey, head });
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
        return failure(classifyClientError(error), { reviewer: reviewerKey, head });
      }

      const hit = matchResult(results, trigger, head);
      if (hit) {
        pendingState = null;
        await savePending();
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
    get pending() { return snapshot(); },
  };
}
