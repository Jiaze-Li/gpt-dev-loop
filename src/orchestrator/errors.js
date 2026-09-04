// Implements docs/workflow/ADAPTER_INTERFACE.md §5 error model.

export class AdapterError extends Error {
  // `details` carries safe, non-content diagnostics (exit code, stderr,
  // duration, model) for operator-facing logging. It never holds prompt or
  // model-reply text. Optional and free-form; consumers must treat every
  // field as possibly absent.
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'AdapterError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

// A cancellation is NOT a provider failure. When an in-flight provider call
// is aborted (AbortSignal, agy AGY_ABORTED, a killed child process), the
// runtime must propagate this immediately and perform ZERO failover — it
// must never be classified as PROVIDER_UNAVAILABLE, and it must never poison
// provider-health or quota state.
export class ProviderCancelledError extends Error {
  constructor(message = 'provider call cancelled', details) {
    super(message);
    this.name = 'ProviderCancelledError';
    this.code = 'PROVIDER_CANCELLED';
    this.cancelled = true;
    if (details && typeof details === 'object') this.details = details;
  }
}

// Recognises every cancellation shape that can reach the role runtime:
//   - an aborted AbortSignal handed to invoke()
//   - AbortError / ABORT_ERR from a native aborted operation
//   - AGY_ABORTED from src/agy/agyClient.js
//   - CancellationError from src/orchestrator/supergpt.js
//   - ProviderCancelledError (above), or any error tagged { cancelled: true }
//   - an AdapterError whose providerFailure is PROVIDER_CANCELLED
export function isCancellation(error, signal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  if (error.cancelled === true) return true;
  const names = new Set(['AbortError', 'CancellationError', 'ProviderCancelledError']);
  if (names.has(error.name)) return true;
  const codes = new Set(['ABORT_ERR', 'AGY_ABORTED', 'CANCELLED', 'PROVIDER_CANCELLED']);
  const code = error.code ?? error.details?.providerFailure ?? error.providerFailure ?? null;
  return codes.has(code);
}

// V2-C trusted PR-closeout trust-boundary failures. Every one of these is a
// fail-closed condition: the deterministic closeout loop must stop and surface
// the reason rather than guess when reviewer identity, PR head, write
// capability, or repair safety cannot be established.
export class PrCloseoutError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'PrCloseoutError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const PR_CLOSEOUT_ERROR_CODES = Object.freeze({
  UNTRUSTED_REVIEWER: 'UNTRUSTED_REVIEWER',
  STALE_REVIEW_HEAD: 'STALE_REVIEW_HEAD',
  MALFORMED_REVIEW: 'MALFORMED_REVIEW',
  UNSAFE_REPAIR_ACTION: 'UNSAFE_REPAIR_ACTION',
  FORK_WRITE_FORBIDDEN: 'FORK_WRITE_FORBIDDEN',
  REPAIR_GATE_NOT_PASSED: 'REPAIR_GATE_NOT_PASSED',
  THREAD_RESOLUTION_UNAVAILABLE: 'THREAD_RESOLUTION_UNAVAILABLE',
});

// Token-Safety authorization boundary. A permit / spend-authorization failure
// is an ORCHESTRATOR decision, never evidence that a provider is unavailable:
// the role runtime must propagate it immediately, perform ZERO failover, and
// must never mutate provider-health or quota state. It is deliberately NOT an
// AdapterError and is never classified through providerFailure().
export class AuthorizationError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'AuthorizationError';
    this.code = code;
    this.authorizationFailure = true;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const AUTHORIZATION_ERROR_CODES = Object.freeze({
  // authorize() rejected the CallIntent before any permit was issued
  SPEND_DENIED: 'SPEND_DENIED',
  INTENT_INCOMPLETE: 'INTENT_INCOMPLETE',
  // dispatch() refused to run without / with an invalid permit
  PERMIT_MISSING: 'PERMIT_MISSING',
  PERMIT_UNKNOWN: 'PERMIT_UNKNOWN',
  PERMIT_CONSUMED: 'PERMIT_CONSUMED',
  PERMIT_INTENT_MISMATCH: 'PERMIT_INTENT_MISMATCH',
  // authorize() rejected the CallIntent because the provider/family is not
  // declared executorEligible for this role (see providerCapabilities.js).
  PROVIDER_NOT_ELIGIBLE_FOR_ROLE: 'PROVIDER_NOT_ELIGIBLE_FOR_ROLE',
  // authorize() rejected the CallIntent because this workflow already has an
  // UNRESOLVED model spend reservation — a prior physical call may have
  // dispatched with usage that could not be reliably settled. See
  // modelSpendReservation.js. Blocks EVERY internal role, not only Executor.
  MODEL_SPEND_USAGE_UNRESOLVED: 'MODEL_SPEND_USAGE_UNRESOLVED',
  // authorize() could not durably persist the reservation required before a
  // permit may be issued. Fail closed: zero physical provider calls.
  RESERVATION_PERSIST_FAILED: 'RESERVATION_PERSIST_FAILED',
});

export function isAuthorizationFailure(error) {
  return Boolean(error) && (error instanceof AuthorizationError || error.authorizationFailure === true);
}

export const ADAPTER_ERROR_CODES = Object.freeze({
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  EXECUTOR_TIMEOUT: 'EXECUTOR_TIMEOUT',
  // The local Executor budget is intentionally a terminal safety brake, not
  // an implementation failure that another model may silently retry.
  EXECUTOR_BUDGET_EXCEEDED: 'EXECUTOR_BUDGET_EXCEEDED',
  EXECUTOR_DUPLICATE_CALL_REJECTED: 'EXECUTOR_DUPLICATE_CALL_REJECTED',
  EXECUTOR_INVALID_OUTPUT: 'EXECUTOR_INVALID_OUTPUT',
  REVIEWER_UNAVAILABLE: 'REVIEWER_UNAVAILABLE',
  REVIEWER_TIMEOUT: 'REVIEWER_TIMEOUT',
  REVIEWER_INVALID_OUTPUT: 'REVIEWER_INVALID_OUTPUT',
  REVIEWER_CONTEXT_BUDGET_EXCEEDED: 'REVIEWER_CONTEXT_BUDGET_EXCEEDED',
  GATE_FAILED: 'GATE_FAILED',
  GATE_RUNNER_ERROR: 'GATE_RUNNER_ERROR',
  SUPERVISOR_INVALID_OUTPUT: 'SUPERVISOR_INVALID_OUTPUT',
  SUPERVISOR_ILLEGAL_TRANSITION: 'SUPERVISOR_ILLEGAL_TRANSITION',
  SUPERVISOR_UNAVAILABLE: 'SUPERVISOR_UNAVAILABLE',
  SUPERVISOR_TIMEOUT: 'SUPERVISOR_TIMEOUT',
  SUPERVISOR_CONTEXT_BUDGET_EXCEEDED: 'SUPERVISOR_CONTEXT_BUDGET_EXCEEDED',
});
