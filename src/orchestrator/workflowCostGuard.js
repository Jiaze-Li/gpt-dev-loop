// Workflow-level cumulative cost circuit breaker.
//
// TokenAnomalyMonitor is post-hoc: it annotates the finished result but
// never stops the loop. This module is the real hard aggregate stop. Every
// metered internal AI/model call belonging to the workflow — Planner,
// Supervisor, Executor, internal Reviewer, and the PR Closeout repair
// Executor — is folded into UsageTracker; once the deduplicated cumulative
// provider cost crosses the ceiling, the workflow stops through the
// existing HUMAN_REQUIRED / BLOCKING safety path and no further model call
// is dispatched. The call that crosses the line has already been recorded
// (the check runs AFTER accounting / BEFORE the next dispatch), so its
// usage is never lost, and there is no provider failover or retry once the
// ceiling is crossed.

// Conservative default: ~10x a single Executor's $0.50 per-call brake,
// enough headroom for a genuine multi-task plan with bounded rework, far
// below a runaway. Override per deployment with WORKFLOW_MAX_COST_USD.
export const DEFAULT_WORKFLOW_MAX_COST_USD = 5.0;

export function resolveWorkflowCostCeilingUsd(env = {}) {
  const raw = env?.WORKFLOW_MAX_COST_USD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WORKFLOW_MAX_COST_USD;
  const n = Number(raw);
  // A non-positive / non-finite override disables the breaker explicitly.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Mechanical token ceilings (the last-resort fuse) ──────────────────
//
// These are NOT heuristics. They are pure aggregate counters read straight
// off UsageTracker's deduplicated record log, so an unknown bug that slips
// past baseline-diff, no-new-information and every per-call budget still
// hits a hard wall. All three use `>=` (reaching the limit blocks the NEXT
// dispatch); the dollar cost breaker above keeps its strict `>`.
//
// usageVolume follows the project's official UsageTracker口径:
//   inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
// It is computed from tokens, never from cost, so a provider that never
// reports costUsd is still fully covered.

// Cumulative usageVolume across one Task's Executor physical calls.
export const DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME = 600_000;
// Real Executor physical calls allowed for a single Task (normal + escalation
// + probe/transport/failover retries that actually produced a provider call).
export const DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK = 4;
// Cumulative usageVolume across the WHOLE workflow (every metered role).
export const DEFAULT_WORKFLOW_MAX_USAGE_VOLUME = 1_500_000;

// A non-positive / non-finite override disables that specific ceiling.
function resolveCeiling(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function resolveTaskExecutorUsageVolumeCeiling(env = {}) {
  return resolveCeiling(env?.TASK_MAX_EXECUTOR_USAGE_VOLUME, DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME);
}

export function resolveExecutorPhysicalCallCeiling(env = {}) {
  return resolveCeiling(env?.MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK, DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK);
}

export function resolveWorkflowUsageVolumeCeiling(env = {}) {
  return resolveCeiling(env?.WORKFLOW_MAX_USAGE_VOLUME, DEFAULT_WORKFLOW_MAX_USAGE_VOLUME);
}

// True when ANY workflow-level or task-level token ceiling is enabled. Used by
// the resume fail-closed gate: if prior spend can't be reconstructed and any
// ceiling is on, we must not resume with a fresh $0 / zero-volume budget.
export function anyTokenCeilingActive(env = {}) {
  return resolveWorkflowCostCeilingUsd(env) > 0
    || resolveWorkflowUsageVolumeCeiling(env) > 0
    || resolveTaskExecutorUsageVolumeCeiling(env) > 0
    || resolveExecutorPhysicalCallCeiling(env) > 0;
}

// Per-Task Executor physical-call count + cumulative usageVolume, taken from
// the tracker's deduplicated log. A "physical call" is one non-duplicate,
// non-deterministic executor record for that taskId — so it CANNOT be bypassed
// by mutating attemptCount / normalAttempts / escalationAttempts, which never
// touch the record log. Survives resume because rehydrateUsageFromState folds
// the persisted records back in first.
export function executorTaskUsage(usageTracker, taskId) {
  const out = { physicalCalls: 0, usageVolume: 0 };
  const records = usageTracker?.records;
  if (!Array.isArray(records) || taskId == null) return out;
  for (const r of records) {
    if (!r || r.role !== 'executor') continue;
    if (r.duplicate || r.deterministic) continue;
    if (r.taskId !== taskId) continue;
    out.physicalCalls += 1;
    out.usageVolume += Number(r.usageVolume) || 0;
  }
  return out;
}

// Returns null when the Task's Executor spend is within both ceilings, or
// { kind: 'CALLS' | 'VOLUME', physicalCalls, usageVolume, limit } when one is
// reached. The call ceiling is checked first (it is the tighter guarantee).
export function taskExecutorCeilingExceeded(usageTracker, taskId, { volumeLimit = 0, callLimit = 0 } = {}) {
  const { physicalCalls, usageVolume } = executorTaskUsage(usageTracker, taskId);
  if (Number(callLimit) > 0 && physicalCalls >= callLimit) {
    return { kind: 'CALLS', physicalCalls, usageVolume, limit: Number(callLimit) };
  }
  if (Number(volumeLimit) > 0 && usageVolume >= volumeLimit) {
    return { kind: 'VOLUME', physicalCalls, usageVolume, limit: Number(volumeLimit) };
  }
  return null;
}

// Returns null when within budget, or { totalUsageVolume, limit } when the
// deduplicated cumulative workflow usageVolume has reached the ceiling. Uses
// UsageTracker.summary().measuredTotal, whose aggregates already exclude
// duplicate and deterministic records.
export function workflowUsageVolumeExceeded(usageTracker, limit) {
  const lim = Number(limit);
  if (!usageTracker || !Number.isFinite(lim) || lim <= 0) return null;
  const total = Number(usageTracker.summary()?.measuredTotal?.usageVolume) || 0;
  if (total < lim) return null;
  return { totalUsageVolume: total, limit: lim };
}

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

export function formatWorkflowUsageVolumeReason({ totalUsageVolume, limit }) {
  return `Workflow cumulative model usage volume ${fmtInt(totalUsageVolume)} processed tokens reached the hard ceiling ${fmtInt(limit)}`;
}

export function formatTaskExecutorCeilingReason(taskId, hit) {
  if (hit.kind === 'CALLS') {
    return `Task "${taskId}" reached the hard Executor physical-call ceiling (${hit.physicalCalls}/${hit.limit} real Executor calls)`;
  }
  return `Task "${taskId}" reached the hard Executor cumulative usage-volume ceiling `
    + `(${fmtInt(hit.usageVolume)}/${fmtInt(hit.limit)} processed tokens over ${hit.physicalCalls} call${hit.physicalCalls === 1 ? '' : 's'})`;
}

// Returns null when within budget, or { totalCostUsd, limitUsd } when the
// deduplicated cumulative workflow cost has crossed the ceiling. Uses
// UsageTracker.summary(), whose aggregates already exclude duplicate and
// deterministic records, so the aggregate matches normal accounting.
export function workflowCostExceeded(usageTracker, limitUsd) {
  const limit = Number(limitUsd);
  if (!usageTracker || !Number.isFinite(limit) || limit <= 0) return null;
  const total = Number(usageTracker.summary()?.measuredTotal?.costUsd) || 0;
  if (total <= limit) return null;
  return { totalCostUsd: total, limitUsd: limit };
}

export function formatWorkflowCostReason({ totalCostUsd, limitUsd }) {
  return `Workflow cumulative model cost $${Number(totalCostUsd).toFixed(4)} exceeded the hard ceiling $${Number(limitUsd).toFixed(2)}`;
}

// Resume support: the cost ceiling is a whole-workflow limit, but a resumed
// run gets a fresh UsageTracker. Fold the usage snapshot the prior process
// persisted into <workflowId>.state.json back into the live tracker BEFORE
// any new model dispatch. UsageTracker.merge() dedupes by immutable callId /
// invocation identity, so replaying the persisted records can never inflate
// the restored aggregate, while genuinely new calls this process makes add
// on top of it. Returns the number of prior records folded in.
export function rehydrateUsageFromState(usageTracker, priorState) {
  if (!usageTracker || typeof usageTracker.merge !== 'function') return 0;
  const priorRecords = priorState?.tokenUsage?.records;
  if (!Array.isArray(priorRecords) || priorRecords.length === 0) return 0;
  usageTracker.merge({ records: priorRecords });
  return priorRecords.length;
}

// Resume fail-closed check. When the cumulative-cost ceiling is ENABLED, a
// resumed run must be able to reconstruct the workflow's prior spend before
// dispatching any model call — otherwise a workflow could lose/corrupt its
// state file and resume with a fresh $0 budget.
//
// `priorState` is the parsed <workflowId>.state.json (or null when it is
// missing / unreadable / unparseable — readLiveWorkflowState collapses all
// three to null). A well-formed state that a fresh run always writes carries
// `tokenUsage.records` as an array (empty === a legitimate, proven "zero
// prior metered model calls").
//
// Returns:
//   { ok: true }                         -> safe to rehydrate and continue
//   { ok: false, reason }                -> FAIL CLOSED: prior spend unknowable
export function assertResumeCostStateReconstructable(priorState, { ceilingUsd, guardActive } = {}) {
  // The fail-closed requirement applies when the dollar cost ceiling is on OR
  // any of the mechanical token ceilings (workflow volume / task volume / task
  // call count) is on — all of them rehydrate from the same persisted records.
  const active = guardActive === true || Number(ceilingUsd) > 0;
  // Guard disabled -> the fail-closed requirement does not apply; the caller
  // keeps its best-effort behavior.
  if (!active) return { ok: true, guardActive: false };

  if (priorState === null || priorState === undefined || typeof priorState !== 'object') {
    return { ok: false, guardActive: true, reason: 'persisted workflow state is missing, unreadable, or malformed' };
  }
  const tu = priorState.tokenUsage;
  if (tu === null || tu === undefined || typeof tu !== 'object' || !Array.isArray(tu.records)) {
    return { ok: false, guardActive: true, reason: 'persisted workflow state carries no reconstructable token-usage records' };
  }
  return { ok: true, guardActive: true };
}
