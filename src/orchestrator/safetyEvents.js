// User-visible safety / cost event projection.
//
// The user never reads internal logs or the dashboard proactively. Any
// important cost or safety anomaly therefore has to survive all the way to
// the terminal result that the Front Agent shows the user. This module owns
// the minimal shared shape and the projection helper; emission sites live in
// automatedLoop.js / supergpt.js / the MCP server.

export const SAFETY_EVENT_CODES = Object.freeze({
  EXECUTOR_BUDGET_EXCEEDED: 'EXECUTOR_BUDGET_EXCEEDED',
  EXECUTOR_DUPLICATE_CALL_REJECTED: 'EXECUTOR_DUPLICATE_CALL_REJECTED',
  VERIFICATION_PERMISSION_BLOCKED: 'VERIFICATION_PERMISSION_BLOCKED',
  REVIEWER_CONTEXT_BUDGET_EXCEEDED: 'REVIEWER_CONTEXT_BUDGET_EXCEEDED',
  SUPERVISOR_CONTEXT_BUDGET_EXCEEDED: 'SUPERVISOR_CONTEXT_BUDGET_EXCEEDED',
  WORKFLOW_COST_BUDGET_EXCEEDED: 'WORKFLOW_COST_BUDGET_EXCEEDED',
  // Resume could not reconstruct prior cumulative spend while the cost
  // ceiling is enabled — refuse to resume with a fresh $0 budget.
  WORKFLOW_COST_STATE_UNAVAILABLE: 'WORKFLOW_COST_STATE_UNAVAILABLE',
  // ── Mechanical token ceilings (the last-resort fuse) ─────────────────
  // These fire independently of every heuristic (baseline-diff, no-new-info,
  // per-call budget). They are pure aggregate token/call counters read off the
  // deduplicated UsageTracker log, so an unknown bug that slips past every
  // other guard still hits a hard wall.
  // One Task's Executor physical calls reached the cumulative usage-volume cap.
  TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED: 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED',
  // One Task reached the maximum number of real Executor physical calls.
  EXECUTOR_CALL_CEILING_EXCEEDED: 'EXECUTOR_CALL_CEILING_EXCEEDED',
  // The whole workflow reached the cumulative usage-volume cap (cost-source
  // independent: a provider that never reports costUsd is still counted).
  WORKFLOW_USAGE_VOLUME_EXCEEDED: 'WORKFLOW_USAGE_VOLUME_EXCEEDED',
  FRONT_AGENT_POLLING_REGRESSION: 'FRONT_AGENT_POLLING_REGRESSION',
  // A Gate-sourced REWORK repeated with the SAME failure fingerprint AND the
  // SAME task diff — the previous Executor attempt produced no new information,
  // so dispatching another Executor call cannot help. The loop stops instead
  // of burning another expensive model call.
  NO_NEW_INFORMATION_RETRY_BLOCKED: 'NO_NEW_INFORMATION_RETRY_BLOCKED',
  // The baseline-diff Gate ignored one or more verification failures that
  // were already failing BEFORE this task ran (pre-existing / out-of-scope
  // repository red tests). The task itself introduced no new failure, so it
  // is PASSed — but the user must still learn the repository has N baseline
  // failures. WARNING severity: the workflow keeps running.
  PREEXISTING_VERIFICATION_FAILURES: 'PREEXISTING_VERIFICATION_FAILURES',
});

export const SAFETY_SEVERITY = Object.freeze({
  // The system recovered or was never at risk: the workflow keeps running and
  // no human input is required, but the event MUST still appear in the
  // terminal / final result.
  WARNING: 'WARNING',
  // The system cannot safely continue: no new expensive AI call is allowed,
  // the workflow ends in an existing terminal status (HUMAN_REQUIRED / FAILED),
  // and the Front Agent must be able to read the reason straight off the
  // returned result.
  BLOCKING: 'BLOCKING',
});

const VALID_CODES = new Set(Object.values(SAFETY_EVENT_CODES));
const VALID_SEVERITIES = new Set(Object.values(SAFETY_SEVERITY));

// Normalises one raw emission into the stable persisted shape. Unknown codes
// / severities are rejected loudly — a silent malformed safety event defeats
// the entire point of this module.
export function makeSafetyEvent({
  code,
  severity,
  role = null,
  taskId = null,
  attempt = null,
  reason = null,
  repeatCount = null,
  actionTaken = null,
  fingerprint = null,
  diffHash = null,
  physicalCalls = null,
  usageVolume = null,
  limit = null,
} = {}) {
  if (!VALID_CODES.has(code)) {
    throw new Error(`makeSafetyEvent: unknown safety event code "${code}"`);
  }
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`makeSafetyEvent: unknown severity "${severity}" for ${code}`);
  }
  return {
    code,
    severity,
    role: role ?? null,
    taskId: taskId ?? null,
    attempt: Number.isFinite(attempt) ? attempt : null,
    reason: reason == null ? null : String(reason),
    repeatCount: Number.isFinite(repeatCount) ? repeatCount : null,
    actionTaken: actionTaken == null ? null : String(actionTaken),
    // Optional non-convergence evidence — only some codes carry these, so they
    // are omitted from the persisted shape when absent to keep older events
    // byte-identical.
    ...(fingerprint == null ? {} : { fingerprint: String(fingerprint) }),
    ...(diffHash == null ? {} : { diffHash: String(diffHash) }),
    // Mechanical-ceiling evidence — only the token-fuse codes carry these.
    ...(Number.isFinite(physicalCalls) ? { physicalCalls } : {}),
    ...(Number.isFinite(usageVolume) ? { usageVolume } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
    at: new Date().toISOString(),
  };
}

// The single projection used by every terminal channel (supergpt.js result,
// MCP start_and_wait, dashboard). `blockingSafetyEvent` is the most recent
// BLOCKING event — the one the Front Agent must surface — or null.
export function summarizeSafetyEvents(events = []) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const blocking = list.filter((e) => e.severity === SAFETY_SEVERITY.BLOCKING);
  return {
    safetyEvents: list,
    blockingSafetyEvent: blocking.length ? blocking[blocking.length - 1] : null,
    warningSafetyEvents: list.filter((e) => e.severity === SAFETY_SEVERITY.WARNING),
    hasBlocking: blocking.length > 0,
    hasWarnings: list.some((e) => e.severity === SAFETY_SEVERITY.WARNING),
  };
}

// One-line human string for a blocking event, for prepending onto a terminal
// `reason` so a Front Agent that only reads `reason` still sees it.
export function formatBlockingSafetyReason(event) {
  if (!event) return null;
  const parts = [`SAFETY[BLOCKING] ${event.code}`];
  if (event.role) parts.push(`role=${event.role}`);
  if (event.reason) parts.push(event.reason);
  if (event.actionTaken) parts.push(`(${event.actionTaken})`);
  return parts.join(' — ');
}

// Decides whether a repeated verification-command permission denial is a
// WARNING (another approved verification command is still runnable, so the
// loop can continue) or a BLOCKING event (every approved verification command
// is denied — there is no safe way forward without a human).
export function classifyVerificationPermissionBlocked({
  approvedCommands = [],
  deniedCommands = [],
} = {}) {
  const denied = new Set((Array.isArray(deniedCommands) ? deniedCommands : []).map(String));
  const remainingApprovedCommands = [
    ...new Set((Array.isArray(approvedCommands) ? approvedCommands : []).map(String)),
  ].filter((c) => !denied.has(c));
  const hasAltPath = remainingApprovedCommands.length > 0;
  return {
    severity: hasAltPath ? SAFETY_SEVERITY.WARNING : SAFETY_SEVERITY.BLOCKING,
    hasAltPath,
    remainingApprovedCommands,
  };
}

// Maps a thrown AdapterError to a safety-event code, or null when the error
// is not one of the first-batch cost/safety guards.
export function safetyCodeForAdapterError(error) {
  const code = error?.code ?? error?.details?.code ?? null;
  if (code && VALID_CODES.has(code)) return code;
  return null;
}
