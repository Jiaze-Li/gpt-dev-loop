// WorkflowStateManager — structured live workflow state, programmatic heartbeat,
// child process monitoring, and progress UX formatting.
//
// Rules (PHASE B1 - B5):
//   - Maintain real-time state independently of tool noise.
//   - Heartbeat must be local and consume ZERO model tokens.
//   - Distinguish heartbeatAt (orchestrator alive), lastProgressAt (workflow transition),
//     and lastActivityAt (child process I/O).
//   - No silent failure: every execution transitions to an explicit terminal state.
//   - Progress UX: compact standardized status block with zero model tokens.
//   - Status read / wait / stop / resume: 100% local, zero model tokens.

import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { readOwnerLease, isLeaseOwnerAlive } from './workflowOwnership.js';
import { appendProviderProcessDiagnostic } from './providerProcessTelemetry.js';
import { validateWorkflowId, assertPathWithinRoot, isTestWorkflowId } from './workflowId.js';

export const WORKFLOW_KINDS = Object.freeze({
  USER: 'USER',
  INTERNAL_TEST: 'INTERNAL_TEST',
});

export const WORKFLOW_STAGES = Object.freeze({
  INIT: 'INIT',
  PLANNING: 'PLANNING',
  PREFLIGHT: 'PREFLIGHT',
  SUPERVISOR: 'SUPERVISOR',
  EXECUTOR: 'EXECUTOR',
  GATE: 'GATE',
  REVIEWER: 'REVIEWER',
  REWORK: 'REWORK',
  APPLYING: 'APPLYING',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  DONE: 'DONE',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  STALLED: 'STALLED',
  STOPPED: 'STOPPED',
});

export const WORKFLOW_STATUSES = Object.freeze({
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  DONE: 'DONE',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  STALLED: 'STALLED',
  STOPPED: 'STOPPED',
});

function formatTime(isoString) {
  if (!isoString) return '--:--:--';
  try {
    const d = new Date(isoString);
    return d.toTimeString().split(' ')[0];
  } catch {
    return '--:--:--';
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${mm}:${ss}`;
}

export class WorkflowStateManager {
  constructor({
    workflowId,
    kind,
    parentWorkflowId = null,
    root = SUPERGPT_WORKTREE_ROOT,
    onStateChange,
  } = {}) {
    validateWorkflowId(workflowId);
    this.workflowId = workflowId;
    this.root = root;
    this.stateFilePath = assertPathWithinRoot(root, path.join(root, `${workflowId}.state.json`), 'state file');
    this.onStateChange = onStateChange;
    this.heartbeatTimer = null;

    const resolvedKind = kind || (isTestWorkflowId(workflowId) ? WORKFLOW_KINDS.INTERNAL_TEST : WORKFLOW_KINDS.USER);
    const now = new Date().toISOString();
    this.state = {
      workflowId,
      kind: resolvedKind,
      parentWorkflowId: parentWorkflowId ?? null,
      workflowStatus: WORKFLOW_STATUSES.STARTING,
      taskIndex: null,
      taskTotal: null,
      taskId: null,
      taskName: null,
      attempt: 0,
      stage: WORKFLOW_STAGES.INIT,
      startedAt: now,
      stageStartedAt: now,
      lastProgressAt: now,
      heartbeatAt: now,
      lastActivityAt: null,
      lastDecision: null,
      executorModel: 'sonnet',
      modelEscalated: false,
      escalationReason: null,
      activeProcesses: [],
      stageStatuses: {
        executor: 'waiting',
        gate: 'waiting',
        reviewer: 'waiting',
      },
      tokenUsage: null,
      routing: { planner: null, supervisor: null, executor: null, reviewer: null, quotaPools: [] },
      taskHistory: [], // completed tasks history with { taskId, decision, attempts }
      taskAttempts: [], // task-scoped attempt history with { taskId, attempt, executorCallId, gateResult, reviewerDecision, requiredChanges, reviewerCallId }
      stageHistory: [], // chronological stage transition history with { stage, startedAt, taskId, taskName, attempt }
      error: null,
      question: null,
      summary: null,
      evidence: null,
      blockers: [],
      // V2-C durable PR closeout loop state (round count, reviewed head,
      // finding signatures, last action) — null until the closeout loop runs.
      prCloseout: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  getCanonicalProgress() {
    return toCanonicalProgress(this.state);
  }

  persist() {
    try {
      if (!existsSync(this.root)) {
        mkdirSync(this.root, { recursive: true });
      }
      writeFileSync(this.stateFilePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch {
      /* best effort persistence */
    }
  }

  notify() {
    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange(this.getState());
      } catch {
        /* ignore callback error */
      }
    }
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.notify();
    this.persist();
  }

  setWorkflowStatus(status) {
    this.state.workflowStatus = status;
    this.state.lastProgressAt = new Date().toISOString();
    this.notify();
    this.persist();
  }

  startStage(stage, details = {}) {
    const now = new Date().toISOString();
    this.state.stage = stage;
    this.state.stageStartedAt = now;
    this.state.lastProgressAt = now;
    if (details.taskId !== undefined) this.state.taskId = details.taskId;
    if (details.taskName !== undefined) this.state.taskName = details.taskName;
    if (details.taskIndex !== undefined) this.state.taskIndex = details.taskIndex;
    if (details.taskTotal !== undefined) this.state.taskTotal = details.taskTotal;
    if (details.attempt !== undefined) this.state.attempt = details.attempt;

    if (!this.state.stageHistory) this.state.stageHistory = [];
    this.state.stageHistory.push({
      stage,
      startedAt: now,
      taskId: details.taskId ?? this.state.taskId ?? null,
      taskName: details.taskName ?? this.state.taskName ?? null,
      attempt: details.attempt ?? this.state.attempt ?? null,
    });

    if (stage === WORKFLOW_STAGES.EXECUTOR) {
      this.state.stageStatuses.executor = 'running';
      this.state.stageStatuses.gate = 'waiting';
      this.state.stageStatuses.reviewer = 'waiting';
    } else if (stage === WORKFLOW_STAGES.GATE) {
      this.state.stageStatuses.executor = 'done';
      this.state.stageStatuses.gate = 'running';
    } else if (stage === WORKFLOW_STAGES.REVIEWER) {
      this.state.stageStatuses.reviewer = 'running';
    }

    this.notify();
    this.persist();
  }

  recordProgress(details = {}) {
    this.state.lastProgressAt = new Date().toISOString();
    Object.assign(this.state, details);
    this.notify();
    this.persist();
  }

  recordActivity(details = {}) {
    this.state.lastActivityAt = new Date().toISOString();
    if (details.chunk && this.state.activeProcesses.length > 0) {
      // Activity confirmed from child process
    }
  }

  recordProcessStart(role, pid) {
    this.state.activeProcesses = this.state.activeProcesses.filter((p) => p.pid !== pid);
    this.state.activeProcesses.push({
      role,
      pid,
      startedAt: new Date().toISOString(),
    });
    this.recordActivity();
    this.persist();
  }

  recordProcessEnd(role, pid, exitCode) {
    this.state.activeProcesses = this.state.activeProcesses.filter((p) => p.pid !== pid);
    this.recordActivity();
    this.persist();
  }

  recordProviderProcessStart(details = {}) {
    this.state.activeProcesses = this.state.activeProcesses.filter((p) => p.pid !== details.pid);
    this.state.activeProcesses.push({ ...details, startedAt: new Date().toISOString() });
    this.recordActivity();
    this.persist();
  }

  recordProviderProcessExit(details = {}) {
    const active = this.state.activeProcesses.find((p) => p.pid === details.pid) ?? {};
    const record = appendProviderProcessDiagnostic({
      root: this.root, workflowId: this.workflowId,
      record: {
        ...active, ...details,
        lastActivityAt: this.state.lastActivityAt,
        userStopped: this.state.stopInitiator === 'user',
        orchestratorStopped: this.state.stopInitiator === 'orchestrator',
      },
    });
    if (details.pid) this.state.activeProcesses = this.state.activeProcesses.filter((p) => p.pid !== details.pid);
    this.state.lastProviderProcessExit = record;
    this.recordActivity();
    this.persist();
    return record;
  }

  recordTaskAttempt(attemptRecord = {}) {
    if (!this.state.taskAttempts) this.state.taskAttempts = [];
    const now = new Date().toISOString();
    const index = this.state.taskAttempts.findIndex(
      (a) => a.taskId === attemptRecord.taskId && a.attempt === attemptRecord.attempt
    );
    if (index >= 0) {
      this.state.taskAttempts[index] = {
        ...this.state.taskAttempts[index],
        ...attemptRecord,
        updatedAt: now,
      };
    } else {
      this.state.taskAttempts.push({
        createdAt: now,
        updatedAt: now,
        ...attemptRecord,
      });
    }
    this.persist();
  }

  recordCompletedTask(taskSummary = {}) {
    if (!this.state.taskHistory) this.state.taskHistory = [];
    this.state.taskHistory.push({ ...taskSummary });
    this.persist();
  }

  // V2-C — persist the durable PR closeout loop state after every transition
  // so a crashed or suspended closeout loop resumes from the last decision.
  // Pass null to clear it.
  recordCloseoutState(closeoutState) {
    this.state.prCloseout = closeoutState
      ? JSON.parse(JSON.stringify(closeoutState))
      : null;
    this.state.lastProgressAt = new Date().toISOString();
    this.notify();
    this.persist();
  }

  setDecision(decision) {
    this.state.lastDecision = decision;
    this.state.lastProgressAt = new Date().toISOString();
    this.notify();
    this.persist();
  }

  setTokenUsage(usageSummary) {
    this.state.tokenUsage = usageSummary;
    this.persist();
  }

  setRouting(routing) {
    if (routing.model) this.state.executorModel = routing.model;
    if (routing.escalated !== undefined) this.state.modelEscalated = routing.escalated;
    if (routing.escalationReason !== undefined) this.state.escalationReason = routing.escalationReason;
    if (routing.role && ['planner', 'supervisor', 'executor', 'reviewer'].includes(routing.role)) {
      this.state.routing[routing.role] = {
        requestedFamily: routing.requestedFamily ?? null,
        resolvedModel: routing.resolvedModel ?? null,
        provider: routing.provider ?? null,
        effort: routing.effort ?? null,
        sessionGeneration: routing.sessionGeneration ?? null,
      };
    }
    if (Array.isArray(routing.quotaPools)) this.state.routing.quotaPools = routing.quotaPools;
    this.persist();
  }

  transitionTerminal(status, details = {}) {
    const now = new Date().toISOString();
    this.state.workflowStatus = status;
    this.state.stage = status;
    this.state.lastProgressAt = now;
    this.state.activeProcesses = [];
    if (details.reason) this.state.error = details.reason;
    if (details.stopInitiator) this.state.stopInitiator = details.stopInitiator;
    if (details.question) this.state.question = details.question;
    if (details.summary) this.state.summary = details.summary;
    if (details.evidence) this.state.evidence = details.evidence;
    if (details.blockers) this.state.blockers = details.blockers;
    if (details.blockerCategory) this.state.blockerCategory = details.blockerCategory;
    if (details.pending_verification || details.pendingVerification) {
      this.state.pending_verification = details.pending_verification || details.pendingVerification;
    }
    this.stopHeartbeat();
    this.notify();
    this.persist();
  }

  startHeartbeat(intervalMs = 1000) {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.state.heartbeatAt = new Date().toISOString();
      // Light throttle on disk writes for heartbeat: write state every 5 seconds
      if (Math.floor(Date.now() / 1000) % 5 === 0) {
        this.persist();
      }
    }, intervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Format compact progress UX block as required in PHASE B4.
   * Zero model tokens.
   */
  formatProgressBlock() {
    const s = this.state;
    const elapsedMs = Date.now() - (s.startedAt ? new Date(s.startedAt).getTime() : Date.now());
    const taskPart = s.taskIndex && s.taskTotal
      ? `${s.taskIndex} / ${s.taskTotal}`
      : s.taskId || '1 / 1';
    const namePart = s.taskName ? ` — ${s.taskName}` : '';

    const lines = [
      `SUPERGPT ⟳ ${s.workflowStatus}`,
      '',
      `Task       ${taskPart}${namePart}`,
      `Attempt    ${s.attempt || 1}`,
      `Stage      ${s.stage}`,
      '',
      `Executor   ${s.stageStatuses.executor}`,
      `Gate       ${s.stageStatuses.gate}`,
      `Reviewer   ${s.stageStatuses.reviewer}`,
      '',
      `Elapsed       ${formatDuration(elapsedMs)}`,
      `Heartbeat     ${formatTime(s.heartbeatAt)}`,
      `Last progress ${formatTime(s.lastProgressAt)}`,
    ];

    if (s.lastActivityAt) {
      lines.push(`Last activity ${formatTime(s.lastActivityAt)}`);
    }

    if (s.modelEscalated) {
      lines.push(`Model         ${s.executorModel} (Escalated: ${s.escalationReason || 'yes'})`);
    }

    if (s.workflowStatus === WORKFLOW_STATUSES.HUMAN_REQUIRED && s.evidence) {
      const ev = s.evidence;
      lines.push('');
      lines.push('--- HUMAN_REQUIRED EVIDENCE ---');
      if (ev.blockerCategory) lines.push(`Category:     ${ev.blockerCategory}`);
      if (ev.rootCause) lines.push(`Root Cause:   ${ev.rootCause}`);
      if (ev.failingGateCommand) lines.push(`Failing Cmd:  ${ev.failingGateCommand}`);
      if (ev.exitCode !== null && ev.exitCode !== undefined) lines.push(`Exit Code:    ${ev.exitCode}`);
      if (ev.latestReviewerDecision) lines.push(`Reviewer:     ${ev.latestReviewerDecision}`);
      if (ev.latestReviewerRequiredChanges && ev.latestReviewerRequiredChanges.length > 0) {
        lines.push(`Required:     ${Array.isArray(ev.latestReviewerRequiredChanges) ? ev.latestReviewerRequiredChanges.join('; ') : ev.latestReviewerRequiredChanges}`);
      }
      if (ev.recommendedAction) lines.push(`Action:       ${ev.recommendedAction}`);
    }

    return lines.join('\n');
  }

  /**
   * Format failure / retry semantic banner as required in PHASE B3.
   */
  formatFailureBanner(reason, { retrying = false, nextAttempt = null } = {}) {
    const s = this.state;
    const taskPart = s.taskIndex && s.taskTotal ? `${s.taskIndex}/${s.taskTotal}` : s.taskId || '1/1';
    const lines = [
      '--------------------------------------------------',
      `SUPERGPT · ${retrying ? 'RETRYING' : 'FAILED'}`,
      `Task ${taskPart}`,
      `Attempt ${s.attempt || 1}`,
      `Stage ${s.stage}`,
      `Reason ${reason || 'unexpected error'}`,
    ];
    if (retrying && nextAttempt) {
      lines.push(`Retrying as Attempt ${nextAttempt}`);
    }
    lines.push('--------------------------------------------------');
    return lines.join('\n');
  }
}

/**
 * Programmatic local state reader (PHASE B5).
 * Consumes zero model tokens.
 */
export function readLiveWorkflowState({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  if (!workflowId) return null;
  validateWorkflowId(workflowId);
  const filePath = assertPathWithinRoot(root, path.join(root, `${workflowId}.state.json`), 'state file');
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * V2-C — read the persisted PR closeout loop state for a workflow, or null.
 * Consumes zero model tokens.
 */
export function readCloseoutState({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  const live = readLiveWorkflowState({ workflowId, root });
  return live?.prCloseout ?? null;
}

/**
 * PR Closeout — the reviewer the workflow is (or would be) using, plus the
 * durable repair-round budget. Reads only persisted state; zero model tokens.
 * Returns null when no closeout loop state has been recorded yet.
 */
export function readCloseoutReviewer({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  state = null,
} = {}) {
  const closeout = state ?? readCloseoutState({ workflowId, root });
  if (!closeout || typeof closeout !== 'object') return null;
  const order = Array.isArray(closeout.reviewerCandidateOrder)
    ? closeout.reviewerCandidateOrder
    : [];
  const active = closeout.reviewerLocked && closeout.activeReviewer
    ? closeout.activeReviewer
    : (order[closeout.reviewerCandidateIndex ?? 0] ?? closeout.prReviewer ?? null);
  return {
    reviewer: active,
    locked: Boolean(closeout.reviewerLocked),
    candidateOrder: order,
    candidateIndex: closeout.reviewerCandidateIndex ?? 0,
    failovers: Array.isArray(closeout.reviewerFailovers) ? closeout.reviewerFailovers : [],
    repairRounds: closeout.repairRounds ?? 0,
    maxRepairRounds: closeout.maxRepairRounds ?? null,
  };
}

export const HEARTBEAT_STALE_TIMEOUT_MS = 2 * 60_000; // 2 minutes

/**
 * Check if a workflow is actively alive (owner process running or fresh heartbeat).
 * Consumes zero model tokens.
 */
export function checkWorkflowLiveness({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  state = null,
  now = Date.now(),
  staleTimeoutMs = HEARTBEAT_STALE_TIMEOUT_MS,
} = {}) {
  const rawState = state ?? readLiveWorkflowState({ workflowId, root });
  if (!rawState) return { isAlive: false, isZombie: false, reason: 'state_not_found' };

  const s = String(rawState.stage || '').toUpperCase();
  const w = String(rawState.workflowStatus || '').toUpperCase();
  const term = [
    WORKFLOW_STATUSES.DONE,
    WORKFLOW_STATUSES.HUMAN_REQUIRED,
    WORKFLOW_STATUSES.FAILED,
    WORKFLOW_STATUSES.TIMEOUT,
    WORKFLOW_STATUSES.STALLED,
    WORKFLOW_STATUSES.STOPPED,
    'SUPERSEDED',
    'DISMISSED',
  ];
  if (term.includes(w)) {
    return { isAlive: true, isZombie: false, reason: 'resolved_status' };
  }

  // 1. Check ownership lease
  const lease = readOwnerLease({ root, workflowId });
  if (lease) {
    const ownerAlive = isLeaseOwnerAlive(lease);
    if (ownerAlive) {
      return { isAlive: true, isZombie: false, ownerPid: lease.pid, lease };
    }
    // Owner lease was published with a recorded local PID that is demonstrably dead -> zombie!
    return {
      isAlive: false,
      isZombie: true,
      reason: 'owner_pid_dead',
      ownerPid: lease.pid,
      lease,
    };
  }

  // 2. No lease directory: check heartbeat
  if (rawState.heartbeatAt) {
    const lastHeartbeat = Date.parse(rawState.heartbeatAt);
    if (Number.isFinite(lastHeartbeat) && (now - lastHeartbeat) > staleTimeoutMs) {
      return {
        isAlive: false,
        isZombie: true,
        reason: 'heartbeat_expired',
        ageMs: now - lastHeartbeat,
      };
    }
  } else if (rawState.startedAt) {
    const startedMs = Date.parse(rawState.startedAt);
    if (Number.isFinite(startedMs) && (now - startedMs) > 24 * 60 * 60_000) {
      return {
        isAlive: false,
        isZombie: true,
        reason: 'started_long_ago_no_lease',
        ageMs: now - startedMs,
      };
    }
  }

  // Within initialization / test grace window
  return { isAlive: true, isZombie: false, reason: 'within_grace_window' };
}

/**
 * Reconcile stale/zombie workflow state to STOPPED and requiresAttention=false.
 * Preserves all checkpoints, events, evidence, and worktrees.
 */
export function reconcileStaleWorkflowState({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  state = null,
  now = Date.now(),
  staleTimeoutMs = HEARTBEAT_STALE_TIMEOUT_MS,
} = {}) {
  validateWorkflowId(workflowId);
  const statePath = assertPathWithinRoot(root, path.join(root, `${workflowId}.state.json`), 'state file');
  const rawState = state ?? readLiveWorkflowState({ workflowId, root });
  if (!rawState) return null;

  const liveness = checkWorkflowLiveness({
    workflowId,
    root,
    state: rawState,
    now,
    staleTimeoutMs,
  });

  if (!liveness.isZombie) {
    return rawState;
  }

  const reconciled = { ...rawState };
  reconciled.workflowStatus = WORKFLOW_STATUSES.STOPPED;
  reconciled.stage = WORKFLOW_STAGES.STOPPED;
  reconciled.stoppedAt = rawState.heartbeatAt || rawState.lastProgressAt || new Date(now).toISOString();
  reconciled.stoppedReason = `zombie_reconciled:${liveness.reason}`;
  reconciled.requiresAttention = false;
  reconciled.reconciledAt = new Date(now).toISOString();

  try {
    const tmpPath = `${statePath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(reconciled, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, statePath);
  } catch {
    try {
      writeFileSync(statePath, `${JSON.stringify(reconciled, null, 2)}\n`, 'utf8');
    } catch {}
  }

  return reconciled;
}

/**
 * Programmatic local state waiter (PHASE B5).
 * Consumes zero model tokens.
 */
export async function waitForWorkflowState({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  predicate,
  timeoutMs = 60000,
  intervalMs = 250,
} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = readLiveWorkflowState({ workflowId, root });
    if (current) {
      if (!predicate || predicate(current)) return current;
      const term = [
        WORKFLOW_STATUSES.DONE,
        WORKFLOW_STATUSES.HUMAN_REQUIRED,
        WORKFLOW_STATUSES.FAILED,
        WORKFLOW_STATUSES.TIMEOUT,
        WORKFLOW_STATUSES.STALLED,
        WORKFLOW_STATUSES.STOPPED,
      ];
      if (term.includes(current.workflowStatus) && (!predicate || predicate(current))) {
        return current;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitForWorkflowState timed out after ${timeoutMs}ms for ${workflowId}`);
}

/**
 * Format semantic meaningful transitions for front-agent display.
 * Consumes zero model tokens.
 */
export function formatTransitionEvent(event) {
  if (!event || !event.type) return null;
  switch (event.type) {
    case 'workflow_started':
      return `▶ WORKFLOW_STARTED: ${event.workflowId || ''}`;
    case 'planning_started':
      return `▶ PLANNING_STARTED`;
    case 'planning_completed':
      return `✔ PLANNING_COMPLETED`;
    case 'task_started':
      return `▶ TASK_STARTED: ${event.taskId || 'next task'}`;
    case 'preflight_started':
      return `  ↳ PREFLIGHT_STARTED: ${event.taskId || ''}`;
    case 'preflight_passed':
      return `  ✔ PREFLIGHT_PASSED`;
    case 'preflight_blocked':
      return `  ✖ PREFLIGHT_BLOCKED: ${event.reason || (event.blockers?.[0]?.detail ?? 'blocker detected')}`;
    case 'task_attempt_started':
    case 'executor_started':
      return `  ↳ EXECUTOR_STARTED: ${event.taskId} (Attempt ${event.attempt || 1})`;
    case 'gate_started':
    case 'verification_started':
      return `  ↳ GATE_STARTED: ${event.taskId || ''} (Attempt ${event.attempt || 1})`;
    case 'verification_finished':
      return event.result === 'PASS' ? `  ✔ GATE_PASS` : `  ✖ GATE_FAIL`;
    case 'reviewer_started':
      return `  ↳ REVIEWER_STARTED: ${event.taskId || ''} (Attempt ${event.attempt || 1})`;
    case 'review_finished':
      return event.decision === 'PASS'
        ? `  ✔ REVIEWER_PASS`
        : `  ↺ REVIEWER_REWORK: ${Array.isArray(event.requiredChanges) ? event.requiredChanges.join('; ') : (event.requiredChanges || 'rework needed')}`;
    case 'rework_requested':
      return `  ↺ CONTINUE_REWORK: ${event.taskId ? `${event.taskId} ` : ''}(Attempt ${event.attempt || 2})`;
    case 'human_required':
      return `⏸ HUMAN_REQUIRED: ${event.question || event.reason}`;
    case 'delivery_started':
      return `▶ DELIVERY_STARTED`;
    case 'delivery_succeeded':
      return `✔ DELIVERY_SUCCEEDED: ${(event.changedFiles || []).length} files delivered`;
    case 'delivery_failed':
      return `✖ DELIVERY_FAILED: ${event.reason}`;
    case 'workflow_finished':
      return event.status === 'WORKFLOW_DONE'
        ? `★ WORKFLOW_DONE: ${event.summary || 'all tasks completed successfully'}`
        : `■ WORKFLOW_${event.status}: ${event.reason || event.summary || ''}`;
    case 'ROLE_PROVIDER_SWITCHED':
    case 'supervisor_provider_switched':
      return `↻ Supervisor switched → ${event.to || event.provider || 'fallback'}${event.reason ? ` (${event.reason})` : ''}`;
    case 'ROLE_SESSION_ROTATED':
      return `↻ Supervisor session rotated (${event.reason || 'context policy'})`;
    default:
      return null;
  }
}

export function formatCanonicalUsage(rawUsage, prCloseout = null) {
  const emptyRole = () => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byModel: {},
  });

  const u = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  const planner = u.planner ? { ...emptyRole(), ...u.planner } : emptyRole();
  const executor = u.executor ? { ...emptyRole(), ...u.executor } : emptyRole();
  const supervisor = u.supervisor ? { ...emptyRole(), ...u.supervisor } : emptyRole();
  const internalReviewer = u.internalReviewer ?? u.reviewer ? { ...emptyRole(), ...(u.internalReviewer ?? u.reviewer) } : emptyRole();

  const measuredTotal = u.measuredTotal ?? u.total ?? {
    calls: planner.calls + executor.calls + supervisor.calls + internalReviewer.calls,
    inputTokens: planner.inputTokens + executor.inputTokens + supervisor.inputTokens + internalReviewer.inputTokens,
    outputTokens: planner.outputTokens + executor.outputTokens + supervisor.outputTokens + internalReviewer.outputTokens,
    cachedTokens: planner.cachedTokens + executor.cachedTokens + supervisor.cachedTokens + internalReviewer.cachedTokens,
    totalTokens: planner.totalTokens + executor.totalTokens + supervisor.totalTokens + internalReviewer.totalTokens,
    costUsd: planner.costUsd + executor.costUsd + supervisor.costUsd + internalReviewer.costUsd,
  };

  const reviewerName = prCloseout?.configuredReviewer || prCloseout?.activeReviewer || u.externalPrReviewer?.reviewer || null;
  const externalPrReviewer = {
    reviewer: reviewerName,
    usageAvailable: false,
    note: reviewerName ? 'Token usage: unavailable / external' : 'Not configured',
    reviewed: Boolean(prCloseout?.reviewedPrHead),
  };

  return {
    planner,
    executor,
    supervisor,
    internalReviewer,
    reviewer: internalReviewer, // alias
    measuredTotal,
    total: measuredTotal, // alias
    externalPrReviewer,
    hasUsageData: measuredTotal.totalTokens > 0 || measuredTotal.calls > 0,
    records: Array.isArray(u.records) ? u.records : [],
  };
}

/**
 * Convert any live or persisted workflow state object into canonical progress format (PART 2).
 * Consumes zero model tokens.
 */
export function toCanonicalProgress(rawState, now = Date.now()) {
  if (!rawState) return null;
  const currentNow = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
  const elapsedMs = rawState.startedAt ? Math.max(0, currentNow - new Date(rawState.startedAt).getTime()) : 0;

  const s = String(rawState.stage || '').toUpperCase();
  const w = String(rawState.workflowStatus || '').toUpperCase();
  let canonicalStatus;
  if (w === 'DONE') canonicalStatus = 'DONE';
  else if (w === 'HUMAN_REQUIRED') canonicalStatus = 'HUMAN_REQUIRED';
  else if (w === 'FAILED' || w === 'TIMEOUT' || w === 'STALLED') canonicalStatus = 'FAILED';
  else if (w === 'STOPPED') canonicalStatus = 'STOPPED';
  else if (['EXECUTOR', 'GATE', 'REVIEWER', 'REWORK', 'ESCALATION', 'SUPERVISOR', 'APPLYING'].includes(s) || ['EXECUTOR', 'GATE', 'REVIEWER', 'REWORK', 'ESCALATION', 'SUPERVISOR', 'APPLYING'].includes(w)) canonicalStatus = 'RUNNING';
  else if (['STARTING', 'PLANNING', 'INIT', 'PREFLIGHT'].includes(s) || ['STARTING', 'PLANNING', 'INIT', 'PREFLIGHT'].includes(w) || w === 'STARTING') canonicalStatus = 'STARTING';
  else canonicalStatus = 'STARTING';

  return {
    workflowId: rawState.workflowId ?? null,
    kind: rawState.kind ?? (isTestWorkflowId(rawState.workflowId) ? WORKFLOW_KINDS.INTERNAL_TEST : WORKFLOW_KINDS.USER),
    parentWorkflowId: rawState.parentWorkflowId ?? null,
    workflowStatus: rawState.workflowStatus ?? 'UNKNOWN',
    rawStatus: rawState.workflowStatus ?? 'UNKNOWN',
    status: canonicalStatus,
    canonicalStatus,
    path: rawState.workflowPath ?? null,
    pathSelectionReason: rawState.pathSelectionReason ?? null,
    task: {
      current: rawState.taskIndex ?? null,
      total: rawState.taskTotal ?? null,
      taskId: rawState.taskId ?? null,
      title: rawState.taskName ?? null,
    },
    attempt: rawState.attempt ?? 1,
    stage: rawState.stage ?? rawState.workflowStatus ?? 'UNKNOWN',
    executor: {
      status: rawState.stageStatuses?.executor ?? 'waiting',
      model: rawState.executorModel ?? 'sonnet',
      escalated: Boolean(rawState.modelEscalated),
      escalationReason: rawState.escalationReason ?? null,
    },
    gate: {
      status: rawState.stageStatuses?.gate ?? 'waiting',
    },
    reviewer: {
      status: rawState.stageStatuses?.reviewer ?? 'waiting',
      routing: rawState.routing?.reviewer ?? null,
    },
    timing: {
      startedAt: rawState.startedAt ?? null,
      elapsedMs,
      elapsed: formatDuration(elapsedMs),
      heartbeatAt: rawState.heartbeatAt ?? null,
      lastProgressAt: rawState.lastProgressAt ?? null,
      lastActivityAt: rawState.lastActivityAt ?? null,
    },
    usage: formatCanonicalUsage(rawState.tokenUsage, rawState.prCloseout),
    routing: rawState.routing ?? { planner: null, supervisor: null, executor: null, reviewer: null, quotaPools: [] },
    terminal: [
      WORKFLOW_STATUSES.HUMAN_REQUIRED,
      WORKFLOW_STATUSES.DONE,
      WORKFLOW_STATUSES.FAILED,
      WORKFLOW_STATUSES.TIMEOUT,
      WORKFLOW_STATUSES.STALLED,
      WORKFLOW_STATUSES.STOPPED,
    ].includes(rawState.workflowStatus),
    summary: rawState.summary ?? null,
    reason: rawState.error ?? rawState.reason ?? null,
    question: rawState.question ?? null,
    evidence: rawState.evidence ?? null,
    blockers: rawState.blockers ?? [],
    blockerCategory: rawState.blockerCategory ?? null,
    deliveredFiles: rawState.deliveredFiles ?? [],
    activeProcesses: rawState.activeProcesses ?? [],
    prCloseout: rawState.prCloseout ?? null,
  };
}

export function readCanonicalProgress({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  const live = readLiveWorkflowState({ workflowId, root });
  return live ? toCanonicalProgress(live) : null;
}

export function validateAcceptanceInvariants(workflowState, usageTracker = null) {
  const violations = [];
  const s = workflowState ?? {};
  const attempts = Array.isArray(s.taskAttempts) ? s.taskAttempts : [];
  const tokenUsage = s.tokenUsage ?? usageTracker?.summary() ?? null;

  // 1. Check for attempt transitions
  const attemptsByTask = {};
  let recordedExecutorCalls = 0;
  let recordedReviewerCalls = 0;

  for (const att of attempts) {
    if (!att.taskId) continue;
    if (att.executorCallId) recordedExecutorCalls += 1;
    if (att.reviewerDecision) recordedReviewerCalls += 1;
    if (!attemptsByTask[att.taskId]) attemptsByTask[att.taskId] = [];
    attemptsByTask[att.taskId].push(att);
  }

  for (const [taskId, list] of Object.entries(attemptsByTask)) {
    list.sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i];
      const next = list[i + 1];

      // Invariant: Reviewer PASS with empty required_changes must not produce same-task retry
      if (current.reviewerDecision === 'PASS' && (!current.requiredChanges || current.requiredChanges.length === 0 || current.requiredChanges === 'none')) {
        if (next) {
          violations.push(
            `Task "${taskId}" attempt ${current.attempt} received Reviewer PASS but was followed by attempt ${next.attempt}`
          );
        }
      }

      // Invariant: If next attempt exists, prior attempt must have received REWORK (or gate failure) with valid reason
      if (next) {
        if (current.reviewerDecision !== 'REWORK' && current.gateResult === 'PASS') {
          violations.push(
            `Task "${taskId}" attempt ${next.attempt} started without prior REWORK or Gate failure on attempt ${current.attempt}`
          );
        }
        if (current.reviewerDecision === 'REWORK' && (!current.requiredChanges || current.requiredChanges.length === 0 || current.requiredChanges === 'none')) {
          violations.push(
            `Task "${taskId}" attempt ${current.attempt} has REWORK decision but required_changes is empty`
          );
        }
        if (current.executorCallId && next.executorCallId && current.executorCallId === next.executorCallId) {
          violations.push(
            `Task "${taskId}" attempt ${next.attempt} did not use a fresh Executor (reused callId ${current.executorCallId})`
          );
        }
      }
    }
  }

  // 2. Exact physical call accounting reconciliation
  if (tokenUsage) {
    const execCalls = tokenUsage.executor?.calls ?? 0;
    const revCalls = tokenUsage.reviewer?.calls ?? 0;
    if (attempts.length > 0 && recordedExecutorCalls !== execCalls) {
      violations.push(
        `Executor calls mismatch: detailed attempts recorded ${recordedExecutorCalls} calls, usage tracker recorded ${execCalls}`
      );
    }
    if (attempts.length > 0 && recordedReviewerCalls !== revCalls) {
      violations.push(
        `Reviewer calls mismatch: detailed attempts recorded ${recordedReviewerCalls} calls, usage tracker recorded ${revCalls}`
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

export const TERMINAL_STATUSES = new Set([
  WORKFLOW_STATUSES.DONE,
  WORKFLOW_STATUSES.HUMAN_REQUIRED,
  WORKFLOW_STATUSES.FAILED,
  WORKFLOW_STATUSES.TIMEOUT,
  WORKFLOW_STATUSES.STALLED,
  WORKFLOW_STATUSES.STOPPED,
]);

/**
 * Capture one immutable terminal snapshot. Fails closed with ACCEPTANCE_NOT_TERMINAL
 * if the workflow is still running or has in-flight role processes.
 */
export function captureTerminalSnapshot({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  state = null,
  usageTracker = null,
} = {}) {
  const raw = state ?? readLiveWorkflowState({ workflowId, root });
  if (!raw) {
    return {
      status: 'ACCEPTANCE_NOT_TERMINAL',
      reason: `Workflow state not found for ${workflowId}`,
      snapshot: null,
    };
  }

  // Rule 1 & 3: Must be a terminal status and have 0 active processes
  const isTerminal = TERMINAL_STATUSES.has(raw.workflowStatus);
  const activeProcesses = Array.isArray(raw.activeProcesses) ? raw.activeProcesses : [];
  if (!isTerminal || activeProcesses.length > 0) {
    return {
      status: 'ACCEPTANCE_NOT_TERMINAL',
      reason: `Workflow ${raw.workflowId} is non-terminal (status: ${raw.workflowStatus}, stage: ${raw.stage}, active processes: ${activeProcesses.length})`,
      snapshot: null,
    };
  }

  // Deep clone to produce an immutable snapshot
  const snapshot = JSON.parse(JSON.stringify(raw));
  if (usageTracker && !snapshot.tokenUsage) {
    snapshot.tokenUsage = usageTracker.summary();
  }

  const invariantCheck = validateAcceptanceInvariants(snapshot, usageTracker);
  return {
    status: invariantCheck.valid ? 'SNAPSHOT_CAPTURED' : 'ACCEPTANCE_EVIDENCE_INCONSISTENT',
    valid: invariantCheck.valid,
    violations: invariantCheck.violations,
    snapshot,
  };
}

/**
 * Generate a validated acceptance report strictly from an immutable terminal snapshot.
 */
export function generateTerminalAcceptanceReport({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  state = null,
  usageTracker = null,
} = {}) {
  const result = captureTerminalSnapshot({ workflowId, root, state, usageTracker });
  if (result.status === 'ACCEPTANCE_NOT_TERMINAL') {
    return {
      acceptance: 'ACCEPTANCE_NOT_TERMINAL',
      valid: false,
      reason: result.reason,
      report: null,
    };
  }

  if (result.status === 'ACCEPTANCE_EVIDENCE_INCONSISTENT' || !result.valid) {
    return {
      acceptance: 'ACCEPTANCE_EVIDENCE_INCONSISTENT',
      valid: false,
      violations: result.violations,
      report: null,
    };
  }

  const s = result.snapshot;
  const attempts = Array.isArray(s.taskAttempts) ? s.taskAttempts : [];
  const usage = s.tokenUsage ?? {};

  const accepted = s.workflowStatus === WORKFLOW_STATUSES.DONE;
  return {
    acceptance: accepted ? 'PASS' : 'NOT_ACCEPTED',
    valid: accepted,
    workflowId: s.workflowId,
    workflowStatus: s.workflowStatus,
    summary: s.summary,
    taskAttempts: attempts,
    tokenUsage: usage,
    report: {
      workflowId: s.workflowId,
      status: s.workflowStatus,
      attemptsTotal: attempts.length,
      attempts,
      usage,
    },
  };
}
