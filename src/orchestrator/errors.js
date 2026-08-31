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
});

export const ADAPTER_ERROR_CODES = Object.freeze({
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  EXECUTOR_TIMEOUT: 'EXECUTOR_TIMEOUT',
  EXECUTOR_INVALID_OUTPUT: 'EXECUTOR_INVALID_OUTPUT',
  REVIEWER_UNAVAILABLE: 'REVIEWER_UNAVAILABLE',
  REVIEWER_TIMEOUT: 'REVIEWER_TIMEOUT',
  REVIEWER_INVALID_OUTPUT: 'REVIEWER_INVALID_OUTPUT',
  GATE_FAILED: 'GATE_FAILED',
  GATE_RUNNER_ERROR: 'GATE_RUNNER_ERROR',
  SUPERVISOR_INVALID_OUTPUT: 'SUPERVISOR_INVALID_OUTPUT',
  SUPERVISOR_ILLEGAL_TRANSITION: 'SUPERVISOR_ILLEGAL_TRANSITION',
  SUPERVISOR_UNAVAILABLE: 'SUPERVISOR_UNAVAILABLE',
  SUPERVISOR_TIMEOUT: 'SUPERVISOR_TIMEOUT',
});
