// V2-C — deterministic PR closeout decision + state model.
//
// SuperGPT stays execution owner; the trusted PR reviewer is a separate
// read-only trust boundary. This module is pure and deterministic: given the
// durable closeout state, an already-ingested trusted review, and the current
// PR head, it returns the next action and the next state.
//
// Decision rules (docs/V2_PLAN.md §V2-C):
//   - clean / non-actionable (P3-only) trusted review        -> DONE
//   - actionable P1/P2                                        -> FIX (bounded repair task)
//   - repaired work must pass deterministic gates before push -> assertRepairReadyForPush()
//   - same finding repeated after a repair round              -> ESCALATE_SUPERVISOR
//   - still unresolved after escalation                       -> HUMAN_REQUIRED
//   - default max automatic repair rounds                     -> 5, then HUMAN_REQUIRED
//   - stale review head (PR head changed)                     -> REFRESH_REVIEW
//   - fork PR with no safe write path + actionable findings   -> REVIEW_ONLY
// Safety boundaries (fail closed, never bypassable here):
//   - never force-push, never auto-merge by default,
//   - never modify .github/workflows/** automatically.

import {
  PrCloseoutError,
  PR_CLOSEOUT_ERROR_CODES,
} from './errors.js';
import {
  ingestTrustedReview,
  isReviewFresh,
  isForkWriteAllowed,
  TRUSTED_REVIEW_VERDICTS,
  NORMALIZED_REVIEW_STATUS,
} from './trustedPrReview.js';

// The Core only ever consumes the unified normalized review. Map either the
// normalized `status` (CLEAN | ACTIONABLE | FAILED) or, for legacy already
// -ingested reviews, the `verdict`, onto a single actionable predicate.
function isActionableReview(trusted) {
  if (trusted && typeof trusted.status === 'string') {
    return trusted.status === NORMALIZED_REVIEW_STATUS.ACTIONABLE;
  }
  return trusted?.verdict === TRUSTED_REVIEW_VERDICTS.ACTIONABLE;
}

export const DEFAULT_MAX_REPAIR_ROUNDS = 3;

// Escalation repair (Supervisor branch C/D) has its own small budget, tracked
// and reported separately from the three ordinary implementation repair rounds.
export const DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS = 3;

// Deterministic Supervisor escalation decision branches (Task Card §4 A–E).
export const SUPERVISOR_ESCALATION_OUTCOMES = Object.freeze({
  RE_REVIEW: 'RE_REVIEW', // A) stale / already-resolved -> re-review at the same head
  OUT_OF_SCOPE: 'OUT_OF_SCOPE', // B) finding is out of scope -> auto close-out
  NEW_STRATEGY: 'NEW_STRATEGY', // C) fresh strategy -> escalation Executor repair
  STRONGER_PROVIDER: 'STRONGER_PROVIDER', // D) stronger model/provider -> escalation repair
  HUMAN_REQUIRED: 'HUMAN_REQUIRED', // E) genuine product/architecture/credential decision
});

const SUPERVISOR_ESCALATION_OUTCOME_VALUES = new Set(Object.values(SUPERVISOR_ESCALATION_OUTCOMES));

// PR Closeout dedicated reviewer configuration (separate from the ordinary
// Task Reviewer — this never changes normal task review selection/behaviour).
export const PR_REVIEWERS = Object.freeze({
  CODEX: 'codex',
  CLAUDE: 'claude',
  INTERNAL: 'internal',
});

export const PR_REVIEWER_VALUES = Object.freeze(['codex', 'claude', 'internal']);

// Default PR Closeout reviewer and default automatic repair-round budget.
export const DEFAULT_PR_REVIEWER = PR_REVIEWERS.CODEX;
export const DEFAULT_MAX_PR_REPAIR_ROUNDS = 3;

// Deterministic three-stage failover order for the PR Closeout reviewer.
export const PR_REVIEWER_FALLBACK_ORDER = Object.freeze(['codex', 'claude', 'internal']);

// HUMAN_REQUIRED reason used when every reviewer in the fallback order is
// unavailable / failing infrastructure (never a repair-round consuming event).
export const REVIEW_INFRASTRUCTURE_REASON = 'REVIEW_INFRASTRUCTURE';

// Coerce an arbitrary configured value into a supported PR reviewer, falling
// back to the given default (itself defaulting to codex) on anything unknown.
export function normalizePrReviewer(value, fallback = DEFAULT_PR_REVIEWER) {
  const v = String(value ?? '').trim().toLowerCase();
  return PR_REVIEWER_VALUES.includes(v) ? v : fallback;
}

// The concrete candidate order for a workflow: the configured reviewer first,
// then the remaining reviewers in the canonical Codex -> Claude -> internal
// order. internal is always retained as the last-resort fallback.
export function resolveReviewerFallbackOrder(configuredReviewer) {
  const first = normalizePrReviewer(configuredReviewer);
  return [first, ...PR_REVIEWER_FALLBACK_ORDER.filter((r) => r !== first)];
}

export const PR_CLOSEOUT_ACTIONS = Object.freeze({
  DONE: 'DONE',
  FIX: 'FIX',
  REFRESH_REVIEW: 'REFRESH_REVIEW',
  ESCALATE_SUPERVISOR: 'ESCALATE_SUPERVISOR',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  REVIEW_ONLY: 'REVIEW_ONLY',
});

export function initialCloseoutState({
  prNumber = null,
  prHead,
  configuredReviewer,
  maxRepairRounds = DEFAULT_MAX_REPAIR_ROUNDS,
  maxPrRepairRounds,
  maxEscalationRepairRounds,
  prReviewer,
  isFork = false,
  safeForkWritePath = false,
} = {}) {
  const requestedRounds = Number.isInteger(maxPrRepairRounds) && maxPrRepairRounds > 0
    ? maxPrRepairRounds
    : maxRepairRounds;
  const rounds = Number.isInteger(requestedRounds) && requestedRounds > 0
    ? requestedRounds
    : DEFAULT_MAX_REPAIR_ROUNDS;
  const escalationRounds = Number.isInteger(maxEscalationRepairRounds) && maxEscalationRepairRounds > 0
    ? maxEscalationRepairRounds
    : DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS;
  const candidateOrder = resolveReviewerFallbackOrder(prReviewer);
  return {
    prNumber: prNumber ?? null,
    prHead: prHead ? String(prHead).trim() : null,
    configuredReviewer: configuredReviewer ? String(configuredReviewer).trim() : null,
    maxRepairRounds: rounds,
    isFork: Boolean(isFork),
    safeForkWritePath: Boolean(safeForkWritePath),
    repairRounds: 0,
    escalated: false,
    // Escalation repair (Supervisor branch C/D) budget, tracked separately from
    // the ordinary three implementation repair rounds above.
    maxEscalationRepairRounds: escalationRounds,
    escalationRepairRounds: 0,
    // Per-round durable evidence: one entry per completed implementation repair
    // round — { round, head, newHead, signatures, findings, repairSummary,
    // gateEvidence }. Consumed when building the Supervisor escalation context.
    repairLog: [],
    // Findings the Supervisor has deterministically closed as OUT_OF_SCOPE
    // (branch B); the Core stops treating these signatures as blocking.
    resolvedSignatures: [],
    // Audit trail of Supervisor escalation decisions applied to this workflow.
    supervisorEscalations: [],
    // Original actionable findings awaiting verification/resolution. These
    // survive checkpoints so a resume never loses the exact GitHub identity.
    reviewFindings: [],
    repairReviewer: null,
    // PR Closeout reviewer selection + three-stage failover progress. Once a
    // reviewer produces a valid review the workflow LOCKS onto it
    // (reviewerLocked) and later repair / push / re-review keep using it;
    // failover only advances the index while unlocked and never counts as a
    // repair round.
    prReviewer: candidateOrder[0],
    reviewerCandidateOrder: candidateOrder,
    reviewerCandidateIndex: 0,
    activeReviewer: null,
    reviewerLocked: false,
    reviewerFailovers: [],
    // signatures of the actionable findings that triggered the most recent
    // repair task; compared against the next review to detect non-convergence.
    lastActionableSignatures: [],
    reviewedPrHead: null,
    lastAction: null,
    lastReason: null,
    history: [],
  };
}

function cloneState(state) {
  return {
    ...state,
    lastActionableSignatures: [...(state.lastActionableSignatures ?? [])],
    history: [...(state.history ?? [])],
    reviewerCandidateOrder: [...(state.reviewerCandidateOrder ?? [])],
    reviewerFailovers: (state.reviewerFailovers ?? []).map((f) => ({ ...f })),
    repairLog: (state.repairLog ?? []).map((e) => ({ ...e })),
    resolvedSignatures: [...(state.resolvedSignatures ?? [])],
    supervisorEscalations: (state.supervisorEscalations ?? []).map((e) => ({ ...e })),
  };
}

// The reviewer the workflow should currently use: the locked one if it has
// been locked, otherwise the current fallback candidate.
export function currentReviewerCandidate(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.reviewerLocked && state.activeReviewer) return state.activeReviewer;
  const order = state.reviewerCandidateOrder?.length
    ? state.reviewerCandidateOrder
    : [...PR_REVIEWER_FALLBACK_ORDER];
  return order[state.reviewerCandidateIndex] ?? null;
}

// Lock the workflow onto the reviewer that produced the first valid review.
// After this, failover is a no-op — repair, push and re-review stay on it.
export function lockActiveReviewer(state, reviewer) {
  const next = cloneState(state);
  const resolved = normalizePrReviewer(reviewer, currentReviewerCandidate(state));
  next.activeReviewer = resolved;
  next.prReviewer = resolved;
  next.reviewerLocked = true;
  return next;
}

// Advance the three-stage failover order. Only valid while unlocked; a
// reviewer that is unavailable / fails to trigger / times out / hits a
// classified infrastructure error drives this, and it never increments a
// repair round. When the order is exhausted the caller must enter
// HUMAN_REQUIRED with REVIEW_INFRASTRUCTURE.
export function failoverReviewer(state, reason) {
  const next = cloneState(state);
  if (next.reviewerLocked) {
    return { state: next, switched: false, exhausted: false, reviewer: next.activeReviewer };
  }
  const order = next.reviewerCandidateOrder.length
    ? next.reviewerCandidateOrder
    : [...PR_REVIEWER_FALLBACK_ORDER];
  const from = order[next.reviewerCandidateIndex] ?? null;
  const nextIndex = next.reviewerCandidateIndex + 1;
  if (nextIndex >= order.length) {
    next.reviewerCandidateIndex = order.length;
    next.reviewerFailovers = [
      ...next.reviewerFailovers,
      { from, to: null, reason: reason ?? REVIEW_INFRASTRUCTURE_REASON, exhausted: true },
    ];
    return {
      state: next,
      switched: false,
      exhausted: true,
      reviewer: null,
      humanRequiredReason: REVIEW_INFRASTRUCTURE_REASON,
    };
  }
  next.reviewerCandidateIndex = nextIndex;
  const to = order[nextIndex];
  next.prReviewer = to;
  next.reviewerFailovers = [
    ...next.reviewerFailovers,
    { from, to, reason: reason ?? null },
  ];
  return { state: next, switched: true, exhausted: false, reviewer: to };
}

function intersects(a = [], b = []) {
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

function record(next, action, reason) {
  next.lastAction = action;
  next.lastReason = reason;
  next.history = [...next.history, { action, reason, at: next.reviewedPrHead, round: next.repairRounds }];
  return { action, reason, state: next };
}

// The core deterministic transition. `review` may be a raw payload (it will be
// ingested/validated here) or an already-ingested trusted review.
export function decideCloseout({
  state,
  review,
  currentPrHead,
  config = {},
} = {}) {
  if (!state || typeof state !== 'object') {
    throw new PrCloseoutError(PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW, 'closeout state missing');
  }
  const next = cloneState(state);
  const head = String(currentPrHead ?? state.prHead ?? '').trim();
  if (!head) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.STALE_REVIEW_HEAD,
      'current PR head is unknown; cannot evaluate closeout',
    );
  }
  next.prHead = head;

  const ingestConfig = {
    configuredReviewer: config.configuredReviewer ?? state.configuredReviewer,
    currentPrHead: head,
    isFork: config.isFork ?? state.isFork,
  };

  // Accept an already-ingested review only if it is still fresh for this head;
  // otherwise (or for a raw payload) run full ingestion, which fails closed on
  // untrusted identity / stale head / malformed data.
  let trusted;
  const preIngested = review && typeof review === 'object' && 'verdict' in review && 'actionableSignatures' in review;
  if (preIngested) {
    if (!isReviewFresh(review, head)) {
      next.reviewedPrHead = null;
      return record(next, PR_CLOSEOUT_ACTIONS.REFRESH_REVIEW, 'stale_review_head');
    }
    if (review.status === NORMALIZED_REVIEW_STATUS.FAILED) {
      throw new PrCloseoutError(
        PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
        `normalized review FAILED: ${review.error?.message ?? review.error?.reason ?? 'unknown'}`,
      );
    }
    trusted = review;
  } else {
    try {
      trusted = ingestTrustedReview({ review, config: ingestConfig, currentPrHead: head });
    } catch (error) {
      if (error instanceof PrCloseoutError
        && error.code === PR_CLOSEOUT_ERROR_CODES.STALE_REVIEW_HEAD) {
        next.reviewedPrHead = null;
        return record(next, PR_CLOSEOUT_ACTIONS.REFRESH_REVIEW, 'stale_review_head');
      }
      throw error;
    }
  }

  next.reviewedPrHead = head;

  // No actionable findings: clean or non-blocking-only -> DONE. Only P1/P2
  // block closeout; OTHER (P3, nit, suggestion, ...) never triggers repairs.
  if (!isActionableReview(trusted)) {
    next.lastActionableSignatures = [];
    return record(
      next,
      PR_CLOSEOUT_ACTIONS.DONE,
      trusted.verdict === TRUSTED_REVIEW_VERDICTS.CLEAN ? 'clean_trusted_review' : 'non_actionable_findings_only',
    );
  }

  // The Supervisor may have deterministically closed some findings as
  // OUT_OF_SCOPE (branch B). Those signatures no longer block closeout; if
  // every remaining actionable finding has been closed this way, we are done.
  const resolved = new Set(state.resolvedSignatures ?? []);
  const liveSignatures = (trusted.actionableSignatures ?? []).filter((s) => !resolved.has(s));
  if (liveSignatures.length === 0) {
    next.lastActionableSignatures = [];
    return record(next, PR_CLOSEOUT_ACTIONS.DONE, 'supervisor_closed_findings_out_of_scope');
  }

  // Actionable findings on a fork PR without a safe write path: review-only.
  if (!isForkWriteAllowed({
    isFork: ingestConfig.isFork,
    safeForkWritePath: config.safeForkWritePath ?? state.safeForkWritePath,
  })) {
    return record(next, PR_CLOSEOUT_ACTIONS.REVIEW_ONLY, 'fork_pr_no_safe_write_path');
  }

  const signatures = liveSignatures;
  const repeated = intersects(state.lastActionableSignatures, signatures) && state.repairRounds >= 1;

  if (state.escalated) {
    if (repeated) {
      return record(next, PR_CLOSEOUT_ACTIONS.HUMAN_REQUIRED, 'unresolved_after_supervisor_escalation');
    }
    // A genuinely new finding after escalation is still bounded by the round cap.
    if (state.repairRounds >= state.maxRepairRounds) {
      return record(next, PR_CLOSEOUT_ACTIONS.HUMAN_REQUIRED, 'max_repair_rounds_exhausted');
    }
    next.repairRounds = state.repairRounds + 1;
    next.lastActionableSignatures = signatures;
    return record(next, PR_CLOSEOUT_ACTIONS.FIX, 'post_escalation_new_finding');
  }

  if (repeated) {
    next.escalated = true;
    return record(next, PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR, 'repeated_finding_after_repair');
  }

  if (state.repairRounds >= state.maxRepairRounds) {
    next.escalated = true;
    return record(next, PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR, 'max_repair_rounds_reached_supervisor_escalation');
  }

  next.repairRounds = state.repairRounds + 1;
  next.lastActionableSignatures = signatures;
  return record(next, PR_CLOSEOUT_ACTIONS.FIX, 'actionable_findings_repair');
}

// Whenever the PR head changes (our own push or an external push), all prior
// review evidence is invalidated and a fresh trusted review is mandatory.
export function invalidateReviewEvidence(state, newPrHead) {
  const next = cloneState(state);
  const head = String(newPrHead ?? '').trim();
  next.prHead = head || next.prHead;
  next.reviewedPrHead = null;
  return next;
}

// Repaired work must pass deterministic gates before it is pushed and
// re-reviewed. Fail closed when the gate result is anything but PASS.
export function assertRepairReadyForPush({ gateResult } = {}) {
  const result = String(gateResult ?? '').trim().toUpperCase();
  if (result !== 'PASS') {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.REPAIR_GATE_NOT_PASSED,
      `repaired work cannot be pushed: deterministic gate result is ${result || 'MISSING'}`,
      { gateResult: gateResult ?? null },
    );
  }
  return true;
}

const WORKFLOW_FILE_RE = /(^|\/)\.github\/workflows\//;

// The immovable safety boundary for any automatic repair/push plan. This is
// never bypassable from within the closeout loop.
export function validateRepairAction(plan = {}, { allowMerge = false, allowWorkflowEdits = false } = {}) {
  const violations = [];
  if (plan.forcePush === true || plan.force === true) {
    violations.push('force-push is never permitted in the closeout loop');
  }
  if ((plan.merge === true || plan.autoMerge === true) && allowMerge !== true) {
    violations.push('automatic merge is disabled by default');
  }
  const touched = []
    .concat(Array.isArray(plan.changedFiles) ? plan.changedFiles : [])
    .concat(Array.isArray(plan.files) ? plan.files : [])
    .map(String);
  if (!allowWorkflowEdits && touched.some((file) => WORKFLOW_FILE_RE.test(file))) {
    violations.push('automatic modification of .github/workflows/** is not permitted');
  }
  if (!allowWorkflowEdits && plan.modifiesWorkflowFiles === true) {
    violations.push('automatic modification of .github/workflows/** is not permitted');
  }
  return { safe: violations.length === 0, violations };
}

export function assertRepairActionSafe(plan, options) {
  const { safe, violations } = validateRepairAction(plan, options);
  if (!safe) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.UNSAFE_REPAIR_ACTION,
      `unsafe closeout repair action: ${violations.join('; ')}`,
      { violations },
    );
  }
  return true;
}

// Convert actionable findings into a normal, focused Executor task card. The
// repair goes through the ordinary Executor -> Gate -> Reviewer loop; this is
// not a separate execution engine.
export function buildRepairTaskCard(trustedReview, {
  repositoryContext = {},
  prNumber = null,
  verificationCommands = [],
} = {}) {
  const actionable = Array.isArray(trustedReview?.actionable) ? trustedReview.actionable : [];
  if (actionable.length === 0) {
    throw new PrCloseoutError(
      PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
      'cannot build a repair task card without actionable findings',
    );
  }
  const files = [...new Set(actionable.map((f) => f.file).filter(Boolean))];
  const changes = actionable.map((f) => `${f.severity} ${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''} — ${f.message}`);
  return {
    task_id: `pr-closeout-repair-${prNumber ?? 'pr'}-round`,
    repository_context: { ...repositoryContext },
    goal: `Resolve ${actionable.length} actionable trusted-review finding(s) from the PR closeout review.`,
    context: `Trusted PR reviewer flagged the following at head ${trustedReview.headSha}:\n- ${changes.join('\n- ')}`,
    scope: 'Address only the listed findings. Do not force-push, merge, or edit .github/workflows/**.',
    allowed_files: files,
    forbidden_files: ['.github/workflows/'],
    acceptance_criteria: [
      'Every listed actionable finding is resolved.',
      'All listed verification commands pass.',
    ],
    verification_commands: [...verificationCommands],
    completion_signal: 'DONE',
  };
}

// Append one completed implementation repair round's durable evidence. Called
// by the loop right after a repaired branch has passed the deterministic gate
// and been (non-force) pushed. Returns a new state; never mutates the input.
export function recordRepairRound(state, {
  round,
  head = null,
  newHead = null,
  signatures = [],
  findings = [],
  repairSummary = null,
  gateEvidence = null,
} = {}) {
  const next = cloneState(state);
  next.repairLog = [
    ...next.repairLog,
    {
      round: (Number.isInteger(round) || (typeof round === 'string' && round.trim()))
        ? round
        : next.repairLog.length + 1,
      head: head ? String(head) : null,
      newHead: newHead ? String(newHead) : null,
      signatures: [...signatures],
      findings: (Array.isArray(findings) ? findings : []).map((f) => ({
        severity: f.severity ?? null,
        file: f.file ?? null,
        line: f.line ?? null,
        message: f.message ?? f.title ?? null,
        signature: f.signature ?? null,
      })),
      repairSummary: repairSummary ?? null,
      gateEvidence: gateEvidence ?? null,
    },
  ];
  return next;
}

// Assemble the full deterministic context the Supervisor needs to choose an
// escalation branch (Task Card §4): current head + reviewer, the three repair
// rounds' findings / summaries / Gate evidence, the currently-active findings,
// and the relevant diff. Pure string/array assembly — sends nothing anywhere.
export function buildSupervisorEscalationContext({
  state,
  currentPrHead = null,
  activeReview = null,
  diff = null,
} = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const rounds = (s.repairLog ?? []).map((entry) => ({
    round: entry.round,
    head: entry.head,
    newHead: entry.newHead,
    signatures: [...(entry.signatures ?? [])],
    findings: (entry.findings ?? []).map((f) => ({ ...f })),
    repairSummary: entry.repairSummary ?? null,
    gateEvidence: entry.gateEvidence ?? null,
  }));
  const activeFindings = Array.isArray(activeReview?.actionable) ? activeReview.actionable : [];
  return {
    headSha: currentPrHead ? String(currentPrHead) : (s.prHead ?? null),
    reviewer: s.activeReviewer ?? s.prReviewer ?? s.configuredReviewer ?? null,
    reviewerLocked: Boolean(s.reviewerLocked),
    repairRounds: s.repairRounds ?? 0,
    maxRepairRounds: s.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS,
    escalationRepairRounds: s.escalationRepairRounds ?? 0,
    maxEscalationRepairRounds: s.maxEscalationRepairRounds ?? DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS,
    rounds,
    repairSummaries: rounds.map((r) => ({ round: r.round, repairSummary: r.repairSummary })),
    gateEvidence: rounds.map((r) => ({ round: r.round, gateEvidence: r.gateEvidence })),
    resolvedSignatures: [...(s.resolvedSignatures ?? [])],
    activeFindings: activeFindings.map((f) => ({ ...f })),
    activeSignatures: [...(activeReview?.actionableSignatures ?? [])],
    diff: diff ?? null,
  };
}

// Coerce whatever the escalation adapter returned into a canonical outcome
// object, or null when the adapter opted out (loop then keeps its default
// bounded re-review behaviour).
export function normalizeSupervisorEscalationOutcome(raw) {
  const candidate = raw && typeof raw === 'object' && !('kind' in raw) && raw.outcome ? raw.outcome : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  const kind = String(candidate.kind ?? '').trim().toUpperCase();
  if (!SUPERVISOR_ESCALATION_OUTCOME_VALUES.has(kind)) return null;
  return {
    kind,
    signatures: Array.isArray(candidate.signatures) ? candidate.signatures.map(String) : [],
    strategy: candidate.strategy ?? null,
    provider: candidate.provider ?? null,
    taskCard: candidate.taskCard ?? candidate.task_card ?? null,
    reason: candidate.reason ?? null,
    question: candidate.question ?? null,
  };
}

// Apply a deterministic Supervisor escalation outcome (branches A–E) to the
// durable state. Returns { action, reason, state } where `action` is one of:
//   RE_REVIEW           — re-review at the same head (branch A)
//   DONE                — findings closed OUT_OF_SCOPE and nothing blocks (branch B)
//   RE_REVIEW           — some findings closed, re-review for the rest (branch B)
//   ESCALATION_REPAIR   — run an escalation Executor repair (branch C / D)
//   HUMAN_REQUIRED      — genuine human decision required, or escalation budget spent (branch E)
export function applySupervisorEscalationOutcome(state, outcome, { activeReview = null } = {}) {
  const next = cloneState(state);
  const resolved = outcome ? normalizeSupervisorEscalationOutcome(outcome) : null;
  const at = next.prHead ?? null;
  const audit = (kind, reason, extra = {}) => {
    next.supervisorEscalations = [
      ...next.supervisorEscalations,
      { kind, reason, at, round: next.repairRounds, escalationRound: next.escalationRepairRounds, ...extra },
    ];
  };

  if (!resolved) {
    audit('DEFAULT', 're_review_no_supervisor_decision');
    return { action: 'RE_REVIEW', reason: 'awaiting_supervisor_decision', state: next };
  }

  switch (resolved.kind) {
    case SUPERVISOR_ESCALATION_OUTCOMES.RE_REVIEW:
      audit(resolved.kind, resolved.reason ?? 'stale_or_resolved');
      return { action: 'RE_REVIEW', reason: 'supervisor_requested_re_review', state: next };

    case SUPERVISOR_ESCALATION_OUTCOMES.OUT_OF_SCOPE: {
      const sigs = resolved.signatures.length
        ? resolved.signatures
        : [...(activeReview?.actionableSignatures ?? [])];
      next.resolvedSignatures = [...new Set([...(next.resolvedSignatures ?? []), ...sigs])];
      audit(resolved.kind, resolved.reason ?? 'out_of_scope', { signatures: sigs });
      return { action: 'RE_REVIEW', reason: 'supervisor_closed_findings_out_of_scope', state: next };
    }

    case SUPERVISOR_ESCALATION_OUTCOMES.NEW_STRATEGY:
    case SUPERVISOR_ESCALATION_OUTCOMES.STRONGER_PROVIDER: {
      if ((next.escalationRepairRounds ?? 0) >= (next.maxEscalationRepairRounds ?? DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS)) {
        audit(resolved.kind, 'escalation_repair_budget_exhausted');
        return {
          action: 'HUMAN_REQUIRED',
          reason: 'escalation_repair_budget_exhausted',
          state: next,
        };
      }
      next.escalationRepairRounds = (next.escalationRepairRounds ?? 0) + 1;
      audit(resolved.kind, resolved.reason ?? 'escalation_repair', {
        strategy: resolved.strategy,
        provider: resolved.provider,
      });
      return {
        action: 'ESCALATION_REPAIR',
        reason: resolved.kind === SUPERVISOR_ESCALATION_OUTCOMES.STRONGER_PROVIDER
          ? 'supervisor_selected_stronger_provider'
          : 'supervisor_provided_new_strategy',
        state: next,
        strategy: resolved.strategy,
        provider: resolved.provider,
        taskCard: resolved.taskCard,
      };
    }

    case SUPERVISOR_ESCALATION_OUTCOMES.HUMAN_REQUIRED:
    default:
      audit('HUMAN_REQUIRED', resolved.reason ?? 'supervisor_requires_human');
      return {
        action: 'HUMAN_REQUIRED',
        reason: resolved.reason ?? 'supervisor_requires_human_decision',
        state: next,
        question: resolved.question ?? null,
      };
  }
}
