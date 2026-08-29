// Error taxonomy for the Git Evidence Collector (see index.js). Kept
// separate from src/orchestrator/errors.js's ADAPTER_ERROR_CODES since a
// git evidence collector is not one of docs/workflow/ADAPTER_INTERFACE.md's
// three named adapters (Executor / Reviewer / Gate Runner) — it is an
// upstream input the Gate Runner / Workflow Manager caller may feed into
// the Reviewer Adapter's `evidence` argument.

export class GitEvidenceError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'GitEvidenceError';
    this.code = code;
  }
}

// Phase 6.3.1: an empty diff is no longer one of these — it is a valid
// Evidence state (DIFF_STATUS.NO_CHANGES in index.js), not a failure to
// collect evidence. Whether NO_CHANGES is acceptable for a given task is
// the Reviewer Adapter's call against the Task Card's acceptance_criteria.
export const GIT_EVIDENCE_ERROR_CODES = Object.freeze({
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  NOT_A_REPOSITORY: 'NOT_A_REPOSITORY',
  DIFF_COMMAND_FAILED: 'DIFF_COMMAND_FAILED',
  // A post-execution untracked path that is a symlink must never be
  // stat()/readFile()'d — both follow the link and would fold the target's
  // bytes (potentially outside the repo) into Reviewer evidence. Fail closed.
  UNTRACKED_SYMLINK_NOT_ALLOWED: 'UNTRACKED_SYMLINK_NOT_ALLOWED',
  // FIFO / socket / block or character device / other non-regular file.
  UNTRACKED_SPECIAL_FILE_NOT_ALLOWED: 'UNTRACKED_SPECIAL_FILE_NOT_ALLOWED',
});
