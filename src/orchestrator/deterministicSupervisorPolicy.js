// Zero-token Supervisor fast path for workflows with a Planner-produced task queue.
// The deterministic Core owns obvious transitions; the model Supervisor is reserved
// for genuine ambiguity / non-convergence.

// A deterministic decision is computed by the orchestrator Core without any
// model call. It must be accounted as exactly zero provider calls and zero
// tokens; UsageTracker enforces this by refusing to aggregate a supervisor
// record that carries neither an immutable provider callId nor provider usage
// metadata (see isDeterministicSupervisorRecord in usageTracker.js).
export const DETERMINISTIC_SUPERVISOR_DECISION_TOKEN_COST = 0;

function asList(value) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (value === null || value === undefined || value === 'none') return [];
  const text = String(value).trim();
  return text ? [text] : [];
}

function reworkSignature(review) {
  return asList(review?.required_changes)
    .map((item) => item.toLowerCase().replace(/\s+/g, ' ').trim())
    .sort()
    .join('\n');
}

export function validPlannedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
    if (typeof task.task_id !== 'string' || !task.task_id.trim()) return false;
    if (ids.has(task.task_id.trim())) return false;
    ids.add(task.task_id.trim());
    if (typeof task.goal !== 'string' || !task.goal.trim()) return false;
    if (!Array.isArray(task.allowed_files) || task.allowed_files.length === 0) return false;
    if (!Array.isArray(task.verification_commands) || task.verification_commands.length === 0) return false;
  }
  return true;
}

import { resolveRepoRelativePaths } from './workspaceConfig.js';

export function materializePlannedTask(task, { repositoryContext = {}, workflowGoal = '', repoFiles } = {}) {
  const verificationCommands = asList(task.verification_commands);
  const acceptanceCriteria = asList(task.acceptance_criteria);
  const allowedFiles = resolveRepoRelativePaths(asList(task.allowed_files), { repoFiles }).paths;
  return {
    task_id: task.task_id.trim(),
    repository_context: { ...repositoryContext },
    goal: task.goal.trim(),
    context: typeof task.context === 'string' && task.context.trim()
      ? task.context.trim()
      : String(workflowGoal ?? '').trim(),
    scope: typeof task.scope === 'string' && task.scope.trim() ? task.scope.trim() : task.goal.trim(),
    allowed_files: allowedFiles,
    forbidden_files: asList(task.forbidden_files),
    acceptance_criteria: acceptanceCriteria.length
      ? acceptanceCriteria
      : [
          `Task goal is satisfied: ${task.goal.trim()}`,
          'All listed verification commands pass.',
        ],
    verification_commands: verificationCommands,
    completion_signal: 'DONE',
  };
}

// Returns { handled:true, decision } when Core can decide without a model,
// otherwise { handled:false, reason } and the caller should invoke Supervisor.
export function decideDeterministically({
  context = {},
  plannedTasks,
  planSummary = null,
  reworkMemory = new Map(),
} = {}) {
  const effectivePlannedTasks = context.plannedTasks || plannedTasks;
  const effectivePlanSummary = context.planSummary || planSummary;

  if (!validPlannedTasks(effectivePlannedTasks)) {
    return { handled: false, reason: 'no_structured_task_queue' };
  }

  const history = Array.isArray(context.history) ? context.history : [];
  const plannedIds = new Set(effectivePlannedTasks.map((task) => task.task_id.trim()));
  const completedIds = new Set();
  for (const entry of history) {
    // OUT_OF_SCOPE closes a task deterministically just like PASS: it is done
    // and the planned queue advances past it (it is not re-selected).
    if ((entry?.decision !== 'PASS' && entry?.decision !== 'OUT_OF_SCOPE') || typeof entry?.task_id !== 'string') continue;
    const id = entry.task_id.trim();
    // A checkpoint from a different plan means the current queue cannot be
    // trusted to advance deterministically; escalate instead of guessing.
    if (!plannedIds.has(id)) return { handled: false, reason: 'plan_history_mismatch' };
    completedIds.add(id);
  }

  const review = context.latestReviewResult ?? null;
  if (review?.decision === 'HUMAN_REQUIRED') {
    return { handled: false, reason: 'reviewer_human_required' };
  }

  if (review?.decision === 'REWORK') {
    const maxAttempts = context.maxAttemptsPerTask || 3;
    const normalAttempts = Number.isFinite(context.normalAttempts) ? context.normalAttempts : (context.attempt || 0);
    if (normalAttempts >= maxAttempts && !context.escalationActive) {
      return { handled: false, reason: 'exhausted_normal_attempts_escalation' };
    }

    // Gate failures are mechanical code/test failures. Environment/toolchain
    // failures are already intercepted by automatedLoop as HUMAN_REQUIRED.
    if (review.source === 'GATE') {
      return { handled: true, decision: { action: 'CONTINUE_REWORK' }, reason: 'gate_rework' };
    }


    const taskId = typeof review.task_id === 'string' ? review.task_id.trim() : '';
    const signature = reworkSignature(review);
    if (!taskId || !plannedIds.has(taskId) || !signature) {
      return { handled: false, reason: 'unscoped_reviewer_rework' };
    }

    const previous = reworkMemory.get(taskId) ?? null;
    reworkMemory.set(taskId, signature);
    if (previous === signature) {
      return { handled: false, reason: 'reviewer_rework_nonconvergence' };
    }
    return { handled: true, decision: { action: 'CONTINUE_REWORK' }, reason: 'ordinary_reviewer_rework' };
  }

  if (review && review.decision !== 'PASS' && review.decision !== 'OUT_OF_SCOPE') {
    return { handled: false, reason: 'unknown_review_state' };
  }

  // PASS and OUT_OF_SCOPE both close the current task; clear its rework memory
  // and let the queue advance to the next planned task (or DONE).
  if ((review?.decision === 'PASS' || review?.decision === 'OUT_OF_SCOPE') && typeof review.task_id === 'string') {
    reworkMemory.delete(review.task_id.trim());
  }

  const nextTask = effectivePlannedTasks.find((task) => !completedIds.has(task.task_id.trim()));
  if (nextTask) {
    return {
      handled: true,
      reason: review?.decision === 'PASS'
        ? 'review_pass_next_task'
        : review?.decision === 'OUT_OF_SCOPE'
          ? 'review_out_of_scope_next_task'
          : 'initial_task',
      decision: {
        action: 'NEXT_TASK',
        task_card: materializePlannedTask(nextTask, {
          repositoryContext: context.repositoryContext,
          workflowGoal: context.workflowGoal,
        }),
      },
    };
  }

  return {
    handled: true,
    reason: 'all_planned_tasks_passed',
    decision: {
      action: 'WORKFLOW_DONE',
      summary: typeof effectivePlanSummary === 'string' && effectivePlanSummary.trim()
        ? effectivePlanSummary.trim()
        : `Completed ${effectivePlannedTasks.length} planned task(s); all passed deterministic Gate and independent Reviewer checks.`,
    },
  };
}
