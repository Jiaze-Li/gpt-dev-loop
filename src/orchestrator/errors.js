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
