// Implements docs/workflow/STATE_MACHINE.md §1-3.

export const STATES = Object.freeze({
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  REVIEWING: 'REVIEWING',
  COMPLETE: 'COMPLETE',
  REWORK: 'REWORK',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  ABORTED: 'ABORTED',
});

// STATE_MACHINE.md §3 "Per-state owner".
export const STATE_OWNERS = Object.freeze({
  PENDING: 'gpt',
  EXECUTING: 'claude',
  VERIFYING: 'shell',
  REVIEWING: 'gpt',
  COMPLETE: 'shell',
  REWORK: 'shell',
  HUMAN_REQUIRED: 'human',
  ABORTED: 'shell',
});

const TERMINAL_STATES = new Set([STATES.COMPLETE, STATES.ABORTED, STATES.HUMAN_REQUIRED]);

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

// STATE_MACHINE.md §2 transition table, keyed by trigger vocabulary.
const TRANSITIONS = {
  [STATES.PENDING]: {
    task_card_generated: STATES.EXECUTING,
  },
  [STATES.EXECUTING]: {
    executor_reports_done: STATES.VERIFYING,
    executor_reports_blocked: STATES.REVIEWING,
    executor_reports_human_required: STATES.HUMAN_REQUIRED,
  },
  [STATES.VERIFYING]: {
    verification_passed: STATES.REVIEWING,
    verification_failed: STATES.REWORK,
  },
  [STATES.REVIEWING]: {
    review_pass: STATES.COMPLETE,
    review_rework: STATES.EXECUTING,
    review_human_required: STATES.HUMAN_REQUIRED,
  },
  [STATES.REWORK]: {
    carry_forward: STATES.EXECUTING,
  },
};

// "any state | retry limit exceeded / corrupted state | ABORTED" (§2) is not
// keyed to a single "current" row, so it is handled outside TRANSITIONS.
const ANY_STATE_TRIGGERS = new Set(['retry_limit_exceeded', 'state_corrupted']);

export function nextState(current, trigger) {
  if (ANY_STATE_TRIGGERS.has(trigger)) {
    if (isTerminal(current)) {
      throw new Error(`Illegal transition: cannot abort from terminal state "${current}"`);
    }
    return STATES.ABORTED;
  }

  const table = TRANSITIONS[current];
  if (!table || !(trigger in table)) {
    throw new Error(`Illegal transition: no trigger "${trigger}" from state "${current}"`);
  }
  return table[trigger];
}
