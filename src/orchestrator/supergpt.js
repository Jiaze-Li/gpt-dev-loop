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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

import { runAutomatedWorkflow } from './automatedLoop.js';
import { selectProviders } from './providerSelection.js';
import { createClaudeSessionManager } from './adapters/claudeSessionManager.js';
import { createGateRunner } from './adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../adapters/gate/git-evidence/index.js';
import { Persistence } from './persistence.js';
import { deliverWorkflowResult } from './resultDelivery.js';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { establishIsolatedWorkspace, resolveWorkflowPlan } from '../../scripts/run-agy-workflow.js';
import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import { UsageTracker } from './usageTracker.js';
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

// The complete typed-event vocabulary emitted through onEvent. Every event
// object is { type, timestamp, ...payload }.
export const SUPERGPT_EVENTS = Object.freeze({
  WORKFLOW_STARTED: 'workflow_started',
  STAGE_CHANGED: 'stage_changed',
  TASK_STARTED: 'task_started',
  TASK_ATTEMPT_STARTED: 'task_attempt_started',
  VERIFICATION_STARTED: 'verification_started',
  VERIFICATION_FINISHED: 'verification_finished',
  REVIEW_FINISHED: 'review_finished',
  REWORK_REQUESTED: 'rework_requested',
  HUMAN_REQUIRED: 'human_required',
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

export function workflowRuntimeDirectory(workflowId) {
  return path.join(SUPERGPT_WORKTREE_ROOT, workflowId, 'persistence');
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
  _pipeline = defaultPipeline,
} = {}) {
  const workflowId = explicitWorkflowId ?? `wf-agy-${randomUUID()}`;
  const result = { ...EMPTY_RESULT(), workflowId };

  const workflowStateManager = new WorkflowStateManager({ workflowId, root: SUPERGPT_WORKTREE_ROOT });
  workflowStateManager.startHeartbeat(1000);
  const lifecycleManager = new WorkflowLifecycleManager({ workflowId, root: SUPERGPT_WORKTREE_ROOT, sourceCwd: cwd });
  const usageTracker = new UsageTracker();

  // Conservative GC in background: clean up any stale abandoned resources
  gcSuperGptResources({ root: SUPERGPT_WORKTREE_ROOT, sourceCwd: cwd }).catch(() => {});

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

  if (signal?.aborted) {
    result.status = 'CANCELLED';
    result.reason = 'AbortSignal was already aborted before the run started';
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.STOPPED, { reason: result.reason });
    workflowStateManager.stopHeartbeat();
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
    return result;
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_STARTED, {
    workflowId,
    goal: goal ?? null,
    planPath: planPath ?? null,
    cwd,
    isResume,
  });

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

  ACTIVE_WORKFLOWS.set(workflowId, {
    abortController: internalAbort,
    workflowStateManager,
    lifecycleManager,
  });

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
      result.reason = 'run cancelled by AbortSignal';
      workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.STOPPED, { reason: result.reason });
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
      return result;
    }
    result.status = 'FAILED';
    result.reason = err?.message ?? String(err);
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: result.reason });
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, reason: result.reason });
    return result;
  } finally {
    ACTIVE_WORKFLOWS.delete(workflowId);
    workflowStateManager.stopHeartbeat();
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, summary: result.summary ?? null });
  return result;
}

// Start is intentionally separate from run: Core retains the promise and all
// lifecycle ownership while callers get a durable id without waiting for work.
export function startSuperGPT(options = {}) {
  const workflowId = options.workflowId ?? `wf-agy-${randomUUID()}`;
  const run = runSuperGPT({ ...options, workflowId });
  // runSuperGPT converts workflow failures into durable terminal state/result;
  // this final catch is only a last-resort guard against an unhandled rejection.
  run.catch(() => {});
  return { status: WORKFLOW_STATUSES.RUNNING, workflowId };
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
}) {
  workflowStateManager?.startStage(WORKFLOW_STAGES.INIT);
  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'workspace' });

  const metadataPath = path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`);
  let worktree, baseline;

  if (isResume && existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      ({ worktree, baseline } = restoreResumableWorkspace(meta));
      lifecycleManager?.trackWorktree(worktree.worktree_path);
    } catch (err) {
      if (lifecycleManager) await lifecycleManager.onInitFailed();
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: `resume failed: ${err.message}` });
      throw err;
    }
  } else {
    try {
      const established = await establishIsolatedWorkspace({
        sourceCwd: cwd,
        workflowId,
        recordMetadata: async (meta) => {
          await mkdir(SUPERGPT_WORKTREE_ROOT, { recursive: true });
          await writeFile(metadataPath, `${JSON.stringify({ ...meta, goal, plan_path: planPath }, null, 2)}\n`, 'utf8');
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

  // Production role runtime is assembled before the first model invocation.
  // Planning is therefore subject to the same policy/quota/health routing as
  // every subsequent workflow role.
  // Provider/session persistence is runtime state, never user-project output.
  // Keeping it outside the isolated worktree prevents it being interpreted as
  // an untracked change and delivered into the invocation workspace.
  const persistence = new Persistence(workflowRuntimeDirectory(workflowId));
  const selection = selectProviders({ env, callAgy: defaultCallAgy, persistence, workflowId, usageTracker, signal, onEvent: (event) => emit(event.type, event) });

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'planning' });
  workflowStateManager?.startStage(WORKFLOW_STAGES.PLANNING);
  let planArg = planPath ?? goal;
  if (answer && !planPath) {
    planArg = `${planArg}\n\n[User Clarification / Answer]:\n${answer}`;
  }
  const resolved = (await selection.runtime.invoke('planner', {
    resolve: (call) => resolveWorkflowPlan({ planArg, cwd: repoRoot, callAgy: call, log: () => {} }),
  }, { operationId: workflowId })).value;
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
  let plan = resolved.plan;
  if (answer) {
    plan = `${plan}\n\n[Human Decision / Answer]:\n${answer}`;
    workflowStateManager?.recordProgress({ humanAnswer: answer });
  }
  workflowStateManager?.recordProgress({ taskTotal: resolved.tasks?.length ?? 1 });
  throwIfAborted(signal);

  const { supervisorSession, createReviewerSession, windowSession } = selection;

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'executing' });
  const baseGate = createGateRunner({
    gitEvidenceCollector: createGitEvidenceCollector(),
    cwd: repoRoot,
    baseline,
  });
  const gateRunner = {
    async run(commands) {
      const evidence = await baseGate.run(commands);
      emit(SUPERGPT_EVENTS.VERIFICATION_FINISHED, { result: evidence.pass ? 'PASS' : 'FAIL' });
      return evidence;
    },
  };

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
    windowSession,
    persistence,
    workflowGoal: plan,
    repositoryContext: {
      repository_name: path.basename(worktree.source_repo_root),
      repository_url: null,
      branch: worktree.source_branch,
      commit_sha: worktree.baseline_head,
    },
    maxAttemptsPerTask: Number(env.AGY_MAX_ATTEMPTS) || 3,
    workflowStateManager,
    usageTracker,
    signal,
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
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
        await execFileAsync('git', ['commit', '-m', `chore(supergpt): complete task ${taskId}`], { cwd: repoRoot });
        const { stdout: newHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
        if (baseline && newHead) {
          baseline.head = newHead.trim();
        }
      } catch {
        /* ignore if clean */
      }
    },
  });

  throwIfAborted(signal);

  const conversations = selection.sessionStore?.snapshot?.() ?? null;

  if (loopResult.status !== 'WORKFLOW_DONE') {
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, {
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
    });
    await lifecycleManager?.onWorkflowSuspended(loopResult.reason ?? 'human_required');
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
    });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
      conversations,
      tokenUsage: usageTracker?.summary() ?? null,
    };
  }

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'delivery' });
  workflowStateManager?.startStage(WORKFLOW_STAGES.APPLYING);
  let delivery;
  try {
    throwIfAborted(signal);
    delivery = await deliverWorkflowResult({ worktree });
  } catch (err) {
    emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: err.message });
    await lifecycleManager?.onWorkflowSuspended('delivery_failed');
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, {
      reason: `delivery failed: ${err.message}`,
    });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      summary: loopResult.summary ?? null,
      reason: `delivery failed: ${err.message}`,
      question: 'Resolve the delivery problem in the isolated worktree, then resume.',
      conversations,
      tokenUsage: usageTracker?.summary() ?? null,
    };
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
      summary: loopResult.summary ?? null,
      deliveredFiles: delivery.changed_files ?? [],
      reason: 'The approved changes conflict with the invocation workspace.',
      question: 'Resolve the conflicting files in the invocation workspace, then resume.',
      conversations,
      tokenUsage: usageTracker?.summary() ?? null,
    };
  }

  // Delivery succeeded! Clean up resources automatically (B6)
  if (lifecycleManager) {
    await lifecycleManager.onWorkflowDelivered();
  }
  workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: loopResult.summary });

  emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles: delivery.changed_files ?? [] });
  return {
    ...EMPTY_RESULT(),
    status: 'WORKFLOW_DONE',
    summary: loopResult.summary ?? null,
    deliveredFiles: delivery.changed_files ?? [],
    conversations,
    tokenUsage: usageTracker?.summary() ?? null,
  };
}

export function supergptStatus({ workflowId, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  return readLiveWorkflowState({ workflowId, root });
}

export function supergptWait({ workflowId, root = SUPERGPT_WORKTREE_ROOT, predicate, timeoutMs, intervalMs } = {}) {
  return waitForWorkflowState({ workflowId, root, predicate, timeoutMs, intervalMs });
}

export async function supergptStop({
  workflowId,
  reason = 'stopped by user',
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  if (!workflowId) throw new Error('supergptStop requires a workflowId');

  const running = ACTIVE_WORKFLOWS.get(workflowId);
  if (running) {
    running.abortController?.abort();
    running.workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.STOPPED, { reason, stopInitiator: 'user' });
    running.workflowStateManager?.stopHeartbeat();
    ACTIVE_WORKFLOWS.delete(workflowId);
  }

  const liveState = readLiveWorkflowState({ workflowId, root });
  const pidsKilled = [];
  if (liveState && Array.isArray(liveState.activeProcesses)) {
    for (const proc of liveState.activeProcesses) {
      if (proc?.pid && isProcessAlive(proc.pid)) {
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
      const raw = readFileSync(statePath, 'utf8');
      const current = JSON.parse(raw);
      current.workflowStatus = WORKFLOW_STATUSES.STOPPED;
      current.stoppedReason = reason;
      current.stoppedAt = new Date().toISOString();
      current.stopInitiator = 'user';
      if (current.stageStatuses) {
        if (current.stageStatuses.executor === 'running') current.stageStatuses.executor = 'stopped';
        if (current.stageStatuses.reviewer === 'running') current.stageStatuses.reviewer = 'stopped';
      }
      writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }

  return {
    workflowId,
    status: WORKFLOW_STATUSES.STOPPED,
    reason,
    pidsKilled,
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
} = {}) {
  if (!workflowId) throw new Error('supergptResume requires a workflowId');

  const root = SUPERGPT_WORKTREE_ROOT;
  const metadataPath = path.join(root, `${workflowId}.workspace.json`);
  if (!existsSync(metadataPath)) {
    throw new Error(`Cannot resume workflow "${workflowId}": workspace metadata not found at ${metadataPath}`);
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot resume workflow "${workflowId}": corrupted workspace metadata (${err.message})`);
  }

  const effectiveCwd = cwd ?? meta.source_workspace ?? meta.source_repo_root ?? process.cwd();

  return runSuperGPT({
    workflowId,
    isResume: true,
    answer,
    goal: meta.goal ?? null,
    planPath: meta.plan_path ?? null,
    cwd: effectiveCwd,
    onEvent,
    outputFormat,
    signal,
    env,
    _pipeline,
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
};
