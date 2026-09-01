// Claude Session Manager — docs/design/agent-lifecycle.md §4.
//
// Wraps the Claude Executor Adapter (claudeExecutorAdapter.js) so the
// executor slot workflowManager.js calls stays a short-lived worker
// instead of one Claude conversation growing across an entire workflow.
// Exposes the same execute(task_card) -> execution_report signature as
// any other Executor Adapter (ADAPTER_INTERFACE.md §1), so it is a
// drop-in replacement wired in at orchestratorCli.js — workflowManager.js
// and stateMachine.js are untouched.
//
// Lifecycle per call to execute():
//   1. start a brand-new Claude session (a fresh executor instance/process
//      — never the previous call's)
//   2. wait for it to finish
//   3. collect its Execution Report
//
// The first call for a task is session #1 and runs the Task Card as-is.
// Every later call (a rework, after a gate failure or a GPT REWORK
// verdict) is a new session — #2, #3, ... — built from the *original*
// Task Card plus the current repository state and the feedback
// workflowManager.js already recorded as `last_error` for the previous
// attempt. It does not resume the earlier session's conversation.

import { spawn as nodeSpawn } from 'node:child_process';
import { createClaudeExecutorAdapter } from './claudeExecutorAdapter.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../errors.js';

function runGit(args, { cwd, spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

async function currentRepositoryState({ cwd, spawn }) {
  const [commit, status] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], { cwd, spawn }),
    runGit(['status', '--short'], { cwd, spawn }),
  ]);
  return `commit: ${commit || 'unknown'}\nchanges:\n${status || '(clean)'}`;
}

// Folds rework feedback + repo state into the Task Card's existing
// `context` field rather than adding a new field, so the Task Card still
// matches TASK_PROTOCOL.md unmodified.
function buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState }) {
  return {
    ...taskCard,
    context: `${taskCard.context}

## Rework — Claude session #${sessionNumber}
This is a new Claude session. The previous session's conversation is not
available to you — treat this as a fresh start informed only by what
follows.

### GPT review / gate feedback from the previous attempt
${feedback}

### Current repository state
${repositoryState}`,
  };
}

export const CLAUDE_MODELS = Object.freeze({
  DEFAULT: 'sonnet',
  ESCALATED: 'opus',
});

const ARCHITECTURAL_RE = /\b(architectural(\s+refactor|\s+change|\s+redesign)?|high\s+complexity|cross-cutting|deep\s+debugging|security-critical)\b/i;

/**
 * Deterministic classifier for Claude executor model selection (A5).
 * Defaults to Sonnet; escalates to Opus when justified.
 */
export function classifyExecutorModel(taskCard, { sessionNumber = 1, feedback = '', env = process.env } = {}) {
  const defaultModel = env?.CLAUDE_DEFAULT_MODEL || CLAUDE_MODELS.DEFAULT;
  const escalatedModel = env?.CLAUDE_ESCALATED_MODEL || CLAUDE_MODELS.ESCALATED;

  if (env?.FORCE_CLAUDE_MODEL) {
    return {
      model: env.FORCE_CLAUDE_MODEL,
      escalated: env.FORCE_CLAUDE_MODEL === escalatedModel,
      escalationReason: 'forced via FORCE_CLAUDE_MODEL environment variable',
    };
  }

  if (taskCard?.executor_model) {
    const isEsc = taskCard.executor_model === escalatedModel;
    return {
      model: taskCard.executor_model,
      escalated: isEsc,
      escalationReason: isEsc ? 'explicitly requested in task card' : null,
    };
  }

  // 1. Explicit high complexity or architectural flags
  if (taskCard?.complexity === 'high' || taskCard?.complexity === 'complex' || taskCard?.high_risk === true || taskCard?.architectural === true) {
    return {
      model: escalatedModel,
      escalated: true,
      escalationReason: 'task explicitly classified as high complexity/architectural risk',
    };
  }

  // 2. Goal or scope text indicates architectural complexity or cross-cutting refactor
  const combinedText = `${taskCard?.goal ?? ''} ${taskCard?.scope ?? ''}`;
  if (ARCHITECTURAL_RE.test(combinedText)) {
    return {
      model: escalatedModel,
      escalated: true,
      escalationReason: 'task goal or scope indicates architectural complexity',
    };
  }

  // 3. Repeated valid REWORK: if sessionNumber >= 3, default executor is struggling
  if (sessionNumber >= 3) {
    return {
      model: escalatedModel,
      escalated: true,
      escalationReason: `repeated rework (attempt ${sessionNumber}) indicates default executor is insufficient`,
    };
  }

  // 4. Feedback from previous attempt indicates deep debugging required
  if (sessionNumber > 1 && feedback && ARCHITECTURAL_RE.test(feedback)) {
    return {
      model: escalatedModel,
      escalated: true,
      escalationReason: 'rework feedback indicates difficult debugging/architectural issues',
    };
  }

  return {
    model: defaultModel,
    escalated: false,
    escalationReason: null,
  };
}

export function createClaudeSessionManager({
  workflowId,
  taskId,
  persistence,
  createExecutor = createClaudeExecutorAdapter,
  cwd = process.cwd(),
  spawn = nodeSpawn,
  env = process.env,
  onRoutingDecision,
  onProcessStarted,
  onProcessExited,
} = {}) {
  let sessionCount = 0;
  const physicalCalls = new Map();

  return {
    async execute(taskCard, { signal, attempt = null, physicalCallReason = 'PRIMARY' } = {}) {
      if (signal?.aborted) throw new Error('executor cancelled');
      if (taskCard?.task_id !== taskId) {
        throw new Error(`Claude session manager for "${taskId}" cannot execute task "${taskCard?.task_id}"`);
      }
      const effectiveAttempt = Number.isFinite(attempt) ? attempt : sessionCount + 1;
      const slot = `${taskId}:${effectiveAttempt}`;
      // The Claude adapter owns one provider only. A second full invocation in
      // the same task/attempt is never a continuation and is therefore unsafe.
      if (physicalCalls.has(slot)) {
        throw new AdapterError(
          ADAPTER_ERROR_CODES.EXECUTOR_DUPLICATE_CALL_REJECTED,
          `duplicate executor physical call rejected for task=${taskId} attempt=${effectiveAttempt}; first reason=${physicalCalls.get(slot)}, requested reason=${physicalCallReason}`
        );
      }
      if (physicalCallReason !== 'PRIMARY') {
        throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_DUPLICATE_CALL_REJECTED, `unsupported executor physical call reason: ${physicalCallReason}`);
      }
      physicalCalls.set(slot, physicalCallReason);
      sessionCount += 1;
      const sessionNumber = sessionCount;

      let feedback = 'none recorded';
      let taskCardForSession = taskCard;
      if (sessionNumber > 1) {
        const state = await persistence?.readState?.(workflowId, taskId);
        feedback = state?.last_error ?? 'none recorded';
        const repositoryState = await currentRepositoryState({ cwd, spawn });
        taskCardForSession = buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState });
      }

      const routing = classifyExecutorModel(taskCard, { sessionNumber, feedback, env });

      if (typeof onRoutingDecision === 'function') {
        try {
          onRoutingDecision({
            workflowId,
            taskId,
            sessionNumber,
            ...routing,
          });
        } catch {
          /* ignore callback error */
        }
      }

      if (persistence && typeof persistence.writeState === 'function') {
        try {
          await persistence.writeState({
            workflow_id: workflowId,
            task_id: taskId,
            executor_model: routing.model,
            model_escalated: routing.escalated,
            escalation_reason: routing.escalationReason,
          });
        } catch {
          /* best effort state recording */
        }
      }

      // A fresh executor per call: starts a new Claude session, waits for
      // it to finish, and collects its Execution Report. Never reuses a
      // previous call's executor/process.
      const processContext = { role: 'executor', taskId, attempt: effectiveAttempt, physicalCallReason, provider: 'claude', requestedFamily: 'claude:default', resolvedModel: routing.model };
      const executor = createExecutor({
        cwd, model: routing.model,
        onProcessStarted: (pid) => onProcessStarted?.({ ...processContext, pid }),
        onProcessExited: (details) => onProcessExited?.({ ...processContext, ...details }),
      });
      const report = await executor.execute(taskCardForSession, { signal });
      if (signal?.aborted) throw new Error('executor cancelled');

      // Ensure report has routing metadata attached
      try {
        Object.defineProperties(report, {
          model: { value: report.model || routing.model, writable: true, configurable: true, enumerable: false },
          modelEscalated: { value: routing.escalated, writable: true, configurable: true, enumerable: false },
          escalationReason: { value: routing.escalationReason, writable: true, configurable: true, enumerable: false },
          physicalCallReason: { value: physicalCallReason, writable: false, configurable: false, enumerable: false },
        });
      } catch {
        /* best effort */
      }

      return report;
    },
  };
}
