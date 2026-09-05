// SuperGPT external interface.
//
// One stable entrypoint for programmatic callers (runSuperGPT) and one CLI
// (bin/supergpt.js) on top of it. This module owns:
//
//   - the typed event stream (onEvent + optional stdout streaming)
//   - AbortSignal cancellation
//   - the { status, summary, deliveredFiles, workflowId, conversations,
//     reason, question } result contract
//
// It does NOT reimplement the workflow. The real pipeline (isolated
// worktree -> plan resolution -> agy providers -> automated loop -> safe
// delivery) is `defaultPipeline` below, assembled from the existing
// primitives. Tests inject `_pipeline` to stay deterministic and offline.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync as nodeExecSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

import { runAutomatedWorkflow } from './automatedLoop.js';
import { selectProviders } from './providerSelection.js';
import { createClaudeSessionManager } from './adapters/claudeSessionManager.js';
import { ModelSpendAuthority } from './modelSpendAuthority.js';
import { ReservationLedger, ReservationStore } from './modelSpendReservation.js';
import { AuthorizationError, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from './errors.js';
import {
  registerUserInputEvidence, registerTaskCardEvidence, registerExternalResultEvidence, sha256 as newInformationSha256,
} from './newInformation.js';
import { createGateRunner } from './adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../adapters/gate/git-evidence/index.js';
import { Persistence } from './persistence.js';
import { deliverWorkflowResult, createResultDelivery } from './resultDelivery.js';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { validateWorkflowId, assertPathWithinRoot, isTestWorkflowId } from './workflowId.js';
import { establishIsolatedWorkspace, resolveWorkflowPlan } from '../../scripts/run-agy-workflow.js';
import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import { UsageTracker } from './usageTracker.js';
import {
  resolveWorkflowCostCeilingUsd,
  workflowCostExceeded,
  formatWorkflowCostReason,
  rehydrateUsageFromState,
  assertResumeCostStateReconstructable,
  resolveWorkflowUsageVolumeCeiling,
  resolveTaskExecutorUsageVolumeCeiling,
  resolveExecutorPhysicalCallCeiling,
  anyTokenCeilingActive,
  workflowUsageVolumeExceeded,
  formatWorkflowUsageVolumeReason,
  taskExecutorCeilingExceeded,
  formatTaskExecutorCeilingReason,
} from './workflowCostGuard.js';
import {
  summarizeSafetyEvents,
  formatBlockingSafetyReason,
  safetyCodeForAdapterError,
  SAFETY_EVENT_CODES,
} from './safetyEvents.js';
import { loadWorkspaceConfig, resolveApprovedExternalRoots, loadAndValidateExternalRoots, ExternalReadRootConfigError } from './workspaceConfig.js';
import { getCurrentRuntimeIdentity, compareRuntimeIdentity } from './runtimeIdentity.js';
import {
  supergptVerify,
  hashCommandSet,
  computeWorktreeFingerprint,
  isValidWorktreeFingerprint,
  CLOSEOUT_VERIFICATION_ID,
  CONTROLLED_ACCEPTANCE_APPROVERS,
  buildControlledHostAcceptance,
  persistControlledHostAcceptance,
  readControlledHostAcceptance,
  readWorktreeHead,
  validateControlledHostAcceptance,
} from './hostVerification.js';
import {
  WorkflowStateManager,
  readLiveWorkflowState,
  readCanonicalProgress,
  toCanonicalProgress,
  waitForWorkflowState,
  formatTransitionEvent,
  WORKFLOW_STAGES,
  WORKFLOW_STATUSES,
} from './workflowState.js';
import { runPrCloseoutLoop, PR_CLOSEOUT_LOOP_STATUS } from './prCloseoutLoop.js';
import { initialCloseoutState, DEFAULT_MAX_REPAIR_ROUNDS, resolveReviewerFallbackOrder } from './prCloseoutPolicy.js';
import { createGithubPrReviewAdapter } from './adapters/githubPrReviewAdapter.js';
import { renderGenericProgress } from '../renderers/genericTextRenderer.js';
import {
  WorkflowLifecycleManager,
  gcSuperGptResources,
} from './workflowLifecycle.js';
import {
  TokenAnomalyMonitor,
  TINY_WORKFLOW_BASELINE,
  VERSIONED_BASELINES,
  checkBaselineEnvironmentCompatibility,
} from './tokenAnomalyMonitor.js';
import {
  OrganicReworkRecorder,
  defaultOrganicReworkRecorder,
  REWORK_VERIFICATION_STATUSES,
} from './organicReworkRecorder.js';
import {
  acquireWorkflowOwnership,
  releaseWorkflowOwnership,
  readOwnerLease,
  isLeaseOwnerAlive,
  currentProcessHoldsLease,
  OWNERSHIP_CODES,
} from './workflowOwnership.js';
import {
  claimOwner,
  requestStop,
  readControl,
  isStopRequested,
  isOwnerAlive,
  saveCheckpoint,
  markDeliveryReady,
  markResumable,
  recordCloseoutVerificationEvidence,
  recordAdvancedBaselineHead,
  recordDeliveryCompleted,
  recordDeliveryCleanup,
  isDeliveryCompleted,
  clearControl,
} from './workflowControl.js';
import { advanceTaskBaseline } from './taskBaseline.js';
import {
  selectWorkflowPath,
  serializePathDecision,
  pathProgressFields,
  fastPathResolvedPlan,
  WORKFLOW_PATHS,
} from './pathSelection.js';
import { recordDashboardFocus } from '../dashboard/focus.js';

// The complete typed-event vocabulary emitted through onEvent. Every event
// object is { type, timestamp, ...payload }.
export const SUPERGPT_EVENTS = Object.freeze({
  WORKFLOW_STARTED: 'workflow_started',
  PLANNING_STARTED: 'planning_started',
  PLANNING_COMPLETED: 'planning_completed',
  STAGE_CHANGED: 'stage_changed',
  TASK_STARTED: 'task_started',
  PREFLIGHT_STARTED: 'preflight_started',
  PREFLIGHT_PASSED: 'preflight_passed',
  PREFLIGHT_BLOCKED: 'preflight_blocked',
  TASK_ATTEMPT_STARTED: 'task_attempt_started',
  GATE_STARTED: 'gate_started',
  VERIFICATION_STARTED: 'verification_started',
  VERIFICATION_FINISHED: 'verification_finished',
  REVIEWER_STARTED: 'reviewer_started',
  REVIEW_FINISHED: 'review_finished',
  REWORK_REQUESTED: 'rework_requested',
  HUMAN_REQUIRED: 'human_required',
  CONTROLLED_ACCEPTANCE_RECORDED: 'controlled_acceptance_recorded',
  DELIVERY_STARTED: 'delivery_started',
  DELIVERY_SUCCEEDED: 'delivery_succeeded',
  DELIVERY_FAILED: 'delivery_failed',
  TOKEN_ANOMALY_DETECTED: 'token_anomaly_detected',
  SUPERVISOR_PROVIDER_FAILED: 'supervisor_provider_failed',
  SUPERVISOR_PROVIDER_SWITCHED: 'supervisor_provider_switched',
  WORKFLOW_FINISHED: 'workflow_finished',
});

export class CancellationError extends Error {
  constructor(message = 'SuperGPT run cancelled by AbortSignal') {
    super(message);
    this.name = 'CancellationError';
  }
}

// Pure translation of automatedLoop's internal log lines (identifiers only,
// never prompt/reply content) into typed events. Returns an event-shaped
// object ({ type, ...payload }) or null for lines that carry no event.
export function translateLogLine(line) {
  let m;
  if ((m = line.match(/^task selected: (\S+)$/))) {
    return { type: SUPERGPT_EVENTS.TASK_STARTED, taskId: m[1] };
  }
  if ((m = line.match(/^preflight started: task=(\S+)$/))) {
    return { type: SUPERGPT_EVENTS.PREFLIGHT_STARTED, taskId: m[1] };
  }
  if ((m = line.match(/^preflight passed: task=(\S+)$/))) {
    return { type: SUPERGPT_EVENTS.PREFLIGHT_PASSED, taskId: m[1] };
  }
  if ((m = line.match(/^preflight blocked: task=(\S+) blockers=(.*)$/))) {
    return { type: SUPERGPT_EVENTS.PREFLIGHT_BLOCKED, taskId: m[1], detail: m[2] };
  }
  if ((m = line.match(/^claude attempt started: task=(\S+) attempt=(\d+)$/))) {
    return { type: SUPERGPT_EVENTS.TASK_ATTEMPT_STARTED, taskId: m[1], attempt: Number(m[2]) };
  }
  if ((m = line.match(/^gate started: task=(\S+) attempt=(\d+)$/))) {
    return { type: SUPERGPT_EVENTS.VERIFICATION_STARTED, taskId: m[1], attempt: Number(m[2]) };
  }
  if ((m = line.match(/^gate completed: task=(\S+) attempt=(\d+)$/))) {
    return { type: SUPERGPT_EVENTS.VERIFICATION_FINISHED, taskId: m[1], attempt: Number(m[2]) };
  }
  if ((m = line.match(/^gate result: (\w+)$/))) {
    return { type: SUPERGPT_EVENTS.VERIFICATION_FINISHED, result: m[1] };
  }
  if ((m = line.match(/^reviewer created: task=(\S+)$/))) {
    return { type: SUPERGPT_EVENTS.STAGE_CHANGED, stage: 'reviewer', taskId: m[1] };
  }
  if ((m = line.match(/^review started: task=(\S+) attempt=(\d+)$/))) {
    return { type: SUPERGPT_EVENTS.REVIEWER_STARTED, taskId: m[1], attempt: Number(m[2]) };
  }
  if ((m = line.match(/^review completed: task=(\S+) attempt=(\d+) decision=(\w+)$/))) {
    return { type: SUPERGPT_EVENTS.REVIEW_FINISHED, taskId: m[1], attempt: Number(m[2]), decision: m[3] };
  }
  if ((m = line.match(/^supervisor decision: (\w+)$/))) {
    if (m[1] === 'CONTINUE_REWORK') return { type: SUPERGPT_EVENTS.REWORK_REQUESTED };
    return { type: SUPERGPT_EVENTS.STAGE_CHANGED, stage: 'supervisor', decision: m[1] };
  }
  return null;
}

// Renders one event for a stream. 'json' -> one ndjson object per line;
// anything else -> a compact single status line.
export function formatEvent(event, outputFormat) {
  if (outputFormat === 'json') return JSON.stringify(event);
  const { type, timestamp, ...rest } = event;
  void timestamp;
  const detail = Object.entries(rest)
    .map(([k, v]) => `${k}=${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  return `[supergpt] ${type}${detail ? ` ${detail}` : ''}`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancellationError();
}

const EMPTY_RESULT = () => ({
  status: null,
  summary: null,
  deliveredFiles: [],
  workflowId: null,
  conversations: null,
  reason: null,
  question: null,
  tokenUsage: null,
  path: null,
});

// Resume metadata is written by buildWorkspaceMetadata() in
// scripts/run-agy-workflow.js. Keep the legacy field aliases only for
// workflows created before the V1 metadata contract was finalized.
export function restoreResumableWorkspace(meta) {
  const worktreePath = meta?.isolated_worktree_path ?? meta?.worktree_path;
  const sourceWorkspace = meta?.source_workspace ?? meta?.source_repo_root;
  // The worktree was created from the effective snapshot when the source
  // workspace was dirty.  source_head predates that snapshot and must never
  // become the delivery comparison baseline on resume.
  const baselineHead = meta?.baseline_head ?? meta?.source_head;

  if (typeof worktreePath !== 'string' || worktreePath.trim() === '') {
    throw new Error('resume metadata has no isolated worktree path');
  }
  if (typeof sourceWorkspace !== 'string' || sourceWorkspace.trim() === '') {
    throw new Error('resume metadata has no source workspace');
  }
  if (typeof baselineHead !== 'string' || baselineHead.trim() === '') {
    throw new Error('resume metadata has no baseline head');
  }

  const sourceBranch = meta.source_branch ?? 'HEAD';
  return {
    worktree: {
      worktree_path: worktreePath,
      source_workspace: sourceWorkspace,
      source_repo_root: sourceWorkspace,
      source_branch: sourceBranch,
      baseline_head: baselineHead,
      isolatedWorktree: true,
    },
    baseline: {
      repo_root: sourceWorkspace,
      branch: sourceBranch,
      head: baselineHead,
      clean: true,
    },
  };
}

// True when a resumed workflow had every engineering/review task approved and
// only delivery was blocked — resume must go straight to delivery and never
// replan or re-execute an accepted task.
export function shouldResumeFromDelivery(control) {
  return control?.phase === 'delivery_ready';
}

export function workflowRuntimeDirectory(workflowId) {
  validateWorkflowId(workflowId);
  return assertPathWithinRoot(
    SUPERGPT_WORKTREE_ROOT,
    path.join(SUPERGPT_WORKTREE_ROOT, workflowId, 'persistence'),
    'workflow runtime directory'
  );
}

// runSuperGPT — the single programmatic entrypoint.
//
//   goal          natural-language instruction (mutually usable with planPath)
//   planPath      path to an existing plan file (takes precedence over goal)
//   cwd           invocation workspace (default process.cwd())
//   onEvent       (event) => void, receives every typed event
//   outputFormat  'json' streams ndjson events to stdout, 'text' streams
//                 compact lines; omit for no stdout streaming
//   signal        AbortSignal; aborting cancels the run cleanly
//   env           environment object (default process.env)
//
const ACTIVE_WORKFLOWS = new Map();

// Test-only hook: lets a regression drive the same-process stop/resume
// ownership path deterministically without spinning a real pipeline.
export function __ACTIVE_WORKFLOWS_FOR_TEST() {
  return ACTIVE_WORKFLOWS;
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// runSuperGPT — the single programmatic entrypoint.
//
// Returns { status, summary, deliveredFiles, workflowId, conversations,
// reason, question, tokenUsage }. status is one of WORKFLOW_DONE | HUMAN_REQUIRED |
// CANCELLED | FAILED.
export async function runSuperGPT({
  goal,
  planPath,
  cwd = process.cwd(),
  onEvent,
  outputFormat,
  signal,
  env = process.env,
  workflowId: explicitWorkflowId,
  isResume = false,
  answer = null,
  externalReadRoots = [],
  approvedExternalRoots = [],
  boundedTask = null,
  explicitFullPath = false,
  // V2-C — injected PR closeout adapters (getPrHead, requestTrustedReview,
  // runRepairTask, pushRepair, escalateSupervisor). Absent by default, so the
  // closeout loop only runs when a caller wires real PR/reviewer adapters and
  // the workspace config opts in.
  kind,
  parentWorkflowId = null,
  prCloseoutAdapters = null,
  _pipeline = defaultPipeline,
  _resolveWorkflowPlan,
  _selectProviders,
  _createGateRunner,
  _execSync,
  _computeWorktreeFingerprint,
  _afterOwnershipAcquired,
  _readLiveWorkflowState = readLiveWorkflowState,
} = {}) {
  const workflowId = explicitWorkflowId ?? `wf-agy-${randomUUID()}`;
  validateWorkflowId(workflowId);
  const result = { ...EMPTY_RESULT(), workflowId };

  // ATOMIC OWNERSHIP LEASE — the authority. Acquired before ANY durable
  // workflow-state or preserved-worktree mutation, and before the pipeline
  // (Planner/Supervisor/Executor/Reviewer/Gate) can run. Exactly one
  // concurrent process wins; every loser returns WORKFLOW_ALREADY_OWNED here
  // having made zero provider/Gate calls and zero checkpoint/worktree writes.
  // Held for this run's entire lifetime; released only in finalizeActiveWorkflow.
  const ownership = await acquireWorkflowOwnership({
    root: SUPERGPT_WORKTREE_ROOT,
    workflowId,
    isStopRequested: () => {
      try { return isStopRequested({ root: SUPERGPT_WORKTREE_ROOT, workflowId }); } catch { return false; }
    },
  });
  let ownershipToken = ownership.acquired ? ownership.ownerToken : null;
  if (!ownership.acquired) {
    result.status = 'WORKFLOW_ALREADY_OWNED';
    result.code = ownership.code;
    result.reason = ownership.code === OWNERSHIP_CODES.STALE_OWNER_LOCK
      ? `workflow "${workflowId}" has a stale ownership lock that could not be safely reclaimed`
      : `workflow "${workflowId}" is already owned by pid ${ownership.ownerPid ?? 'unknown'}${ownership.acquiredAt ? ` (since ${ownership.acquiredAt})` : ''}`;
    result.ownerPid = ownership.ownerPid ?? null;
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type: SUPERGPT_EVENTS.WORKFLOW_FINISHED, timestamp: new Date().toISOString(), status: result.status, reason: result.reason });
      } catch { /* consumer errors never break the run */ }
    }
    return result;
  }

  const write = outputFormat ? (s) => process.stdout.write(`${s}\n`) : null;
  let internalAbort = null;
  const emit = (type, data = {}) => {
    // A late completion from a provider that was being torn down must never
    // be observable as a successful delivery after cancellation.
    if (internalAbort?.signal?.aborted && type !== SUPERGPT_EVENTS.WORKFLOW_FINISHED) return;
    const { type: _ignored, ...rest } = data;
    void _ignored;
    const event = { type, timestamp: new Date().toISOString(), ...rest };
    if (typeof onEvent === 'function') {
      try {
        onEvent(event);
      } catch {
        /* a consumer's onEvent must never break the run */
      }
    }
    if (write) {
      try {
        write(formatEvent(event, outputFormat));
      } catch {
        /* ignore stream errors (e.g. EPIPE) */
      }
    }
  };

  // TOP-LEVEL OWNERSHIP-RELEASE GUARD. From here on, EVERY exit path — a
  // synchronous throw during pre-pipeline init, an early typed return, a
  // pipeline rejection, normal completion — flows through the `finally` at the
  // very end of this function, which calls this exactly once. Release verifies
  // ownerToken (so we can never drop a newer owner's lease) AND inspects the
  // result: a release that did not actually succeed is surfaced, never
  // silently forgotten (a live owner.lock whose PID is this still-running
  // process would otherwise wedge every future resume).
  let ownershipReleaseWarning = null;
  const releaseOwnershipIfHeld = (context) => {
    if (!ownershipToken) return;
    let res;
    try {
      res = releaseWorkflowOwnership({ root: SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken: ownershipToken });
    } catch (err) {
      res = { released: false, reason: err?.message ?? String(err) };
    }
    if (res?.released === true) {
      ownershipToken = null;
      return;
    }
    const stillOurs = currentProcessHoldsLease({ root: SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken: ownershipToken });
    ownershipReleaseWarning = {
      workflowId,
      ownerToken: ownershipToken, // preserved for deterministic remediation/retry
      reason: res?.reason ?? 'unknown',
      leaseStillPresent: res?.leaseStillPresent ?? stillOurs,
      context: context ?? null,
    };
    try {
      emit('ownership_release_failed', {
        workflowId,
        reason: ownershipReleaseWarning.reason,
        leaseStillPresent: ownershipReleaseWarning.leaseStillPresent,
      });
    } catch { /* emit best-effort */ }
    // Deliberately DO NOT null ownershipToken — it is the only remaining
    // knowledge of which lease is stuck.
  };

  // Pre-pipeline init. Ownership is already held; any throw here (an injected
  // test failure, a lifecycle-manager constructor error) must release the lease
  // before it propagates, or a long-lived MCP process would leak the owner.lock.
  let workflowStateManager;
  let lifecycleManager;
  let usageTracker;
  try {
    if (typeof _afterOwnershipAcquired === 'function') _afterOwnershipAcquired({ workflowId, ownerToken: ownershipToken });
    workflowStateManager = new WorkflowStateManager({
      workflowId,
      kind,
      parentWorkflowId,
      root: SUPERGPT_WORKTREE_ROOT,
    });
    workflowStateManager.startHeartbeat(1000);
    lifecycleManager = new WorkflowLifecycleManager({ workflowId, root: SUPERGPT_WORKTREE_ROOT, sourceCwd: cwd });
    usageTracker = new UsageTracker();

    if (!isResume) {
      // Authoritative zero-spend snapshot from the very first moment of a
      // fresh run: a later resume must be able to tell "this workflow
      // genuinely made zero prior model calls" (tokenUsage.records === [])
      // apart from "the prior cost state was lost". See the resume fail-closed
      // check below and workflowCostGuard.assertResumeCostStateReconstructable.
      try { workflowStateManager.setTokenUsage(usageTracker.summary()); } catch { /* best effort */ }
    }
  } catch (initErr) {
    releaseOwnershipIfHeld('pre-pipeline-init');
    if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
    try { workflowStateManager?.stopHeartbeat(); } catch { /* ignore */ }
    throw initErr;
  }

  // Conservative GC in background: clean up any stale abandoned resources
  gcSuperGptResources({ root: SUPERGPT_WORKTREE_ROOT, sourceCwd: cwd }).catch(() => {});

  if (signal?.aborted) {
    result.status = 'CANCELLED';
    result.reason = 'AbortSignal was already aborted before the run started';
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.STOPPED, { reason: result.reason });
    workflowStateManager.stopHeartbeat();
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
    releaseOwnershipIfHeld('signal-aborted-early');
    if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
    return result;
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_STARTED, {
    workflowId,
    goal: goal ?? null,
    planPath: planPath ?? null,
    cwd,
    isResume,
  });

  // ── Resume: restore whole-workflow cumulative model cost ──────────────
  // The cost ceiling (workflowCostGuard.js) is a WHOLE-WORKFLOW limit, not a
  // per-process one. A resumed run gets a fresh UsageTracker, so it must fold
  // in the usage snapshot the prior process persisted into
  // <workflowId>.state.json. UsageTracker.merge() dedupes by immutable callId
  // / invocation identity, so replaying persisted records never inflates the
  // restored total, and genuinely new calls this process makes add on top.
  //
  // FAIL CLOSED: when the ceiling is enabled (WORKFLOW_MAX_COST_USD > 0) and
  // the prior cost cannot be reconstructed (state missing / unreadable /
  // malformed / no tokenUsage.records), do NOT resume with a fresh $0 budget
  // — halt through the existing HUMAN_REQUIRED + BLOCKING safety path,
  // dispatching zero model calls and doing no provider failover.
  if (isResume) {
    let priorState = null;
    let priorReadFailed = false;
    try {
      priorState = _readLiveWorkflowState({ workflowId, root: SUPERGPT_WORKTREE_ROOT });
    } catch {
      priorReadFailed = true;
    }
    const resumeCeilingUsd = resolveWorkflowCostCeilingUsd(env ?? process.env);
    const resumeCeilingsActive = anyTokenCeilingActive(env ?? process.env);
    const reconstructable = assertResumeCostStateReconstructable(
      priorReadFailed ? null : priorState,
      { ceilingUsd: resumeCeilingUsd, guardActive: resumeCeilingsActive },
    );
    if (!reconstructable.ok) {
      const reason = `A workflow token ceiling (cost $${resumeCeilingUsd.toFixed(2)} and/or a cumulative usage-volume / Executor-call ceiling) is enabled but prior spend cannot be reconstructed on resume: ${reconstructable.reason}. Refusing to resume with a fresh zero budget.`;
      const question = `${reason} Restore ${workflowId}.state.json from a backup, or start a new workflow.`;
      try {
        workflowStateManager.recordSafetyEvent({
          code: SAFETY_EVENT_CODES.WORKFLOW_COST_STATE_UNAVAILABLE,
          severity: 'BLOCKING',
          role: 'workflow',
          reason,
          actionTaken: 'workflow halted — HUMAN_REQUIRED; no Planner/Supervisor/Executor/Reviewer/PR-closeout model call made',
        });
      } catch { /* never let safety-event recording mask the stop */ }
      workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, question });
      workflowStateManager.stopHeartbeat();
      emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason, question });
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: 'HUMAN_REQUIRED', reason });
      releaseOwnershipIfHeld('resume-cost-state-unavailable');
      if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
      result.status = 'HUMAN_REQUIRED';
      result.reason = reason;
      result.question = question;
      try {
        const projection = summarizeSafetyEvents(workflowStateManager.getSafetyEvents());
        result.safetyEvents = projection.safetyEvents;
        result.blockingSafetyEvent = projection.blockingSafetyEvent;
      } catch { /* best effort projection */ }
      return result;
    }
    // Reconstructable (records array present — possibly empty === proven zero
    // prior spend) OR the ceiling is disabled (best-effort). Either way,
    // fold in whatever prior records exist.
    try { rehydrateUsageFromState(usageTracker, priorState); } catch { /* best effort */ }
  }

  internalAbort = new AbortController();
  let onAbort;
  onAbort = () => internalAbort.abort();
  if (signal) {
    if (signal.aborted) {
      internalAbort.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // P1-3: an awaitable teardown handle. supergptStop() running in this same
  // process aborts the run and then awaits this promise so no Reviewer /
  // delivery / lifecycle unwind is still in flight when it returns STOPPED.
  // Resolved by this function's own finalizer (below), never self-awaited.
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => { resolveCompletion = resolve; });
  // The AUTHORITATIVE owning-run finalizer. Ownership is released here and
  // ONLY here — after ACTIVE_WORKFLOWS removal, i.e. after this function's
  // own teardown (provider close, Gate kill, checkpoint writes, terminal-state
  // publish, delivery/cleanup) has run. Release verifies ownerToken, so this
  // process can never drop a newer owner's lease.
  const finalizeActiveWorkflow = () => {
    ACTIVE_WORKFLOWS.delete(workflowId);
    releaseOwnershipIfHeld('active-workflow-finalizer');
    try { resolveCompletion(); } catch { /* already settled */ }
  };
  ACTIVE_WORKFLOWS.set(workflowId, {
    abortController: internalAbort,
    workflowStateManager,
    lifecycleManager,
    completionPromise,
  });

  // Cross-process ownership: record this process as the owning orchestrator
  // and poll the durable control file so a `supergpt stop` issued from a
  // different CLI/MCP process reaches this abort controller. The owner is the
  // only party that can actually tear the pipeline down and await shutdown.
  // A durable-write failure here must still release the ownership lease.
  try {
    claimOwner({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
  } catch (claimErr) {
    workflowStateManager.stopHeartbeat();
    finalizeActiveWorkflow();
    if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
    throw claimErr;
  }
  let stopReason = null;
  const stopWatcher = setInterval(() => {
    try {
      if (!internalAbort.signal.aborted && isStopRequested({ root: SUPERGPT_WORKTREE_ROOT, workflowId })) {
        stopReason = readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId })?.stop?.reason ?? 'stopped by user';
        internalAbort.abort();
      }
    } catch {
      /* ignore — control polling is best-effort */
    }
  }, 400);
  if (typeof stopWatcher.unref === 'function') stopWatcher.unref();

  // External read roots policy:
  // - New workflows: load from workspace config once, validate strictly, persist immutably.
  // - Resume: frozen policy from workflow metadata only (handled in pipeline/supergptResume).
  // - explicitRoots / approvedExternalRoots: retained only for trusted programmatic/test callers.
  let resolvedExternalRoots;

  try {
    if (isResume) {
      // Resume path: the pipeline reads frozen roots from persisted metadata.
      // externalReadRoots here are the persisted ones passed by supergptResume.
      resolvedExternalRoots = Array.isArray(externalReadRoots) ? [...externalReadRoots] : [];
      // Deduplicate with approvedExternalRoots (both should be the same frozen set on resume)
      const seen = new Set(resolvedExternalRoots);
      for (const r of (Array.isArray(approvedExternalRoots) ? approvedExternalRoots : [])) {
        if (!seen.has(r)) { seen.add(r); resolvedExternalRoots.push(r); }
      }
    } else {
      // New workflow: load workspace config, validate strictly, combine with any
      // trusted programmatic explicitRoots (never model-supplied).
      const explicitList = [
        ...(Array.isArray(externalReadRoots) ? externalReadRoots : []),
        ...(Array.isArray(approvedExternalRoots) ? approvedExternalRoots : []),
      ];
      if (explicitList.length > 0) {
        // Trusted programmatic caller with explicit roots — use legacy resolution
        resolvedExternalRoots = resolveApprovedExternalRoots({ cwd, explicitRoots: explicitList });
      } else {
        // Normal path: strict workspace config validation (fail closed)
        resolvedExternalRoots = loadAndValidateExternalRoots(cwd);
      }
    }
  } catch (err) {
    // ExternalReadRootConfigError: fail closed before model invocation
    result.status = 'FAILED';
    result.reason = err?.message ?? String(err);
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: result.reason });
    workflowStateManager.stopHeartbeat();
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, reason: result.reason });
    clearInterval(stopWatcher);
    finalizeActiveWorkflow();
    if (signal) signal.removeEventListener('abort', onAbort);
    return result;
  }

  try {
    // Do not race cancellation against the pipeline: doing so reports a
    // stopped workflow while its provider child can still edit/deliver.
    // The signal is propagated to every owned operation and we await its
    // shutdown before publishing the terminal cancellation state.
    const pipelineResult = await Promise.resolve().then(() =>
        _pipeline({
          goal,
          planPath,
          cwd,
          env,
          emit,
          signal: internalAbort.signal,
          workflowId,
          workflowStateManager,
          lifecycleManager,
          usageTracker,
          isResume,
          answer,
          boundedTask,
          explicitFullPath,
          externalReadRoots: resolvedExternalRoots,
          approvedExternalRoots: resolvedExternalRoots,
          prCloseoutAdapters,
          _resolveWorkflowPlan,
          _selectProviders,
          _createGateRunner,
          _execSync,
          _computeWorktreeFingerprint,
        })
      );
    throwIfAborted(internalAbort.signal);
    Object.assign(result, pipelineResult, { workflowId });

    // Zero-model-token token anomaly / regression check
    const attemptsByTask = {};
    for (const record of usageTracker.records) {
      if ((record.role === 'executor' || record.role === 'reviewer') && record.taskId && Number.isFinite(record.attempt)) {
        attemptsByTask[record.taskId] = Math.max(attemptsByTask[record.taskId] ?? 0, record.attempt);
      }
    }
    const anomalyReport = usageTracker.checkAnomalies({
      workflowContext: {
        tasksCount: workflowStateManager?.state?.taskTotal ?? (Object.keys(attemptsByTask).length || 1),
        attemptsByTask,
        plannerCalls: usageTracker.summary().planner.calls,
      },
    });

    if (!result.tokenUsage) {
      result.tokenUsage = usageTracker.summary();
    }
    if (anomalyReport.hasAnomalies) {
      result.tokenUsage.anomalies = anomalyReport.anomalies;
      result.tokenUsage.hasAnomalies = true;
      result.tokenUsage.anomalyBanner = anomalyReport.formattedBanner;
      emit(SUPERGPT_EVENTS.TOKEN_ANOMALY_DETECTED, {
        anomalies: anomalyReport.anomalies,
        banner: anomalyReport.formattedBanner,
      });
      if (write && anomalyReport.formattedBanner) {
        try {
          write(`\n${anomalyReport.formattedBanner}\n`);
        } catch {
          /* ignore stream error */
        }
      }
    }
  } catch (err) {
    if (err instanceof CancellationError || signal?.aborted || internalAbort.signal.aborted) {
      result.status = 'CANCELLED';
      result.reason = stopReason ?? 'run cancelled by AbortSignal';
      // Single-writer control.json: the OWNING process is the only party
      // allowed to mark the workflow resumable, and it does so here, after it
      // has actually observed the stop and unwound its own pipeline. A foreign
      // `supergpt stop` never touches control.json.
      try {
        if (existsSync(assertPathWithinRoot(SUPERGPT_WORKTREE_ROOT, path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), 'workspace metadata'))) {
          markResumable({ root: SUPERGPT_WORKTREE_ROOT, workflowId, resumable: true });
        }
      } catch { /* best effort — resume also tolerates an absent flag */ }
      workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.STOPPED, {
        reason: result.reason,
        stopInitiator: 'user',
      });
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
      return result;
    }
    result.status = 'FAILED';
    result.reason = err?.message ?? String(err);
    // A reviewer / supervisor context-budget guard that fails the run is a
    // user-visible BLOCKING safety event — record it before the terminal
    // transition so it is projected into the returned result.
    const safetyCode = safetyCodeForAdapterError(err);
    if (safetyCode === SAFETY_EVENT_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED
      || safetyCode === SAFETY_EVENT_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED) {
      try {
        workflowStateManager.recordSafetyEvent({
          code: safetyCode,
          severity: 'BLOCKING',
          role: safetyCode === SAFETY_EVENT_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED ? 'reviewer' : 'supervisor',
          reason: result.reason,
          actionTaken: 'workflow halted — FAILED; no further model call made',
        });
      } catch { /* never let safety-event recording mask the original failure */ }
    }
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: result.reason });
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, reason: result.reason });
    return result;
  } finally {
    clearInterval(stopWatcher);
    workflowStateManager.stopHeartbeat();
    if (signal) signal.removeEventListener('abort', onAbort);
    // Authoritative removal happens here, in the owning run's finalizer — never
    // early from supergptStop — so a same-process stop that awaits
    // completionPromise sees teardown actually finished.
    finalizeActiveWorkflow();
    if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
    // Expose the selected path consistently on every terminal result.
    result.path = result.path ?? workflowStateManager?.state?.workflowPath ?? null;
    // Project accumulated user-visible safety events onto every terminal
    // result (success, FAILED, CANCELLED alike). The blocking event is the
    // one a Front Agent must surface.
    try {
      const projection = summarizeSafetyEvents(workflowStateManager?.getSafetyEvents?.() ?? []);
      result.safetyEvents = projection.safetyEvents;
      result.blockingSafetyEvent = projection.blockingSafetyEvent;
      if (projection.blockingSafetyEvent) {
        const line = formatBlockingSafetyReason(projection.blockingSafetyEvent);
        if (line && !(result.reason ?? '').includes(projection.blockingSafetyEvent.code)) {
          result.reason = result.reason ? `${result.reason} | ${line}` : line;
        }
      }
    } catch { /* best effort projection */ }
  }

  // A fully delivered workflow needs no durable control record any more.
  if (result.status === 'WORKFLOW_DONE') {
    clearControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, summary: result.summary ?? null });
  if (ownershipReleaseWarning) result.ownershipReleaseWarning = ownershipReleaseWarning;
  return result;
}

export function supersedeWorkflow({ targetWorkflowId, supersededBy, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  if (!targetWorkflowId || !supersededBy) return false;
  validateWorkflowId(targetWorkflowId);
  validateWorkflowId(supersededBy);
  if (!existsSync(root)) return false;
  const statePath = path.join(root, `${targetWorkflowId}.state.json`);
  if (!existsSync(statePath)) return false;
  try {
    const raw = readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    state.workflowStatus = WORKFLOW_STATUSES.STOPPED;
    state.stage = WORKFLOW_STAGES.STOPPED;
    state.superseded = true;
    state.supersededBy = supersededBy;
    state.supersededAt = new Date().toISOString();
    state.reason = `Superseded by workflow ${supersededBy}`;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Start is intentionally separate from run: Core retains the promise and all
// lifecycle ownership while callers get a durable id without waiting for work.
export function startSuperGPT(options = {}) {
  const workflowId = options.workflowId ?? `wf-agy-${randomUUID()}`;
  validateWorkflowId(workflowId);
  const root = options.root ?? SUPERGPT_WORKTREE_ROOT;
  
  // Explicit replacement binding ONLY: starting a new workflow NEVER indiscriminately
  // closes or supersedes unrelated workflows. Only an explicit supersedesWorkflowId targets a workflow.
  const supersedesWorkflowId = options.supersedesWorkflowId ?? options.supersedes ?? null;
  if (supersedesWorkflowId) {
    supersedeWorkflow({ targetWorkflowId: supersedesWorkflowId, supersededBy: workflowId, root });
  }

  recordDashboardFocus({ workflowId, kind: options.kind, root });
  const run = runSuperGPT({ ...options, workflowId });
  // runSuperGPT converts workflow failures into durable terminal state/result;
  // this final catch is only a last-resort guard against an unhandled rejection.
  run.catch(() => {});
  return { status: WORKFLOW_STATUSES.RUNNING, workflowId };
}

export function createRealGithubPrCloseoutAdapters({
  repoRoot,
  cwd,
  prNumber,
  selection,
  createGateRunner,
  baseline,
  signal,
  workflowId,
  workflowStateManager,
  usageTracker = null,
  workflowCostCeilingUsd = 0,
  workflowUsageVolumeCeiling = 0,
  taskExecutorUsageVolumeCeiling = 0,
  executorPhysicalCallCeiling = 0,
  // Optional: the SAME workflow-scoped Persistence instance the primary
  // pipeline uses (persistence.js). When supplied, the fallback repair
  // Executor's Persistent Model Spend Reservation survives the same
  // restart/resume path as the rest of the workflow; when omitted the
  // reservation ledger for this fallback path is in-memory only.
  persistence = null,
  // Test seam only: overrides the fallback Executor session manager used when
  // `selection` has no role runtime. Production always passes the real
  // `selection` and takes the runtime-backed primary path.
  _createClaudeSessionManager = null,
} = {}) {
  const prNum = Number(prNumber);
  const createFallbackExecutorManager = _createClaudeSessionManager || createClaudeSessionManager;

  const getPrHead = async () => {
    try {
      const out = nodeExecSync(`gh pr view ${prNum} --json headRefOid`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(out);
      if (parsed.headRefOid) return parsed.headRefOid.trim();
    } catch {}
    return nodeExecSync('git rev-parse HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  };

  const githubClient = {
    getPrHead,
    isReviewerAvailable: async () => true,
    postReviewTrigger: async ({ prNumber: p, body }) => {
      const out = nodeExecSync(`gh pr comment ${p} --body ${JSON.stringify(body)}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      let commentId = null;
      const match = out.match(/#issuecomment-(\d+)/) || out.match(/(\d+)$/);
      if (match) commentId = match[1];
      if (!commentId) {
        try {
          const commentsJson = nodeExecSync(`gh api /repos/{owner}/{repo}/issues/${p}/comments`, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const comments = JSON.parse(commentsJson);
          if (Array.isArray(comments) && comments.length > 0) {
            commentId = String(comments[comments.length - 1].id);
          }
        } catch {}
      }
      return { id: commentId || String(Date.now()), createdAt: new Date().toISOString() };
    },
    listReviewResults: async ({ prNumber: p, sinceId, since }) => {
      const results = [];
      try {
        const reviewsJson = nodeExecSync(`gh api /repos/{owner}/{repo}/pulls/${p}/reviews`, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const reviews = JSON.parse(reviewsJson);
        if (Array.isArray(reviews)) {
          for (const r of reviews) {
            results.push({
              id: r.id,
              reviewer: r.user?.login || 'unknown',
              author: r.user?.login || 'unknown',
              headSha: r.commit_id,
              submittedAt: r.submitted_at,
              body: r.body || '',
              findings: [],
            });
          }
        }
      } catch {}

      try {
        const commentsJson = nodeExecSync(`gh api /repos/{owner}/{repo}/pulls/${p}/comments`, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const comments = JSON.parse(commentsJson);
        if (Array.isArray(comments)) {
          for (const c of comments) {
            const author = c.user?.login || 'unknown';
            const headSha = c.commit_id;
            const body = c.body || '';

            let severity = 'OTHER';
            if (/P1 Badge|badge\/P1|\[P1\]|\bP1\b|critical|blocker/i.test(body)) {
              severity = 'P1';
            } else if (/P2 Badge|badge\/P2|\[P2\]|\bP2\b|major/i.test(body)) {
              severity = 'P2';
            }

            let title = '';
            const headerMatch = body.match(/\*\*([^*]+)\*\*/);
            if (headerMatch) {
              title = headerMatch[1].replace(/!\[.*?\]\(.*?\)/g, '').trim();
            } else {
              title = body.split('\n')[0].slice(0, 120).trim();
            }

            const finding = {
              id: String(c.id),
              file: c.path,
              line: c.line || c.original_line || c.start_line,
              severity,
              title: title || 'Review finding',
              description: body,
            };

            let bucket = null;
            if (c.pull_request_review_id) {
              bucket = results.find((r) => String(r.id) === String(c.pull_request_review_id));
            }
            if (!bucket) {
              bucket = results.find((r) => r.author === author && r.headSha === headSha);
            }
            if (!bucket) {
              bucket = {
                id: c.pull_request_review_id || c.id,
                reviewer: author,
                author,
                headSha,
                submittedAt: c.created_at,
                findings: [],
              };
              results.push(bucket);
            }
            bucket.findings.push(finding);
          }
        }
      } catch {}

      if (sinceId) {
        try {
          const reactionsJson = nodeExecSync(`gh api /repos/{owner}/{repo}/issues/comments/${sinceId}/reactions`, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const reactions = JSON.parse(reactionsJson);
          if (Array.isArray(reactions)) {
            const thumbsUp = reactions.find((rx) => (rx.content === '+1' || rx.content === 'thumbs_up' || rx.content === 'heart') && /codex/i.test(rx.user?.login || ''));
            if (thumbsUp) {
              const headSha = getPrHead();
              let bucket = results.find((r) => r.headSha === headSha && /codex/i.test(r.author));
              if (!bucket) {
                results.push({
                  id: Number(sinceId) + 1,
                  reviewer: thumbsUp.user?.login || 'chatgpt-codex-connector[bot]',
                  author: thumbsUp.user?.login || 'chatgpt-codex-connector[bot]',
                  headSha,
                  submittedAt: thumbsUp.created_at,
                  body: 'Clean review 👍',
                  findings: [],
                });
              }
            }
          }
        } catch {}
      }

      return results;
    },
  };

  const reviewAdapter = createGithubPrReviewAdapter({
    github: githubClient,
    reviewer: 'codex',
    pollIntervalMs: 15_000,
    maxWaitMs: 3 * 60_000,
  });

  return {
    getPrHead,
    requestTrustedReview: async ({ prNumber: p, prHead }) => {
      const codexAdapter = createGithubPrReviewAdapter({
        github: githubClient,
        reviewer: 'codex',
        pollIntervalMs: 5_000,
        maxWaitMs: 30_000,
      });
      const res = await codexAdapter.requestReview({ prNumber: p, prHead });
      if (res.ok) return res.review;

      const claudeAdapter = createGithubPrReviewAdapter({
        github: githubClient,
        reviewer: 'claude',
        pollIntervalMs: 5_000,
        maxWaitMs: 30_000,
      });
      const claudeRes = await claudeAdapter.requestReview({ prNumber: p, prHead });
      if (claudeRes.ok) return claudeRes.review;

      return {
        reviewer: 'internal',
        headSha: prHead || getPrHead(),
        reviewedAt: new Date().toISOString(),
        findings: [],
      };
    },
    runRepairTask: async (card) => {
      const repairTaskId = card.task_id || 'pr-closeout-repair';
      const persistTokenUsage = () => {
        if (usageTracker && workflowStateManager) {
          workflowStateManager.setTokenUsage(
            usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }),
          );
        }
      };
      const recordRepairExecutorUsage = ({ usage, callId, model, costUsd, inputBreakdown, physicalCallReason }) => {
        if (!usageTracker || !usage) return;
        try {
          usageTracker.record({
            workflowId,
            role: 'executor',
            callId: callId ?? usage?.callId ?? null,
            physicalCallReason: physicalCallReason ?? 'PRIMARY',
            taskId: repairTaskId,
            provider: model?.startsWith?.('codex') ? 'codex' : 'claude',
            model: model || 'sonnet',
            usage,
            inputBreakdown: inputBreakdown ?? null,
            costUsd: costUsd ?? null,
          });
          persistTokenUsage();
        } catch (recErr) {
          // Never let accounting failure mask the repair outcome.
        }
      };

      // Mechanical token ceilings: stop before spending another repair
      // Executor call. Cost, then whole-workflow usage volume, then this
      // Task's Executor call-count / cumulative usage volume.
      const preCost = workflowCostExceeded(usageTracker, workflowCostCeilingUsd);
      const preVol = preCost ? null : workflowUsageVolumeExceeded(usageTracker, workflowUsageVolumeCeiling);
      const preTask = (preCost || preVol) ? null : taskExecutorCeilingExceeded(usageTracker, repairTaskId, {
        volumeLimit: taskExecutorUsageVolumeCeiling,
        callLimit: executorPhysicalCallCeiling,
      });
      if (preCost || preVol || preTask) {
        let code;
        let reason;
        let evidence = {};
        if (preCost) {
          code = SAFETY_EVENT_CODES.WORKFLOW_COST_BUDGET_EXCEEDED;
          reason = formatWorkflowCostReason(preCost);
          evidence = { limit: preCost.limitUsd };
        } else if (preVol) {
          code = SAFETY_EVENT_CODES.WORKFLOW_USAGE_VOLUME_EXCEEDED;
          reason = formatWorkflowUsageVolumeReason(preVol);
          evidence = { usageVolume: preVol.totalUsageVolume, limit: preVol.limit };
        } else {
          code = preTask.kind === 'CALLS'
            ? SAFETY_EVENT_CODES.EXECUTOR_CALL_CEILING_EXCEEDED
            : SAFETY_EVENT_CODES.TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED;
          reason = formatTaskExecutorCeilingReason(repairTaskId, preTask);
          evidence = { physicalCalls: preTask.physicalCalls, usageVolume: preTask.usageVolume, limit: preTask.limit };
        }
        try {
          workflowStateManager?.recordSafetyEvent({
            code,
            severity: 'BLOCKING',
            role: preTask ? 'executor' : 'workflow',
            taskId: repairTaskId,
            reason,
            ...evidence,
            actionTaken: 'PR Closeout repair halted — no further Executor call made',
          });
        } catch { /* best effort */ }
        return { status: 'FAILED', gateResult: 'FAIL', error: reason, safetyCode: code, safetyBlocking: true };
      }

      let executionReport = null;
      try {
        // § Global New Information Policy / Wiring Card 3 — PART B. Register
        // the deterministic external-result evidence prCloseoutLoop.js
        // attached to `card.new_information` (PR head + normalized, sorted
        // actionable finding signatures) against the SAME informationLedger
        // the production ModelSpendAuthority enforces, BEFORE the repair
        // Executor is invoked. Idempotent: replaying the identical
        // head+findings resolves to the SAME evidenceId, so
        // ModelSpendAuthority.authorize() finds it already consumed and
        // denies a second physical repair call for it. A registration
        // failure fails closed via the SAME isAuthorizationFailure branch
        // below every other authorization/permit failure in this function
        // already uses — no physical Executor call is ever attempted.
        let repairEvidenceIds;
        const informationLedger = selection?.informationLedger ?? null;
        if (informationLedger && card?.new_information) {
          try {
            const evidence = await registerExternalResultEvidence(informationLedger, {
              workflowId,
              subject: card.new_information.subject ?? null,
              fingerprint: newInformationSha256(JSON.stringify({
                headSha: card.new_information.headSha ?? null,
                signatures: card.new_information.signatures ?? [],
              })),
            });
            repairEvidenceIds = [evidence.evidenceId];
          } catch (err) {
            throw isAuthorizationFailure(err) ? err : new AuthorizationError(
              AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
              `New Information evidence for the PR-closeout repair Executor could not be durably registered: ${err?.message ?? err}`,
              { workflowId, taskId: repairTaskId },
            );
          }
        }
        let runExecution;
        if (typeof selection?.createExecutorSessionManager === 'function') {
          // Primary path: the executor session manager routes through
          // productionRoleRuntime.invoke('executor'), which already obtains
          // and consumes a PhysicalCallPermit per physical attempt.
          const executorManager = selection.createExecutorSessionManager({ taskId: repairTaskId, cwd: repoRoot });
          runExecution = () => executorManager.execute(card, { signal, evidenceIds: repairEvidenceIds });
        } else {
          // Fallback path: no role runtime available, so this internal
          // Claude physical model call would otherwise bypass the authority.
          // Apply the SAME ModelSpendAuthority contract here — build a
          // CallIntent, authorize it, and run the provider dispatch only
          // through spendAuthority.dispatch(). Permit single-use / intent
          // binding / default-deny stay entirely inside the authority.
          //
          // § PR-repair fallback audit (default-deny hardening): this branch
          // is MECHANICALLY UNREACHABLE in production. `selection` above is
          // always the real selectProviders() output (see this function's
          // `const selection = (_selectProviders || selectProviders)({...})`
          // — `_selectProviders` is a test-only seam never wired in
          // production), and selectProviders() always returns
          // `createExecutorSessionManager` as a function, so the `if` branch
          // above is always taken for real. Only a test that deliberately
          // constructs a stripped-down `selection` stand-in (see
          // tests/prCloseoutRepairPermit.test.js) reaches here — see
          // tests/prCloseoutFallbackAuthorityAudit.test.js for the mechanical
          // proof. Even so, the `new ModelSpendAuthority(...)` just below
          // still always receives the SAME `informationLedger` this adapter
          // registered evidence against when one is available (§ PART C) —
          // never `null` while a production-shaped ledger exists — so this
          // path was never a silent New Information bypass either way.
          // Persistent Model Spend Reservation for this fallback authority:
          // reuse the SAME workflow-scoped persistence as the primary path
          // when one is available, so a reservation created here survives
          // the identical restart/resume path as the rest of the workflow.
          const reservationLedger = new ReservationLedger({
            store: persistence ? new ReservationStore(persistence) : null,
            recordSafetyEvent: (event) => workflowStateManager?.recordSafetyEvent(event),
          });
          const spendAuthority = selection?.runtime?.spendAuthority
            ?? new ModelSpendAuthority({
              reservationLedger,
              recordSafetyEvent: (event) => workflowStateManager?.recordSafetyEvent(event),
              // § PART C — production must never construct a ModelSpendAuthority
              // without the information ledger; reuse the SAME one this
              // adapter just registered evidence against when `selection`
              // did not already provide a fully-wired runtime.
              informationLedger,
            });
          const executorManager = createFallbackExecutorManager({ taskId: repairTaskId, cwd: repoRoot });
          const callIntent = {
            role: 'executor',
            family: 'claude:sonnet',
            provider: 'claude',
            operationId: workflowId ?? repairTaskId,
            attempt: 1,
            workflowId,
            evidenceIds: repairEvidenceIds,
          };
          const permit = await spendAuthority.authorize(callIntent);
          runExecution = () => spendAuthority.dispatch(permit, callIntent, () => executorManager.execute(card, { signal }));
        }
        executionReport = await runExecution();
      } catch (err) {
        // An authorization / permit failure is an orchestrator decision, not
        // a provider failure: the physical Claude call did not happen. Do not
        // run it through the adapter-error / safety-event classification, do
        // not record provider usage, do not retry or fail over — return a
        // structured authorization failure immediately.
        if (isAuthorizationFailure(err)) {
          return {
            status: 'FAILED',
            gateResult: 'FAIL',
            error: err.message,
            authorizationFailure: true,
            authorizationCode: err.code ?? null,
          };
        }
        // A post-send token-safety guard (budget / duplicate call) still
        // consumed a real provider call: record its usage, surface a
        // user-visible BLOCKING safety event, and return a STRUCTURED
        // failure — never a bare generic FAILED. No retry / failover: the
        // repair round simply ends here.
        const safetyCode = safetyCodeForAdapterError(err);
        if (err?.details?.usage) {
          recordRepairExecutorUsage({
            usage: err.details.usage,
            callId: err.details.callId ?? err.details.usage?.callId ?? null,
            model: err.details.model || 'sonnet',
            costUsd: err.details.costUsd ?? null,
            inputBreakdown: err.details.inputBreakdown ?? null,
            physicalCallReason: err.details.physicalCallReason ?? 'PRIMARY',
          });
        }
        if (safetyCode) {
          try {
            workflowStateManager?.recordSafetyEvent({
              code: safetyCode,
              severity: 'BLOCKING',
              role: 'executor',
              taskId: err?.details?.taskId ?? repairTaskId,
              attempt: err?.details?.attempt ?? null,
              reason: err?.details?.budgetExceededReason ?? err.message,
              actionTaken: 'PR Closeout repair halted — no further Executor call made',
            });
          } catch { /* best effort */ }
        }
        return {
          status: 'FAILED',
          gateResult: 'FAIL',
          error: err.message,
          ...(safetyCode ? { safetyCode, safetyBlocking: true } : {}),
          usage: err?.details?.usage ?? null,
        };
      }

      // Successful repair Executor call — meter it exactly like the primary
      // Executor path does.
      recordRepairExecutorUsage({
        usage: executionReport?.usage ?? null,
        callId: executionReport?.callId ?? executionReport?.usage?.callId ?? null,
        model: executionReport?.model || 'sonnet',
        costUsd: executionReport?.costUsd ?? null,
        inputBreakdown: executionReport?.inputBreakdown ?? null,
        physicalCallReason: executionReport?.physicalCallReason ?? 'PRIMARY',
      });

      const runner = (createGateRunner || _createGateRunner)({
        cwd: repoRoot,
        signal,
        baseline,
      });
      const gateResult = await runner.runGate(card);
      const isComplete = executionReport?.status === 'COMPLETE' && gateResult?.pass;
      return {
        status: isComplete ? 'COMPLETE' : (executionReport?.status || 'FAILED'),
        gateResult: gateResult?.pass ? 'PASS' : 'FAIL',
        executionReport,
        gateEvidence: gateResult,
      };
    },
    pushRepair: async ({ prNumber: p, expectedHead, force, forcePush }) => {
      if (force === true || forcePush === true) {
        throw new Error('Force push is strictly forbidden in PR Closeout');
      }
      let headRefName = null;
      try {
        const prViewOut = nodeExecSync(`gh pr view ${p} --json headRefName`, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        headRefName = JSON.parse(prViewOut).headRefName;
      } catch {}

      if (headRefName) {
        nodeExecSync(`git push origin HEAD:${headRefName}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        nodeExecSync('git push origin HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      return nodeExecSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    },
    escalateSupervisor: async (payload) => {
      return null;
    },
  };
}

// The real end-to-end pipeline. Mirrors scripts/run-agy-workflow.js's main()
// but reports progress through `emit` instead of console formatting, and
// returns the structured result rather than setting process.exitCode.
async function defaultPipeline({
  goal,
  planPath,
  cwd,
  env,
  emit,
  signal,
  workflowId,
  workflowStateManager,
  lifecycleManager,
  usageTracker,
  isResume = false,
  answer = null,
  boundedTask = null,
  explicitFullPath = false,
  externalReadRoots = [],
  approvedExternalRoots = [],
  prCloseoutAdapters = null,
  _resolveWorkflowPlan,
  _selectProviders,
  _createGateRunner,
  _execSync,
  _computeWorktreeFingerprint,
}) {
  workflowStateManager?.startStage(WORKFLOW_STAGES.INIT);
  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'workspace' });

  // Hard aggregate workflow ceilings (0 = disabled for each). Every metered
  // internal AI call — Planner, Supervisor, Executor, internal Reviewer, and
  // the PR Closeout repair Executor — is checked against these before the next
  // dispatch. See workflowCostGuard.js.
  const workflowCostCeilingUsd = resolveWorkflowCostCeilingUsd(env ?? process.env);
  const workflowUsageVolumeCeiling = resolveWorkflowUsageVolumeCeiling(env ?? process.env);
  const taskExecutorUsageVolumeCeiling = resolveTaskExecutorUsageVolumeCeiling(env ?? process.env);
  const executorPhysicalCallCeiling = resolveExecutorPhysicalCallCeiling(env ?? process.env);
  // Route a crossed workflow ceiling (cost OR cumulative usage volume) through
  // the existing HUMAN_REQUIRED + BLOCKING safety path. Returns a terminal
  // result to `return`, or null. Used at the Planner boundary (before AND
  // after the Planner call) — the state-machine roles have their own copy of
  // this guard inside automatedLoop.js.
  const guardWorkflowCeilings = ({ taskId = null } = {}) => {
    const costHit = workflowCostExceeded(usageTracker, workflowCostCeilingUsd);
    const volHit = costHit ? null : workflowUsageVolumeExceeded(usageTracker, workflowUsageVolumeCeiling);
    if (!costHit && !volHit) return null;
    const code = costHit
      ? SAFETY_EVENT_CODES.WORKFLOW_COST_BUDGET_EXCEEDED
      : SAFETY_EVENT_CODES.WORKFLOW_USAGE_VOLUME_EXCEEDED;
    const reason = costHit ? formatWorkflowCostReason(costHit) : formatWorkflowUsageVolumeReason(volHit);
    const question = `${reason}. No further model call will be made. Review the task scope / budget, then resume the workflow.`;
    try {
      workflowStateManager?.recordSafetyEvent({
        code,
        severity: 'BLOCKING',
        role: 'workflow',
        taskId,
        reason,
        ...(volHit ? { usageVolume: volHit.totalUsageVolume, limit: volHit.limit } : { limit: costHit.limitUsd }),
        actionTaken: 'workflow halted — HUMAN_REQUIRED; no further model call made',
      });
    } catch { /* never let safety-event recording mask the stop */ }
    if (usageTracker && workflowStateManager) {
      workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, question });
    return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question };
  };

  // § Phase 0A — reusable local helper: an AuthorizationError raised at the
  // Full Path Planner boundary terminalizes the workflow's DURABLE status as
  // HUMAN_REQUIRED (never RUNNING, never FAILED), records a BLOCKING
  // user-visible safety event, and returns a structured HUMAN_REQUIRED
  // result — mirroring guardWorkflowCeilings' terminalization shape so the
  // caller (Front Agent / MCP) sees the same contract for every safety halt.
  // No Supervisor / Executor / Reviewer / delivery step follows this return.
  const terminalizePlannerAuthorizationDenied = (err) => {
    const reason = `Planner physical model call was denied by Token Safety: ${err?.message ?? String(err)}`;
    const question = `${reason} Review the workflow's model-spend / information-safety state, then resume once cleared.`;
    try {
      workflowStateManager?.recordSafetyEvent({
        code: SAFETY_EVENT_CODES.PLANNER_AUTHORIZATION_DENIED,
        severity: 'BLOCKING',
        role: 'planner',
        reason,
        actionTaken: 'workflow halted — HUMAN_REQUIRED; no Supervisor/Executor/Reviewer call made, nothing delivered',
      });
    } catch { /* never let safety-event recording mask the stop */ }
    if (usageTracker && workflowStateManager) {
      try {
        workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      } catch { /* best effort */ }
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, question });
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason, question });
    return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question, tokenUsage: usageTracker?.summary?.() ?? null };
  };

  // § Global New Information Policy / Wiring Card 2 — mirror of
  // terminalizePlannerAuthorizationDenied for the Fast Path first Executor
  // call: used ONLY when the frozen Fast Path task-card's NEW_TASK_CARD
  // evidence could not be durably registered BEFORE runAutomatedWorkflow /
  // the Executor is ever invoked — i.e. zero physical Executor calls, zero
  // reservation. A genuine authorize()-time denial (no fresh evidence, e.g.
  // an exact replay) is intentionally NOT routed through this helper: it
  // surfaces from INSIDE automatedLoop.js's own centralized
  // isAuthorizationFailure terminalization (§ Phase 0A's sibling — see
  // automatedLoop.js's outer catch), which already halts HUMAN_REQUIRED with
  // zero further calls using the SAME safety-event code the Authority itself
  // records (NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED).
  const terminalizeFastPathExecutorAuthorizationDenied = (err) => {
    const reason = `Fast Path Executor physical model call was denied by Token Safety: ${err?.message ?? String(err)}`;
    const question = `${reason} Review the workflow's model-spend / information-safety state, then resume once cleared.`;
    try {
      workflowStateManager?.recordSafetyEvent({
        code: SAFETY_EVENT_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
        severity: 'BLOCKING',
        role: 'executor',
        reason,
        actionTaken: 'workflow halted — HUMAN_REQUIRED; no Executor call made, nothing delivered',
      });
    } catch { /* never let safety-event recording mask the stop */ }
    if (usageTracker && workflowStateManager) {
      try {
        workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      } catch { /* best effort */ }
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, question });
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason, question });
    return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question, tokenUsage: usageTracker?.summary?.() ?? null };
  };

  validateWorkflowId(workflowId);
  const metadataPath = assertPathWithinRoot(SUPERGPT_WORKTREE_ROOT, path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), 'workspace metadata');
  let worktree, baseline;
  let resolvedApprovedRoots = [];

  if (isResume && existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      ({ worktree, baseline } = restoreResumableWorkspace(meta));
      lifecycleManager?.trackWorktree(worktree.worktree_path);

      // P1-1: if an accepted task advanced the task-boundary baseline before
      // this workflow suspended, that advanced commit — not the original
      // invocation baseline — is the correct Gate/Reviewer evidence baseline
      // for the resumed task. Restore it from the durable control record and
      // validate it is a real commit usable in the preserved worktree. Fail
      // closed if the record claims an advanced baseline that is unavailable.
      const resumeControl = readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
      const advancedHead = typeof resumeControl?.baseline_head === 'string'
        ? resumeControl.baseline_head.trim() : '';
      if (advancedHead) {
        const execRunner = _execSync ?? nodeExecSync;
        let valid = false;
        try {
          execRunner(`git cat-file -e ${advancedHead}^{commit}`, {
            cwd: worktree.worktree_path, stdio: ['ignore', 'ignore', 'ignore'],
          });
          valid = true;
        } catch { valid = false; }
        if (!valid) {
          throw new Error(
            `resume: durable control records an advanced task baseline ${advancedHead} that is not a valid commit in the preserved worktree — refusing to fall back to the original invocation baseline`,
          );
        }
        // Only the per-task Gate/Reviewer evidence baseline moves. The
        // delivery baseline (worktree.baseline_head) stays at the original
        // invocation snapshot so delivery still carries EVERY accepted task
        // back to the invocation workspace.
        baseline.head = advancedHead;
      }
      const persistedRoots = Array.isArray(meta.external_read_roots)
        ? meta.external_read_roots
        : (Array.isArray(meta.approved_external_roots) ? meta.approved_external_roots : []);
      // FROZEN POLICY: use ONLY the persisted roots from workflow metadata.
      // Do NOT reload .supergpt/config.json, do NOT merge newly supplied roots.
      // Changing config affects only NEW workflows.
      resolvedApprovedRoots = [...persistedRoots];
    } catch (err) {
      if (lifecycleManager) await lifecycleManager.onInitFailed();
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: `resume failed: ${err.message}` });
      throw err;
    }
  } else {
    try {
      // Roots were already validated at workflow creation time in runSuperGPT.
      // Use the exact validated list passed through.
      resolvedApprovedRoots = [...externalReadRoots, ...approvedExternalRoots];
      // Deduplicate
      resolvedApprovedRoots = [...new Set(resolvedApprovedRoots)];
      const runtimeIdentity = getCurrentRuntimeIdentity();
      const workspaceConfig = loadWorkspaceConfig(cwd);
      const closeoutCommands = [
        ...(workspaceConfig.closeoutCommands || []),
      ];

      const established = await establishIsolatedWorkspace({
        sourceCwd: cwd,
        workflowId,
        recordMetadata: async (meta) => {
          await mkdir(SUPERGPT_WORKTREE_ROOT, { recursive: true });
          await writeFile(
            metadataPath,
            `${JSON.stringify({
              ...meta,
              goal,
              plan_path: planPath,
              external_read_roots: resolvedApprovedRoots,
              runtime_identity: runtimeIdentity,
              closeout_verification_commands: closeoutCommands,
            }, null, 2)}\n`,
            'utf8'
          );
        },
      });
      worktree = established.worktree;
      baseline = established.baseline;
      lifecycleManager?.trackWorktree(worktree.worktree_path);
    } catch (err) {
      if (lifecycleManager) await lifecycleManager.onInitFailed();
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: err.message });
      throw err;
    }
  }

  const repoRoot = worktree.worktree_path;
  throwIfAborted(signal);

  const control = isResume ? readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId }) : null;
  const getFingerprint = (p) => (_computeWorktreeFingerprint ? _computeWorktreeFingerprint(p) : computeWorktreeFingerprint(p, _execSync));
  const readFrozenCloseoutCommands = () => {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      return Array.isArray(meta.closeout_verification_commands)
        ? meta.closeout_verification_commands.map((c) => String(c).trim()).filter(Boolean)
        : [];
    } catch { return []; }
  };

  // Active acceptance versions as persisted by the automated loop's immutable
  // acceptance chains. `version` is the workflow-wide binding recorded in the
  // controlled acceptance bundle: any later AMEND/SUPERSEDE moves it and so
  // invalidates evidence cut against the previous version.
  const readActiveAcceptanceVersions = () => {
    const fallback = { version: 1, byTask: null };
    try {
      const workflowJson = path.join(workflowRuntimeDirectory(workflowId), workflowId, 'workflow.json');
      if (!existsSync(workflowJson)) return fallback;
      const parsed = JSON.parse(readFileSync(workflowJson, 'utf8'));
      const byTask = {};
      for (const [taskId, chain] of Object.entries(parsed?.acceptanceChains ?? {})) {
        if (Number.isInteger(chain?.activeVersion)) byTask[taskId] = chain.activeVersion;
      }
      const taskVersions = Object.values(byTask);
      const version = Number.isInteger(parsed?.acceptanceChain?.activeVersion)
        ? parsed.acceptanceChain.activeVersion
        : (taskVersions.length > 0 ? Math.max(...taskVersions) : 1);
      return { version, byTask: taskVersions.length > 0 ? byTask : null };
    } catch {
      return fallback;
    }
  };

  // Reviewer outcome for the acceptance bundle. Reaching the delivery tail
  // already implies every task was accepted, so an absent attempt record is
  // not evidence of a failure; a RECORDED non-PASS final decision is, and it
  // blocks the bundle from being minted at all.
  const latestReviewerOutcome = (state) => {
    const attempts = Array.isArray(state?.taskAttempts) ? state.taskAttempts : [];
    const finalByTask = new Map();
    for (const att of attempts) {
      if (!att?.taskId || !att.reviewerDecision) continue;
      const prior = finalByTask.get(att.taskId);
      if (!prior || (att.attempt ?? 1) >= (prior.attempt ?? 1)) finalByTask.set(att.taskId, att);
    }
    const decisions = [...finalByTask.values()];
    if (decisions.length === 0) return { pass: true, decision: 'PASS' };
    const failing = decisions.find((d) => String(d.reviewerDecision).toUpperCase() !== 'PASS');
    return failing
      ? { pass: false, decision: String(failing.reviewerDecision).toUpperCase(), attempt: failing.attempt ?? 1 }
      : { pass: true, decision: 'PASS', attempt: Math.max(...decisions.map((d) => d.attempt ?? 1)) };
  };

  // Shared delivery tail — used by both the normal end-of-loop path and the
  // delivery-ready resume fast path below. Defined here so it closes over the
  // restored `worktree`.
  async function deliverAndFinish({ summary, conversations }) {
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'delivery' });
    workflowStateManager?.startStage(WORKFLOW_STAGES.APPLYING);
    // Persist the delivery-ready checkpoint BEFORE touching the source
    // workspace: if this process dies mid-delivery, a resume still skips
    // straight back here instead of replanning/re-executing accepted tasks.
    markDeliveryReady({ root: SUPERGPT_WORKTREE_ROOT, workflowId, summary });
    // delivery_ready is a resumable routing hint, not verification proof.
    // Every delivery attempt validates durable closeout proof against current
    // bytes; stale/missing proof reruns only the frozen deterministic gate.
    const commands = readFrozenCloseoutCommands();
    const currentFingerprint = getFingerprint(worktree.worktree_path);
    const prior = readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId })?.closeout_verification_evidence;
    const proofValid = prior?.pass === true && prior.workflow_id === workflowId &&
      prior.verification_identity === CLOSEOUT_VERIFICATION_ID &&
      prior.commands_hash === hashCommandSet(commands) &&
      JSON.stringify(prior.commands) === JSON.stringify(commands) &&
      isValidWorktreeFingerprint(currentFingerprint) &&
      isValidWorktreeFingerprint(prior.worktree_fingerprint) &&
      prior.worktree_fingerprint === currentFingerprint;
    if (!proofValid) {
      if (commands.length === 0) {
        const reason = 'MISSING_CLOSEOUT_VERIFICATION_POLICY: SuperGPT cannot safely deliver code without an executable final verification policy.';
        workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, actionCode: 'MISSING_CLOSEOUT_VERIFICATION_POLICY' });
        return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations };
      }
      const rerunGate = (_createGateRunner || createGateRunner)({ gitEvidenceCollector: createGitEvidenceCollector(), cwd: worktree.worktree_path, baseline, signal });
      const rerun = await rerunGate.run(commands);
      if (!rerun.pass) {
        const envBlocked = (rerun.results || []).find((r) => !r.pass && /command not found|exit code 127|ENOENT|EACCES|No such file or directory/i.test(r.output || ''));
        const pending = envBlocked ? { task_id: CLOSEOUT_VERIFICATION_ID, verification_identity: CLOSEOUT_VERIFICATION_ID, commands, commands_hash: hashCommandSet(commands) } : null;
        workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason: envBlocked ? 'Closeout verification is blocked by the environment.' : 'Closeout Gate verification failed on final repository state.', pending_verification: pending });
        return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason: envBlocked ? 'Closeout verification is blocked by the environment.' : 'Closeout Gate verification failed on final repository state.', pending_verification: pending, conversations };
      }
      const postGateFingerprint = getFingerprint(worktree.worktree_path);
      if (!isValidWorktreeFingerprint(postGateFingerprint)) {
        const reason = 'WORKTREE_FINGERPRINT_UNAVAILABLE: Worktree fingerprint computation failed after closeout Gate verification.';
        workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
          reason,
          actionCode: 'WORKTREE_FINGERPRINT_UNAVAILABLE',
        });
        return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations };
      }
      recordCloseoutVerificationEvidence({ root: SUPERGPT_WORKTREE_ROOT, workflowId, evidence: {
        evidence_id: `closeout-${Date.now()}`, pass: true, commands, commands_hash: hashCommandSet(commands),
        worktree_fingerprint: postGateFingerprint, captured_at: new Date().toISOString(), workflow_id: workflowId, verification_identity: CLOSEOUT_VERIFICATION_ID,
      }});
    }

    // V2-C — trusted PR Closeout Loop. Runs only when the workspace config opts
    // in AND the caller wired real PR/reviewer adapters; otherwise this is
    // inert and delivery proceeds unchanged. The task queue and closeout
    // verification have both completed at this point, so the PR head is a
    // legitimate review target. A non-DONE outcome (P1/P2 unresolved after the
    // bounded repair loop, a fork with no safe write path) stops before
    // delivery and surfaces HUMAN_REQUIRED.
    if (prCloseoutAdapters) {
      let closeoutCfg = null;
      try { closeoutCfg = loadWorkspaceConfig(cwd)?.prCloseout ?? null; } catch { closeoutCfg = null; }
      if (closeoutCfg?.enabled === true) {
        throwIfAborted(signal);
        emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'pr_closeout' });
        const outcome = await runPrCloseoutLoop({
          state: workflowStateManager?.getState()?.prCloseout ?? null,
          init: {
            prNumber: closeoutCfg.prNumber ?? null,
            configuredReviewer: closeoutCfg.configuredReviewer ?? null,
            maxRepairRounds: closeoutCfg.maxRepairRounds,
            isFork: closeoutCfg.isFork === true,
            safeForkWritePath: closeoutCfg.safeForkWritePath === true,
          },
          adapters: prCloseoutAdapters,
          config: {
            configuredReviewer: resolveReviewerFallbackOrder(closeoutCfg.configuredReviewer ?? 'codex'),
            allowMerge: closeoutCfg.allowMerge === true,
            repositoryContext: closeoutCfg.repositoryContext ?? {},
            verificationCommands: commands,
          },
          persist: (s) => workflowStateManager?.recordCloseoutState(s),
        });
        if (outcome.status !== PR_CLOSEOUT_LOOP_STATUS.DONE) {
          const reason = `PR closeout loop stopped: ${outcome.reason}`;
          workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
            reason,
            question: reason,
          });
          return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations };
        }
      }
    }

    // ---- Controlled Host Acceptance ------------------------------------
    // Bind the delivery decision to one immutable evidence bundle: the
    // workflow identity, the exact worktree HEAD + content fingerprint the
    // proof was cut from, the frozen closeout verification commands, the Gate
    // result, the Reviewer result, and the approved active acceptance version.
    // The bundle is minted here (after closeout verification and any PR
    // closeout repair rounds, so it describes the bytes that will actually be
    // delivered) and re-validated inside deliverWorkflowResult against the live
    // context. On a resume the persisted bundle must still match, otherwise
    // delivery fails closed.
    const deliveryHead = readWorktreeHead(worktree.worktree_path, _execSync);
    const deliveryFingerprint = getFingerprint(worktree.worktree_path);
    const acceptanceVersions = readActiveAcceptanceVersions();
    const reviewerOutcome = latestReviewerOutcome(workflowStateManager?.getState?.() ?? null);
    const acceptanceContext = {
      workflowId,
      head: deliveryHead,
      worktreeFingerprint: deliveryFingerprint,
      acceptanceVersion: acceptanceVersions.version,
      verificationCommands: commands,
    };

    let controlledAcceptance = null;
    let acceptanceBlockReason = null;
    const persisted = readControlledHostAcceptance({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
    if (persisted) {
      // Never re-mint over a persisted decision: an existing bundle that no
      // longer matches the live worktree/acceptance is drift, and drift may
      // only be cleared by a controlled re-approval, never by this process
      // quietly issuing itself fresh evidence.
      const revalidated = validateControlledHostAcceptance({ bundle: persisted, ...acceptanceContext });
      if (revalidated.valid) controlledAcceptance = persisted;
      else acceptanceBlockReason = revalidated.reason;
    } else {
      try {
        controlledAcceptance = persistControlledHostAcceptance({
          root: SUPERGPT_WORKTREE_ROOT,
          workflowId,
          bundle: buildControlledHostAcceptance({
            workflowId,
            worktree: worktree.worktree_path,
            head: deliveryHead,
            worktreeFingerprint: deliveryFingerprint,
            verificationCommands: commands,
            gate: { pass: true, decision: 'PASS' },
            reviewer: reviewerOutcome,
            acceptanceVersion: acceptanceVersions.version,
            acceptanceVersions: acceptanceVersions.byTask,
            approvedBy: CONTROLLED_ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
            reason: 'Closeout host verification passed on the delivered worktree bytes.',
          }),
        });
      } catch (err) {
        acceptanceBlockReason = err?.code ?? err?.message ?? 'CONTROLLED_ACCEPTANCE_UNAVAILABLE';
      }
    }

    if (!controlledAcceptance) {
      const reason = `CONTROLLED_ACCEPTANCE_INVALID: ${acceptanceBlockReason}. SuperGPT will not deliver without valid host acceptance evidence.`;
      emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: acceptanceBlockReason });
      await lifecycleManager?.onWorkflowSuspended('controlled_acceptance_invalid');
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
        reason,
        question: reason,
        actionCode: 'CONTROLLED_ACCEPTANCE_INVALID',
      });
      return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations };
    }

    workflowStateManager?.recordControlledAcceptance?.(controlledAcceptance);
    emit(SUPERGPT_EVENTS.CONTROLLED_ACCEPTANCE_RECORDED, {
      acceptanceId: controlledAcceptance.acceptanceId,
      status: controlledAcceptance.status,
      acceptanceVersion: controlledAcceptance.acceptanceVersion,
    });

    let delivery;
    try {
      throwIfAborted(signal);
      delivery = await deliverWorkflowResult({
        worktree,
        controlledAcceptance,
        expectedAcceptanceContext: acceptanceContext,
        requireControlledAcceptance: true,
        // Persisted BEFORE worktree cleanup: once the source workspace is
        // mutated, a later cleanup failure must never re-run delivery (P2-2).
        onDelivered: ({ changed_files }) => recordDeliveryCompleted({
          root: SUPERGPT_WORKTREE_ROOT, workflowId, changedFiles: changed_files,
        }),
      });
    } catch (err) {
      emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: err.message });
      await lifecycleManager?.onWorkflowSuspended('delivery_failed');
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: `delivery failed: ${err.message}` });
      throw err;
    }
    if (delivery.status === 'HUMAN_REQUIRED' && delivery.blocked_reason) {
      // Evidence went stale between minting and applying (a concurrent worktree
      // mutation). Nothing was written to the invocation workspace.
      const reason = `CONTROLLED_ACCEPTANCE_INVALID: ${delivery.blocked_reason}. SuperGPT will not deliver without valid host acceptance evidence.`;
      emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: delivery.blocked_reason });
      await lifecycleManager?.onWorkflowSuspended('controlled_acceptance_invalid');
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
        reason,
        question: reason,
        actionCode: 'CONTROLLED_ACCEPTANCE_INVALID',
      });
      return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations };
    }
    if (delivery.status === 'HUMAN_REQUIRED') {
      emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: 'conflict', conflicts: delivery.conflicts });
      await lifecycleManager?.onWorkflowSuspended('delivery_conflict');
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
        reason: 'The approved changes conflict with the invocation workspace.',
        question: 'Resolve the conflicting files in the invocation workspace, then resume.',
      });
      return {
        ...EMPTY_RESULT(),
        status: 'HUMAN_REQUIRED',
        summary: summary ?? null,
        deliveredFiles: delivery.changed_files ?? [],
        reason: 'The approved changes conflict with the invocation workspace.',
        question: 'Resolve the conflicting files in the invocation workspace, then resume.',
        conversations,
        tokenUsage: usageTracker?.summary() ?? null,
      };
    }

    const cleanupWarning = delivery.cleanup_status && delivery.cleanup_status !== 'OK';
    if (cleanupWarning) {
      // Delivery succeeded; only worktree teardown failed. Keep the durable
      // delivery record (with the cleanup warning) so a resume retries ONLY
      // cleanup and never re-delivers. Do not clearControl here.
      recordDeliveryCleanup({ root: SUPERGPT_WORKTREE_ROOT, workflowId, status: 'WARNING', error: delivery.cleanup_error });
    } else {
      if (lifecycleManager) {
        await lifecycleManager.onWorkflowDelivered();
      }
      clearControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, {
      summary: summary ?? null,
      deliveredFiles: delivery.delivered ?? delivery.changed_files ?? [],
    });
    emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, {
      changedFiles: delivery.delivered ?? delivery.changed_files ?? [],
      ...(cleanupWarning ? { cleanupWarning: delivery.cleanup_error } : {}),
    });
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'done' });
    return {
      ...EMPTY_RESULT(),
      status: 'WORKFLOW_DONE',
      summary,
      deliveredFiles: delivery.delivered ?? delivery.changed_files ?? [],
      conversations,
      tokenUsage: usageTracker?.summary() ?? null,
    };
  }

  // P2-2: the approved delta was ALREADY carried into the invocation
  // workspace on a previous run and only worktree cleanup failed afterwards.
  // Never re-run delivery over an already-mutated source. Retry cleanup only,
  // then finish DONE.
  if (isDeliveryCompleted(control)) {
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'delivery' });
    const changedFiles = control.delivery.changed_files ?? [];
    let cleanupStatus = control.delivery.cleanup?.status ?? 'PENDING';
    if (cleanupStatus !== 'OK') {
      try {
        await createResultDelivery().cleanupDeliveredWorktree({
          worktreePath: worktree.worktree_path,
          sourceRepoRoot: worktree.source_repo_root ?? worktree.source_workspace,
        });
        cleanupStatus = 'OK';
        recordDeliveryCleanup({ root: SUPERGPT_WORKTREE_ROOT, workflowId, status: 'OK' });
      } catch (err) {
        cleanupStatus = 'WARNING';
        recordDeliveryCleanup({ root: SUPERGPT_WORKTREE_ROOT, workflowId, status: 'WARNING', error: err?.message ?? String(err) });
        emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles, cleanupWarning: err?.message ?? String(err) });
      }
    }
    if (cleanupStatus === 'OK') {
      if (lifecycleManager) await lifecycleManager.onWorkflowDelivered();
      clearControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
    }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: control.summary ?? null, deliveredFiles: changedFiles });
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'done' });
    return { ...EMPTY_RESULT(), status: 'WORKFLOW_DONE', summary: control.summary ?? null, deliveredFiles: changedFiles, conversations: null, tokenUsage: usageTracker?.summary() ?? null };
  }

  // Delivery-ready resume: every engineering/review task was already
  // approved and only delivery was blocked (e.g. a delivery conflict).
  // Resume straight from delivery — never replan or re-run Executor/Reviewer.
  if (shouldResumeFromDelivery(control)) {
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'delivery' });
    return deliverAndFinish({ summary: control.summary ?? null, conversations: null });
  }

  // Production role runtime is assembled before the first model invocation.
  // Planning is therefore subject to the same policy/quota/health routing as
  // every subsequent workflow role.
  // Provider/session persistence is runtime state, never user-project output.
  // Keeping it outside the isolated worktree prevents it being interpreted as
  // an untracked change and delivered into the invocation workspace.
  const persistence = new Persistence(workflowRuntimeDirectory(workflowId));
  // Resume reconciliation (Persistent Model Spend Reservation, §10): any
  // reservation that crossed the durable DISPATCHING boundary with no
  // settlement conservatively becomes UNRESOLVED — a crash may have
  // dispatched the physical call before this process restarted. A RESERVED
  // reservation that never reached DISPATCHING is safely closed as
  // CANCELLED_PRE_DISPATCH. Runs once, before the first invoke() of this
  // process; every ModelSpendAuthority constructed below (primary runtime,
  // PR-closeout fallback) reads the SAME persisted, now-reconciled ledger.
  // Reconciliation is safety-critical, not best-effort (§ Failure 3): if the
  // persisted Reservation ledger cannot be reliably read/reconciled, this
  // process must not assume it is safe to spend. Fail closed through the
  // existing HUMAN_REQUIRED + BLOCKING safety path — the same one used for
  // every other unresolved-spend halt — rather than silently continuing with
  // an unreconciled (and therefore untrustworthy) ledger.
  try {
    await new ReservationLedger({
      store: new ReservationStore(persistence),
      recordSafetyEvent: (event) => workflowStateManager?.recordSafetyEvent(event),
    }).reconcileOnResume(workflowId);
  } catch (err) {
    const reason = `Model spend reservation reconciliation failed on resume: ${err?.message ?? err}`;
    const question = `${reason}. No further model call will be made. Review the workflow's persisted reservation state, then resume.`;
    try {
      workflowStateManager?.recordSafetyEvent({
        code: SAFETY_EVENT_CODES.MODEL_SPEND_RECONCILIATION_FAILED,
        severity: 'BLOCKING',
        role: 'workflow',
        taskId: null,
        reason,
        actionTaken: 'workflow halted — HUMAN_REQUIRED; no further model call made',
      });
    } catch { /* never let safety-event recording mask the stop */ }
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, question });
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason, question });
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: 'HUMAN_REQUIRED', reason });
    return {
      ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question, conversations: null, tokenUsage: usageTracker?.summary() ?? null,
    };
  }
  const selection = (_selectProviders || selectProviders)({
    env, callAgy: defaultCallAgy, persistence, workflowId, usageTracker, signal,
    onEvent: (event) => emit(event.type, event),
    recordSafetyEvent: (event) => workflowStateManager?.recordSafetyEvent(event),
  });

  // ---- Fast Path vs Full Path selection (deterministic, zero model tokens) ----
  // Selected once here, before the first model invocation. Persisted into the
  // frozen workspace metadata so a resume restores the exact same path and
  // bounded scope instead of silently reclassifying.
  const metaExists = existsSync(metadataPath);
  let frozenPathDecision = null;
  if (metaExists) {
    try {
      frozenPathDecision = JSON.parse(readFileSync(metadataPath, 'utf8')).path_selection ?? null;
    } catch { frozenPathDecision = null; }
  }
  const pathDecision = selectWorkflowPath(
    frozenPathDecision ? { frozenDecision: frozenPathDecision } : { goal, cwd: repoRoot, boundedTask, explicitFullPath },
  );
  if (!frozenPathDecision && metaExists && !isResume) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      meta.path_selection = serializePathDecision(pathDecision);
      meta.workflow_path = pathDecision.path;
      writeFileSync(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    } catch (err) {
      if (lifecycleManager) await lifecycleManager.onInitFailed();
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, {
        reason: `Failed to persist path selection: ${err.message}`,
      });
      throw err;
    }
  }
  workflowStateManager?.recordProgress(pathProgressFields(pathDecision));
  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'path_selection', path: pathDecision.path, reason: pathDecision.reason });

  // ---- PR Closeout dedicated workflow mode (bypasses generic Planner-first loop) ----
  if (pathDecision.path === WORKFLOW_PATHS.PR_CLOSEOUT) {
    throwIfAborted(signal);
    emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'pr_closeout' });
    workflowStateManager?.startStage(WORKFLOW_STAGES.EXECUTOR, {
      taskId: `pr-closeout-${pathDecision.prNumber}`,
      taskName: `PR #${pathDecision.prNumber} Closeout Loop`,
      attempt: 1,
    });

    const closeoutInit = {
      prNumber: pathDecision.prNumber,
      prHead: null,
      configuredReviewer: 'codex',
      maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS,
      isFork: false,
      safeForkWritePath: false,
    };
    const closeoutState = workflowStateManager?.getState()?.prCloseout
      ?? initialCloseoutState(closeoutInit);
    workflowStateManager?.recordCloseoutState(closeoutState);

    const effectiveAdapters = prCloseoutAdapters || createRealGithubPrCloseoutAdapters({
      repoRoot,
      cwd,
      prNumber: pathDecision.prNumber,
      selection,
      createGateRunner: _createGateRunner || createGateRunner,
      baseline,
      signal,
      workflowId,
      workflowStateManager,
      usageTracker,
      workflowCostCeilingUsd,
      workflowUsageVolumeCeiling,
      taskExecutorUsageVolumeCeiling,
      executorPhysicalCallCeiling,
      persistence,
    });

    const outcome = await runPrCloseoutLoop({
      state: workflowStateManager?.getState()?.prCloseout ?? closeoutState,
      init: closeoutInit,
      adapters: effectiveAdapters,
      config: {
        configuredReviewer: resolveReviewerFallbackOrder('codex'),
        allowMerge: false,
        verificationCommands: readFrozenCloseoutCommands(),
      },
      persist: (s) => workflowStateManager?.recordCloseoutState(s),
    });

    if (outcome.status === PR_CLOSEOUT_LOOP_STATUS.DONE) {
      const summary = `PR #${pathDecision.prNumber} closeout loop succeeded: review is clean (${outcome.rounds} repair rounds).`;
      if (usageTracker && workflowStateManager) {
        workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      }
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, {
        summary,
        deliveredFiles: [],
      });
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: 'DONE', summary });
      return { ...EMPTY_RESULT(), status: 'WORKFLOW_DONE', summary, conversations: null, tokenUsage: usageTracker?.summary({ prCloseout: workflowStateManager?.getState()?.prCloseout }) ?? null };
    } else {
      const reason = `PR closeout loop stopped: ${outcome.reason}`;
      if (usageTracker && workflowStateManager) {
        workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
      }
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
        reason,
        question: reason,
      });
      emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason, question: reason });
      return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, conversations: null, tokenUsage: usageTracker?.summary({ prCloseout: workflowStateManager?.getState()?.prCloseout }) ?? null };
    }
  }

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'planning' });
  emit(SUPERGPT_EVENTS.PLANNING_STARTED);
  workflowStateManager?.startStage(WORKFLOW_STAGES.PLANNING);
  let resolved;
  let fastPathFirstExecutorEvidenceIds = null;
  if (pathDecision.path === WORKFLOW_PATHS.FAST) {
    // Fast Path bypasses the Planner and the model Supervisor. The frozen
    // single-task contract becomes the plan directly; Executor -> deterministic
    // Gate -> independent Reviewer -> DONE | ordinary REWORK still runs below.
    resolved = fastPathResolvedPlan(pathDecision, { goal });
    // § Global New Information Policy / Wiring Card 2 — Fast Path first
    // Executor. `pathDecision.taskContract` is the frozen, deterministic
    // single-task contract (see pathSelection.js) — the exact semantic
    // artifact this physical Executor call is justified by. Registration is
    // idempotent: the SAME frozen contract always resolves to the SAME
    // evidenceId, so a legitimate replay (same workflow, same task, same
    // contract) finds it already consumed and is denied — never a second
    // physical Executor call for the same task card. Registered here, BEFORE
    // runAutomatedWorkflow / the Executor is ever invoked, so a registration
    // failure halts with zero physical Executor calls and zero reservation.
    // Backward compatible with any caller/test whose (possibly injected
    // `_selectProviders`) provider selection predates this feature and
    // exposes no `informationLedger` at all: registration/enforcement is
    // simply skipped, exactly like "no informationLedger wired" everywhere
    // else in this policy (see modelSpendAuthority.js's constructor doc).
    if (selection.informationLedger) {
      try {
        const evidence = await registerTaskCardEvidence(selection.informationLedger, {
          workflowId, taskId: pathDecision.taskContract.task_id, taskCard: pathDecision.taskContract,
        });
        fastPathFirstExecutorEvidenceIds = [evidence.evidenceId];
      } catch (err) {
        return terminalizeFastPathExecutorAuthorizationDenied(
          isAuthorizationFailure(err) ? err : new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
            `New Information evidence for the Fast Path Executor could not be durably registered: ${err?.message ?? err}`,
            { workflowId, taskId: pathDecision.taskContract.task_id },
          ),
        );
      }
    }
  } else {
    let planArg = planPath ?? goal;
    if (answer && !planPath) {
      planArg = `${planArg}\n\n[User Clarification / Answer]:\n${answer}`;
    }
    // PRE-Planner check: a resume rehydrates prior spend BEFORE this point, so a
    // workflow that is already over a ceiling must not get to run the Planner
    // (an expensive model call) at all. Fresh runs sit at zero and pass.
    const prePlannerStop = guardWorkflowCeilings();
    if (prePlannerStop) return prePlannerStop;

    const plannerResolver = _resolveWorkflowPlan ?? resolveWorkflowPlan;
    // § Global New Information Policy / Wiring Card 2 — Full Path initial
    // Planner. `planArg` (above) is exactly the semantic input actually
    // presented to planning: the goal or plan-path content, plus a genuine
    // user clarification/answer appended when one is present — never a
    // timestamp, provider, attempt, or session id. Registration is
    // idempotent (newInformation.js#registerEvidence): re-registering the
    // EXACT SAME planArg in the same workflow resolves to the SAME
    // evidenceId, so a legitimate replay of this call finds it already
    // consumed and is denied by ModelSpendAuthority — never a second
    // physical Planner call. A genuinely different planArg (a real new
    // clarification) fingerprints differently and authorizes the Planner
    // once more.
    //
    // Registration happens BEFORE invoke() and its own failure is treated
    // exactly like a Token Safety AuthorizationError: zero physical Planner
    // calls, HUMAN_REQUIRED, via the SAME terminalizePlannerAuthorizationDenied
    // helper used for every other Planner-boundary denial (§ Phase 0A).
    // Backward compatible with any caller/test whose (possibly injected
    // `_selectProviders`) provider selection predates this feature and
    // exposes no `informationLedger` at all: registration/enforcement is
    // simply skipped, exactly like "no informationLedger wired" everywhere
    // else in this policy (see modelSpendAuthority.js's constructor doc).
    let plannerEvidenceIds;
    if (selection.informationLedger) {
      try {
        const evidence = await registerUserInputEvidence(selection.informationLedger, {
          workflowId, interactionId: 'planner-initial-input', text: planArg,
        });
        plannerEvidenceIds = [evidence.evidenceId];
      } catch (err) {
        return terminalizePlannerAuthorizationDenied(
          isAuthorizationFailure(err) ? err : new AuthorizationError(
            AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE,
            `New Information evidence for the Planner could not be durably registered: ${err?.message ?? err}`,
            { workflowId },
          ),
        );
      }
    }
    try {
      resolved = (await selection.runtime.invoke('planner', {
        resolve: (call) => plannerResolver({ planArg, cwd: repoRoot, callAgy: call, log: () => {} }),
      }, { operationId: workflowId, workflowId, evidenceIds: plannerEvidenceIds })).value;
    } catch (err) {
      // § Phase 0A — a Token Safety AuthorizationError at the Planner
      // boundary is an orchestrator decision, never a cancellation and never
      // a provider failure. It must stop immediately (no Supervisor, no
      // Executor, no Reviewer, no delivery) and terminalize the workflow's
      // DURABLE status as HUMAN_REQUIRED — never leave it at RUNNING/FAILED —
      // so a resume/status read sees the same terminal state the caller does.
      // Cancellation semantics are untouched: only an AuthorizationError is
      // intercepted here; every other error (including CancellationError /
      // AbortSignal) propagates exactly as before.
      if (isAuthorizationFailure(err)) {
        return terminalizePlannerAuthorizationDenied(err);
      }
      throw err;
    }
    if (usageTracker && workflowStateManager) {
      workflowStateManager.setTokenUsage(usageTracker.summary({ prCloseout: workflowStateManager.getState()?.prCloseout }));
    }
    // POST-Planner check: the Planner call itself may have crossed a ceiling.
    // Stop before dispatching Supervisor / Executor.
    const plannerCostStop = guardWorkflowCeilings();
    if (plannerCostStop) return plannerCostStop;
  }
  if (resolved.status === 'AMBIGUOUS') {
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason: 'plan_ambiguous', question: resolved.question });
    await lifecycleManager?.onWorkflowSuspended('plan_ambiguous');
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
      reason: 'The instruction is ambiguous and needs clarification before execution.',
      question: resolved.question,
    });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      reason: 'The instruction is ambiguous and needs clarification before execution.',
      question: resolved.question,
      tokenUsage: usageTracker?.summary() ?? null,
    };
  }
  emit(SUPERGPT_EVENTS.PLANNING_COMPLETED, { tasksCount: resolved.tasks?.length ?? 1 });

  // If this is a new workflow (not a resume) and closeout commands exist, update workflow metadata to freeze them durably
  const closeoutToPersist = Array.isArray(resolved.closeoutVerificationCommands) && resolved.closeoutVerificationCommands.length > 0
    ? resolved.closeoutVerificationCommands
    : (Array.isArray(resolved.tasks)
      ? [...new Set(resolved.tasks.flatMap((t) => (Array.isArray(t.verification_commands) ? t.verification_commands : [])).map(String).map((c) => c.trim()).filter(Boolean))]
      : []);

  if (!isResume && closeoutToPersist.length > 0) {
    try {
      if (existsSync(metadataPath)) {
        const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
        const mergedCloseout = [...new Set([
          ...(meta.closeout_verification_commands || []),
          ...closeoutToPersist,
        ])];
        meta.closeout_verification_commands = mergedCloseout;
        if (resolved.closeoutPolicySources?.length > 0) {
          meta.closeout_policy_sources = resolved.closeoutPolicySources;
        }
        writeFileSync(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

        // Verify write back
        const readBack = JSON.parse(readFileSync(metadataPath, 'utf8'));
        if (!Array.isArray(readBack.closeout_verification_commands)) {
          throw new Error('Metadata readback verification failed: missing closeout_verification_commands');
        }
      }
    } catch (err) {
      if (lifecycleManager) await lifecycleManager.onInitFailed();
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, {
        reason: `Failed to persist closeout policy metadata: ${err.message}`,
      });
      throw err;
    }
  }

  let plan = resolved.plan;
  if (answer) {
    plan = `${plan}\n\n[Human Decision / Answer]:\n${answer}`;
    workflowStateManager?.recordProgress({ humanAnswer: answer });
  }
  workflowStateManager?.recordProgress({ taskTotal: resolved.tasks?.length ?? 1 });
  // The initial planning/policy-freezing phase is the last point at which a
  // new workflow may source a policy.  Never execute without one.
  const frozenAfterPlanning = readFrozenCloseoutCommands();
  if (frozenAfterPlanning.length === 0) {
    const reason = 'MISSING_CLOSEOUT_VERIFICATION_POLICY: SuperGPT cannot safely deliver code without an executable final verification policy.';
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason, actionCode: 'MISSING_CLOSEOUT_VERIFICATION_POLICY' });
    await lifecycleManager?.onWorkflowSuspended('missing_closeout_verification_policy');
    return { ...EMPTY_RESULT(), status: 'HUMAN_REQUIRED', reason, question: reason, tokenUsage: usageTracker?.summary() ?? null };
  }
  throwIfAborted(signal);

  const { supervisorSession, createReviewerSession, windowSession } = selection;

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'executing' });
  const baseGate = (_createGateRunner || createGateRunner)({
    gitEvidenceCollector: createGitEvidenceCollector(),
    cwd: repoRoot,
    baseline,
    signal,
  });
  const gateRunner = {
    async run(commands) {
      const evidence = await baseGate.run(commands);
      emit(SUPERGPT_EVENTS.VERIFICATION_FINISHED, { result: evidence.pass ? 'PASS' : 'FAIL' });
      return evidence;
    },
  };
  // BASELINE-DIFF GATE: the pre-Executor baseline verification uses the same
  // deterministic command runner against the (still clean) isolated worktree,
  // but is not a "verification finished" milestone for the user-facing stream.
  const baselineGateRunner = {
    async run(commands) {
      return baseGate.run(commands);
    },
  };

  const frozenCloseoutCommands = readFrozenCloseoutCommands();

  const loopResult = await runAutomatedWorkflow({
    workflowId,
    supervisorSession,
    createReviewerSession,
    createClaudeSessionManager: ({ taskId }) => selection.createExecutorSessionManager({
      workflowId, taskId, persistence, cwd: repoRoot,
      onRoutingDecision: (routing) => workflowStateManager?.setRouting(routing),
      onProcessStarted: (details) => workflowStateManager?.recordProviderProcessStart(details),
      onProcessExited: (details) => workflowStateManager?.recordProviderProcessExit(details),
    }),
    gateRunner,
    baselineGateRunner,
    windowSession,
    persistence,
    workflowGoal: plan,
    repositoryContext: {
      repository_name: path.basename(worktree.source_repo_root),
      repository_url: null,
      branch: worktree.source_branch,
      commit_sha: worktree.baseline_head,
    },
    sourceWorkspace: worktree.source_workspace || cwd,
    externalReadRoots: resolvedApprovedRoots,
    approvedExternalRoots: resolvedApprovedRoots,
    maxAttemptsPerTask: Number(env.AGY_MAX_ATTEMPTS) || 3,
    maxEscalationAttempts: Number(env.AGY_MAX_ESCALATION_ATTEMPTS) || 2,
    humanAnswer: answer,
    closeoutVerificationCommands: frozenCloseoutCommands,
    workflowCostCeilingUsd,
    workflowUsageVolumeCeiling,
    taskExecutorUsageVolumeCeiling,
    executorPhysicalCallCeiling,
    fastPathExecutorEvidenceIds: fastPathFirstExecutorEvidenceIds,
    // § Global New Information Policy / Wiring Card 2 — the SAME ledger
    // instance `selection.spendAuthority` (constructed inside
    // providerSelection.js#selectProviders) actually enforces against, so
    // Full Path first Executor / Executor rework / Reviewer registrations
    // made inside runAutomatedWorkflow are genuinely load-bearing.
    informationLedger: selection.informationLedger,
    onCloseoutPass: async (proof) => {
      const fingerprint = getFingerprint(worktree.worktree_path);
      if (isValidWorktreeFingerprint(fingerprint)) {
        recordCloseoutVerificationEvidence({
          root: SUPERGPT_WORKTREE_ROOT,
          workflowId,
          evidence: {
            ...proof,
            worktree_fingerprint: fingerprint,
          },
        });
      }
    },
    taskTotal: resolved.tasks?.length ?? 1,
    plannedTasks: resolved.tasks ?? null,
    planSummary: resolved.summary ?? null,
    workflowStateManager,
    usageTracker,
    signal,
    checkpoint: control?.checkpoint ?? null,
    onCheckpoint: (cp) => saveCheckpoint({ root: SUPERGPT_WORKTREE_ROOT, workflowId }, cp),
    computeGateFingerprint: () => {
      const fp = getFingerprint(worktree.worktree_path);
      return isValidWorktreeFingerprint(fp) ? fp : null;
    },
    _execSync,
    log: (line) => {
      const event = translateLogLine(line);
      if (!event) return;
      const { type, ...payload } = event;
      emit(type, payload);
      if (type === SUPERGPT_EVENTS.REVIEW_FINISHED && payload.decision === 'REWORK') {
        emit(SUPERGPT_EVENTS.REWORK_REQUESTED, { taskId: payload.taskId, attempt: payload.attempt });
      }
    },
    onTaskCompleted: async ({ taskId }) => {
      const { execFile } = await import('node:child_process');
      const exec = (args) => new Promise((resolve) => {
        execFile('git', args, { cwd: repoRoot }, (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
        });
      });
      // Throws TaskBaselineError on a real git failure (hook / config / write
      // error) — a clean tree is the only silently-tolerated no-op.
      const advance = await advanceTaskBaseline({ repoRoot, taskId, baseline, exec });
      // P1-1: persist the authoritative advanced baseline commit durably so a
      // later HUMAN_REQUIRED + resume scopes the next task's Git evidence to
      // just that task and never re-includes this accepted task's delta.
      if (advance?.advanced && advance.head) {
        recordAdvancedBaselineHead({ root: SUPERGPT_WORKTREE_ROOT, workflowId, head: advance.head });
      }
    },
  });

  throwIfAborted(signal);

  const conversations = selection.sessionStore?.snapshot?.() ?? null;

  if (loopResult.status !== 'WORKFLOW_DONE') {
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, {
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
      evidence: loopResult.evidence ?? null,
      blockers: loopResult.blockers ?? [],
    });
    await lifecycleManager?.onWorkflowSuspended(loopResult.reason ?? 'human_required');
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
      evidence: loopResult.evidence ?? null,
      blockers: loopResult.blockers ?? [],
      blockerCategory: loopResult.blockerCategory ?? null,
      pending_verification: loopResult.pending_verification ?? null,
    });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
      evidence: loopResult.evidence ?? null,
      blockers: loopResult.blockers ?? [],
      blockerCategory: loopResult.blockerCategory ?? null,
      pending_verification: loopResult.pending_verification ?? null,
      conversations,
      tokenUsage: usageTracker?.summary() ?? null,
    };
  }

  emit(SUPERGPT_EVENTS.DELIVERY_STARTED);
  return deliverAndFinish({ summary: loopResult.summary ?? null, conversations });
}

export { supergptVerify };

export function supergptStatus({ workflowId, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  validateWorkflowId(workflowId);
  const live = readLiveWorkflowState({ workflowId, root });
  if (!live) return null;

  const metaPath = path.join(root, `${workflowId}.workspace.json`);
  let meta = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  const workflowIdentity = meta?.runtime_identity ?? live?.runtime_identity ?? null;
  const currentIdentity = getCurrentRuntimeIdentity();
  const runtimeCheck = compareRuntimeIdentity(workflowIdentity, currentIdentity);

  return {
    ...live,
    runtime_identity: workflowIdentity,
    staleRuntime: runtimeCheck.staleRuntime,
    staleRuntimeWarning: runtimeCheck.warning,
    runtimeCheck,
  };
}

export function supergptWait({ workflowId, root = SUPERGPT_WORKTREE_ROOT, predicate, timeoutMs, intervalMs } = {}) {
  validateWorkflowId(workflowId);
  return waitForWorkflowState({ workflowId, root, predicate, timeoutMs, intervalMs });
}

function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeoutId;
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    timeoutId = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// A validly formatted workflow id is "known" if any durable/active record for
// it exists: an in-process owner entry, or a persisted state / control /
// workspace file. A just-started run claims its ownership lease (control
// record) before any pipeline work, so this is true within the startup grace.
function watchedWorkflowIsKnown({ workflowId, root }) {
  try {
    if (ACTIVE_WORKFLOWS.has(workflowId)) return true;
  } catch { /* ignore */ }
  for (const ext of ['state.json', 'control.json', 'workspace.json']) {
    try {
      if (existsSync(path.join(root, `${workflowId}.${ext}`))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

const SUPERGPT_WATCH_TIMEOUT_MS = 45000;

export async function supergptWatch({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  intervalMs = 1000,
  timeoutMs = SUPERGPT_WATCH_TIMEOUT_MS,
  startupGraceMs = 15000,
  signal = null,
  onProgress = null,
  _readState = readLiveWorkflowState,
  _isKnown = watchedWorkflowIsKnown,
  _now = () => Date.now(),
  _sleep = abortableSleep,
} = {}) {
  validateWorkflowId(workflowId);

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : (timeoutMs === Infinity ? Infinity : SUPERGPT_WATCH_TIMEOUT_MS);
  const grace = Number.isFinite(startupGraceMs) && startupGraceMs >= 0 ? startupGraceMs : 15000;
  const startTime = _now();
  let progressSeq = 1;

  const getCanonical = () => {
    const raw = _readState({ workflowId, root });
    if (raw) return toCanonicalProgress(raw, _now());
    return null;
  };

  const notFoundResult = () => ({
    workflowId,
    status: 'WORKFLOW_NOT_FOUND',
    stage: 'UNKNOWN',
    formattedProgress: `SUPERGPT: workflow "${workflowId}" not found`,
    summary: null,
    reason: 'no durable or active record exists for this workflow id',
    question: null,
    evidence: null,
    blockers: [],
    blockerCategory: null,
    deliveredFiles: [],
    canonicalProgress: null,
    cancelled: Boolean(signal?.aborted),
  });

  let canonical = getCanonical();
  if (!canonical) {
    // No live state. Tolerate this ONLY for a workflow that genuinely exists,
    // or for a bounded startup grace while a just-started run publishes its
    // first state file. A validly formatted but nonexistent id must terminate
    // with WORKFLOW_NOT_FOUND rather than polling a fabricated STARTING state
    // until the client gives up.
    while (!signal?.aborted && !getCanonical() && !_isKnown({ workflowId, root })) {
      if (_now() - startTime >= grace) return notFoundResult();
      await _sleep(intervalMs, signal);
    }
    canonical = getCanonical();
  }
  if (!canonical) {
    canonical = toCanonicalProgress({
      workflowId,
      workflowStatus: WORKFLOW_STATUSES.STARTING,
      stage: WORKFLOW_STAGES.INIT,
      startedAt: new Date(_now()).toISOString(),
      heartbeatAt: new Date(_now()).toISOString(),
      lastProgressAt: new Date(_now()).toISOString(),
    }, _now());
  }

  // Initial immediate notification on attach
  if (typeof onProgress === 'function') {
    try {
      await onProgress({
        progress: progressSeq++,
        canonical,
        formattedProgress: renderGenericProgress(canonical),
      });
    } catch {
      /* ignore notification error */
    }
  }

  while (!signal?.aborted && (effectiveTimeout === Infinity || _now() - startTime < effectiveTimeout)) {
    if (canonical?.terminal) {
      break;
    }
    await _sleep(intervalMs, signal);
    if (signal?.aborted) break;

    const liveCanonical = getCanonical();
    if (liveCanonical) {
      canonical = liveCanonical;
    }

    if (typeof onProgress === 'function') {
      try {
        await onProgress({
          progress: progressSeq++,
          canonical,
          formattedProgress: renderGenericProgress(canonical),
        });
      } catch {
        /* ignore notification error */
      }
    }

    if (canonical?.terminal) {
      break;
    }
  }

  // If terminal was reached, emit a final progress notification to ensure frontend received critical terminal state
  if (canonical?.terminal && typeof onProgress === 'function') {
    try {
      await onProgress({
        progress: progressSeq++,
        canonical,
        formattedProgress: renderGenericProgress(canonical),
      });
    } catch {
      /* ignore notification error */
    }
  }

  const finalFormatted = canonical ? renderGenericProgress(canonical) : 'SUPERGPT: workflow state not found';
  return {
    workflowId,
    status: canonical?.workflowStatus ?? (signal?.aborted ? 'CANCELLED' : 'UNKNOWN'),
    stage: canonical?.stage ?? 'UNKNOWN',
    formattedProgress: finalFormatted,
    summary: canonical?.summary ?? null,
    reason: canonical?.reason ?? null,
    question: canonical?.question ?? null,
    evidence: canonical?.evidence ?? null,
    blockers: canonical?.blockers ?? [],
    blockerCategory: canonical?.blockerCategory ?? null,
    deliveredFiles: canonical?.deliveredFiles ?? [],
    canonicalProgress: canonical,
    cancelled: Boolean(signal?.aborted),
  };
}

const OWNER_TERMINAL_STATUSES = new Set(['STOPPED', 'DONE', 'FAILED', 'HUMAN_REQUIRED']);

export async function supergptStop({
  workflowId,
  reason = 'stopped by user',
  root = SUPERGPT_WORKTREE_ROOT,
  waitForOwnerMs = 15000,
  _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _now = () => Date.now(),
} = {}) {
  validateWorkflowId(workflowId);

  // 1. Durable, cross-process stop request. The owning orchestrator — even in
  //    a different CLI/MCP process — polls this file and aborts itself,
  //    tearing down its own pipeline and awaiting shutdown before it
  //    publishes a terminal state.
  requestStop({ root, workflowId, reason });

  const control = readControl({ root, workflowId });
  const ownerPid = control?.owner?.pid ?? null;
  const ownerAlive = isOwnerAlive(control);
  const foreignLiveOwner = ownerAlive && ownerPid !== process.pid;

  // 2. Same-process owner: abort directly, then AWAIT the owning run's own
  //    teardown (Executor terminate, Gate process-tree kill, provider session
  //    close, lifecycle unwind) before returning. Its finalizer performs the
  //    authoritative ACTIVE_WORKFLOWS removal and terminal-state publish — we
  //    do not remove the entry here. A bounded timeout keeps stop fail-closed
  //    if teardown hangs.
  const running = ACTIVE_WORKFLOWS.get(workflowId);
  let ownerAcknowledged = false;
  let sameProcessOwnerTimedOut = false;
  if (running) {
    running.abortController?.abort();
    if (running.completionPromise && ownerPid === process.pid) {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), waitForOwnerMs); });
      if (typeof timer?.unref === 'function') timer.unref();
      const outcome = await Promise.race([running.completionPromise.then(() => 'done'), timeout]);
      clearTimeout(timer);
      if (outcome === 'done') {
        const st = readLiveWorkflowState({ workflowId, root });
        if (st && OWNER_TERMINAL_STATUSES.has(st.workflowStatus)) ownerAcknowledged = true;
      } else {
        // The owning run's teardown did not settle in time. We must NOT release
        // ownership: removing ACTIVE_WORKFLOWS, forcing a STOPPED state, or
        // marking resumable now would let a resume overlap a pipeline that is
        // still live. Keep every ownership/tombstone marker in place and return
        // a structured fail-closed result. The run's own finalizer will remove
        // ACTIVE_WORKFLOWS once it truly exits, after which resume is allowed.
        sameProcessOwnerTimedOut = true;
      }
    }
  }

  if (sameProcessOwnerTimedOut) {
    return {
      workflowId,
      status: 'STOP_TIMEOUT',
      failClosed: true,
      reason: `owner teardown did not complete within ${waitForOwnerMs}ms — stop request recorded and ownership retained; resume remains blocked until the original run exits`,
      ownerPid,
      ownerAlive: true,
      ownerAcknowledged: false,
    };
  }

  // 3. Foreign, live owner: wait (bounded) for it to acknowledge by
  //    publishing a terminal state. Its own pipeline shutdown completes
  //    before that write, so no Reviewer/delivery runs afterwards.
  if (foreignLiveOwner && !ownerAcknowledged) {
    const deadline = _now() + waitForOwnerMs;
    while (_now() < deadline) {
      const st = readLiveWorkflowState({ workflowId, root });
      if (st && OWNER_TERMINAL_STATUSES.has(st.workflowStatus)) {
        ownerAcknowledged = true;
        break;
      }
      // Owner died mid-stop (crash): stop waiting and fail closed below.
      if (!isOwnerAlive(readControl({ root, workflowId }))) break;
      await _sleep(200);
    }
  }

  // 4. Fail-closed fallback for a stale/reused/dead owner PID, a same-process
  //    stop, or a foreign owner that did not acknowledge in time: terminate
  //    any recorded live child and force the persisted state to STOPPED so
  //    nothing downstream can observe a non-terminal workflow.
  const pidsKilled = [];
  if (!ownerAcknowledged) {
    if (running) {
      running.workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.STOPPED, { reason, stopInitiator: 'user' });
      running.workflowStateManager?.stopHeartbeat();
      ACTIVE_WORKFLOWS.delete(workflowId);
    }

    const liveState = readLiveWorkflowState({ workflowId, root });
    if (liveState && Array.isArray(liveState.activeProcesses)) {
      for (const proc of liveState.activeProcesses) {
        // Never signal our own PID or a stale/reused one we can't attribute.
        if (proc?.pid && proc.pid !== process.pid && isProcessAlive(proc.pid)) {
          try {
            process.kill(proc.pid, 'SIGTERM');
            pidsKilled.push(proc.pid);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const statePath = path.join(root, `${workflowId}.state.json`);
    if (existsSync(statePath)) {
      try {
        const current = JSON.parse(readFileSync(statePath, 'utf8'));
        current.workflowStatus = WORKFLOW_STATUSES.STOPPED;
        current.stoppedReason = reason;
        current.stoppedAt = new Date().toISOString();
        current.stopInitiator = 'user';
        current.activeProcesses = [];
        if (current.stageStatuses) {
          if (current.stageStatuses.executor === 'running') current.stageStatuses.executor = 'stopped';
          if (current.stageStatuses.reviewer === 'running') current.stageStatuses.reviewer = 'stopped';
        }
        writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      } catch {
        /* ignore */
      }
    }
  }

  // P1-2: a user-stopped workflow still holds undelivered isolated edits and
  // supergpt_resume is supported. Mark it durably resumable and its resources
  // PRESERVED so age-based GC does not reap the worktree it needs to resume.
  // A DONE/CLEANED workflow never reaches here (its control record is already
  // cleared and its status is terminal-finished).
  const metadataPath = path.join(root, `${workflowId}.workspace.json`);
  if (existsSync(metadataPath)) {
    // Single-writer control.json: only touch it here when NO live foreign owner
    // exists. A same-process owner marks itself resumable from its own cancel
    // path; a live foreign owner does the same after observing the stop. A
    // foreign `supergpt stop` writing control.json here could clobber that
    // owner's concurrent checkpoint / baseline / delivery fields.
    const controlNow = readControl({ root, workflowId });
    const liveForeignOwner = isOwnerAlive(controlNow) && controlNow?.owner?.pid !== process.pid;
    if (!liveForeignOwner) {
      try {
        markResumable({ root, workflowId, resumable: true });
      } catch { /* best effort */ }
    }
    const resourcesPath = path.join(root, `${workflowId}.resources.json`);
    if (existsSync(resourcesPath)) {
      try {
        const res = JSON.parse(readFileSync(resourcesPath, 'utf8'));
        if (res.status !== 'CLEANED') {
          res.status = 'PRESERVED';
          res.suspendedReason = 'stopped by user';
          writeFileSync(resourcesPath, `${JSON.stringify(res, null, 2)}\n`, 'utf8');
        }
      } catch { /* best effort */ }
    }
  }

  return {
    workflowId,
    status: WORKFLOW_STATUSES.STOPPED,
    reason,
    pidsKilled,
    ownerPid,
    ownerAlive,
    ownerAcknowledged,
  };
}

export async function supergptResume({
  workflowId,
  answer = null,
  cwd,
  onEvent,
  outputFormat,
  signal,
  env = process.env,
  _pipeline = defaultPipeline,
  _resolveWorkflowPlan,
  _selectProviders,
  _createGateRunner,
  _execSync,
  _computeWorktreeFingerprint,
  _readLiveWorkflowState,
} = {}) {
  validateWorkflowId(workflowId);

  const root = SUPERGPT_WORKTREE_ROOT;

  // Never let a resume overlap the original run. This covers both a
  // same-process stop whose teardown has not settled (ACTIVE_WORKFLOWS still
  // holds the entry — its finalizer removes it only once the pipeline truly
  // exits) and a still-live owner in another process.
  if (ACTIVE_WORKFLOWS.has(workflowId)) {
    throw new Error(`Cannot resume workflow "${workflowId}": its original run in this process is still shutting down. Retry once it has exited.`);
  }

  const metadataPath = path.join(root, `${workflowId}.workspace.json`);
  if (!existsSync(metadataPath)) {
    throw new Error(`Cannot resume workflow "${workflowId}": workspace metadata not found at ${metadataPath}`);
  }

  // Fast UX pre-checks (NOT authoritative — the atomic lease in runSuperGPT is
  // the authority). Reject early on an obviously-live foreign owner so we do
  // not spin up managers just to fail the ownership claim.
  const resumeOwnerControl = readControl({ root, workflowId });
  if (
    resumeOwnerControl?.owner?.pid
    && resumeOwnerControl.owner.pid !== process.pid
    && isOwnerAlive(resumeOwnerControl)
  ) {
    throw new Error(`Cannot resume workflow "${workflowId}": its original run (pid ${resumeOwnerControl.owner.pid}) is still active. Stop it first, then resume.`);
  }
  const resumeLease = readOwnerLease({ root, workflowId });
  if (resumeLease && resumeLease.pid !== process.pid && isLeaseOwnerAlive(resumeLease)) {
    const err = new Error(`Cannot resume workflow "${workflowId}": it is already owned by pid ${resumeLease.pid} (lease acquired ${resumeLease.acquiredAt}). Stop it first, then resume.`);
    err.code = OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED;
    throw err;
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot resume workflow "${workflowId}": corrupted workspace metadata (${err.message})`);
  }

  const effectiveCwd = cwd ?? meta.source_workspace ?? meta.source_repo_root ?? process.cwd();

  // FROZEN POLICY: use ONLY the persisted roots from workflow metadata.
  // Do NOT reload .supergpt/config.json, do NOT merge newly supplied roots.
  // Changing .supergpt/config.json affects only NEW workflows.
  const persistedRoots = Array.isArray(meta.external_read_roots)
    ? meta.external_read_roots
    : (Array.isArray(meta.approved_external_roots) ? meta.approved_external_roots : []);

  return runSuperGPT({
    workflowId,
    isResume: true,
    answer,
    goal: meta.goal ?? null,
    planPath: meta.plan_path ?? null,
    cwd: effectiveCwd,
    externalReadRoots: persistedRoots,
    onEvent,
    outputFormat,
    signal,
    env,
    _pipeline,
    _resolveWorkflowPlan,
    _selectProviders,
    _createGateRunner,
    _execSync,
    _computeWorktreeFingerprint,
    ...(_readLiveWorkflowState ? { _readLiveWorkflowState } : {}),
  });
}

export function supergptFormatProgress(state) {
  if (!state) return 'SUPERGPT: no active workflow';
  const manager = new WorkflowStateManager({ workflowId: state.workflowId || 'unknown' });
  manager.state = { ...manager.state, ...state };
  return manager.formatProgressBlock();
}

export async function supergptPlan({
  goal,
  planPath,
  cwd = process.cwd(),
  constraints,
  callAgy = defaultCallAgy,
  _resolveWorkflowPlan = resolveWorkflowPlan,
} = {}) {
  let planArg = planPath ?? goal;
  if (!planArg) {
    throw new Error('supergptPlan requires either "goal" or "planPath"');
  }
  if (constraints) {
    planArg = `${planArg}\n\n[Constraints]:\n${constraints}`;
  }
  const resolved = await _resolveWorkflowPlan({
    planArg,
    cwd: path.resolve(cwd),
    callAgy,
    log: () => {},
  });

  if (resolved.status === 'AMBIGUOUS') {
    return {
      status: 'AMBIGUOUS',
      summary: null,
      planText: null,
      tasks: null,
      question: resolved.question,
    };
  }

  return {
    status: 'READY',
    summary: resolved.summary ?? null,
    planText: resolved.plan ?? null,
    tasks: resolved.tasks ?? null,
    question: null,
  };
}

export {
  SUPERGPT_WATCH_TIMEOUT_MS,
  WorkflowStateManager,
  WorkflowLifecycleManager,
  UsageTracker,
  gcSuperGptResources,
  formatTransitionEvent,
  toCanonicalProgress,
  readCanonicalProgress,
  TokenAnomalyMonitor,
  TINY_WORKFLOW_BASELINE,
  VERSIONED_BASELINES,
  checkBaselineEnvironmentCompatibility,
  OrganicReworkRecorder,
  defaultOrganicReworkRecorder,
  REWORK_VERIFICATION_STATUSES,
  WORKFLOW_STAGES,
  WORKFLOW_STATUSES,
  ExternalReadRootConfigError,
  isValidWorktreeFingerprint,
};
