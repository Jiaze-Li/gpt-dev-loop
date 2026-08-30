// Generic text renderer for SuperGPT progress state.
// Portable across front agents (Gemini, Claude Code, Codex, terminal, etc.).
// 0 ANSI codes, 0 platform-specific widgets, 0 model tokens.

import { toCanonicalProgress } from '../orchestrator/workflowState.js';

export function renderGenericProgress(stateOrCanonical) {
  if (!stateOrCanonical) return 'SUPERGPT: no active workflow';
  const c = stateOrCanonical.task && stateOrCanonical.timing
    ? stateOrCanonical
    : toCanonicalProgress(stateOrCanonical);

  const taskPart = c.task.current && c.task.total
    ? `${c.task.current} / ${c.task.total}`
    : c.task.taskId || '1 / 1';
  const titlePart = c.task.title ? ` — ${c.task.title}` : '';

  const formatTime = (iso) => {
    if (!iso) return '--:--:--';
    try {
      return new Date(iso).toTimeString().split(' ')[0];
    } catch {
      return '--:--:--';
    }
  };

  const lines = [
    `SUPERGPT ⟳ ${c.workflowStatus}`,
    '',
    `Task       ${taskPart}${titlePart}`,
    `Attempt    ${c.attempt}`,
    `Stage      ${c.stage}`,
    '',
    `Planner    ${roleText(c, 'planner')}`,
    `Supervisor ${roleText(c, 'supervisor')}`,
    `Executor   ${roleText(c, 'executor', c.executor.status)}`,
    `Gate       ${c.gate.status}`,
    `Reviewer   ${roleText(c, 'reviewer', c.reviewer.status)}`,
    '',
    `Elapsed       ${c.timing.elapsed}`,
    `Heartbeat     ${formatTime(c.timing.heartbeatAt)}`,
    `Last progress ${formatTime(c.timing.lastProgressAt)}`,
  ];

  if (c.timing.lastActivityAt) {
    lines.push(`Last activity ${formatTime(c.timing.lastActivityAt)}`);
  }

  if (c.staleRuntimeWarning || stateOrCanonical?.staleRuntimeWarning) {
    lines.push('', `[WARNING] ${c.staleRuntimeWarning || stateOrCanonical.staleRuntimeWarning}`);
  }

  if (c.executor.escalated) {
    lines.push(`Model         ${c.executor.model} (Escalated: ${c.executor.escalationReason || 'yes'})`);
  }
  const supervisor = c.routing?.supervisor;
  if (supervisor?.requestedFamily) lines.splice(7, 0, `Supervisor ${supervisor.resolvedModel || supervisor.requestedFamily}${supervisor.effort ? ` · ${supervisor.effort}` : ''}`);
  if (c.reviewer.routing?.requestedFamily) lines.splice(11, 0, `Reviewer model ${c.reviewer.routing.resolvedModel || c.reviewer.routing.requestedFamily}${c.reviewer.routing.effort ? ` · ${c.reviewer.routing.effort}` : ''}`);

  return lines.join('\n');
}

function roleText(c, role, explicitStatus = null) {
  const route = c.routing?.[role];
  const roleStage = role.toUpperCase();
  const status = explicitStatus || (c.stage === roleStage ? 'running' : route ? 'done' : 'waiting');
  const model = route?.resolvedModel || route?.requestedFamily || (role === 'executor' ? c.executor?.model : null);
  const provider = route?.provider;
  return [provider, model, status].filter(Boolean).join(' · ');
}

export function renderGenericCompletion(result) {
  if (!result) return 'SUPERGPT: no result';
  const isDone = result.status === 'WORKFLOW_DONE';
  const statusSymbol = isDone ? '✓' : '✖';
  const lines = [
    `SUPERGPT ${statusSymbol} ${result.status}`,
    '',
  ];
  if (result.summary) {
    lines.push(`Summary:    ${result.summary}`);
  }
  if (result.deliveredFiles && result.deliveredFiles.length > 0) {
    lines.push(`Delivered:  ${result.deliveredFiles.join(', ')}`);
  }
  if (result.reason) {
    lines.push(`Reason:     ${result.reason}`);
  }
  if (result.question) {
    lines.push(`Question:   ${result.question}`);
  }
  return lines.join('\n');
}

export function renderGenericPlan(planResult) {
  if (!planResult) return 'SUPERGPT: no plan';
  if (planResult.status === 'AMBIGUOUS') {
    return [
      'SUPERGPT · PLAN AMBIGUOUS',
      '',
      `Question: ${planResult.question || 'Clarification required before execution.'}`,
    ].join('\n');
  }

  const lines = [
    'SUPERGPT · PLAN READY',
    '',
    `Summary: ${planResult.summary || 'Plan generated'}`,
    '',
    'Tasks:',
  ];

  if (Array.isArray(planResult.tasks)) {
    planResult.tasks.forEach((t, i) => {
      const id = t.task_id || t.id || `task-${i + 1}`;
      const desc = t.description || t.title || t.instruction || JSON.stringify(t);
      lines.push(`  ${i + 1}. [${id}] ${desc}`);
    });
  } else if (planResult.planText) {
    lines.push(planResult.planText);
  }

  return lines.join('\n');
}
