// ReviewLoop PR external-review controller.
//
// ReviewLoop never repairs or pushes application code. In PR mode it:
//   - binds every trusted review to the EXACT current PR HEAD
//   - reuses a fresh existing current-head review instead of re-triggering
//   - posts AT MOST ONE `@codex/@claude review` per semantic HEAD state
//   - waits locally for the result with ZERO model tokens / ZERO Worker wakeups
//   - persists WAITING_FOR_REVIEW so a restart reattaches without re-triggering
//   - returns normalized findings to the SAME Worker on REWORK
//   - never force-pushes, never auto-merges
//
// `prBackend` is the injected transport (production: githubPrReviewAdapter;
// tests: a deterministic mock). It performs only local GitHub API polling.

import {
  ExternalModelTriggerAuthority,
  ExternalTriggerStore,
  EXTERNAL_TRIGGER_STATUS,
} from '../orchestrator/externalModelTriggerAuthority.js';
import { isExternalTriggerFailure } from '../orchestrator/errors.js';
import { normalizeReview } from './reviewPolicy.js';
import { checkPrReviewTrust } from './prTrust.js';
import { resolveReviewLoopLimits } from './reviewSpend.js';

export const PR_REVIEW_OUTCOMES = Object.freeze({
  REVIEW_READY: 'REVIEW_READY',
  WAITING_FOR_REVIEW: 'WAITING_FOR_REVIEW',
  PUSH_REQUIRED: 'PUSH_REQUIRED',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

export function createPrReviewController({
  loopId,
  persistence = null,
  prBackend,
  env = process.env,
  onEvent,
  recordSafetyEvent,
  triggerAuthority = null,
} = {}) {
  // REVIEWLOOP_MAX_EXTERNAL_REVIEW_TRIGGERS is a public tuning knob — wire it
  // into the deterministic trigger ceiling the ExternalModelTriggerAuthority
  // already enforces, rather than leaving it resolved-but-ignored.
  const { maxExternalReviewTriggers } = resolveReviewLoopLimits(env);
  const authority = triggerAuthority ?? new ExternalModelTriggerAuthority({
    store: persistence ? new ExternalTriggerStore(persistence) : null,
    maxExternalModelTriggers: maxExternalReviewTriggers,
    maxExternalReviewRounds: maxExternalReviewTriggers,
    recordSafetyEvent,
    onEvent,
  });

  // Obtain a trusted review for the current PR HEAD. Returns one of
  // PR_REVIEW_OUTCOMES. `loopState.lastReviewedPrHead` tracks HEAD progression.
  async function obtainReview({ objective, loopState, signal, onHeartbeat }) {
    const prNumber = objective.prNumber;
    const reviewer = objective.reviewer; // codex | claude
    const currentHead = await prBackend.getPrHead({ prNumber });
    if (!currentHead) {
      return { outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED, reason: 'cannot resolve current PR HEAD' };
    }

    // Local Worker fixes not pushed: PR HEAD unchanged since last review -> do
    // NOT request a fresh external review of the unchanged head.
    if (loopState.lastReviewedPrHead && loopState.lastReviewedPrHead === currentHead
      && loopState.lastReview && loopState.lastReview.status === 'ACTIONABLE') {
      // Only block re-review; if the Worker genuinely pushed, currentHead differs.
      return {
        outcome: PR_REVIEW_OUTCOMES.PUSH_REQUIRED,
        head: currentHead,
        reason: 'PR HEAD unchanged since the last review; push your fix before requesting a fresh PR review',
      };
    }

    // §19 — a fresh trusted review already exists for the CURRENT HEAD: ingest
    // it, do not post another trigger. Re-checked against the ReviewLoop PR
    // trust boundary here (defense in depth — the backend also checks).
    const existing = await prBackend.findExistingReview({ prNumber, headSha: currentHead, reviewer });
    if (existing) {
      const trust = checkPrReviewTrust({ raw: existing, configuredReviewer: reviewer, currentHead, env });
      if (!trust.ok) {
        return {
          outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED,
          head: currentHead,
          reason: `existing PR review failed the ReviewLoop trust boundary (${trust.reason})`,
        };
      }
      await authority.recordResult({
        workflowId: loopId, prNumber, headSha: currentHead, resultMeta: { source: 'existing' },
      }).catch(() => {});
      return finalizeReview({ raw: trust.review, reviewer, head: currentHead, source: 'existing-current-head' });
    }

    // Reattach to an in-flight trigger for this head (WAITING_FOR_REVIEW resume)
    // before authorizing a new one.
    const pending = loopState.pendingExternalTrigger;
    const reattach = pending && pending.head === currentHead;

    let permit;
    if (!reattach) {
      let decision;
      try {
        decision = await authority.authorize({
          workflowId: loopId, prNumber, headSha: currentHead, reviewer,
        });
      } catch (err) {
        if (isExternalTriggerFailure(err)) {
          return { outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED, reason: err.message, head: currentHead };
        }
        throw err;
      }
      if (decision.outcome === 'REUSE') {
        // A trigger for this exact semantic HEAD already dispatched — wait, do
        // not post again.
        loopState.pendingExternalTrigger = {
          head: currentHead, reviewer, status: EXTERNAL_TRIGGER_STATUS.TRIGGERED,
        };
      } else {
        permit = decision.permit;
        try {
          await authority.dispatch(permit, {
            workflowId: loopId, prNumber, headSha: currentHead, reviewer,
          }, async () => {
            const posted = await prBackend.postReviewTrigger({ prNumber, reviewer, headSha: currentHead });
            // The External Model Trigger Authority settles on a durable comment
            // id — never on a bare "it returned".
            return { id: posted?.id ?? posted?.commentId ?? posted?.triggerId ?? null, createdAt: posted?.createdAt };
          });
        } catch (err) {
          if (isExternalTriggerFailure(err)) {
            return { outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED, reason: err.message, head: currentHead };
          }
          throw err;
        }
        loopState.pendingExternalTrigger = {
          head: currentHead, reviewer, status: EXTERNAL_TRIGGER_STATUS.TRIGGERED,
        };
        onEvent?.({ type: 'REVIEWLOOP_EXTERNAL_TRIGGER_POSTED', loopId, head: currentHead, reviewer });
      }
    }

    loopState.externalTriggerCount = (loopState.externalTriggerCount ?? 0)
      + (reattach ? 0 : (permit ? 1 : 0));

    // Local zero-model wait. The backend polls GitHub; if the transport forces
    // detachment it returns null and we persist WAITING_FOR_REVIEW.
    let raw = null;
    try {
      raw = await prBackend.waitForReview({
        prNumber, headSha: currentHead, reviewer, signal, onHeartbeat,
      });
    } catch (err) {
      return { outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED, reason: `review wait failed: ${err.message}`, head: currentHead };
    }

    if (!raw) {
      return {
        outcome: PR_REVIEW_OUTCOMES.WAITING_FOR_REVIEW,
        head: currentHead,
        reason: 'external review triggered; waiting for the result',
      };
    }

    const trust = checkPrReviewTrust({ raw, configuredReviewer: reviewer, currentHead, env });
    if (!trust.ok) {
      // A returned review that does not prove reviewer identity + exact HEAD is
      // not a trusted result — keep the trigger pending rather than accept it.
      return {
        outcome: PR_REVIEW_OUTCOMES.HUMAN_REQUIRED,
        head: currentHead,
        reason: `PR review result failed the ReviewLoop trust boundary (${trust.reason})`,
      };
    }
    await authority.recordResult({
      workflowId: loopId, prNumber, headSha: currentHead, resultMeta: { source: 'trigger' },
    }).catch(() => {});
    loopState.pendingExternalTrigger = null;
    return finalizeReview({ raw: trust.review, reviewer, head: currentHead, source: 'fresh-trigger' });
  }

  function finalizeReview({ raw, reviewer, head, source }) {
    // raw has already passed checkPrReviewTrust: raw.headSha is explicit and
    // equals `head`. requireExplicitHead guards against any regression that
    // would let the normalizer substitute the current HEAD.
    const review = normalizeReview({ raw, reviewer, provider: reviewer, head, requireExplicitHead: true });
    review.source = source;
    return { outcome: PR_REVIEW_OUTCOMES.REVIEW_READY, review, head };
  }

  return { obtainReview, authority };
}
