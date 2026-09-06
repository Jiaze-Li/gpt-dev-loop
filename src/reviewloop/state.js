// ReviewLoop durable state + deterministic state machine.
//
// One loopId == one review session. State is persisted through the existing
// Persistence workflow-state snapshot (persistence.js), keyed by loopId, under
// the `reviewLoop` key of the loop's state file. No parallel database.
//
// No fresh ReviewLoop session ever exposes PLANNING / FAST / FULL / EXECUTOR /
// DELIVERY / WORKFLOW_DONE — those were V2 SuperGPT workflow states.

export const REVIEW_LOOP_STATES = Object.freeze({
  READY_FOR_WORK: 'READY_FOR_WORK',
  REVIEWING: 'REVIEWING',
  WAITING_FOR_REVIEW: 'WAITING_FOR_REVIEW',
  REWORK: 'REWORK',
  SUPERVISING: 'SUPERVISING',
  PASS: 'PASS',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
});

export const TERMINAL_STATES = Object.freeze([
  REVIEW_LOOP_STATES.PASS,
  REVIEW_LOOP_STATES.HUMAN_REQUIRED,
  REVIEW_LOOP_STATES.FAILED,
  REVIEW_LOOP_STATES.STOPPED,
]);

// Allowed transitions. WAITING_FOR_REVIEW is a normal durable state, never an
// error — it re-enters REVIEWING when the external result arrives.
const TRANSITIONS = Object.freeze({
  READY_FOR_WORK: ['REVIEWING', 'STOPPED', 'FAILED'],
  REVIEWING: ['PASS', 'REWORK', 'SUPERVISING', 'WAITING_FOR_REVIEW', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  WAITING_FOR_REVIEW: ['REVIEWING', 'WAITING_FOR_REVIEW', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  REWORK: ['REVIEWING', 'STOPPED', 'FAILED'],
  SUPERVISING: ['REWORK', 'REVIEWING', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED'],
  PASS: [],
  HUMAN_REQUIRED: ['REVIEWING'], // a later reviewloop_review with genuinely new state may reopen
  FAILED: [],
  STOPPED: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

const STATE_KEY = 'reviewLoop';

export function initialLoopState(objective) {
  return {
    loopId: objective.loopId,
    state: REVIEW_LOOP_STATES.READY_FOR_WORK,
    objective,
    round: 0,
    reviewerCalls: 0,
    supervisorCalls: 0,
    externalTriggerCount: 0,
    // deterministic no-new-information tracking
    lastReviewedFingerprint: null,
    lastReviewedPrHead: null,
    lastGateFingerprint: null,
    // convergence tracking
    findingSignatureHistory: [], // [{ round, signatures: [] }]
    supervisorInvoked: false,
    pendingExternalTrigger: null, // { head, reviewer, triggerId, status }
    lastReview: null, // compact normalized review
    lastSupervisorGuidance: null,
    history: [],
    createdAt: objective.createdAt,
    updatedAt: objective.createdAt,
  };
}

export function recordTransition(loopState, to, reason) {
  const from = loopState.state;
  if (from === to) {
    loopState.updatedAt = new Date().toISOString();
    return loopState;
  }
  if (!canTransition(from, to)) {
    throw new Error(`ReviewLoop: illegal transition ${from} -> ${to} (${reason ?? 'no reason'})`);
  }
  loopState.state = to;
  loopState.updatedAt = new Date().toISOString();
  loopState.history = [
    ...(loopState.history ?? []),
    { from, to, reason: reason ?? null, round: loopState.round, at: loopState.updatedAt },
  ];
  return loopState;
}

// Persistence adapter over the existing workflow-state snapshot.
export class ReviewLoopStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') {
      return null;
    }
    const state = await this._persistence.readWorkflowState(loopId);
    return state?.[STATE_KEY] ?? null;
  }

  async save(loopId, loopState) {
    if (!loopId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    await this._persistence.updateWorkflowState(loopId, { [STATE_KEY]: loopState });
  }
}

// A persisted loop state that still carries a V2 SuperGPT workflow schema must
// NOT be silently reinterpreted under ReviewLoop semantics — fail closed.
export function assertNotLegacyWorkflow(raw) {
  if (!raw || typeof raw !== 'object') return;
  const legacyMarkers = ['workflowStatus', 'stage', 'taskIndex', 'pathSelectionReason', 'executorModel'];
  const hit = legacyMarkers.filter((k) => k in raw);
  if (hit.length >= 2 && !('state' in raw && 'loopId' in raw)) {
    throw new Error(
      `ReviewLoop: refusing to resume a legacy SuperGPT V2 workflow snapshot (${hit.join(', ')}); start a fresh reviewloop_begin`,
    );
  }
}
