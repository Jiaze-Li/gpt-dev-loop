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
import { loadWorkspaceConfig, resolveApprovedExternalRoots, loadAndValidateExternalRoots, ExternalReadRootConfigError } from './workspaceConfig.js';
import { getCurrentRuntimeIdentity, compareRuntimeIdentity } from './runtimeIdentity.js';
import { supergptVerify, hashCommandSet, computeWorktreeFingerprint, CLOSEOUT_VERIFICATION_ID } from './hostVerification.js';
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
  claimOwner,
  requestStop,
  readControl,
  isStopRequested,
  isOwnerAlive,
  saveCheckpoint,
  markDeliveryReady,
  recordCloseoutVerificationEvidence,
  clearControl,
} from './workflowControl.js';
import { advanceTaskBaseline } from './taskBaseline.js';

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
  externalReadRoots = [],
  approvedExternalRoots = [],
  _pipeline = defaultPipeline,
  _resolveWorkflowPlan,
  _selectProviders,
  _createGateRunner,
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

  // Cross-process ownership: record this process as the owning orchestrator
  // and poll the durable control file so a `supergpt stop` issued from a
  // different CLI/MCP process reaches this abort controller. The owner is the
  // only party that can actually tear the pipeline down and await shutdown.
  claimOwner({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
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
    ACTIVE_WORKFLOWS.delete(workflowId);
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
          externalReadRoots: resolvedExternalRoots,
          approvedExternalRoots: resolvedExternalRoots,
          _resolveWorkflowPlan,
          _selectProviders,
          _createGateRunner,
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
      workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.STOPPED, {
        reason: result.reason,
        stopInitiator: 'user',
      });
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
      return result;
    }
    result.status = 'FAILED';
    result.reason = err?.message ?? String(err);
    workflowStateManager.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: result.reason });
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, reason: result.reason });
    return result;
  } finally {
    clearInterval(stopWatcher);
    ACTIVE_WORKFLOWS.delete(workflowId);
    workflowStateManager.stopHeartbeat();
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  // A fully delivered workflow needs no durable control record any more.
  if (result.status === 'WORKFLOW_DONE') {
    clearControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
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
  externalReadRoots = [],
  approvedExternalRoots = [],
  _resolveWorkflowPlan,
  _selectProviders,
  _createGateRunner,
}) {
  workflowStateManager?.startStage(WORKFLOW_STAGES.INIT);
  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'workspace' });

  const metadataPath = path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`);
  let worktree, baseline;
  let resolvedApprovedRoots = [];

  if (isResume && existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      ({ worktree, baseline } = restoreResumableWorkspace(meta));
      lifecycleManager?.trackWorktree(worktree.worktree_path);
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
  const readFrozenCloseoutCommands = () => {
    try {
      const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
      return Array.isArray(meta.closeout_verification_commands)
        ? meta.closeout_verification_commands.map((c) => String(c).trim()).filter(Boolean)
        : [];
    } catch { return []; }
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
    const currentFingerprint = computeWorktreeFingerprint(worktree.worktree_path);
    const prior = readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId })?.closeout_verification_evidence;
    const proofValid = prior?.pass === true && prior.workflow_id === workflowId &&
      prior.verification_identity === CLOSEOUT_VERIFICATION_ID &&
      prior.commands_hash === hashCommandSet(commands) &&
      JSON.stringify(prior.commands) === JSON.stringify(commands) &&
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
      recordCloseoutVerificationEvidence({ root: SUPERGPT_WORKTREE_ROOT, workflowId, evidence: {
        evidence_id: `closeout-${Date.now()}`, pass: true, commands, commands_hash: hashCommandSet(commands),
        worktree_fingerprint: computeWorktreeFingerprint(worktree.worktree_path), captured_at: new Date().toISOString(), workflow_id: workflowId, verification_identity: CLOSEOUT_VERIFICATION_ID,
      }});
    }
    let delivery;
    try {
      throwIfAborted(signal);
      delivery = await deliverWorkflowResult({ worktree });
    } catch (err) {
      emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: err.message });
      await lifecycleManager?.onWorkflowSuspended('delivery_failed');
      workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.FAILED, { reason: `delivery failed: ${err.message}` });
      throw err;
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

    if (lifecycleManager) {
      await lifecycleManager.onWorkflowDelivered();
    }
    clearControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId });
    workflowStateManager?.transitionTerminal(WORKFLOW_STATUSES.DONE, {
      summary: summary ?? null,
      deliveredFiles: delivery.delivered ?? delivery.changed_files ?? [],
    });
    emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles: delivery.delivered ?? delivery.changed_files ?? [] });
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
  const selection = (_selectProviders || selectProviders)({ env, callAgy: defaultCallAgy, persistence, workflowId, usageTracker, signal, onEvent: (event) => emit(event.type, event) });

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'planning' });
  emit(SUPERGPT_EVENTS.PLANNING_STARTED);
  workflowStateManager?.startStage(WORKFLOW_STAGES.PLANNING);
  let planArg = planPath ?? goal;
  if (answer && !planPath) {
    planArg = `${planArg}\n\n[User Clarification / Answer]:\n${answer}`;
  }
  const plannerResolver = _resolveWorkflowPlan ?? resolveWorkflowPlan;
  const resolved = (await selection.runtime.invoke('planner', {
    resolve: (call) => plannerResolver({ planArg, cwd: repoRoot, callAgy: call, log: () => {} }),
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
  emit(SUPERGPT_EVENTS.PLANNING_COMPLETED, { tasksCount: resolved.tasks?.length ?? 1 });

  // If this is a new workflow (not a resume) and the planner identified closeout commands, update workflow metadata to freeze them durably
  if (!isResume && Array.isArray(resolved.closeoutVerificationCommands) && resolved.closeoutVerificationCommands.length > 0) {
    try {
      if (existsSync(metadataPath)) {
        const meta = JSON.parse(readFileSync(metadataPath, 'utf8'));
        const mergedCloseout = [...new Set([
          ...(meta.closeout_verification_commands || []),
          ...resolved.closeoutVerificationCommands,
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
    closeoutVerificationCommands: frozenCloseoutCommands,
    onCloseoutPass: async (proof) => recordCloseoutVerificationEvidence({
      root: SUPERGPT_WORKTREE_ROOT, workflowId, evidence: {
        ...proof,
        worktree_fingerprint: computeWorktreeFingerprint(worktree.worktree_path),
      },
    }),
    taskTotal: resolved.tasks?.length ?? 1,
    workflowStateManager,
    usageTracker,
    signal,
    checkpoint: control?.checkpoint ?? null,
    onCheckpoint: (cp) => saveCheckpoint({ root: SUPERGPT_WORKTREE_ROOT, workflowId }, cp),
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
      await advanceTaskBaseline({ repoRoot, taskId, baseline, exec });
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

export async function supergptWatch({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  intervalMs = 1000,
  timeoutMs = Infinity,
  signal = null,
  onProgress = null,
  _readState = readLiveWorkflowState,
  _now = () => Date.now(),
  _sleep = abortableSleep,
} = {}) {
  if (!workflowId) throw new Error('supergptWatch requires a workflowId');

  const effectiveTimeout = timeoutMs === null || timeoutMs === undefined ? Infinity : timeoutMs;
  const startTime = _now();
  let progressSeq = 1;

  const getCanonical = () => {
    const raw = _readState({ workflowId, root });
    if (raw) return toCanonicalProgress(raw, _now());
    return null;
  };

  let canonical = getCanonical();
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
  if (!workflowId) throw new Error('supergptStop requires a workflowId');

  // 1. Durable, cross-process stop request. The owning orchestrator — even in
  //    a different CLI/MCP process — polls this file and aborts itself,
  //    tearing down its own pipeline and awaiting shutdown before it
  //    publishes a terminal state.
  requestStop({ root, workflowId, reason });

  const control = readControl({ root, workflowId });
  const ownerPid = control?.owner?.pid ?? null;
  const ownerAlive = isOwnerAlive(control);
  const foreignLiveOwner = ownerAlive && ownerPid !== process.pid;

  // 2. Same-process owner: abort directly and let its own teardown run.
  const running = ACTIVE_WORKFLOWS.get(workflowId);
  if (running) {
    running.abortController?.abort();
  }

  // 3. Foreign, live owner: wait (bounded) for it to acknowledge by
  //    publishing a terminal state. Its own pipeline shutdown completes
  //    before that write, so no Reviewer/delivery runs afterwards.
  let ownerAcknowledged = false;
  if (foreignLiveOwner) {
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
  WORKFLOW_STAGES,
  WORKFLOW_STATUSES,
  ExternalReadRootConfigError,
};
