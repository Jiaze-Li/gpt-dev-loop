// Per-physical-call budget re-check, injected into ModelSpendAuthority as
// its `policy(intent) -> { allow, reason }` callback.
//
// This module adds NO new budget logic — it re-runs the SAME primitives
// automatedLoop.js / supergpt.js already use (workflowCostGuard.js), but at
// the one place every physical dispatch — including a future re-enabled
// failover's second, third, ... candidate inside a single logical
// invoke() — must pass through: ModelSpendAuthority.authorize(). Existing
// pre-invoke() checks in automatedLoop.js / supergpt.js are unchanged and
// still fire first (cheaper, and produce the richer HUMAN_REQUIRED /
// safety-event UX); this is the mechanical backstop that makes the
// per-physical-call re-check true even if a future caller's pre-check is
// skipped, stale, or the invocation fans out into more than one physical
// attempt.
//
// Convention: for role === 'executor', operationId is
// `${workflowId}:${taskId}` (see providerSelection.js
// createExecutorSessionManager — the only production constructor of
// Executor CallIntents through this policy). A missing/malformed
// operationId means the per-TASK ceilings CANNOT be evaluated for that
// call — and an unevaluatable ceiling must fail the call closed (DENY),
// never fall through as if the ceiling did not apply. No taskId is ever
// guessed; "undefined" (the literal string, e.g. from a stringified
// `${undefined}:${undefined}` template) is treated as absent, same as a
// missing/empty taskId.

import {
  workflowCostExceeded,
  workflowUsageVolumeExceeded,
  taskExecutorCeilingExceeded,
  formatWorkflowCostReason,
  formatWorkflowUsageVolumeReason,
  formatTaskExecutorCeilingReason,
} from './workflowCostGuard.js';

function taskIdFromOperationId(operationId) {
  if (typeof operationId !== 'string') return null;
  const sep = operationId.indexOf(':');
  if (sep === -1) return null;
  const taskId = operationId.slice(sep + 1);
  if (!taskId || taskId === 'undefined') return null;
  return taskId;
}

export function createExecutorBudgetPolicy({
  usageTracker,
  workflowCostCeilingUsd = 0,
  workflowUsageVolumeCeiling = 0,
  taskExecutorUsageVolumeCeiling = 0,
  executorPhysicalCallCeiling = 0,
} = {}) {
  return function executorBudgetPolicy(intent) {
    if (!usageTracker) return { allow: true };

    // Workflow-wide ceilings: every metered role (exactly like
    // automatedLoop.js's enforceWorkflowCost()), re-read fresh so a second
    // physical attempt inside the same invoke() cannot ride on the first
    // attempt's now-stale decision.
    const costHit = workflowCostExceeded(usageTracker, workflowCostCeilingUsd);
    if (costHit) return { allow: false, reason: formatWorkflowCostReason(costHit) };

    const volHit = workflowUsageVolumeExceeded(usageTracker, workflowUsageVolumeCeiling);
    if (volHit) return { allow: false, reason: formatWorkflowUsageVolumeReason(volHit) };

    if (intent.role !== 'executor') return { allow: true };

    const taskId = taskIdFromOperationId(intent.operationId);
    if (!taskId) {
      return {
        allow: false,
        reason: `Executor physical call denied: operationId ${JSON.stringify(intent.operationId)} `
          + 'does not carry a reliable taskId, so the task-level budget ceiling cannot be evaluated',
      };
    }

    const taskHit = taskExecutorCeilingExceeded(usageTracker, taskId, {
      volumeLimit: taskExecutorUsageVolumeCeiling,
      callLimit: executorPhysicalCallCeiling,
    });
    if (taskHit) return { allow: false, reason: formatTaskExecutorCeilingReason(taskId, taskHit) };

    return { allow: true };
  };
}
