// Automated orchestration loop — autonomous Supervisor-Executor-Reviewer development loop:
//
//   SupervisorSession   — manages Task Card generation and workflow decisions
//                         with logical continuity and failover across providers
//   ReviewerSession     — audits task execution reports and gate evidence per attempt
//   ExecutorAdapter     — executes task cards in isolated worktrees (Claude/Codex)
//   GateRunner          — executes deterministic verification commands and collects Git evidence
//
// This file sequences the multi-role development loop:
//
//   Supervisor.decide() -> NEXT_TASK
//     -> Executor.execute() -> gate.run() -> Reviewer.review()
//     -> Supervisor.decide() again, carrying the Review Result
//     -> CONTINUE_REWORK  loops back to Executor.execute() on the SAME task
//     -> NEXT_TASK / WORKFLOW_DONE / HUMAN_REQUIRED transitions the workflow
//
// Legal supervisor-decision / workflow-state pairing (enforced below by
// assertLegalTransition, independent of whatever parseSupervisorDecision
// already validated about the reply's own shape):
//
//   latest Review Result is REWORK/HUMAN_REQUIRED (a task is mid-flight)
//     -> only CONTINUE_REWORK or HUMAN_REQUIRED are legal
//   latest Review Result is PASS, or no task is active yet
//     -> only NEXT_TASK, WORKFLOW_DONE, or HUMAN_REQUIRED are legal
//
// A Supervisor reply that violates this is a protocol violation, not a
// signal to guess at the "right" action — it throws
// AdapterError(SUPERVISOR_ILLEGAL_TRANSITION) and the loop takes no action
// at all for that reply.

import { AdapterError, ADAPTER_ERROR_CODES, isCancellation } from './errors.js';
import { WORKFLOW_STAGES, WORKFLOW_STATUSES } from './workflowState.js';
import { classifyVerificationPermissionBlocked, SAFETY_EVENT_CODES, SAFETY_SEVERITY } from './safetyEvents.js';
import { defaultOrganicReworkRecorder } from './organicReworkRecorder.js';
import { nullWindowSession } from './agyProviderSessions.js';
import {
  runPreflight as defaultRunPreflight,
  buildHumanRequiredEvidence,
  FAILURE_CATEGORIES,
} from './preflight.js';
import { getValidHostEvidence, markHostEvidenceConsumed, hashCommandSet, CLOSEOUT_VERIFICATION_ID } from './hostVerification.js';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { decideDeterministically } from './deterministicSupervisorPolicy.js';
import {
  diffBaselineFailures,
  summarizeBaselineEvidence,
  BASELINE_DIFF_VERDICTS,
} from './baselineDiffGate.js';
import {
  createAcceptanceChain,
  serializeAcceptanceChain,
  deserializeAcceptanceChain,
  stampActiveAcceptance,
} from './taskCard.js';

function defaultLog(line) {
  console.log(`gpt-loop: ${line}`);
}

// A BLOCKED report whose only permission_denials are commands the current
// Task Card never approved as verification_commands: the Executor tripped its
// own security boundary running an unauthorized environment probe. This is
// never an ENVIRONMENT blocker and never consumes an implementation retry.
const EXECUTOR_UNAUTHORIZED_PROBE = 'EXECUTOR_UNAUTHORIZED_PROBE';
// Bounded so a persistently misbehaving Executor cannot loop forever.
const MAX_UNAUTHORIZED_PROBE_RETRIES = 3;

// Local deterministic warning only: it never changes the Reviewer verdict.
export function reviewerReworkNonConvergence(previous, current, evidence) {
  if (previous?.decision !== 'REWORK' || current?.decision !== 'REWORK' || evidence?.pass !== true) return false;
  const normalize = (items) => (Array.isArray(items) ? items : [items])
    .map((item) => String(item).toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean).sort().join('\n');
  return normalize(previous.required_changes) !== '' && normalize(previous.required_changes) === normalize(current.required_changes);
}

// --- Bounded rate-limit recovery ---------------------------------------
//
// Provider rate-limit throttling (surfaced as PROVIDER_RATE_LIMITED or RATE_LIMITED)
// is NOT a task failure, a review verdict, a send failure, or a gate
// failure. When it hits a Reviewer review (or a Supervisor decision), the
// ONLY correct response is to wait for the throttle to clear and re-issue
// the request — never to rerun the Executor, rerun the deterministic
// gate, bump the task attempt counter, or ask the Supervisor for a fresh decision.
// All of that surrounding state is deliberately left untouched here.
//
// Recovery is strictly bounded (maxRetries) with a conservative escalating
// cooldown; once the budget is spent the workflow stops with a resumable
// HUMAN_REQUIRED carrying a clear rate-limit reason, rather than looping.

class RateLimitStopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitStopError';
  }
}

// Duck-typed so this module stays free of external bridge dependencies —
// rate limit errors are identified by code / name / message pattern.
function isRateLimitError(err) {
  return err?.name === 'RateLimitedError' || err?.code === 'RATE_LIMITED' || err?.code === 'PROVIDER_RATE_LIMITED' || /making requests too quickly|rate.?limit/i.test(err?.message ?? '');
}

// Auto-retry when the failure stage proves the provider request was rejected pre-send.
function rateLimitedBeforeSend(err) {
  return /looking for the composer|waiting for the page to become ready|preflight/i.test(err?.message ?? '');
}

function rateLimitCooldownMs(err, retry, baseMs, jitterMs) {
  const retryAfter = Number(err?.retryAfterMs ?? err?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, baseMs * 4);
  // Conservative escalating backoff: base, 2·base, 3·base … plus 0…jitter of
  // randomness so repeated retries never resynchronize into a tight burst.
  return baseMs * (retry + 1) + Math.floor(Math.random() * (jitterMs + 1));
}

function formatReviewFeedback(reviewResult) {
  const changes = Array.isArray(reviewResult.required_changes)
    ? reviewResult.required_changes.map((change) => `- ${change}`).join('\n')
    : String(reviewResult.required_changes ?? 'none');
  return `Reviewer decision: ${reviewResult.decision}

Findings:
${reviewResult.findings ?? 'none'}

Required changes:
${changes}

Rationale:
${reviewResult.rationale ?? 'none'}`;
}

// Throws if activating a tab violated the one invariant the dedicated
// automation window exists to prove holds ("target tab active=true AND
// its window focused=false, simultaneously") — see extension/windowLifecycle.js's
// header comment for the live evidence this is built on. `label` is a
// tabId-bearing string only (e.g. "supervisor tab 501") — never prompt/reply
// content.
function assertWindowInvariant(activation, label) {
  if (activation.windowFocused !== false) {
    throw new Error(
      `Automation window unexpectedly became focused while activating ${label} (focused=${activation.windowFocused}) — refusing to continue.`
    );
  }
  if (activation.active !== true) {
    throw new Error(`${label} did not become active after activation (active=${activation.active}) — refusing to continue.`);
  }
}

function assertLegalTransition(decision, hasPendingRework) {
  if (hasPendingRework) {
    if (decision.action !== 'CONTINUE_REWORK' && decision.action !== 'HUMAN_REQUIRED') {
      throw new AdapterError(
        ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION,
        `Supervisor returned "${decision.action}" while the current task's latest Review Result was not PASS. Only CONTINUE_REWORK or HUMAN_REQUIRED are legal here — refusing to act.`
      );
    }
  } else if (decision.action === 'CONTINUE_REWORK') {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION,
      'Supervisor returned CONTINUE_REWORK with no pending rework task to continue (either no task is active yet, or the latest Review Result was PASS) — refusing to act.'
    );
  }
}

// runAutomatedWorkflow drives one workflow, start to finish, without any
// human copying a prompt between GPT and Claude by hand.
//
//   workflowId               — string, threaded into ClaudeSessionManager's
//                               persistence key and this loop's history
// runAutomatedWorkflow drives one workflow, start to finish, across the
// multi-role Planner/Supervisor/Executor/Reviewer pipeline:
//
//   workflowId               — string identifying the workflow instance
//   supervisorSession        — a SupervisorSession-shaped object:
//                               { create(), decide(context), close() }.
//                               create() is called once at the start of
//                               this function; close() is called on
//                               WORKFLOW_DONE.
//   createReviewerSession()  — returns a fresh ReviewerSession-shaped
//                               object: { create(taskId), review(taskId,
//                               taskCard, executionReport, evidence),
//                               close() }. Called once per task; the same
//                               task's rework rounds reuse the session.
//   createClaudeSessionManager({ taskId }) — returns an Executor-Adapter-
//                               shaped object: { execute(taskCard) ->
//                               execution_report }. Called once per task.
//   gateRunner               — { run(verification_commands) -> evidence },
//                               collects command execution evidence.
//   windowSession            — optional window/session lifecycle placeholder,
//                               defaults to nullWindowSession.
//   persistence              — optional Persistence-shaped object ({ writeState }).
//   workflowGoal/repositoryContext — passed through to the Supervisor via decide().
//   maxAttemptsPerTask       — bounded-retry safety guard (default 3):
//                               the maximum number of execution attempts before
//                               stopping as HUMAN_REQUIRED.
//   log                      — optional (line) => void operational logger.
//
// Returns one of:
//   { status: 'WORKFLOW_DONE', summary, history }
//   { status: 'HUMAN_REQUIRED', reason, question, history, taskId? }
export async function runAutomatedWorkflow({
  workflowId,
  supervisorSession,
  createReviewerSession,
  createClaudeSessionManager,
  gateRunner,
  windowSession = nullWindowSession,
  persistence,
  workflowGoal,
  repositoryContext,
  maxAttemptsPerTask = 3,
  maxEscalationAttempts = 2,
  humanAnswer = null,
  keepOpenOnFailure = false,
  keepOpenOnSuccess = false,
  sourceWorkspace = null,
  externalReadRoots = [],
  approvedExternalRoots = [],
  repoRoot = null,
  runPreflightFn = defaultRunPreflight,
  // Bounded rate-limit recovery knobs (see RateLimitStopError et al above).
  // maxRetries — automatic cooldown/retry attempts before a resumable stop.
  // cooldownMs / cooldownJitterMs — conservative escalating backoff base and
  // random spread. sleep — injectable for deterministic tests only.
  rateLimitRecovery = {},
  log = defaultLog,
  workflowStateManager = null,
  usageTracker = null,
  onTaskCompleted = null,
  signal = null,
  // BASELINE-DIFF GATE. When a runner is supplied, each task's
  // verification_commands are run once BEFORE the Executor's first edit (in
  // the isolated workspace, baseline fixed) and the pre-existing failing-test
  // identities are recorded. The post-Executor Gate then attributes only
  // NEW failures to the task; pre-existing repository red tests do not
  // trigger REWORK. Local deterministic commands only — zero model calls.
  // Feature is OFF when null (every existing caller/test is unaffected).
  baselineGateRunner = null,
  closeoutVerificationCommands = [],
  onCloseoutPass = null,
  taskTotal = null,
  plannedTasks = null,
  planSummary = null,
  // Deterministic loop-resume support. `checkpoint` (if given) rehydrates
  // the exact suspension point — accepted-task history, the mid-flight task
  // card, its attempt counter and latest Review Result — so a resumed run
  // never replans or re-executes an already-accepted task. `onCheckpoint` is
  // called after every state-advancing transition with the current snapshot.
  checkpoint = null,
  onCheckpoint = null,
  // P2-1: returns a deterministic fingerprint of the isolated worktree, used
  // to persist/detect post-Gate drift for a REVIEW_PENDING resume.
  computeGateFingerprint = null,
  _execSync,
}) {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('automated workflow cancelled');
  };
  const {
    maxRetries: rlMaxRetries = 2,
    cooldownMs: rlCooldownMs = 90000,
    cooldownJitterMs: rlCooldownJitterMs = 30000,
    sleep: rlSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = rateLimitRecovery;
  const history = [];
  let latestReviewResult = null;
  let latestGateEvidence = null;

  // BASELINE-DIFF GATE state. `taskBaselineEvidence` is the trimmed, persisted
  // pre-Executor verification result for `taskBaselineTaskId`. It is captured
  // exactly once per task (in the NEXT_TASK branch, before the first Executor
  // call) or rehydrated from a checkpoint — NEVER re-captured on a worktree
  // the Executor has already modified.
  const baselineDiffEnabled = Boolean(baselineGateRunner);
  let taskBaselineEvidence = null;
  let taskBaselineTaskId = null;
  let taskBaselineCommandsHash = null;
  const seenBlockers = new Map();
  let currentTaskCard = null;
  const loopReworkMemory = new Map();
  let reviewerSession = null;
  let reviewerCreated = false;
  let reviewerTabId = null;
  let claudeManager = null;
  let normalAttempts = 0;
  let escalationAttempts = 0;
  let escalationActive = false;
  let supervisorGuidance = null;
  let taskAttemptHistory = [];
  let attemptCount = 0;
  let unauthorizedProbeRetries = 0;
  let unauthorizedProbeGuidance = null;

  // Monotonic per-attempt round id. Every committed Executor attempt bumps it,
  // and every Review Result it produces (Reviewer verdict, Gate-fail REWORK, or
  // closeout-fail REWORK) is stamped with the round it belongs to. On a
  // checkpoint resume a persisted REWORK whose round no longer matches the
  // restored round — or whose task_id is not the restored mid-flight task — is
  // STALE: it came from a superseded or already-closed review round and must
  // never re-trigger rework. See the checkpoint-rehydration block below.
  let reviewRound = 0;
  let supervisorTabId = null;
  // P2-1: set when resuming from a REVIEW_PENDING checkpoint — carries the
  // persisted Executor Report + Gate evidence to feed straight into review.
  let resumeReviewPending = null;

  const persistCheckpoint = async (extra = {}) => {
    if (typeof onCheckpoint !== 'function') return;
    // Every checkpoint is a durable-writer contract: the loop must never
    // advance past a transition it could not persist, or a crash would resume
    // from a stale point and repeat (or re-include) accepted-task work. A
    // REVIEW_PENDING checkpoint additionally underpins the "no rework, no
    // re-verification" resume promise. So any persistence failure is surfaced,
    // not swallowed — onCheckpoint failures propagate out of the loop.
    await onCheckpoint({
      history: history.map((entry) => ({ ...entry })),
      currentTaskCard: currentTaskCard ?? null,
      currentTaskId: currentTaskCard?.task_id ?? null,
      attempt: normalAttempts + escalationAttempts,
      normalAttempts,
      escalationAttempts,
      escalationActive,
      supervisorGuidance: supervisorGuidance ?? null,
      reviewRound,
      humanAnswer: humanAnswer ?? null,
      latestReviewResult: latestReviewResult ?? null,
      // Default: a plain engineering checkpoint. A REVIEW_PENDING checkpoint
      // (P2-1) passes phase + the immutable Executor/Gate material via extra.
      phase: null,
      executionReport: null,
      gateEvidence: null,
      worktreeFingerprint: null,
      // BASELINE-DIFF GATE: the pre-Executor verification snapshot survives a
      // resume so the baseline is never re-taken on an already-modified tree.
      taskBaseline: (baselineDiffEnabled && taskBaselineTaskId)
        ? {
          taskId: taskBaselineTaskId,
          commandsHash: taskBaselineCommandsHash,
          evidence: taskBaselineEvidence,
        }
        : null,
      ...extra,
    });
  };

  // BASELINE-DIFF GATE: run the current task's verification_commands ONCE,
  // before the Executor has touched anything, and remember which failures
  // were already there. Local deterministic commands only — zero model calls.
  // A baseline that could not be captured leaves the feature inert for this
  // task (the original Gate FAIL behaviour stands); it is never fatal.
  async function captureTaskBaseline() {
    taskBaselineEvidence = null;
    taskBaselineTaskId = null;
    taskBaselineCommandsHash = null;
    if (!baselineDiffEnabled || !currentTaskCard) return;
    const commands = Array.isArray(currentTaskCard.verification_commands)
      ? currentTaskCard.verification_commands.map((c) => String(c))
      : [];
    if (commands.length === 0) return;
    try {
      log(`baseline verification started: task=${currentTaskCard.task_id} (pre-Executor)`);
      const raw = await baselineGateRunner.run(commands);
      throwIfAborted();
      taskBaselineEvidence = summarizeBaselineEvidence(raw);
      taskBaselineTaskId = currentTaskCard.task_id;
      taskBaselineCommandsHash = hashCommandSet(commands);
      const failing = (taskBaselineEvidence.results || []).filter((r) => !r.pass).length;
      log(
        `baseline verification completed: task=${currentTaskCard.task_id} `
        + `pass=${taskBaselineEvidence.pass} preexistingFailingCommands=${failing}`
      );
      workflowStateManager?.recordProgress({
        taskBaseline: {
          taskId: taskBaselineTaskId,
          commandsHash: taskBaselineCommandsHash,
          pass: taskBaselineEvidence.pass,
          capturedAt: new Date().toISOString(),
          evidence: taskBaselineEvidence,
        },
      });
    } catch (err) {
      if (isCancellation(err, signal)) throw err;
      log(
        `baseline verification could not run (${err.message}) — baseline-diff gate `
        + `disabled for task=${currentTaskCard?.task_id}; original Gate FAIL behaviour stands`
      );
      taskBaselineEvidence = null;
      taskBaselineTaskId = null;
      taskBaselineCommandsHash = null;
    }
  }

  if (checkpoint && typeof checkpoint === 'object') {
    if (Array.isArray(checkpoint.history)) history.push(...checkpoint.history);
    reviewRound = Number.isFinite(checkpoint.reviewRound) ? checkpoint.reviewRound : 0;
    supervisorGuidance = checkpoint.supervisorGuidance ?? null;

    // BASELINE-DIFF GATE: restore the pre-Executor baseline captured before
    // suspension. Never re-run baseline verification on resume — the worktree
    // now carries the Executor's edits and is no longer a valid baseline.
    if (baselineDiffEnabled && checkpoint.taskBaseline && checkpoint.taskBaseline.evidence) {
      taskBaselineEvidence = checkpoint.taskBaseline.evidence;
      taskBaselineTaskId = checkpoint.taskBaseline.taskId ?? null;
      taskBaselineCommandsHash = checkpoint.taskBaseline.commandsHash ?? null;
      log(`baseline verification restored from checkpoint: task=${taskBaselineTaskId}`);
    }

    // Stale-REWORK isolation. A persisted Review Result is a LIVE rework
    // trigger only when it (a) is not a terminal decision (PASS / OUT_OF_SCOPE
    // close the task) and (b) is POSITIVELY identified as belonging to the
    // restored mid-flight task AND the restored review round. Missing identity
    // is NOT treated as a match: a persisted REWORK whose round or task_id is
    // absent, from an older/superseded round, or from a different task is
    // stale and must not resume the loop into a rework attempt.
    //
    // Migration rule for legacy checkpoints: a checkpoint written before
    // lifecycle-metadata stamping carries no `reviewRound` field at all. Those
    // predate the isolation contract and have no identity to verify, so they
    // fall back to the original rule (any non-terminal persisted Review Result
    // resumes the task). Once `reviewRound` is present the checkpoint is
    // new-format and positive identification is mandatory.
    const persistedReview = checkpoint.latestReviewResult ?? null;
    const reviewIsTerminal = persistedReview?.decision === 'PASS'
      || persistedReview?.decision === 'OUT_OF_SCOPE';
    const checkpointIsLegacy = checkpoint.reviewRound === undefined
      || checkpoint.reviewRound === null;
    const restoredTaskId = checkpoint.currentTaskCard?.task_id ?? null;
    const reviewRoundIsCurrent = Number.isFinite(persistedReview?.round)
      && Number.isFinite(checkpoint.reviewRound)
      && persistedReview.round === checkpoint.reviewRound;
    const reviewTaskIsCurrent = typeof persistedReview?.task_id === 'string'
      && typeof restoredTaskId === 'string'
      && persistedReview.task_id === restoredTaskId;
    const reviewPositivelyCurrent = checkpointIsLegacy
      ? reviewTaskIsCurrent
      : (reviewRoundIsCurrent && reviewTaskIsCurrent);
    const hasLiveRework = persistedReview !== null
      && !reviewIsTerminal
      && reviewPositivelyCurrent;
    if (persistedReview && !reviewIsTerminal && !hasLiveRework) {
      log('loop checkpoint: stale REWORK ignored (not positively identified as the restored task/round) — not resumed as mid-flight');
    }

    // Only rehydrate a mid-flight task when there is a live, current-round
    // rework to continue. An accepted task is already in `history`; re-seeding
    // it as current would make the loop re-run its Executor/Reviewer.
    const isPendingReviewForCurrentTask = checkpoint.phase === 'REVIEW_PENDING'
      && checkpoint.currentTaskCard
      && (!checkpoint.currentTaskId || checkpoint.currentTaskId === checkpoint.currentTaskCard.task_id)
      && checkpoint.executionReport
      && checkpoint.gateEvidence
      && !reviewIsTerminal
      && (persistedReview === null || reviewTaskIsCurrent);

    if (isPendingReviewForCurrentTask) {
      // Executor + Gate already completed for this attempt; only the Reviewer
      // call was blocked. Restore that exact point and re-enter at review.
      currentTaskCard = checkpoint.currentTaskCard;
      normalAttempts = Number.isFinite(checkpoint.normalAttempts)
        ? checkpoint.normalAttempts
        : (Number.isFinite(checkpoint.attempt) ? checkpoint.attempt : 1);
      escalationAttempts = Number.isFinite(checkpoint.escalationAttempts)
        ? checkpoint.escalationAttempts
        : 0;
      escalationActive = Boolean(checkpoint.escalationActive);
      if (humanAnswer && (normalAttempts >= maxAttemptsPerTask || escalationActive)) {
        escalationActive = true;
      }
      attemptCount = normalAttempts + escalationAttempts;
      latestReviewResult = checkpoint.latestReviewResult ?? null;
      claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
      reviewerSession = createReviewerSession();
      reviewerCreated = false;
      resumeReviewPending = {
        executionReport: checkpoint.executionReport,
        evidence: checkpoint.gateEvidence,
        worktreeFingerprint: checkpoint.worktreeFingerprint ?? null,
      };
      log(`loop checkpoint restored: REVIEW_PENDING task=${currentTaskCard.task_id} attempt=${attemptCount} (normal=${normalAttempts}, escalation=${escalationAttempts}, escalationActive=${escalationActive}) completed=${history.length}`);
    } else if (checkpoint.currentTaskCard && hasLiveRework) {
      currentTaskCard = checkpoint.currentTaskCard;
      normalAttempts = Number.isFinite(checkpoint.normalAttempts)
        ? checkpoint.normalAttempts
        : (Number.isFinite(checkpoint.attempt) ? checkpoint.attempt : 0);
      escalationAttempts = Number.isFinite(checkpoint.escalationAttempts)
        ? checkpoint.escalationAttempts
        : 0;
      escalationActive = Boolean(checkpoint.escalationActive);
      if (humanAnswer && (normalAttempts >= maxAttemptsPerTask || escalationActive)) {
        escalationActive = true;
      }
      attemptCount = normalAttempts + escalationAttempts;
      latestReviewResult = checkpoint.latestReviewResult ?? null;
      claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
      reviewerSession = createReviewerSession();
      reviewerCreated = false;
      log(`loop checkpoint restored: task=${currentTaskCard.task_id} attempt=${attemptCount} (normal=${normalAttempts}, escalation=${escalationAttempts}, escalationActive=${escalationActive}) completed=${history.length}`);
    } else {
      log(`loop checkpoint restored: completed=${history.length} (no mid-flight task)`);
    }
  }

  throwIfAborted();
  const { windowId, initialTabId } = await windowSession.create();
  log(`automation window created: windowId=${windowId} initialTabId=${initialTabId}`);
  await logWindowTabs('after-window-create');

  // Safe metadata only (windowId/tabId/active/status/urlState/openerTabId —
  // see windowLifecycle.js's listAutomationWindowTabs doc comment); never
  // prompt/reply content, never a tab's URL/title. A no-op if this
  // windowSession doesn't implement listTabs (e.g. a fake in a test that
  // doesn't care about this diagnostic).
  async function logWindowTabs(stage) {
    if (typeof windowSession.listTabs !== 'function') return;
    const tabs = await windowSession.listTabs(windowId);
    log(`automation window tabs: ${stage}: ${JSON.stringify(tabs)}`);
  }

  async function activateSupervisorTab() {
    const activation = await windowSession.activateTab(supervisorTabId);
    assertWindowInvariant(activation, `supervisor tab ${supervisorTabId}`);
  }

  async function activateReviewerTab() {
    const activation = await windowSession.activateTab(reviewerTabId);
    assertWindowInvariant(activation, `reviewer tab ${reviewerTabId}`);
  }

  // Runs one GPT-request step (a Reviewer review, or a Supervisor decision)
  // with bounded rate-limit recovery. `run(retry)` performs the request;
  // `reactivate()` re-activates that step's tab before a retry (requirement:
  // the retry reactivates and preflights the SAME tab — the review()/decide()
  // call itself re-runs its own preflight). Nothing else is retried or
  // reset. On budget exhaustion (or a rate limit that might already have
  // been submitted) it throws RateLimitStopError, which the caller turns
  // into a resumable HUMAN_REQUIRED.
  async function runWithRateLimitRecovery({ label, subject, run, reactivate }) {
    for (let retry = 0; ; retry += 1) {
      throwIfAborted();
      try {
        return await run(retry);
      } catch (err) {
        if (!isRateLimitError(err)) throw err;

        if (!rateLimitedBeforeSend(err)) {
          log(`${label} rate limited after possible submission: ${subject} — not retried (avoiding a duplicate submission)`);
          throw new RateLimitStopError(
            `${label} for ${subject} was rate-limited by ChatGPT after the request may already have been submitted; ` +
              'it was NOT retried automatically to avoid a duplicate submission. Resume once the limit clears.'
          );
        }

        if (retry >= rlMaxRetries) {
          log(`${label} rate limited: ${subject} retry-budget-exhausted (${rlMaxRetries})`);
          throw new RateLimitStopError(
            `${label} for ${subject} stayed rate-limited by ChatGPT after ${rlMaxRetries} automatic cooldown/retry attempt(s); ` +
              'automatic recovery budget is exhausted. Resume once the limit clears.'
          );
        }

        log(`${label} rate limited: ${subject} retry=${retry + 1}`);
        log('rate-limit cooldown started');
        await rlSleep(rateLimitCooldownMs(err, retry, rlCooldownMs, rlCooldownJitterMs));
        throwIfAborted();
        log('rate-limit cooldown completed');
        if (reactivate) await reactivate();
        log(`${label} retry started`);
      }
    }
  }

  async function closeReviewer() {
    if (reviewerSession) {
      if (typeof reviewerSession.close === 'function') {
        await reviewerSession.close();
      }
      reviewerSession = null;
      reviewerCreated = false;
      reviewerTabId = null;
    }
  }

  // Resolve — and, when persistence is available, persist — the immutable
  // acceptance version chain for a freshly selected task, then stamp the
  // current active acceptance onto the card. Every consumer downstream
  // (Executor prompt, Gate verification, Reviewer payload) then reads that
  // exact active version rather than a raw, Executor-mutable criteria array.
  async function bindActiveAcceptance(card) {
    // A Supervisor-issued Task Card is not structurally required to carry
    // acceptance_criteria (the older NEXT_TASK contract omits it entirely).
    // Only build and stamp an immutable acceptance version chain when the
    // card actually declares non-empty criteria; otherwise pass it through
    // untouched so verification still runs off verification_commands.
    const declaredCriteria = Array.isArray(card.acceptance_criteria)
      ? card.acceptance_criteria.filter((item) => String(item).trim().length > 0)
      : [];
    if (declaredCriteria.length === 0) {
      return card;
    }
    let chain = null;
    const hasStore = persistence && typeof persistence.writeAcceptanceChain === 'function';
    if (hasStore) {
      try {
        const stored = await persistence.readAcceptanceChain(workflowId, card.task_id);
        if (stored) chain = deserializeAcceptanceChain(stored);
      } catch {
        /* unreadable stored chain — fall back to a fresh version-1 chain */
      }
    }
    if (!chain) {
      chain = createAcceptanceChain(card.acceptance_criteria);
      if (hasStore) {
        try {
          await persistence.writeAcceptanceChain(workflowId, serializeAcceptanceChain(chain), card.task_id);
        } catch {
          /* non-fatal: the in-memory chain still stamps the card for this run */
        }
      }
    }
    return stampActiveAcceptance(card, chain);
  }

  // Runs exactly one Claude execute() -> gate.run() -> (lazy Reviewer
  // create) -> Reviewer.review() round for currentTaskCard. Returns
  // { done: false } to let the outer loop go back to the Supervisor with
  // the fresh Review Result, or { done: true, result } if the
  // maxAttemptsPerTask guard tripped or an environment blocker occurred.
  async function runAttempt() {
    throwIfAborted();

    // 1. DETERMINISTIC PREFLIGHT CHECK (Zero model tokens)
    log(`preflight started: task=${currentTaskCard.task_id}`);
    workflowStateManager?.startStage(WORKFLOW_STAGES.PREFLIGHT, {
      taskId: currentTaskCard.task_id,
      taskName: currentTaskCard.goal,
      attempt: attemptCount + 1,
    });

    const effectiveRepoRoot = repoRoot || (repositoryContext?.repo_root ?? process.cwd());
    const preflight = await runPreflightFn({
      taskCard: currentTaskCard,
      cwd: effectiveRepoRoot,
      sourceWorkspace,
      externalReadRoots,
      approvedExternalRoots,
      env: process.env,
    });

    if (preflight.status === 'BLOCKED') {
      log(`preflight blocked: task=${currentTaskCard.task_id} blockers=${JSON.stringify(preflight.blockers)}`);
      const primary = preflight.blockers[0] || { detail: 'Preflight check failed' };
      const fingerprint = primary.fingerprint || 'PREFLIGHT_BLOCKED';
      seenBlockers.set(fingerprint, (seenBlockers.get(fingerprint) || 0) + 1);

      const evidence = buildHumanRequiredEvidence({
        workflowId,
        taskCard: currentTaskCard,
        attempt: attemptCount || 1,
        stage: WORKFLOW_STAGES.PREFLIGHT,
        blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
        rootCause: primary.detail,
        preflightResult: preflight,
        blockerFingerprint: fingerprint,
        blockerCount: seenBlockers.get(fingerprint),
        filesInvolved: preflight.blockers.map((b) => b.resource).filter(Boolean),
        recommendedAction: primary.remediation,
        history,
      });

      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason: primary.detail,
          question: `Preflight capability check blocked execution of task "${currentTaskCard.task_id}": ${primary.detail}. Remediate the environment issue before resuming.`,
          taskId: currentTaskCard.task_id,
          evidence,
          blockers: preflight.blockers,
          blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
          history,
        },
      };
    }

    log(`preflight passed: task=${currentTaskCard.task_id}`);
    if (preflight.snapshots?.length > 0) {
      currentTaskCard.auxiliary_snapshots = preflight.snapshots;
    }

    if (maxAttemptsPerTask <= 0) {
      const maxAttemptEvidence = buildHumanRequiredEvidence({
        workflowId,
        taskCard: currentTaskCard,
        attempt: 0,
        stage: WORKFLOW_STAGES.PREFLIGHT,
        blockerCategory: FAILURE_CATEGORIES.IMPLEMENTATION,
        rootCause: `Task "${currentTaskCard.task_id}" reached maxAttemptsPerTask (${maxAttemptsPerTask}) without a PASS.`,
        latestGateResult: latestGateEvidence ?? null,
        latestReviewerDecision: latestReviewResult?.decision ?? null,
        latestReviewerRequiredChanges: latestReviewResult?.required_changes ?? null,
        history,
      });
      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason: `Task "${currentTaskCard.task_id}" reached maxAttemptsPerTask (${maxAttemptsPerTask}) without a PASS.`,
          question: `Task "${currentTaskCard.task_id}" reached maximum rework attempts (${maxAttemptsPerTask}). Latest Reviewer required changes: ${JSON.stringify(latestReviewResult?.required_changes || [])}. How should this be handled?`,
          taskId: currentTaskCard.task_id,
          evidence: maxAttemptEvidence,
          blockerCategory: FAILURE_CATEGORIES.IMPLEMENTATION,
          history,
        },
      };
    }

    if (!escalationActive) {
      if (normalAttempts >= maxAttemptsPerTask) {
        escalationActive = true;
        escalationAttempts += 1;
        attemptCount = normalAttempts + escalationAttempts;
      } else {
        normalAttempts += 1;
        attemptCount = normalAttempts;
      }
    } else {

      if (escalationAttempts >= maxEscalationAttempts) {
        const maxEscalationEvidence = buildHumanRequiredEvidence({
          workflowId,
          taskCard: currentTaskCard,
          attempt: normalAttempts + escalationAttempts,
          stage: WORKFLOW_STAGES.REVIEWER,
          blockerCategory: FAILURE_CATEGORIES.IMPLEMENTATION,
          rootCause: `Task "${currentTaskCard.task_id}" exhausted escalation attempts (${maxEscalationAttempts}) without a PASS.`,
          latestGateResult: latestGateEvidence ?? null,
          latestReviewerDecision: latestReviewResult?.decision ?? null,
          latestReviewerRequiredChanges: latestReviewResult?.required_changes ?? null,
          history,
        });
        return {
          done: true,
          result: {
            status: 'HUMAN_REQUIRED',
            reason: `Task "${currentTaskCard.task_id}" exhausted escalation attempts (${maxEscalationAttempts}) without a PASS.`,
            question: `Task "${currentTaskCard.task_id}" exhausted maximum escalation attempts (${maxEscalationAttempts}). Latest Reviewer required changes: ${JSON.stringify(latestReviewResult?.required_changes || [])}. How should this be handled?`,
            taskId: currentTaskCard.task_id,
            evidence: maxEscalationEvidence,
            blockerCategory: FAILURE_CATEGORIES.IMPLEMENTATION,
            history,
          },
        };
      }
      escalationAttempts += 1;
      attemptCount = normalAttempts + escalationAttempts;
    }

    // A committed attempt opens a fresh review round; any Review Result this
    // attempt produces is stamped with it for stale-REWORK isolation on resume.
    reviewRound += 1;
    log(`claude attempt started: task=${currentTaskCard.task_id} attempt=${attemptCount} round=${reviewRound} (normal=${normalAttempts}, escalation=${escalationAttempts})`);
    workflowStateManager?.startStage(WORKFLOW_STAGES.EXECUTOR, {
      taskId: currentTaskCard.task_id,
      taskName: currentTaskCard.goal,
      attempt: attemptCount,
    });
    // A fresh Executor deliberately has no conversational memory. Carry the
    // last Reviewer verdict in the task payload so a CONTINUE_REWORK can
    // actually correct the defect it identified instead of repeating the
    // original attempt verbatim. Also expose read-only auxiliary snapshots.
    const executorTaskCard = {
      ...currentTaskCard,
      ...(currentTaskCard.auxiliary_snapshots ? { auxiliary_snapshots: currentTaskCard.auxiliary_snapshots } : {}),
      ...(latestReviewResult?.decision === 'REWORK'
        ? {
            rework_feedback: {
              findings: latestReviewResult.findings ?? [],
              required_changes: latestReviewResult.required_changes ?? [],
              rationale: latestReviewResult.rationale ?? null,
            },
          }
        : {}),
      ...(supervisorGuidance ? { supervisor_guidance: supervisorGuidance, repair_guidance: supervisorGuidance } : {}),
      ...(unauthorizedProbeGuidance ? { unauthorized_probe_guidance: unauthorizedProbeGuidance } : {}),
    };
    // One-shot: the guidance is baked into this attempt's payload; a later
    // clean attempt must not keep re-sending it.
    unauthorizedProbeGuidance = null;

    let executionReport;
    try {
      executionReport = await claudeManager.execute(executorTaskCard, { signal, attempt: attemptCount, physicalCallReason: 'PRIMARY' });
    } catch (err) {
      if (isCancellation(err, signal)) throw err;
      // A post-send budget / duplicate-call failure still consumed a real
      // provider call. Record its usage before surfacing the blocker so the
      // dashboard never shows executor.calls = 0 for a call that happened.
      if (usageTracker && err?.details?.usage) {
        try {
          usageTracker.record({
            workflowId,
            role: 'executor',
            callId: err.details.callId ?? err.details.usage?.callId ?? null,
            physicalCallReason: err.details.physicalCallReason ?? 'PRIMARY',
            taskId: err.details.taskId ?? currentTaskCard.task_id,
            attempt: err.details.attempt ?? attemptCount,
            provider: 'claude',
            model: err.details.model || 'sonnet',
            usage: err.details.usage,
            costUsd: err.details.costUsd ?? null,
            providerMetadata: err.details.budgetExceededReason
              ? { budgetExceededReason: err.details.budgetExceededReason, numTurns: err.details.numTurns ?? null }
              : null,
          });
          if (workflowStateManager) {
            workflowStateManager.setTokenUsage(
              usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout })
            );
          }
        } catch (recordErr) {
          log(`executor budget-failure usage recording failed: ${recordErr.message}`);
        }
      }
      // User-visible safety event: a token/duplicate guard tripped and the
      // workflow cannot safely continue (it ends HUMAN_REQUIRED below). This
      // MUST reach the terminal result, not just the log.
      if (workflowStateManager
        && (err?.code === ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED
          || err?.code === ADAPTER_ERROR_CODES.EXECUTOR_DUPLICATE_CALL_REJECTED)) {
        try {
          workflowStateManager.recordSafetyEvent({
            code: err.code,
            severity: 'BLOCKING',
            role: 'executor',
            taskId: err?.details?.taskId ?? currentTaskCard.task_id,
            attempt: err?.details?.attempt ?? attemptCount,
            reason: err?.details?.budgetExceededReason ?? err.message,
            actionTaken: 'workflow halted — HUMAN_REQUIRED; no further executor call made',
          });
        } catch (seErr) {
          log(`safety event record failed: ${seErr.message}`);
        }
      }
      log(`executor infrastructure failure: task=${currentTaskCard.task_id} attempt=${attemptCount} error=${err.message}`);
      const failureCategory = FAILURE_CATEGORIES.INFRASTRUCTURE;
      const reason = `Executor failed: ${err.message}`;
      const humanEvidence = buildHumanRequiredEvidence({
        workflowId,
        taskCard: currentTaskCard,
        attempt: attemptCount,
        stage: WORKFLOW_STAGES.EXECUTOR,
        blockerCategory: failureCategory,
        rootCause: reason,
        stderrTail: err?.details?.stderr || err.message,
        history,
      });
      if (workflowStateManager) {
        workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
          reason,
          question: `All executor provider candidates failed or timed out (${err.message}). Check model providers, network, and CLI configuration, then resume.`,
          evidence: humanEvidence,
          blockerCategory: failureCategory,
        });
      }
      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason,
          question: `All executor provider candidates failed or timed out (${err.message}). Check model providers, network, and CLI configuration, then resume.`,
          taskId: currentTaskCard.task_id,
          evidence: humanEvidence,
          blockerCategory: failureCategory,
          history,
        },
      };
    }
    throwIfAborted();
    log(`claude attempt completed: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
    if (usageTracker) {
      usageTracker.record({
        workflowId,
        role: 'executor',
        callId: executionReport?.callId ?? executionReport?.usage?.callId,
        physicalCallReason: executionReport?.physicalCallReason ?? 'PRIMARY',
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        provider: executionReport?.provider ?? (executionReport?.model?.startsWith('claude') ? 'claude' : (executionReport?.model?.startsWith('codex') ? 'codex' : 'claude')),
        model: executionReport?.model || 'sonnet',
        usage: executionReport?.usage ?? null,
        inputBreakdown: executionReport?.inputBreakdown ?? null,
        costUsd: executionReport?.costUsd ?? null,
      });
    }
    if (workflowStateManager) {
      if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      if (executionReport?.model) {
        workflowStateManager.setRouting({
          model: executionReport.model,
          escalated: executionReport.modelEscalated,
          escalationReason: executionReport.escalationReason,
        });
      }
    }

    if (executionReport?.status === 'BLOCKED') {
      // Deterministic, whole-string verbatim reconciliation of the Executor's
      // permission_denials against THIS Task Card's approved
      // verification_commands.
      // EXACT string equality is enforced: do NOT use .trim() or normalization,
      // so non-identical or whitespace-altered commands are recognized as probes.
      const denials = Array.isArray(executionReport.permissionDenials)
        ? executionReport.permissionDenials
        : [];
      const deniedCommands = denials
        .map((d) => (d && d.tool_input && typeof d.tool_input.command === 'string'
          ? d.tool_input.command
          : null))
        .filter((c) => c !== null);
      if (deniedCommands.length > 0) {
        const approvedCommands = new Set(
          (currentTaskCard.verification_commands ?? []).map((c) => String(c))
        );
        // Exact verbatim match only — no prefix, substring, glob, or trim expansion.
        const deniedApproved = deniedCommands.filter((c) => approvedCommands.has(c));
        const deniedProbes = deniedCommands.filter((c) => !approvedCommands.has(c));

        // The adapter flags `verificationBlocked` when the same command was
        // denied >= 2 times in one invocation (turn burn). Project it as a
        // user-visible safety event: WARNING when another approved
        // verification path is still open, BLOCKING when every approved
        // verification command is denied.
        if (workflowStateManager && executionReport.verificationBlocked) {
          const { severity, hasAltPath, remainingApprovedCommands } = classifyVerificationPermissionBlocked({
            approvedCommands: [...approvedCommands],
            deniedCommands,
          });
          try {
            workflowStateManager.recordSafetyEvent({
              code: 'VERIFICATION_PERMISSION_BLOCKED',
              severity,
              role: 'executor',
              taskId: currentTaskCard.task_id,
              attempt: attemptCount,
              repeatCount: executionReport.verificationBlocked.repeatCount ?? null,
              reason: `verification command repeatedly permission-denied: ${executionReport.verificationBlocked.command ?? '(unknown)'}`,
              actionTaken: hasAltPath
                ? `other approved verification path still available (${remainingApprovedCommands.length}); workflow continues`
                : 'no approved verification path remains; workflow halts for human input',
            });
          } catch (seErr) {
            log(`safety event record failed: ${seErr.message}`);
          }
        }

        if (deniedApproved.length === 0 && deniedProbes.length > 0) {
          unauthorizedProbeRetries += 1;
          log(
            `executor unauthorized probe denied (not an approved verification command): ` +
              `task=${currentTaskCard.task_id} attempt=${attemptCount} ` +
              `commands=${JSON.stringify(deniedProbes)} retry=${unauthorizedProbeRetries}/${MAX_UNAUTHORIZED_PROBE_RETRIES}`
          );
          if (unauthorizedProbeRetries > MAX_UNAUTHORIZED_PROBE_RETRIES) {
            log(`executor exceeded maximum unauthorized probe retries (${MAX_UNAUTHORIZED_PROBE_RETRIES}): task=${currentTaskCard.task_id}`);
            const failureCategory = FAILURE_CATEGORIES.IMPLEMENTATION;
            const reason = `Executor exceeded maximum unauthorized probe retries (${MAX_UNAUTHORIZED_PROBE_RETRIES}) for unapproved commands: ${JSON.stringify(deniedProbes)}.`;
            const humanEvidence = buildHumanRequiredEvidence({
              workflowId,
              taskCard: currentTaskCard,
              attempt: attemptCount,
              stage: WORKFLOW_STAGES.EXECUTOR,
              blockerCategory: failureCategory,
              rootCause: reason,
              stderrTail: executionReport?.stderr || reason,
              history,
            });
            if (workflowStateManager) {
              workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
                reason,
                question: `Executor repeatedly attempted unauthorized probe commands (${JSON.stringify(deniedProbes)}) instead of executing approved verification commands. How should this be handled?`,
                evidence: humanEvidence,
                blockerCategory: failureCategory,
              });
            }
            return {
              done: true,
              result: {
                status: 'HUMAN_REQUIRED',
                reason,
                question: `Executor repeatedly attempted unauthorized probe commands (${JSON.stringify(deniedProbes)}) instead of executing approved verification commands. How should this be handled?`,
                taskId: currentTaskCard.task_id,
                evidence: humanEvidence,
                blockerCategory: failureCategory,
                history,
              },
            };
          }
          // Does NOT consume an implementation retry.
          if (escalationActive) {
            escalationAttempts = Math.max(0, escalationAttempts - 1);
          } else {
            normalAttempts = Math.max(0, normalAttempts - 1);
          }
          attemptCount = normalAttempts + escalationAttempts;
          unauthorizedProbeGuidance = {
            denied_commands: [...deniedProbes],
            approved_verification_commands: [...approvedCommands],
            message:
              'Run ONLY the exact, verbatim approved verification_commands. Do NOT add 2>&1, pipes, echo, git log, or other auxiliary probe commands.',
          };
          workflowStateManager?.recordProgress?.();
          return await runAttempt();
        }
        // else: at least one denied command IS an approved verification
        // command — fall through to the ENVIRONMENT classification below.
      }

      const issues = Array.isArray(executionReport.issues) ? executionReport.issues.join(' ') : String(executionReport.issues || '');
      const nextRec = String(executionReport.next_recommendation || '');
      const combined = `${issues} ${nextRec}`.toLowerCase();

      // Check for nested-route / internal MCP launcher tool confusion:
      // If the Executor refuses execution because of supergpt_route / supergpt_start / supergpt MCP tools,
      // this is an internal protocol violation, NOT a host environment blocker.
      // Must NOT transition to HUMAN_REQUIRED. Instead, feed back anti-nested-routing guidance and retry.
      const isNestedRouteError = /supergpt_route|supergpt_start|supergpt_plan|supergpt mcp/i.test(combined);
      if (isNestedRouteError) {
        log(`executor internal protocol error (nested route attempt): task=${currentTaskCard.task_id} attempt=${attemptCount}`);
        unauthorizedProbeRetries += 1;
        if (unauthorizedProbeRetries > MAX_UNAUTHORIZED_PROBE_RETRIES) {
          log(`executor exceeded maximum nested routing retries (${MAX_UNAUTHORIZED_PROBE_RETRIES}): task=${currentTaskCard.task_id}`);
          const failureCategory = FAILURE_CATEGORIES.IMPLEMENTATION;
          const reason = `Executor repeatedly confused internal role with front-agent launcher.`;
          const humanEvidence = buildHumanRequiredEvidence({
            workflowId,
            taskCard: currentTaskCard,
            attempt: attemptCount,
            stage: WORKFLOW_STAGES.EXECUTOR,
            blockerCategory: failureCategory,
            rootCause: reason,
            stderrTail: reason,
            history,
          });
          if (workflowStateManager) {
            workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
              reason,
              question: `Executor repeatedly confused internal role with front-agent launcher. How should this be handled?`,
              evidence: humanEvidence,
              blockerCategory: failureCategory,
            });
          }
          return {
            done: true,
            result: {
              status: 'HUMAN_REQUIRED',
              reason,
              question: `Executor repeatedly confused internal role with front-agent launcher. How should this be handled?`,
              taskId: currentTaskCard.task_id,
              evidence: humanEvidence,
              blockerCategory: failureCategory,
              history,
            },
          };
        }
        if (escalationActive) {
          escalationAttempts = Math.max(0, escalationAttempts - 1);
        } else {
          normalAttempts = Math.max(0, normalAttempts - 1);
        }
        attemptCount = normalAttempts + escalationAttempts;
        unauthorizedProbeGuidance = {
          denied_commands: [],
          approved_verification_commands: [...(currentTaskCard.verification_commands ?? [])],
          message:
            'You are the internal Executor in an active SuperGPT workflow. Do NOT call supergpt_route, supergpt_start, or any supergpt launcher tools. Focus 100% on editing allowed_files and running the approved verification_commands.',
        };
        workflowStateManager?.recordProgress?.();
        return await runAttempt();
      }

      const isEnvOrPerm = /permission|tool|install|configure|command not found|unavailable|path|node|npm|git|dependency/i.test(combined);

      if (isEnvOrPerm) {
        log(`executor BLOCKED by environment requirement: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
        if (escalationActive) {
          escalationAttempts = Math.max(0, escalationAttempts - 1);
        } else {
          normalAttempts = Math.max(0, normalAttempts - 1);
        }
        attemptCount = normalAttempts + escalationAttempts;
        const blockerCategory = FAILURE_CATEGORIES.ENVIRONMENT;
        const reason = `Executor blocked: ${executionReport.issues?.[0] || executionReport.next_recommendation || 'Environment/tool requirement'}`;
        const humanEvidence = buildHumanRequiredEvidence({
          workflowId,
          taskCard: currentTaskCard,
          attempt: attemptCount,
          stage: WORKFLOW_STAGES.EXECUTOR,
          blockerCategory,
          rootCause: reason,
          stderrTail: issues,
          history,
        });
        if (workflowStateManager) {
          workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
            reason,
            question: `Executor is blocked by an environment requirement: ${reason}. Resolve the requirement on host, then resume.`,
            evidence: humanEvidence,
            blockerCategory,
          });
        }
        return {
          done: true,
          result: {
            status: 'HUMAN_REQUIRED',
            reason,
            question: `Executor is blocked by an environment requirement: ${reason}. Resolve the requirement on host, then resume.`,
            taskId: currentTaskCard.task_id,
            evidence: humanEvidence,
            blockerCategory,
            history,
          },
        };
      }
    }

    log(`gate started: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
    workflowStateManager?.startStage(WORKFLOW_STAGES.GATE);

    // Consume trusted host Gate evidence if available and valid
    let evidence;
    const evidenceRoot = workflowStateManager?.root || SUPERGPT_WORKTREE_ROOT;
    const hostEvidenceCheck = getValidHostEvidence({
      workflowId,
      taskId: currentTaskCard.task_id,
      verificationCommands: currentTaskCard.verification_commands,
      root: evidenceRoot,
    });
    if (hostEvidenceCheck?.valid && hostEvidenceCheck.hostEvidence?.pass) {
      log(`gate: consuming valid trusted host verification evidence (id=${hostEvidenceCheck.hostEvidence.evidenceId})`);
      markHostEvidenceConsumed({
        workflowId,
        evidenceId: hostEvidenceCheck.hostEvidence.evidenceId,
        root: evidenceRoot,
      });
      evidence = hostEvidenceCheck.hostEvidence.evidence || {
        pass: true,
        results: hostEvidenceCheck.hostEvidence.results,
        changed_files: [],
        git_diff: '',
      };
    } else {
      evidence = await gateRunner.run(currentTaskCard.verification_commands);
    }
    latestGateEvidence = evidence;
    throwIfAborted();
    log(`gate completed: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
    if (workflowStateManager) {
      workflowStateManager.state.stageStatuses.gate = evidence.pass ? 'PASS' : 'FAIL';
      workflowStateManager.recordProgress();
    }

    // Check if Gate failed due to an environment/toolchain issue
    const envFailure = (evidence.results || []).find(
      (r) => !r.pass && (
        r.output?.includes('command not found') ||
        r.output?.includes('exit code 127') ||
        r.output?.includes('COMMAND_TIMEOUT') ||
        /ENOENT|EACCES|No such file or directory/i.test(r.output || '')
      )
    );

    if (envFailure) {
      const cmdName = envFailure.command.trim().split(/\s+/)[0];
      const fingerprint = `GATE_ENV:${cmdName}`;
      seenBlockers.set(fingerprint, (seenBlockers.get(fingerprint) || 0) + 1);

      const gateEnvEvidence = buildHumanRequiredEvidence({
        workflowId,
        taskCard: currentTaskCard,
        attempt: attemptCount,
        stage: WORKFLOW_STAGES.GATE,
        blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
        rootCause: `Gate verification command failed to execute: ${envFailure.command} (${envFailure.output})`,
        failingGateCommand: envFailure.command,
        exitCode: 127,
        stderrTail: envFailure.output,
        latestGateResult: evidence,
        blockerFingerprint: fingerprint,
        blockerCount: seenBlockers.get(fingerprint),
        recommendedAction: `Ensure command '${cmdName}' is installed and executable in the environment.`,
        history,
      });

      const pendingVerification = {
        task_id: currentTaskCard.task_id,
        commands: [...currentTaskCard.verification_commands],
        commands_hash: hashCommandSet(currentTaskCard.verification_commands),
        reason: envFailure.output || envFailure.command,
        generation: attemptCount,
      };

      if (workflowStateManager) {
        workflowStateManager.state.pending_verification = pendingVerification;
        workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
          reason: `Gate command execution failed: ${envFailure.command} (${envFailure.output})`,
          question: `Gate verification command failed due to an environment blocker: ${envFailure.output}. Fix the environment requirement, then resume.`,
          pending_verification: pendingVerification,
        });
      }

      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason: `Gate command execution failed: ${envFailure.command} (${envFailure.output})`,
          question: `Gate verification command failed due to an environment blocker: ${envFailure.output}. Fix the environment requirement, then resume.`,
          taskId: currentTaskCard.task_id,
          evidence: gateEnvEvidence,
          blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
          pending_verification: pendingVerification,
          history,
        },
      };
    }

    // BASELINE-DIFF GATE. Compare this attempt's failing-test identities
    // against the pre-Executor baseline for this task. Pre-existing repository
    // red tests are NOT this task's responsibility and must not drive REWORK.
    const baselineDiff = (
      baselineDiffEnabled
      && taskBaselineTaskId === currentTaskCard.task_id
    )
      ? diffBaselineFailures(taskBaselineEvidence, evidence)
      : null;
    if (baselineDiff) {
      evidence.baselineDiff = baselineDiff;
      log(
        `baseline-diff gate: task=${currentTaskCard.task_id} attempt=${attemptCount} verdict=${baselineDiff.verdict} `
        + `baseline=${baselineDiff.baselineFailures.length} current=${baselineDiff.currentFailures.length} `
        + `new=${baselineDiff.newFailures.length} ignored=${baselineDiff.ignoredBaselineFailures.length}`
      );
    }

    // PASS_WITH_BASELINE_FAILURES: the Gate found failures, but every one was
    // already failing before this task ran. Treat as PASS for this task —
    // route to the Reviewer, not to REWORK — while keeping the pre-existing
    // repository failures visible as a WARNING and in the Gate evidence.
    if (baselineDiff && baselineDiff.verdict === BASELINE_DIFF_VERDICTS.PASS_WITH_BASELINE_FAILURES) {
      log(
        `gate PASS (baseline-diff): task=${currentTaskCard.task_id} attempt=${attemptCount} — `
        + `${baselineDiff.ignoredBaselineFailures.length} pre-existing verification failure(s) ignored, `
        + `0 introduced by this task`
      );
      if (workflowStateManager) {
        try {
          workflowStateManager.recordSafetyEvent({
            code: SAFETY_EVENT_CODES.PREEXISTING_VERIFICATION_FAILURES,
            severity: SAFETY_SEVERITY.WARNING,
            role: 'gate',
            taskId: currentTaskCard.task_id,
            attempt: attemptCount,
            reason:
              `${baselineDiff.ignoredBaselineFailures.length} verification failure(s) were already failing `
              + `before task "${currentTaskCard.task_id}" ran and were not introduced by it: `
              + `${baselineDiff.ignoredBaselineFailures.slice(0, 10).join('; ')}`,
            actionTaken:
              'task PASSed on baseline-diff (introduced no new failure); pre-existing repository failures left intact',
          });
        } catch (seErr) {
          log(`preexisting-verification-failures safety event record failed: ${seErr.message}`);
        }
      }
      return runReviewStep({
        executionReport,
        evidence: { ...evidence, pass: true, baselineDiff },
      });
    }

    // STATE_MACHINE.md §2: VERIFYING FAIL -> REWORK (never REVIEWING).
    // A non-environment Gate failure routes deterministically back to a fresh
    // Executor attempt and consumes ZERO Reviewer calls — a Reviewer PASS
    // must never be able to override a Gate FAIL. The failing Gate results
    // are carried forward as actionable Executor rework feedback.
    if (evidence.pass !== true) {
      const failingResults = (evidence.results || []).filter((r) => !r.pass);
      // NEW_FAILURES: only the failures this task actually introduced are its
      // responsibility. Everything else keeps the original per-command shape.
      const attributeToNewFailures = baselineDiff
        && baselineDiff.verdict === BASELINE_DIFF_VERDICTS.NEW_FAILURES
        && baselineDiff.newFailures.length > 0;
      const failureSummary =
        (attributeToNewFailures
          ? `new failures introduced by this task: ${baselineDiff.newFailures.join('; ')}`
          : failingResults.map((r) => `${r.command}: ${r.output || 'failed'}`).join('; ')) ||
        'Gate verification did not pass';
      log(
        `gate FAIL (non-environment): routing task=${currentTaskCard.task_id} attempt=${attemptCount} ` +
          `to REWORK without invoking the Reviewer` +
          (attributeToNewFailures ? ` (baseline-diff: ${baselineDiff.newFailures.length} new failure(s))` : '')
      );

      latestReviewResult = {
        task_id: currentTaskCard.task_id,
        decision: 'REWORK',
        findings: attributeToNewFailures
          ? baselineDiff.newFailures.map((id) => `New verification failure introduced by this task: ${id}`)
          : failingResults.map((r) => `Gate command failed: ${r.command}`),
        required_changes: attributeToNewFailures
          ? baselineDiff.newFailures.map((id) => `Fix newly failing test/assertion introduced by this task: ${id}`)
          : failingResults.map((r) => `Fix failing verification command: ${r.command}`),
        rationale: `Gate verification failed on this attempt: ${failureSummary}`,
        source: 'GATE',
        round: reviewRound,
        ...(baselineDiff ? { baselineDiff } : {}),
      };

      if (workflowStateManager) {
        workflowStateManager.state.stageStatuses.reviewer = 'REWORK';
        workflowStateManager.setDecision('REWORK');
        workflowStateManager.recordTaskAttempt({
          taskId: currentTaskCard.task_id,
          attempt: attemptCount,
          executorCallId: executionReport?.callId ?? executionReport?.usage?.callId ?? null,
          gateResult: 'FAIL',
          reviewerDecision: 'REWORK',
          requiredChanges: latestReviewResult.required_changes,
          reviewerCallId: null,
        });
        workflowStateManager.recordProgress();
      }

      try {
        defaultOrganicReworkRecorder.observeAttempt({
          workflowId,
          taskId: currentTaskCard.task_id,
          attempt: attemptCount,
          executorCallId: executionReport?.callId ?? executionReport?.usage?.callId ?? null,
          executorModel: executionReport?.model ?? null,
          gateResult: 'FAIL',
          reviewerDecision: 'REWORK',
          reviewerCallId: null,
          reviewerModel: null,
          requiredChanges: latestReviewResult.required_changes,
          evidence,
          round: reviewRound,
          nonConvergence: false,
        });
      } catch {
        /* non-blocking passive observation */
      }

      if (persistence) {
        await persistence.writeState({
          workflow_id: workflowId,
          task_id: currentTaskCard.task_id,
          last_error: `Gate verification failed: ${failureSummary}`,
        });
      }

      taskAttemptHistory.push({
        attempt: attemptCount,
        gateResult: 'FAIL',
        reviewerDecision: 'REWORK',
        findings: latestReviewResult.findings,
        executionReport: executionReport ?? null,
      });

      await persistCheckpoint();
      return { done: false };

    }

    return runReviewStep({ executionReport, evidence });
  }

  // The Reviewer half of an attempt, split out so a resume can re-enter it
  // directly from a persisted REVIEW_PENDING checkpoint — WITHOUT re-running
  // the Executor or the Gate (P2-1).
  async function runReviewStep({ executionReport, evidence }) {
    latestGateEvidence = evidence;

    if (!reviewerCreated) {
      const reviewerIdentity = await reviewerSession.create(currentTaskCard.task_id, { windowId });
      reviewerTabId = reviewerIdentity?.tabId ?? null;
      reviewerCreated = true;
      log(`reviewer created: task=${currentTaskCard.task_id}`);
      await logWindowTabs('after-reviewer-create');
    }

    await activateReviewerTab();
    log(`review started: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
    workflowStateManager?.startStage(WORKFLOW_STAGES.REVIEWER);
    let reviewResult;
    try {
      reviewResult = await runWithRateLimitRecovery({
        label: 'review',
        subject: `task=${currentTaskCard.task_id} attempt=${attemptCount}`,
        run: (retry) =>
          reviewerSession.review(currentTaskCard.task_id, currentTaskCard, executionReport, evidence, {
            reuseAttempt: retry > 0,
          }),
        reactivate: activateReviewerTab,
      });
    } catch (err) {
      if (err instanceof RateLimitStopError) {
        // A rate limit is not a task/review failure: the current task,
        // attempt number, Execution Report/Evidence, this ReviewerSession
        // and conversation, and the Supervisor session are all left intact.
        // HUMAN_REQUIRED closes nothing (see its branch below), so the run
        // is fully resumable once ChatGPT's limit clears.
        //
        // P2-1: persist the completed Executor + Gate evidence and a
        // REVIEW_PENDING resume phase BEFORE returning, so a resumed process
        // restarts exactly at the Reviewer with this immutable material and
        // never re-runs the Executor or the Gate. A worktree fingerprint is
        // stored so a resume can detect post-Gate drift and re-verify.
        await persistCheckpoint({
          phase: 'REVIEW_PENDING',
          executionReport,
          gateEvidence: evidence,
          worktreeFingerprint: (typeof computeGateFingerprint === 'function' ? computeGateFingerprint() : null) ?? null,
        });
        return {
          done: true,
          result: {
            status: 'HUMAN_REQUIRED',
            reason: err.message,
            question:
              'ChatGPT rate-limiting is blocking the Reviewer for this task. Wait for the limit to clear, then resume this workflow — no rework or re-verification is needed.',
            taskId: currentTaskCard.task_id,
            history,
          },
        };
      }
      throw err;
    }
    log(`review completed: task=${currentTaskCard.task_id} attempt=${attemptCount} decision=${reviewResult.decision}`);
    if (usageTracker) {
      usageTracker.record({
        workflowId,
        role: 'internalReviewer',
        callId: reviewResult?.callId ?? reviewResult?.usage?.callId,
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        provider: reviewResult?.provider,
        model: reviewResult?.model,
        usage: reviewResult?.usage ?? null,
        durationMs: reviewResult?.durationMs,
      });
    }
    if (workflowStateManager) {
      if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      workflowStateManager.state.stageStatuses.reviewer = reviewResult.decision;
      workflowStateManager.setDecision(reviewResult.decision);
      workflowStateManager.recordTaskAttempt({
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        executorCallId: executionReport?.callId ?? executionReport?.usage?.callId ?? null,
        gateResult: evidence?.pass ? 'PASS' : 'FAIL',
        reviewerDecision: reviewResult.decision,
        requiredChanges: Array.isArray(reviewResult.required_changes) ? reviewResult.required_changes : reviewResult.required_changes ? [reviewResult.required_changes] : [],
        reviewerCallId: reviewResult.callId ?? reviewResult.usage?.callId ?? null,
      });
    }

    try {
      defaultOrganicReworkRecorder.observeAttempt({
        workflowId,
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        executorCallId: executionReport?.callId ?? executionReport?.usage?.callId ?? null,
        executorModel: executionReport?.model ?? null,
        gateResult: evidence?.pass ? 'PASS' : 'FAIL',
        reviewerDecision: reviewResult.decision,
        reviewerCallId: reviewResult.callId ?? reviewResult.usage?.callId ?? null,
        reviewerModel: reviewResult.model ?? null,
        requiredChanges: reviewResult.required_changes ?? [],
        evidence,
        round: reviewRound,
        nonConvergence: reviewerReworkNonConvergence(latestReviewResult, reviewResult, evidence),
      });
    } catch {
      /* non-blocking passive observation */
    }

    if (reviewResult.decision !== 'PASS' && persistence) {
      await persistence.writeState({
        workflow_id: workflowId,
        task_id: currentTaskCard.task_id,
        last_error: formatReviewFeedback(reviewResult),
      });
    }

    if (reviewerReworkNonConvergence(latestReviewResult, reviewResult, evidence)) {
      log(`REVIEWER_REWORK_NONCONVERGENCE task=${currentTaskCard.task_id} attempt=${attemptCount}`);
      workflowStateManager?.recordProgress({ diagnostic: 'REVIEWER_REWORK_NONCONVERGENCE' });
    }
    reviewResult.round = reviewRound;

    // OUT_OF_SCOPE auto-closure. The Reviewer has judged that a required change
    // lies outside this Task Card's declared scope/allowed_files. That is a
    // deterministic terminal outcome for THIS task — not a defect to rework and
    // not a human ambiguity — so the task lifecycle closes here, is recorded in
    // history (distinct from PASS, so it stays auditable), and the loop returns
    // to the Supervisor for the next task. This never fires for a REWORK, a
    // Gate FAIL, or a HUMAN_REQUIRED: those keep their own handling above.
    if (reviewResult.decision === 'OUT_OF_SCOPE') {
      latestReviewResult = reviewResult;
      const outOfScopeChanges = Array.isArray(reviewResult.required_changes)
        ? reviewResult.required_changes
        : reviewResult.required_changes && reviewResult.required_changes !== 'none'
          ? [reviewResult.required_changes]
          : [];
      log(`review OUT_OF_SCOPE: task=${currentTaskCard.task_id} attempt=${attemptCount} — closing task lifecycle deterministically`);
      history.push({
        task_id: currentTaskCard.task_id,
        decision: 'OUT_OF_SCOPE',
        attempts: normalAttempts + escalationAttempts,
        out_of_scope_changes: outOfScopeChanges,
      });
      workflowStateManager?.recordCompletedTask?.({
        taskId: currentTaskCard.task_id,
        decision: 'OUT_OF_SCOPE',
        attempts: normalAttempts + escalationAttempts,
      });
      await persistCheckpoint();
      return { done: false };
    }

    taskAttemptHistory.push({
      attempt: attemptCount,
      gateResult: evidence?.pass ? 'PASS' : 'FAIL',
      reviewerDecision: reviewResult.decision,
      findings: reviewResult.findings ?? reviewResult.required_changes ?? [],
      executionReport: executionReport ?? null,
    });

    latestReviewResult = reviewResult;
    if (reviewResult.decision === 'PASS') {
      history.push({
        task_id: currentTaskCard.task_id,
        decision: 'PASS',
        attempts: normalAttempts + escalationAttempts,
      });
      workflowStateManager?.recordCompletedTask({
        taskId: currentTaskCard.task_id,
        decision: 'PASS',
        attempts: normalAttempts + escalationAttempts,
      });
      if (typeof onTaskCompleted === 'function') {
        // A failure here (e.g. a real task-baseline commit error) corrupts
        // task-scoped evidence for every following task — it must abort the
        // workflow, not be logged and ignored.
        await onTaskCompleted({ taskId: currentTaskCard.task_id, taskCard: currentTaskCard });
      }
    }
    await persistCheckpoint();
    return { done: false };

  }

  try {
    const supervisorIdentity = await supervisorSession.create({ windowId });
    supervisorTabId = supervisorIdentity?.tabId ?? null;
    log(`supervisor tab created: supervisorTabId=${supervisorTabId}`);

    // The automation window's own initial tab (see the module doc comment
    // above) is never used for anything once the real Supervisor tab is up
    // — close it now so the window doesn't carry a permanent unused
    // placeholder alongside the tabs this loop actually addresses.
    if (initialTabId !== null && initialTabId !== undefined && initialTabId !== supervisorTabId) {
      if (typeof windowSession.closeTab !== 'function') {
        log(`automation window: placeholder cleanup skipped — windowSession has no closeTab (initialTabId=${initialTabId})`);
      } else {
        log(`automation window: requesting placeholder close initialTabId=${initialTabId}`);
        try {
          await windowSession.closeTab(initialTabId);
          log(`automation window: placeholder close succeeded initialTabId=${initialTabId}`);
        } catch (err) {
          log(`automation window: placeholder close failed initialTabId=${initialTabId}: ${err.message}`);
          throw err;
        }

        // Fail closed: verify the placeholder is actually gone rather than
        // trusting the close call's mere resolution — a swallowed error
        // upstream (or an extension-side response missing initialTabId, as
        // seen in the live test) leaves the placeholder silently open.
        const tabsAfterClose = await windowSession.listTabs(windowId);
        const placeholderStillPresent = tabsAfterClose.some((tab) => tab.tabId === initialTabId);
        if (placeholderStillPresent) {
          throw new Error(
            `Automation window placeholder tab initialTabId=${initialTabId} is still present after close() reported success — refusing to continue with an unexpected extra tab.`
          );
        }
      }
    }
    await logWindowTabs('after-supervisor-create');

    // P2-1: a REVIEW_PENDING resume re-enters the Reviewer directly with the
    // persisted Executor Report + Gate evidence — no Executor, no Gate rerun.
    if (resumeReviewPending) {
      const persisted = resumeReviewPending;
      resumeReviewPending = null;
      const captured = persisted.worktreeFingerprint;
      const currentFp = typeof computeGateFingerprint === 'function' ? computeGateFingerprint() : null;
      const valid = (v) => typeof v === 'string' && v.trim().length > 0;
      // Saved Executor + Gate evidence may be re-used for a Reviewer-only
      // resume ONLY when the captured fingerprint is valid AND the current
      // fingerprint is valid AND they are identical. A null/unavailable
      // fingerprint on either side means we cannot prove the worktree still
      // matches — fail closed and route back through a fresh full attempt
      // (Executor state + Gate) rather than trusting stale evidence.
      if (valid(captured) && valid(currentFp) && captured === currentFp) {
        const outcome = await runReviewStep({
          executionReport: persisted.executionReport,
          evidence: persisted.evidence,
        });
        if (outcome.done) return outcome.result;
      } else {
        const why = !valid(captured)
          ? 'captured worktree fingerprint unavailable'
          : !valid(currentFp)
            ? 'resume worktree fingerprint unavailable'
            : `worktree drift detected (was=${captured} now=${currentFp})`;
        log(`REVIEW_PENDING resume: ${why} — saved Gate evidence not reused, re-running attempt`);
        attemptCount = Math.max(0, attemptCount - 1);
        const outcome = await runAttempt();
        if (outcome.done) return outcome.result;
      }
    }

    for (;;) {
      const decisionContext = {
        workflowGoal,
        repositoryContext,
        history,
        currentTaskCard,
        taskCard: currentTaskCard,
        latestReviewResult,
        latestGateEvidence,
        attemptHistory: taskAttemptHistory,
        executionReports: taskAttemptHistory.map((a) => a.executionReport).filter(Boolean),
        gitChanges: latestGateEvidence?.diff || null,
        normalAttempts,
        escalationAttempts,
        escalationActive,
        maxAttemptsPerTask,
        maxEscalationAttempts,
        plannedTasks,
        planSummary,
        isEscalating: normalAttempts >= maxAttemptsPerTask && !escalationActive,
      };

      let decision;
      const deterministic = decideDeterministically({
        context: decisionContext,
        plannedTasks,
        planSummary,
        reworkMemory: loopReworkMemory,
      });

      if (deterministic.handled) {
        decision = deterministic.decision;
        log(`deterministic supervisor decision: ${decision.action} (${deterministic.reason})`);
      } else {
        await activateSupervisorTab();
        workflowStateManager?.startStage(WORKFLOW_STAGES.SUPERVISOR);
        try {
          decision = await runWithRateLimitRecovery({
            label: 'supervisor decision',
            subject: `task=${currentTaskCard ? currentTaskCard.task_id : 'none'}`,
            run: () => supervisorSession.decide(decisionContext),
            reactivate: activateSupervisorTab,
          });
        } catch (err) {
          if (err instanceof RateLimitStopError) {
            // Same contract as the Reviewer case: nothing is closed, nothing
            // is rerun, the Supervisor conversation and any open Reviewer
            // session/tab are preserved for a resumed run.
            workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
              reason: err.message,
              question: 'ChatGPT rate-limiting is blocking the Supervisor decision.',
            });
            return {
              status: 'HUMAN_REQUIRED',
              reason: err.message,
              question:
                'ChatGPT rate-limiting is blocking the Supervisor decision. Wait for the limit to clear, then resume this workflow.',
              history,
              ...(currentTaskCard ? { taskId: currentTaskCard.task_id } : {}),
              tokenUsage: usageTracker?.summary() ?? null,
            };
          }
          throw err;
        }
      }

      log(`supervisor decision: ${decision.action}`);

      if (usageTracker) {
        usageTracker.record({
          workflowId,
          role: 'supervisor',
          callId: decision?.callId ?? decision?.usage?.callId,
          provider: decision?.provider,
          model: decision?.model,
          usage: decision?.usage ?? null,
          durationMs: decision?.durationMs,
        });
      }
      if (workflowStateManager) {
        if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
        workflowStateManager.setDecision(decision.action);
      }

      // OUT_OF_SCOPE closes the task exactly like PASS does — the task is no
      // longer mid-flight, so NEXT_TASK / WORKFLOW_DONE / HUMAN_REQUIRED (not
      // CONTINUE_REWORK) are the legal Supervisor transitions from here.
      const hasPendingRework = latestReviewResult !== null
        && latestReviewResult.decision !== 'PASS'
        && latestReviewResult.decision !== 'OUT_OF_SCOPE';
      assertLegalTransition(decision, hasPendingRework);

      if (decision.action === 'HUMAN_REQUIRED') {
        // NO NEW INFORMATION -> NO NEW MODEL CALL: the deterministic policy
        // stopped a Gate-rework loop because the same failure repeated against
        // an unchanged diff. Project it as a BLOCKING safety event so it
        // survives to the terminal result the Front Agent shows the user.
        if (decision.noNewInformation && workflowStateManager) {
          try {
            workflowStateManager.recordSafetyEvent({
              code: SAFETY_EVENT_CODES.NO_NEW_INFORMATION_RETRY_BLOCKED,
              severity: SAFETY_SEVERITY.BLOCKING,
              role: 'supervisor',
              taskId: decision.noNewInformation.taskId ?? currentTaskCard?.task_id ?? null,
              attempt: attemptCount,
              fingerprint: decision.noNewInformation.gateFingerprint ?? null,
              diffHash: decision.noNewInformation.diffHash ?? null,
              reason: decision.reason,
              actionTaken:
                'workflow halted — HUMAN_REQUIRED; no further Executor call dispatched '
                + '(identical Gate failure + unchanged task diff on two consecutive attempts)',
            });
          } catch (seErr) {
            log(`no-new-information safety event record failed: ${seErr.message}`);
          }
        }
        // Deliberately does not close anything: HUMAN_REQUIRED means "stop
        // and preserve enough state to continue later", and the whole point
        // of these being persistent conversations (inside a window that is
        // left open too) is that a human (or a resumed run) can pick the
        // same conversation/tab back up.
        const supervisorEvidence = buildHumanRequiredEvidence({
          workflowId,
          taskCard: currentTaskCard,
          attempt: attemptCount,
          stage: WORKFLOW_STAGES.SUPERVISOR,
          blockerCategory: FAILURE_CATEGORIES.REVIEW,
          rootCause: decision.reason || 'Supervisor requested human intervention',
          latestGateResult: latestGateEvidence ?? null,
          latestReviewerDecision: latestReviewResult?.decision ?? null,
          latestReviewerRequiredChanges: latestReviewResult?.required_changes ?? null,
          recommendedAction: decision.question || 'Provide human decision to resolve ambiguity or policy question.',
          history,
        });

        workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
          reason: decision.reason,
          question: decision.question,
          evidence: supervisorEvidence,
          blockerCategory: FAILURE_CATEGORIES.REVIEW,
        });
        return {
          status: 'HUMAN_REQUIRED',
          reason: decision.reason,
          question: decision.question,
          evidence: supervisorEvidence,
          blockerCategory: FAILURE_CATEGORIES.REVIEW,
          history,
          ...(currentTaskCard ? { taskId: currentTaskCard.task_id } : {}),
          tokenUsage: usageTracker?.summary() ?? null,
        };
      }

      if (decision.action === 'WORKFLOW_DONE') {
        // Deterministic Core Closeout Gate Guard:
        // WORKFLOW_DONE from Supervisor is only a request to finish.
        // If frozen closeout_verification_commands is non-empty, Core ALWAYS executes those frozen closeout commands
        // against the current isolated worktree (or consumes matching trusted host evidence bound to current worktree).
        if (Array.isArray(closeoutVerificationCommands) && closeoutVerificationCommands.length > 0) {
          const evidenceRoot = workflowStateManager?.root || SUPERGPT_WORKTREE_ROOT;
          const hostEvidenceCheck = getValidHostEvidence({
            workflowId,
            taskId: CLOSEOUT_VERIFICATION_ID,
            verificationIdentity: CLOSEOUT_VERIFICATION_ID,
            verificationCommands: closeoutVerificationCommands,
            root: evidenceRoot,
            execSync: _execSync,
          });

          let closeoutEvidence;
          if (hostEvidenceCheck?.valid && hostEvidenceCheck.hostEvidence?.pass) {
            log(`closeout gate: consuming valid trusted host verification evidence (id=${hostEvidenceCheck.hostEvidence.evidenceId})`);
            closeoutEvidence = hostEvidenceCheck.hostEvidence.evidence || {
              pass: true,
              results: hostEvidenceCheck.hostEvidence.results,
              changed_files: [],
              git_diff: '',
            };
          } else {
            log(`closeout gate: running core closeout verification commands: ${JSON.stringify(closeoutVerificationCommands)}`);
            workflowStateManager?.startStage(WORKFLOW_STAGES.GATE);
            closeoutEvidence = await gateRunner.run(closeoutVerificationCommands);
            throwIfAborted();
          }

          if (!closeoutEvidence.pass) {
            // Check if blocked by environment/toolchain
            const envFailure = (closeoutEvidence.results || []).find(
              (r) => !r.pass && (
                r.output?.includes('command not found') ||
                r.output?.includes('exit code 127') ||
                /ENOENT|EACCES|No such file or directory/i.test(r.output || '')
              )
            );

            if (envFailure) {
              const cmdName = envFailure.command.trim().split(/\s+/)[0];
              const fingerprint = `GATE_ENV:${cmdName}`;
              seenBlockers.set(fingerprint, (seenBlockers.get(fingerprint) || 0) + 1);

              const closeoutTaskId = CLOSEOUT_VERIFICATION_ID;
              const gateEnvEvidence = buildHumanRequiredEvidence({
                workflowId,
                taskCard: currentTaskCard || { task_id: closeoutTaskId, goal: 'Closeout Verification' },
                attempt: attemptCount,
                stage: WORKFLOW_STAGES.GATE,
                blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
                rootCause: `Closeout Gate verification command failed to execute: ${envFailure.command} (${envFailure.output})`,
                failingGateCommand: envFailure.command,
                exitCode: 127,
                stderrTail: envFailure.output,
                latestGateResult: closeoutEvidence,
                blockerFingerprint: fingerprint,
                blockerCount: seenBlockers.get(fingerprint),
                recommendedAction: `Ensure command '${cmdName}' is installed and executable in the environment.`,
                history,
              });

              const pendingVerification = {
                task_id: closeoutTaskId,
                verification_identity: CLOSEOUT_VERIFICATION_ID,
                commands: [...closeoutVerificationCommands],
                commands_hash: hashCommandSet(closeoutVerificationCommands),
                reason: envFailure.output || envFailure.command,
                generation: attemptCount,
              };

              if (workflowStateManager) {
                workflowStateManager.state.pending_verification = pendingVerification;
                workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
                  reason: `Closeout Gate command execution failed: ${envFailure.command} (${envFailure.output})`,
                  question: `Closeout verification failed due to an environment blocker: ${envFailure.output}. Fix the environment requirement, then resume.`,
                  pending_verification: pendingVerification,
                });
              }

              return {
                status: 'HUMAN_REQUIRED',
                reason: `Closeout Gate command execution failed: ${envFailure.command} (${envFailure.output})`,
                question: `Closeout verification failed due to an environment blocker: ${envFailure.output}. Fix the environment requirement, then resume.`,
                taskId: closeoutTaskId,
                evidence: gateEnvEvidence,
                blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
                pending_verification: pendingVerification,
                history,
                tokenUsage: usageTracker?.summary() ?? null,
              };
            }

            // Closeout failed on code/test assertions: route back through review/rework or fail closed
            log(`closeout gate failed: ${JSON.stringify(closeoutEvidence.results)}`);
            if (currentTaskCard) {
              const failingResults = (closeoutEvidence.results || []).filter((r) => !r.pass);
              const failureSummary = failingResults.map((r) => `${r.command}: ${r.output || 'failed'}`).join('; ');
              latestReviewResult = {
                task_id: currentTaskCard.task_id,
                decision: 'REWORK',
                rationale: `Closeout Gate verification failed on final repository state: ${failureSummary}`,
                required_changes: failingResults.map((r) => `Fix failure in closeout command: ${r.command}`),
                source: 'GATE',
                round: reviewRound,
              };
              if (workflowStateManager) {
                workflowStateManager.state.stageStatuses.gate = 'FAIL';
                workflowStateManager.state.stageStatuses.reviewer = 'REWORK';
                workflowStateManager.recordProgress();
              }
              // Loop back to Supervisor for rework decision
              continue;
            } else {
              workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, {
                reason: 'Closeout Gate verification failed',
                evidence: closeoutEvidence,
              });
              return {
                status: 'FAILED',
                reason: 'Closeout Gate verification failed on final repository state',
                evidence: closeoutEvidence,
                history,
                tokenUsage: usageTracker?.summary() ?? null,
              };
            }
          }
          const proof = {
            evidence_id: hostEvidenceCheck?.valid ? hostEvidenceCheck.hostEvidence.evidenceId : `closeout-${Date.now()}`,
            pass: true,
            commands: [...closeoutVerificationCommands],
            commands_hash: hashCommandSet(closeoutVerificationCommands),
            worktree_fingerprint: null,
            captured_at: new Date().toISOString(),
            workflow_id: workflowId,
            verification_identity: CLOSEOUT_VERIFICATION_ID,
          };
          // defaultPipeline supplies the authoritative worktree fingerprint.
          await onCloseoutPass?.(proof, closeoutEvidence);
        }

        workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, {
          summary: decision.summary,
        });
        if (keepOpenOnSuccess) {
          log(
            `workflow done; --keep-open is set — leaving windowId=${windowId} supervisorTabId=${supervisorTabId} ` +
              `reviewerTabId=${reviewerTabId} open for inspection`
          );
        } else {
          await closeReviewer();
          await supervisorSession.close();
          await windowSession.close(windowId);
        }
        return {
          status: 'WORKFLOW_DONE',
          summary: decision.summary,
          history,
          tokenUsage: usageTracker?.summary() ?? null,
        };
      }

      if (decision.action === 'CONTINUE_REWORK') {
        if (normalAttempts >= maxAttemptsPerTask) {
          escalationActive = true;
        }
        if (decision.guidance || decision.repair_guidance || decision.strategy) {
          supervisorGuidance = decision.guidance || decision.repair_guidance || decision.strategy;
        }
        if (decision.executor_model || decision.model) {
          currentTaskCard.executor_model = decision.executor_model || decision.model;
        } else if (escalationActive) {
          currentTaskCard.executor_model = currentTaskCard.executor_model || 'opus';
        }
        workflowStateManager?.startStage(WORKFLOW_STAGES.REWORK);
        if (workflowStateManager) {
          const reqStr = Array.isArray(latestReviewResult?.required_changes)
            ? latestReviewResult.required_changes.join('; ')
            : latestReviewResult?.required_changes || 'rework needed';
          const banner = workflowStateManager.formatFailureBanner(
            `Review requested changes: ${reqStr}`,
            { retrying: true, nextAttempt: attemptCount + 1 }
          );
          log(banner);
        }
        const outcome = await runAttempt();
        if (outcome.done) return outcome.result;
        continue;
      }

      if (decision.action === 'OUT_OF_SCOPE') {
        log(`supervisor decision OUT_OF_SCOPE: task=${currentTaskCard.task_id} attempt=${attemptCount} — closing task lifecycle deterministically`);
        history.push({
          task_id: currentTaskCard.task_id,
          decision: 'OUT_OF_SCOPE',
          attempts: normalAttempts + escalationAttempts,
        });
        workflowStateManager?.recordCompletedTask?.({
          taskId: currentTaskCard.task_id,
          decision: 'OUT_OF_SCOPE',
          attempts: normalAttempts + escalationAttempts,
        });
        await persistCheckpoint();
        continue;
      }

      // decision.action === 'NEXT_TASK'
      await closeReviewer(); // closes the PREVIOUS task's reviewer tab, if any — conversation itself is left in the account, not deleted
      currentTaskCard = await bindActiveAcceptance({ ...decision.task_card });
      log(`task selected: ${currentTaskCard.task_id} (acceptance v${currentTaskCard.acceptance_version})`);
      // reviewerSession is instantiated now but its create(taskId) — the
      // call that actually opens the background ChatGPT tab, INSIDE the
      // same automation window — is deferred to runAttempt(), right before
      // the first review() (see module doc).
      reviewerSession = createReviewerSession();
      reviewerCreated = false;
      claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
      normalAttempts = 0;
      escalationAttempts = 0;
      escalationActive = false;
      supervisorGuidance = null;
      taskAttemptHistory = [];
      unauthorizedProbeRetries = 0;
      unauthorizedProbeGuidance = null;
      attemptCount = 0;
      latestReviewResult = null;

      // BASELINE-DIFF GATE: capture the pre-existing verification failures now,
      // before the Executor's first edit, while this is still a clean baseline.
      await captureTaskBaseline();

      await persistCheckpoint();

      const outcome = await runAttempt();
      if (outcome.done) return outcome.result;

    }
  } catch (err) {
    if (signal?.aborted) {
      // A cancellation is not a workflow failure: leave terminal-state
      // classification to the caller, which reports CANCELLED/STOPPED.
      if (!keepOpenOnFailure) {
        await closeReviewer().catch(() => {});
        await supervisorSession.close().catch(() => {});
        await windowSession.close(windowId).catch(() => {});
      }
      throw err;
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: err.message });
    if (workflowStateManager) {
      log(workflowStateManager.formatFailureBanner(err.message, { retrying: false }));
    }
    if (keepOpenOnFailure) {
      // Debug-only: preserve every resource this run opened instead of the
      // usual best-effort teardown, so a live failure can be inspected in
      // the actual ChatGPT tabs — see scripts/test-automated-loop-live.js's
      // --keep-open-on-failure flag. Never runs unless a caller opts in.
      log(
        `unexpected failure; --keep-open-on-failure is set — leaving windowId=${windowId} supervisorTabId=${supervisorTabId} ` +
          `reviewerTabId=${reviewerTabId} open for inspection (error: ${err.message})`
      );
      throw err;
    }
    // Best-effort error cleanup: never let a failure while tearing down
    // leak an open tab/window, and never let it mask the original error.
    await closeReviewer().catch(() => {});
    await supervisorSession.close().catch(() => {});
    await windowSession.close(windowId).catch(() => {});
    throw err;
  }
}
