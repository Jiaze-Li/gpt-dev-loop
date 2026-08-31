// V2-C — PR Closeout Loop orchestration.
//
// Ties the pure deterministic closeout policy (prCloseoutPolicy.js) and the
// trusted-review trust boundary (trustedPrReview.js) to concrete
// side-effecting adapters, and to durable workflow state so a crashed or
// suspended loop resumes with an identical decision.
//
// SuperGPT stays the execution owner. Everything that reaches outside the
// process — reading the PR head, asking the configured trusted reviewer for a
// review, running the Executor -> Gate -> Reviewer repair, pushing the repaired
// branch — goes through an injected adapter so the whole loop is deterministic
// and offline-testable. The adapters, not this module, perform I/O; this module
// only decides and sequences.
//
// Hard safety boundaries (never bypassable here):
//   - never force-push (the push adapter is contractually non-force; every
//     repair plan is re-validated with assertRepairActionSafe),
//   - never auto-merge unless config.allowMerge === true,
//   - never edit .github/workflows/** automatically,
//   - at most `maxRepairRounds` (default 5) automatic repair rounds, then
//     HUMAN_REQUIRED.

import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from './errors.js';
import {
  PR_CLOSEOUT_ACTIONS,
  DEFAULT_MAX_REPAIR_ROUNDS,
  initialCloseoutState,
  decideCloseout,
  invalidateReviewEvidence,
  assertRepairReadyForPush,
  assertRepairActionSafe,
  buildRepairTaskCard,
  recordRepairRound,
  buildSupervisorEscalationContext,
  applySupervisorEscalationOutcome,
} from './prCloseoutPolicy.js';
import { ingestTrustedReview } from './trustedPrReview.js';
import {
  FINDING_LIFECYCLE,
  THREAD_RESOLUTION_STATUS,
  markFindingFixed,
} from './adapters/normalizedPrReview.js';

export const PR_CLOSEOUT_LOOP_STATUS = Object.freeze({
  DONE: 'DONE',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  REVIEW_ONLY: 'REVIEW_ONLY',
  CLEAN_WITH_UNRESOLVED_THREADS: 'CLEAN_WITH_UNRESOLVED_THREADS',
});

// A single, explicit list of the fields that make up the durable closeout
// state. `serializeCloseoutState` / `restoreCloseoutState` round-trip exactly
// these so a persisted state reloads into an identical object.
const STATE_FIELDS = [
  'prNumber',
  'prHead',
  'configuredReviewer',
  'maxRepairRounds',
  'isFork',
  'safeForkWritePath',
  'repairRounds',
  'escalated',
  'maxEscalationRepairRounds',
  'escalationRepairRounds',
  'lastActionableSignatures',
  'reviewedPrHead',
  'lastAction',
  'lastReason',
  'history',
  'repairLog',
  'resolvedSignatures',
  'supervisorEscalations',
  'reviewFindings',
  'repairReviewer',
];

const STATE_ARRAY_FIELDS = new Set([
  'lastActionableSignatures',
  'history',
  'repairLog',
  'resolvedSignatures',
  'supervisorEscalations',
  'reviewFindings',
]);

// Normalize any closeout-state-shaped object (fresh, persisted, or hand-built)
// into the canonical shape the deterministic policy expects. Missing fields are
// filled from `initialCloseoutState`; array fields are always fresh arrays;
// `maxRepairRounds` is clamped to a positive integer.
export function restoreCloseoutState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = initialCloseoutState({
    prNumber: source.prNumber ?? null,
    prHead: source.prHead ?? null,
    configuredReviewer: source.configuredReviewer ?? null,
    maxRepairRounds: source.maxRepairRounds,
    isFork: source.isFork ?? false,
    safeForkWritePath: source.safeForkWritePath ?? false,
  });
  const restored = { ...base };
  for (const field of STATE_FIELDS) {
    if (source[field] === undefined) continue;
    if (STATE_ARRAY_FIELDS.has(field)) {
      restored[field] = Array.isArray(source[field]) ? [...source[field]] : [];
    } else {
      restored[field] = source[field];
    }
  }
  restored.repairRounds = Number.isInteger(restored.repairRounds) && restored.repairRounds >= 0
    ? restored.repairRounds
    : 0;
  restored.escalationRepairRounds = Number.isInteger(restored.escalationRepairRounds) && restored.escalationRepairRounds >= 0
    ? restored.escalationRepairRounds
    : 0;
  restored.escalated = Boolean(restored.escalated);
  return restored;
}

// Produce a plain, JSON-safe snapshot of the durable closeout state. Round
// trips through JSON without loss and reloads via `restoreCloseoutState` to an
// identical object.
export function serializeCloseoutState(state = {}) {
  const restored = restoreCloseoutState(state);
  const out = {};
  for (const field of STATE_FIELDS) {
    const value = restored[field];
    out[field] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

// Re-ingest the raw review payload so the FIX branch has the normalized,
// trusted, fresh finding list needed to build a bounded repair Task Card. This
// repeats the validation `decideCloseout` already performed; if it disagrees
// (identity / freshness), we fail closed rather than repair against an
// untrusted or stale review.
function ingestForRepair(review, { head, state, config }) {
  if (review && typeof review === 'object' && 'verdict' in review && 'actionable' in review) {
    return review;
  }
  return ingestTrustedReview({
    review,
    config: {
      configuredReviewer: config.configuredReviewer ?? state.configuredReviewer,
      currentPrHead: head,
      isFork: config.isFork ?? state.isFork,
    },
    currentPrHead: head,
  });
}

function terminal(status, reason, state) {
  return { status, reason, state, rounds: state.repairRounds };
}

// Drive the deterministic PR closeout loop to a terminal outcome.
//
// adapters (all async, all injected — this module performs no I/O itself):
//   getPrHead()                         -> current PR head SHA
//   requestTrustedReview({prNumber,prHead}) -> raw trusted-review payload
//   runRepairTask(taskCard)             -> { status: 'COMPLETE'|'HUMAN_REQUIRED'|'ABORTED',
//                                            gateResult: 'PASS'|..., plan?, changedFiles? }
//   pushRepair({prNumber,expectedHead}) -> new PR head SHA (adapter MUST NOT force-push)
//   escalateSupervisor?({state,review}) -> void (optional; loop still bounded without it)
//   refreshReview?                      -> defaults to requestTrustedReview
//
// persist?(serializedState)  is invoked after every state transition so a crash
// resumes from the last durable decision.
export async function runPrCloseoutLoop({
  state = null,
  init = {},
  adapters = {},
  config = {},
  persist,
  maxIterations,
} = {}) {
  const {
    getPrHead,
    requestTrustedReview,
    runRepairTask,
    pushRepair,
    escalateSupervisor,
    refreshReview,
    resolveReviewThread,
  } = adapters;

  if (typeof getPrHead !== 'function' || typeof requestTrustedReview !== 'function') {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'runPrCloseoutLoop requires getPrHead and requestTrustedReview adapters',
    );
  }

  let current = state
    ? restoreCloseoutState(state)
    : initialCloseoutState({
      prNumber: init.prNumber ?? null,
      prHead: init.prHead ?? null,
      configuredReviewer: init.configuredReviewer ?? config.configuredReviewer ?? null,
      maxRepairRounds: init.maxRepairRounds,
      isFork: init.isFork ?? false,
      safeForkWritePath: init.safeForkWritePath ?? false,
    });

  const savedPersist = async () => {
    if (typeof persist === 'function') await persist(serializeCloseoutState(current));
  };
  await savedPersist();

  const requestReview = typeof refreshReview === 'function' ? refreshReview : requestTrustedReview;
  // Bound total turns independently of the policy's own round cap: a
  // misbehaving review adapter that keeps returning a stale head must not spin
  // forever.
  const cap = Number.isInteger(maxIterations) && maxIterations > 0
    ? maxIterations
    : (current.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS) * 3 + 6;

  let lastRefreshHead = null;
  let refreshWithoutProgress = 0;

  // Shared Executor -> Gate -> (non-force) push for both an ordinary repair
  // round and a Supervisor escalation repair. Returns { newHead, repair,
  // trusted } on success, or { done } carrying a terminal result to return.
  async function runRepairAndPush({ head, review, extraContext = null }) {
    if (typeof runRepairTask !== 'function' || typeof pushRepair !== 'function') {
      throw new PrCloseoutError(
        PR_CLOSEOUT_ERROR_CODES.UNSAFE_REPAIR_ACTION,
        'a repair action requires runRepairTask and pushRepair adapters',
      );
    }
    const trusted = ingestForRepair(review, { head, state: current, config });
    const card = buildRepairTaskCard(trusted, {
      repositoryContext: config.repositoryContext ?? {},
      prNumber: current.prNumber,
      verificationCommands: config.verificationCommands ?? [],
    });
    if (extraContext) card.supervisor_escalation = extraContext;
    assertRepairActionSafe(
      { changedFiles: card.allowed_files, files: card.allowed_files },
      { allowMerge: config.allowMerge === true, allowWorkflowEdits: false },
    );
    const repair = await runRepairTask(card);
    if (!repair || repair.status !== 'COMPLETE') {
      return {
        done: terminal(
          PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED,
          `repair_task_${(repair && repair.status ? repair.status : 'no_result').toLowerCase()}`,
          current,
        ),
      };
    }
    assertRepairReadyForPush({ gateResult: repair.gateResult });
    if (repair.plan && typeof repair.plan === 'object') {
      assertRepairActionSafe(repair.plan, {
        allowMerge: config.allowMerge === true,
        allowWorkflowEdits: false,
      });
    }
    const newHead = String(await pushRepair({
      prNumber: current.prNumber,
      expectedHead: head,
    }) ?? '').trim();
    if (!newHead) {
      return { done: terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, 'repair_push_no_head', current) };
    }
    return { newHead, repair, trusted };
  }

  function rememberRepairFindings(trusted) {
    const existing = new Map((current.reviewFindings ?? []).map((f) => [f.signature, f]));
    for (const finding of trusted.actionable ?? []) {
      if (!existing.has(finding.signature)) existing.set(finding.signature, { ...finding });
    }
    current.reviewFindings = [...existing.values()];
    current.repairReviewer = trusted.reviewer;
  }

  for (let iteration = 0; iteration < cap; iteration += 1) {
    const head = String(await getPrHead() ?? '').trim();
    if (!head) {
      return terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, 'pr_head_unavailable', current);
    }

    // The PR head moved out from under a prior review (our push or an external
    // push) — all earlier review evidence is void.
    if (current.reviewedPrHead && current.reviewedPrHead !== head) {
      current = invalidateReviewEvidence(current, head);
      await savedPersist();
    }

    const review = iteration === 0
      ? await requestTrustedReview({ prNumber: current.prNumber, prHead: head })
      : await requestReview({ prNumber: current.prNumber, prHead: head });

    // A pushed repair is only confirmed by the same reviewer examining the
    // new head.  Compare stable signatures; absence confirms only that exact
    // subset.  Merely moving the head never changes finding lifecycle.
    if ((current.reviewFindings ?? []).some((f) => f.lifecycle === FINDING_LIFECYCLE.OPEN)) {
      const verification = ingestForRepair(review, { head, state: current, config });
      const sameReviewer = String(verification.reviewer ?? '').trim().toLowerCase()
        === String(current.repairReviewer ?? '').trim().toLowerCase();
      const reviewId = verification.normalized?.review_id ?? review?.reviewId ?? review?.review_id ?? review?.id;
      if (sameReviewer && verification.headSha === head && current.prHead === head) {
        const live = new Set(verification.actionableSignatures ?? []);
        current.reviewFindings = current.reviewFindings.map((finding) => {
          if (finding.lifecycle !== FINDING_LIFECYCLE.OPEN || live.has(finding.signature)) return finding;
          return markFindingFixed(finding, { verificationReviewId: reviewId, resolvedOnHead: head });
        });

        // Resolution is deliberately per finding and idempotent. A failure
        // does not roll a confirmed code fix back to OPEN and cannot prevent
        // other confirmed findings from resolving.
        for (let index = 0; index < current.reviewFindings.length; index += 1) {
          const finding = current.reviewFindings[index];
          if (finding.lifecycle !== FINDING_LIFECYCLE.FIXED
            || finding.threadResolutionStatus === THREAD_RESOLUTION_STATUS.RESOLVED) continue;
          if (typeof resolveReviewThread !== 'function') {
            current.reviewFindings[index] = {
              ...finding,
              threadResolutionStatus: THREAD_RESOLUTION_STATUS.FAILED,
            };
            continue;
          }
          const result = await resolveReviewThread(finding, {
            prNumber: current.prNumber,
            prHead: head,
            verificationReviewId: reviewId,
          });
          current.reviewFindings[index] = result?.finding ?? (result?.ok
            ? { ...finding, lifecycle: FINDING_LIFECYCLE.RESOLVED,
              threadResolutionStatus: THREAD_RESOLUTION_STATUS.RESOLVED,
              ...(result.evidence ?? {}) }
            : { ...finding, threadResolutionStatus: THREAD_RESOLUTION_STATUS.FAILED });
        }
        await savedPersist();
      }
    }

    const decision = decideCloseout({ state: current, review, currentPrHead: head, config });
    current = decision.state;
    await savedPersist();

    switch (decision.action) {
      case PR_CLOSEOUT_ACTIONS.DONE:
        if ((current.reviewFindings ?? []).some((finding) =>
          finding.lifecycle === FINDING_LIFECYCLE.FIXED
          && finding.threadResolutionStatus === THREAD_RESOLUTION_STATUS.FAILED)) {
          return terminal(
            PR_CLOSEOUT_LOOP_STATUS.CLEAN_WITH_UNRESOLVED_THREADS,
            'clean_with_unresolved_threads',
            current,
          );
        }
        return terminal(PR_CLOSEOUT_LOOP_STATUS.DONE, decision.reason, current);

      case PR_CLOSEOUT_ACTIONS.REVIEW_ONLY:
        return terminal(PR_CLOSEOUT_LOOP_STATUS.REVIEW_ONLY, decision.reason, current);

      case PR_CLOSEOUT_ACTIONS.HUMAN_REQUIRED:
        return terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, decision.reason, current);

      case PR_CLOSEOUT_ACTIONS.REFRESH_REVIEW: {
        // A stale review with no head movement means the review adapter is not
        // catching up. Give it a bounded number of retries, then stop.
        if (lastRefreshHead === head) {
          refreshWithoutProgress += 1;
        } else {
          refreshWithoutProgress = 0;
          lastRefreshHead = head;
        }
        if (refreshWithoutProgress >= 2) {
          return terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, 'stale_review_not_refreshing', current);
        }
        continue;
      }

      case PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR: {
        // Assemble the full deterministic context (head, reviewer, three
        // rounds of findings / repair summaries / Gate evidence, active
        // findings, relevant diff) and hand it to the Supervisor.
        const activeReview = ingestForRepair(review, { head, state: current, config });
        const escalationContext = buildSupervisorEscalationContext({
          state: current,
          currentPrHead: head,
          activeReview,
          diff: config.relevantDiff ?? config.diff ?? null,
        });
        let supervisorOutcome = null;
        if (typeof escalateSupervisor === 'function') {
          supervisorOutcome = await escalateSupervisor({
            state: serializeCloseoutState(current),
            review,
            context: escalationContext,
          });
        }
        const applied = applySupervisorEscalationOutcome(current, supervisorOutcome, { activeReview });
        current = applied.state;
        await savedPersist();

        if (applied.action === 'HUMAN_REQUIRED') {
          return terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, applied.reason, current);
        }
        if (applied.action === 'ESCALATION_REPAIR') {
          const outcome = await runRepairAndPush({
            head,
            review,
            extraContext: { strategy: applied.strategy ?? null, provider: applied.provider ?? null },
          });
          if (outcome.done) return outcome.done;
          current = recordRepairRound(current, {
            round: `E${current.escalationRepairRounds}`,
            head,
            newHead: outcome.newHead,
            signatures: outcome.trusted.actionableSignatures,
            findings: outcome.trusted.actionable,
            repairSummary: outcome.repair.summary
              ?? (applied.reason === 'supervisor_selected_stronger_provider'
                ? `escalation repair via ${applied.provider ?? 'stronger provider'}`
                : 'escalation repair (new strategy)'),
            gateEvidence: outcome.repair.gateResult,
          });
          rememberRepairFindings(outcome.trusted);
          current = invalidateReviewEvidence(current, outcome.newHead);
          await savedPersist();
        }
        // RE_REVIEW (branch A / B remainder) and post-escalation-repair both
        // fall through to a fresh review by the same locked reviewer.
        continue;
      }

      case PR_CLOSEOUT_ACTIONS.FIX: {
        const outcome = await runRepairAndPush({ head, review });
        if (outcome.done) return outcome.done;
        current = recordRepairRound(current, {
          round: current.repairRounds,
          head,
          newHead: outcome.newHead,
          signatures: outcome.trusted.actionableSignatures,
          findings: outcome.trusted.actionable,
          repairSummary: outcome.repair.summary ?? null,
          gateEvidence: outcome.repair.gateResult,
        });
        rememberRepairFindings(outcome.trusted);
        current = invalidateReviewEvidence(current, outcome.newHead);
        await savedPersist();
        continue;
      }

      default:
        throw new PrCloseoutError(
          PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
          `unknown closeout action: ${decision.action}`,
        );
    }
  }

  return terminal(PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED, 'closeout_loop_iteration_cap', current);
}
