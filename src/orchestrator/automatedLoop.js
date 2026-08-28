// Automated orchestration loop (Issue #2, step 4) — first fully-automatic
// end-to-end wiring of the primitives already built in earlier steps:
//
//   SupervisorSession   (src/bridge/supervisorSession.js)   — one persistent
//                        ChatGPT conversation for the whole workflow
//   ReviewerSession     (src/bridge/reviewerSession.js)     — one persistent
//                        ChatGPT conversation per task, reused across every
//                        REWORK round of that task
//   ClaudeSessionManager(src/orchestrator/adapters/claudeSessionManager.js)
//                        — a brand-new Claude session for every single
//                        execute() call (initial attempt and every rework)
//   gate runner          (src/orchestrator/adapters/gateRunner.js)  — runs
//                        verification_commands and collects evidence
//
// This file does not reimplement any of the above. It only sequences them:
//
//   Supervisor.decide() -> NEXT_TASK
//     -> Claude.execute() -> gate.run() -> Reviewer.review()
//     -> Supervisor.decide() again, now carrying that Review Result
//     -> CONTINUE_REWORK  loops back to a fresh Claude.execute() on the
//                         SAME task, through the SAME ReviewerSession
//     -> NEXT_TASK/WORKFLOW_DONE/HUMAN_REQUIRED ends that task
//
// Deliberately bypasses workflowManager.js/stateMachine.js: that state
// machine drives EXECUTING/VERIFYING/REWORK/REVIEWING for one task straight
// through to a terminal state without ever consulting the Supervisor
// per-attempt. This loop's whole point is the opposite — the Supervisor is
// asked to approve (or refuse) every single rework round via
// CONTINUE_REWORK, per Issue #2's spec. Reusing workflowManager.js's
// internal auto-retry would silently drop that consultation, so this is a
// new, separate thin controller instead of a change to that file.
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

import { AdapterError, ADAPTER_ERROR_CODES } from './errors.js';
import { WORKFLOW_STAGES, WORKFLOW_STATUSES } from './workflowState.js';
import { defaultOrganicReworkRecorder } from './organicReworkRecorder.js';
import {
  runPreflight as defaultRunPreflight,
  buildHumanRequiredEvidence,
  FAILURE_CATEGORIES,
} from './preflight.js';

function defaultLog(line) {
  console.log(`gpt-loop: ${line}`);
}

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
// ChatGPT's own "You're making requests too quickly" throttle (surfaced by
// the extension as RATE_LIMITED — see extension/domActions.js isRateLimited)
// is NOT a task failure, a review verdict, a send failure, or a gate
// failure. When it hits a Reviewer review (or a Supervisor decision), the
// ONLY correct response is to wait for the throttle to clear and re-issue
// the SAME GPT request — never to rerun Claude, rerun the deterministic
// gate, bump the task attempt counter, spin up a new Reviewer conversation,
// or ask the Supervisor for a fresh decision. All of that surrounding state
// is deliberately left untouched here.
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

// Duck-typed so this module stays free of a hard dependency on
// src/bridge/errors.js — the bridge maps RATE_LIMITED to a RateLimitedError
// whose `.name` is exactly this, and the underlying banner text is stable.
function isRateLimitError(err) {
  return err?.name === 'RateLimitedError' || err?.code === 'RATE_LIMITED' || /making requests too quickly/i.test(err?.message ?? '');
}

// requirement: only auto-retry when the failure stage PROVES the GPT
// request was rejected before the user message was ever confirmed sent —
// otherwise a retry risks a duplicate submission into the same
// conversation. The extension throws RATE_LIMITED from a handful of
// distinct stages (extension/domActions.js); only these two are strictly
// pre-send. "while waiting for a reply" (and anything unrecognized) is
// treated as possibly-already-sent and is NOT auto-retried.
function rateLimitedBeforeSend(err) {
  return /looking for the composer|waiting for the page to become ready/i.test(err?.message ?? '');
}

function rateLimitCooldownMs(err, retry, baseMs, jitterMs) {
  // Prefer an explicit cooldown if the throttle ever surfaces one. ChatGPT's
  // banner currently does not (there is no Retry-After to read), so in
  // practice this always falls through to the conservative backoff below —
  // it is here so a future UI-provided cooldown is used automatically.
  const retryAfter = Number(err?.retryAfterMs);
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
//   supervisorSession         — a SupervisorSession-shaped object:
//                               { create(), decide(context), close() }.
//                               create() is called once at the start of
//                               this function; close() is called only on
//                               WORKFLOW_DONE.
//   createReviewerSession()   — returns a fresh ReviewerSession-shaped
//                               object: { create(taskId), review(taskId,
//                               taskCard, executionReport, evidence),
//                               close() }. Called once per task (a new task
//                               gets a new session; the same task's rework
//                               rounds reuse the one already created).
//   createClaudeSessionManager({ taskId }) — returns an Executor-Adapter-
//                               shaped object: { execute(taskCard) ->
//                               execution_report }. Called once per task;
//                               every execute() call on the object it
//                               returns is a fresh Claude session per that
//                               object's own contract.
//   gateRunner                — { run(verification_commands) -> evidence },
//                               unchanged from ADAPTER_INTERFACE.md §3.
//   windowSession             — a windowSession-shaped object:
//                               { create() -> { windowId, initialTabId },
//                               activateTab(tabId) -> { tabId, active,
//                               windowId, windowFocused }, close(windowId),
//                               closeTab(tabId), listTabs(windowId) ->
//                               [{ windowId, tabId, active, status, urlState,
//                               openerTabId }] }. closeTab/listTabs are used
//                               only for the initial-placeholder-tab cleanup
//                               and stage-diagnostic logging described below
//                               — neither sends a GPT request. See src/bridge/windowSession.js
//                               for the real extension-backed implementation
//                               (thin wrappers over the windowCreate/
//                               windowActivateTab/windowClose wire actions
//                               proven live by
//                               scripts/test-background-automation-window-live.js).
//                               Required — every Supervisor/Reviewer tab this
//                               loop opens lives inside the ONE dedicated,
//                               permanently unfocused window this creates, so
//                               the user's own foreground Chrome window/tab is
//                               never touched. create() is called exactly
//                               once, at the very start of this function;
//                               activateTab(tabId) is called immediately
//                               before every supervisorSession.decide() and
//                               every reviewerSession.review() so the target
//                               tab is `active` inside the automation window
//                               (never the globally-active tab) without ever
//                               focusing that window — a reply
//                               windowFocused !== false or active !== true
//                               aborts the whole workflow (assertWindowInvariant
//                               above) rather than silently proceeding.
//                               close(windowId) is called once the workflow
//                               reaches WORKFLOW_DONE (after both sessions'
//                               own close()) and, best-effort, on any error
//                               that escapes this loop — never on
//                               HUMAN_REQUIRED, which deliberately leaves the
//                               window/tabs open for a resumed run.
//   persistence                — optional Persistence-shaped object
//                               ({ writeState }); when given, Reviewer
//                               feedback is written to
//                               { workflow_id, task_id, last_error } before
//                               every rework attempt so
//                               ClaudeSessionManager's own rework-prompt
//                               logic (which reads exactly that state) can
//                               fold it in. Required if any task actually
//                               goes through a rework round; omit only for
//                               workflows you're certain will PASS first
//                               try.
//   workflowGoal/repositoryContext — passed straight through to
//                               buildSupervisorPrompt via decide().
//   maxAttemptsPerTask         — bounded-retry safety guard (default 3):
//                               the maximum number of Claude execute()
//                               attempts (initial + every rework) for a
//                               single task before this loop stops itself
//                               and returns HUMAN_REQUIRED, instead of
//                               following CONTINUE_REWORK forever.
//   keepOpenOnFailure          — debug-only (default false, unchanged
//                               production semantics). When true, the
//                               best-effort cleanup an unexpected error
//                               normally triggers (closeReviewer/
//                               supervisorSession.close/windowSession.close)
//                               is skipped, and the preserved windowId/
//                               supervisorTabId/reviewerTabId are logged
//                               instead, before the error is rethrown —
//                               added only for
//                               scripts/test-automated-loop-live.js's
//                               --keep-open-on-failure flag, so a live
//                               failure can be inspected in the actual
//                               ChatGPT tabs instead of racing a teardown
//                               that already happened. Sends no extra GPT
//                               requests either way — this only changes
//                               whether the existing close() calls run.
//   keepOpenOnSuccess          — debug-only (default false, unchanged
//                               production semantics). Same skip, but for
//                               the WORKFLOW_DONE cleanup — added only for
//                               scripts/test-automated-loop-live.js's
//                               --keep-open flag (manual inspection of the
//                               final ChatGPT state after a successful run).
//                               Never applies to HUMAN_REQUIRED, which
//                               already preserves everything under its own,
//                               unrelated resume contract (see below) —
//                               these two flags never touch that branch.
//   log                        — optional (line) => void, called at each
//                               loop stage (task selected, claude attempt
//                               started/completed, gate started/completed,
//                               reviewer created, review started/completed,
//                               supervisor decision) for operational
//                               visibility. Never passed prompt/reply
//                               content — task/attempt/decision identifiers
//                               only. Defaults to a "gpt-loop: " prefixed
//                               console.log, matching this codebase's other
//                               stderr/stdout log lines.
//
// Automation window tab-count invariant (diagnostic finding, 2026-08-27):
// chrome.windows.create() always creates one initial tab of its own,
// navigated to config.chatgptUrl as a side effect of opening the window at
// all (see windowSession.create()'s doc comment). Left alone, that initial
// tab sits in the automation window forever as an unused, idle ChatGPT tab
// nobody ever addresses — on top of the real Supervisor tab
// supervisorSession.create() then opens, and later the real Reviewer tab —
// which is why a live window was observed holding 3 tabs where only 2
// (Supervisor + Reviewer) are ever actually used. This loop closes that
// initial placeholder tab (via windowSession.closeTab) immediately after the
// real Supervisor tab is confirmed up, restoring the intended invariant:
// exactly 1 working tab after Supervisor creation, 2 while a Reviewer tab is
// also open, 1 again after the Reviewer tab closes. Chosen over the
// alternative (reusing the initial tab itself AS the Supervisor tab) because
// it needs no new branch in createSupervisorTab's proven create+readiness
// logic — it only adds one extra close() call after that logic already
// succeeded.
//
// Reviewer tab lifecycle is deliberately LAZY (live E2E finding,
// 2026-08-27): createReviewerSession() is called at NEXT_TASK to get a
// ReviewerSession-shaped object, but that object's own create(taskId) —
// which is what actually opens the background ChatGPT tab — is NOT called
// until immediately before the first review() of that task, i.e. after
// Claude execute() and gate.run() have both already completed. Opening the
// tab any earlier left it sitting idle in the background for the entire
// Claude execution + gate run, which was long enough to trip ChatGPT's own
// idle/rate handling in the already-observed live failure. Same-task
// REWORK rounds reuse that one already-created ReviewerSession exactly as
// before; a new NEXT_TASK still closes the previous task's tab and defers
// creating the next one the same way. If the maxAttemptsPerTask guard
// trips (or HUMAN_REQUIRED intervenes) before any review() call, no
// Reviewer tab was ever opened for that task.
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
  windowSession,
  persistence,
  workflowGoal,
  repositoryContext,
  maxAttemptsPerTask = 3,
  keepOpenOnFailure = false,
  keepOpenOnSuccess = false,
  sourceWorkspace = null,
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
  // Deterministic loop-resume support. `checkpoint` (if given) rehydrates
  // the exact suspension point — accepted-task history, the mid-flight task
  // card, its attempt counter and latest Review Result — so a resumed run
  // never replans or re-executes an already-accepted task. `onCheckpoint` is
  // called after every state-advancing transition with the current snapshot.
  checkpoint = null,
  onCheckpoint = null,
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
  const seenBlockers = new Map();
  let currentTaskCard = null;
  let reviewerSession = null;
  let reviewerCreated = false;
  let reviewerTabId = null;
  let claudeManager = null;
  let attemptCount = 0;
  let supervisorTabId = null;

  const persistCheckpoint = async () => {
    if (typeof onCheckpoint !== 'function') return;
    try {
      await onCheckpoint({
        history: history.map((entry) => ({ ...entry })),
        currentTaskCard: currentTaskCard ?? null,
        currentTaskId: currentTaskCard?.task_id ?? null,
        attempt: attemptCount,
        latestReviewResult: latestReviewResult ?? null,
      });
    } catch {
      /* checkpoint persistence is best-effort — never break the loop */
    }
  };

  if (checkpoint && typeof checkpoint === 'object') {
    if (Array.isArray(checkpoint.history)) history.push(...checkpoint.history);
    // Only rehydrate a mid-flight task when the last Review Result was not a
    // PASS. An accepted task is already in `history`; re-seeding it as
    // current would make the loop re-run its Executor/Reviewer.
    if (checkpoint.currentTaskCard && checkpoint.latestReviewResult?.decision !== 'PASS') {
      currentTaskCard = checkpoint.currentTaskCard;
      attemptCount = Number.isFinite(checkpoint.attempt) ? checkpoint.attempt : 0;
      latestReviewResult = checkpoint.latestReviewResult ?? null;
      claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
      reviewerSession = createReviewerSession();
      reviewerCreated = false;
      log(`loop checkpoint restored: task=${currentTaskCard.task_id} attempt=${attemptCount} completed=${history.length}`);
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
      await reviewerSession.close();
      reviewerSession = null;
      reviewerCreated = false;
      reviewerTabId = null;
    }
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

    attemptCount += 1;
    if (attemptCount > maxAttemptsPerTask) {
      const maxAttemptEvidence = buildHumanRequiredEvidence({
        workflowId,
        taskCard: currentTaskCard,
        attempt: maxAttemptsPerTask,
        stage: WORKFLOW_STAGES.REVIEWER,
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

    log(`claude attempt started: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
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
    };
    const executionReport = await claudeManager.execute(executorTaskCard, { signal });
    throwIfAborted();
    log(`claude attempt completed: task=${currentTaskCard.task_id} attempt=${attemptCount}`);

    if (executionReport?.usage && usageTracker) {
      usageTracker.record({
        role: 'executor',
        callId: executionReport.callId ?? executionReport.usage?.callId,
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        model: executionReport.model,
        usage: executionReport.usage,
        costUsd: executionReport.costUsd,
      });
    }
    if (workflowStateManager) {
      if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary());
      if (executionReport?.model) {
        workflowStateManager.setRouting({
          model: executionReport.model,
          escalated: executionReport.modelEscalated,
          escalationReason: executionReport.escalationReason,
        });
      }
    }

    log(`gate started: task=${currentTaskCard.task_id} attempt=${attemptCount}`);
    workflowStateManager?.startStage(WORKFLOW_STAGES.GATE);
    const evidence = await gateRunner.run(currentTaskCard.verification_commands);
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

      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason: `Gate command execution failed: ${envFailure.command} (${envFailure.output})`,
          question: `Gate verification command failed due to an environment blocker: ${envFailure.output}. Fix the environment requirement, then resume.`,
          taskId: currentTaskCard.task_id,
          evidence: gateEnvEvidence,
          blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
          history,
        },
      };
    }

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

    if (reviewResult?.usage && usageTracker) {
      usageTracker.record({
        role: 'reviewer',
        callId: reviewResult.callId ?? reviewResult.usage?.callId,
        taskId: currentTaskCard.task_id,
        attempt: attemptCount,
        model: reviewResult.model,
        usage: reviewResult.usage,
        durationMs: reviewResult.durationMs,
      });
    }
    if (workflowStateManager) {
      if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary());
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
    latestReviewResult = reviewResult;
    if (reviewResult.decision === 'PASS') {
      history.push({ task_id: currentTaskCard.task_id, decision: 'PASS', attempts: attemptCount });
      workflowStateManager?.recordCompletedTask({ taskId: currentTaskCard.task_id, decision: 'PASS', attempts: attemptCount });
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

    for (;;) {
      await activateSupervisorTab();
      workflowStateManager?.startStage(WORKFLOW_STAGES.SUPERVISOR);
      let decision;
      try {
        decision = await runWithRateLimitRecovery({
          label: 'supervisor decision',
          subject: `task=${currentTaskCard ? currentTaskCard.task_id : 'none'}`,
          run: () =>
            supervisorSession.decide({
              workflowGoal,
              repositoryContext,
              history,
              latestReviewResult,
            }),
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

      log(`supervisor decision: ${decision.action}`);

      if (decision?.usage && usageTracker) {
        usageTracker.record({
          role: 'supervisor',
          callId: decision.callId ?? decision.usage?.callId,
          model: decision.model,
          usage: decision.usage,
          durationMs: decision.durationMs,
        });
      }
      if (workflowStateManager) {
        if (usageTracker) workflowStateManager.setTokenUsage(usageTracker.summary());
        workflowStateManager.setDecision(decision.action);
      }

      const hasPendingRework = latestReviewResult !== null && latestReviewResult.decision !== 'PASS';
      assertLegalTransition(decision, hasPendingRework);

      if (decision.action === 'HUMAN_REQUIRED') {
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

      // decision.action === 'NEXT_TASK'
      await closeReviewer(); // closes the PREVIOUS task's reviewer tab, if any — conversation itself is left in the account, not deleted
      currentTaskCard = decision.task_card;
      log(`task selected: ${currentTaskCard.task_id}`);
      // reviewerSession is instantiated now but its create(taskId) — the
      // call that actually opens the background ChatGPT tab, INSIDE the
      // same automation window — is deferred to runAttempt(), right before
      // the first review() (see module doc).
      reviewerSession = createReviewerSession();
      reviewerCreated = false;
      claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
      attemptCount = 0;
      latestReviewResult = null;
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
