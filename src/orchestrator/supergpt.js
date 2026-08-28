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
import { mkdir, writeFile } from 'node:fs/promises';

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
});

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
// Returns { status, summary, deliveredFiles, workflowId, conversations,
// reason, question }. status is one of WORKFLOW_DONE | HUMAN_REQUIRED |
// CANCELLED | FAILED.
export async function runSuperGPT({
  goal,
  planPath,
  cwd = process.cwd(),
  onEvent,
  outputFormat,
  signal,
  env = process.env,
  _pipeline = defaultPipeline,
} = {}) {
  const workflowId = `wf-agy-${randomUUID()}`;
  const result = { ...EMPTY_RESULT(), workflowId };

  const write = outputFormat ? (s) => process.stdout.write(`${s}\n`) : null;
  const emit = (type, data = {}) => {
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
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
    return result;
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_STARTED, {
    workflowId,
    goal: goal ?? null,
    planPath: planPath ?? null,
    cwd,
  });

  let onAbort;
  const abortPromise = new Promise((_resolve, reject) => {
    onAbort = () => reject(new CancellationError());
  });
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const pipelineResult = await Promise.race([
      Promise.resolve().then(() => _pipeline({ goal, planPath, cwd, env, emit, signal, workflowId })),
      abortPromise,
    ]);
    Object.assign(result, pipelineResult, { workflowId });
  } catch (err) {
    if (err instanceof CancellationError || signal?.aborted) {
      result.status = 'CANCELLED';
      result.reason = 'run cancelled by AbortSignal';
      emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status });
      return result;
    }
    result.status = 'FAILED';
    result.reason = err?.message ?? String(err);
    emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, reason: result.reason });
    return result;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  emit(SUPERGPT_EVENTS.WORKFLOW_FINISHED, { status: result.status, summary: result.summary ?? null });
  return result;
}

// The real end-to-end pipeline. Mirrors scripts/run-agy-workflow.js's main()
// but reports progress through `emit` instead of console formatting, and
// returns the structured result rather than setting process.exitCode.
async function defaultPipeline({ goal, planPath, cwd, env, emit, signal, workflowId }) {
  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'workspace' });
  const metadataPath = path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`);
  const { worktree, baseline } = await establishIsolatedWorkspace({
    sourceCwd: cwd,
    workflowId,
    recordMetadata: async (meta) => {
      await mkdir(SUPERGPT_WORKTREE_ROOT, { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    },
  });
  const repoRoot = worktree.worktree_path;
  throwIfAborted(signal);

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'planning' });
  const planArg = planPath ?? goal;
  const resolved = await resolveWorkflowPlan({
    planArg,
    cwd: repoRoot,
    callAgy: defaultCallAgy,
    log: () => {},
  });
  if (resolved.status === 'AMBIGUOUS') {
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason: 'plan_ambiguous', question: resolved.question });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      reason: 'The instruction is ambiguous and needs clarification before execution.',
      question: resolved.question,
    };
  }
  const plan = resolved.plan;
  throwIfAborted(signal);

  const persistence = new Persistence(path.join(repoRoot, '.gpt-dev-loop', 'workflows'));
  const selection = selectProviders({ env, callAgy: defaultCallAgy, persistence, workflowId });
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
    createClaudeSessionManager: ({ taskId }) =>
      createClaudeSessionManager({ workflowId, taskId, persistence, cwd: repoRoot }),
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
    log: (line) => {
      const event = translateLogLine(line);
      if (!event) return;
      const { type, ...payload } = event;
      emit(type, payload);
      if (type === SUPERGPT_EVENTS.REVIEW_FINISHED && payload.decision === 'REWORK') {
        emit(SUPERGPT_EVENTS.REWORK_REQUESTED, { taskId: payload.taskId, attempt: payload.attempt });
      }
    },
  });

  const conversations = selection.sessionStore?.snapshot?.() ?? null;

  if (loopResult.status !== 'WORKFLOW_DONE') {
    emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, {
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
    });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      reason: loopResult.reason ?? null,
      question: loopResult.question ?? null,
      conversations,
    };
  }

  emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'delivery' });
  let delivery;
  try {
    delivery = await deliverWorkflowResult({ worktree });
  } catch (err) {
    emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: err.message });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      summary: loopResult.summary ?? null,
      reason: `delivery failed: ${err.message}`,
      question: 'Resolve the delivery problem in the isolated worktree, then resume.',
      conversations,
    };
  }

  if (delivery.status === 'HUMAN_REQUIRED') {
    emit(SUPERGPT_EVENTS.DELIVERY_FAILED, { reason: 'conflict', conflicts: delivery.conflicts });
    return {
      ...EMPTY_RESULT(),
      status: 'HUMAN_REQUIRED',
      summary: loopResult.summary ?? null,
      deliveredFiles: delivery.changed_files ?? [],
      reason: 'The approved changes conflict with the invocation workspace.',
      question: 'Resolve the conflicting files in the invocation workspace, then resume.',
      conversations,
    };
  }

  emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles: delivery.changed_files ?? [] });
  return {
    ...EMPTY_RESULT(),
    status: 'WORKFLOW_DONE',
    summary: loopResult.summary ?? null,
    deliveredFiles: delivery.changed_files ?? [],
    conversations,
  };
}
