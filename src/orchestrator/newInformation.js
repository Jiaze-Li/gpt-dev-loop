// Global deterministic New Information Policy.
//
//   NO NEW INFORMATION -> NO NEW INTERNAL MODEL CALL
//
// This module lifts the existing Gate-specific "no new information" heuristic
// (deterministicSupervisorPolicy.js#decideDeterministically /
// SAFETY_EVENT_CODES.NO_NEW_INFORMATION_RETRY_BLOCKED — which remains valid
// as an earlier, richer diagnostic) into a centralized, durable authority
// boundary that ModelSpendAuthority.authorize() can enforce for EVERY
// internal role, not only the Gate-rework Supervisor path.
//
//   retry     != new information
//   failover  != new information
//   timeout   != new information
//   provider failure != new information
//
// Newness is established ONLY from a deterministic fingerprint of a
// mechanically inspectable artifact (a Task Card, a Gate failure, a task
// diff, reviewer findings, a durable user-interaction identity, a repository
// HEAD, an external review result) — never from timestamps, retry counters,
// physical attempt numbers, provider identity, or process restart.
//
// Durable storage reuses the EXISTING workflow-scoped snapshot
// (Persistence.readWorkflowState / updateWorkflowState — see persistence.js),
// under the `modelSpendInformation` key of workflow.json, exactly like
// Persistent Model Spend Reservation (modelSpendReservation.js) reuses it for
// `modelSpendReservations`. No parallel database is introduced.

import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// ── 1. Deterministic event taxonomy (§1) ──────────────────────────────
export const NEW_INFORMATION_EVENT_TYPES = Object.freeze({
  NEW_TASK_CARD: 'NEW_TASK_CARD',
  NEW_USER_INPUT: 'NEW_USER_INPUT',
  NEW_GATE_FINGERPRINT: 'NEW_GATE_FINGERPRINT',
  CHANGED_TASK_DIFF: 'CHANGED_TASK_DIFF',
  NEW_REVIEW_FINDINGS: 'NEW_REVIEW_FINDINGS',
  CHANGED_REPOSITORY_STATE: 'CHANGED_REPOSITORY_STATE',
  NEW_EXTERNAL_RESULT: 'NEW_EXTERNAL_RESULT',
});

const VALID_EVENT_TYPES = new Set(Object.values(NEW_INFORMATION_EVENT_TYPES));

export function isValidEventType(type) {
  return VALID_EVENT_TYPES.has(type);
}

// ── 2. Deterministic evidence identity (§2) ───────────────────────────
//
//   event identity = type + workflow scope + semantic subject + fingerprint
//
// Re-registering the EXACT SAME semantic information (same type, same
// subject, same fingerprint, same workflow) always resolves to the SAME
// evidenceId — it never becomes fresh merely because time passed, a process
// restarted, or a different provider/attempt is in play.
export function computeEvidenceId({
  type, workflowId = null, subject = null, fingerprint,
}) {
  if (!isValidEventType(type)) {
    throw new Error(`computeEvidenceId: unknown New Information event type "${type}"`);
  }
  const payload = {
    type,
    workflowId: workflowId ?? null,
    subject: subject ?? null,
    fingerprint: String(fingerprint ?? ''),
  };
  return sha256(JSON.stringify(payload));
}

// ── 5. Evidence consumption scope (§5) ────────────────────────────────
//
// Deliberately (role, operationId, evidenceId) — NEVER provider family and
// NEVER physical attempt number. Including either would let automatic
// failover reuse identical information and bypass the policy (§ Phase 4).
export function computeConsumptionKey({ role, operationId, evidenceId }) {
  return `${role ?? ''}::${operationId ?? ''}::${evidenceId ?? ''}`;
}

// ── 7. Role/action eligibility policy (§7) ────────────────────────────
//
// Which New Information event TYPES may justify a physical call for a given
// role. Deliberately conservative and reviewed against the actual production
// call sites (see PRODUCTION CALL-SITE INVENTORY in modelSpendAuthority.js /
// the task's Final Report): CHANGED_TASK_DIFF alone does not, by itself,
// justify another Executor call — Executor is the role that PRODUCES that
// diff, so re-running it on its own artifact is never eligible here.
export const ROLE_EVENT_ELIGIBILITY = Object.freeze({
  planner: new Set([
    NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT,
    NEW_INFORMATION_EVENT_TYPES.CHANGED_REPOSITORY_STATE,
  ]),
  supervisor: new Set([
    NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD,
    NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT,
    NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT,
    NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF,
    NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS,
    NEW_INFORMATION_EVENT_TYPES.CHANGED_REPOSITORY_STATE,
    NEW_INFORMATION_EVENT_TYPES.NEW_EXTERNAL_RESULT,
  ]),
  executor: new Set([
    NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD,
    NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT,
    NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT,
    NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS,
    NEW_INFORMATION_EVENT_TYPES.CHANGED_REPOSITORY_STATE,
    // § Wiring Card 3 / PART B — the PR-closeout repair Executor is justified
    // by a deterministic EXTERNAL trusted-review result (head + normalized
    // actionable finding signatures), never by its own prior diff.
    NEW_INFORMATION_EVENT_TYPES.NEW_EXTERNAL_RESULT,
  ]),
  reviewer: new Set([
    NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF,
    NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT,
    NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD,
    NEW_INFORMATION_EVENT_TYPES.NEW_EXTERNAL_RESULT,
  ]),
});

export function isEligible(role, type) {
  return ROLE_EVENT_ELIGIBILITY[role]?.has(type) === true;
}

// ── 4. Durable New Information ledger (§4) ────────────────────────────
const WORKFLOW_STATE_KEY = 'modelSpendInformation';

// Persistence adapter over the SAME workflow-scoped snapshot every other
// durable orchestrator state already uses. A test double / minimal
// persistence stand-in without the workflow-state interface degrades to
// "no persistence configured" (in-memory only), exactly like
// ReservationStore — never treated as a runtime failure.
export class InformationStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(workflowId) {
    if (!workflowId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') {
      return { events: {}, consumptions: {} };
    }
    const state = await this._persistence.readWorkflowState(workflowId);
    const info = state?.[WORKFLOW_STATE_KEY];
    return {
      events: info?.events && typeof info.events === 'object' ? { ...info.events } : {},
      consumptions: info?.consumptions && typeof info.consumptions === 'object' ? { ...info.consumptions } : {},
    };
  }

  async save(workflowId, data) {
    if (!workflowId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    await this._persistence.updateWorkflowState(workflowId, { [WORKFLOW_STATE_KEY]: data });
  }
}

// The New Information lifecycle: register deterministic evidence, and
// durably claim (role, operationId, evidenceId) consumption BEFORE a permit
// may be minted for it. One ledger typically backs one ModelSpendAuthority
// (production wiring), but it is authority-agnostic: it keys everything by
// workflowId.
//
// Without a `store` (the default), the ledger is in-memory only for the
// lifetime of the process — fine for unit tests, and for any caller that
// deliberately never wires durability.
export class NewInformationLedger {
  constructor({ store = null } = {}) {
    this._store = store;
    this._cache = new Map(); // workflowId -> { events: Map, consumptions: Map }
  }

  async _load(workflowId) {
    const key = workflowId ?? null;
    if (this._cache.has(key)) return this._cache.get(key);
    const persisted = this._store ? await this._store.load(key) : { events: {}, consumptions: {} };
    const state = {
      events: new Map(Object.entries(persisted?.events ?? {})),
      consumptions: new Map(Object.entries(persisted?.consumptions ?? {})),
    };
    this._cache.set(key, state);
    return state;
  }

  async _persistCandidate(workflowId, candidate) {
    if (!this._store) return;
    await this._store.save(workflowId ?? null, {
      events: Object.fromEntries(candidate.events.entries()),
      consumptions: Object.fromEntries(candidate.consumptions.entries()),
    });
  }

  // Idempotent registration (§2/§8): re-registering the SAME evidenceId
  // returns the EXISTING record rather than creating a fresh one. Old
  // workflows that predate this feature load with empty maps, never
  // corruption (backward compatible with workflow.json missing this key).
  async registerEvidence({
    workflowId, type, subject = null, fingerprint, source = null, evidenceId,
  }) {
    const id = evidenceId ?? computeEvidenceId({
      type, workflowId, subject, fingerprint,
    });
    const state = await this._load(workflowId);
    if (state.events.has(id)) return state.events.get(id);
    const record = {
      evidenceId: id,
      type,
      workflowId: workflowId ?? null,
      subject: subject ?? null,
      fingerprint: String(fingerprint ?? ''),
      source: source ?? null,
      createdAt: new Date().toISOString(),
    };
    const candidateEvents = new Map(state.events);
    candidateEvents.set(id, record);
    await this._persistCandidate(workflowId, { events: candidateEvents, consumptions: state.consumptions });
    state.events = candidateEvents;
    return record;
  }

  async getEvidence(workflowId, evidenceId) {
    const state = await this._load(workflowId);
    return state.events.get(evidenceId) ?? null;
  }

  async isConsumed({ workflowId, role, operationId, evidenceId }) {
    const state = await this._load(workflowId);
    return state.consumptions.has(computeConsumptionKey({ role, operationId, evidenceId }));
  }

  // Durably claims (role, operationId, evidenceId). Idempotent: consuming an
  // already-consumed key again is a no-op that returns the existing record
  // (never double counted, never re-authorizes on its own — the caller must
  // still find a DIFFERENT unconsumed eligible evidenceId to authorize a new
  // call). Durable-before-cache, same discipline as
  // ReservationLedger.settleKnown/markUnresolved: the candidate consumption
  // map is persisted FIRST; the cache is mutated only after persistence
  // succeeds. A rejection here must be treated as fail-closed by the caller —
  // zero physical provider calls.
  async consume({ workflowId, role, operationId, evidenceId }) {
    const state = await this._load(workflowId);
    const key = computeConsumptionKey({ role, operationId, evidenceId });
    if (state.consumptions.has(key)) return state.consumptions.get(key);
    const record = {
      evidenceId, role: role ?? null, operationId: operationId ?? null, consumedAt: new Date().toISOString(),
    };
    const candidateConsumptions = new Map(state.consumptions);
    candidateConsumptions.set(key, record);
    await this._persistCandidate(workflowId, { events: state.events, consumptions: candidateConsumptions });
    state.consumptions = candidateConsumptions;
    return record;
  }

  // Deterministic, zero-model-token decision: given candidate evidenceIds for
  // a role/operation, return the FIRST registered, role-eligible, unconsumed
  // evidence event — or null when none qualify. An unregistered id is never
  // treated as evidence (it cannot be mechanically traced to a concrete
  // fingerprint).
  async findEligibleUnconsumed({
    workflowId, role, operationId, evidenceIds = [],
  }) {
    const state = await this._load(workflowId);
    for (const evidenceId of evidenceIds) {
      const event = state.events.get(evidenceId);
      if (!event) continue;
      if (!isEligible(role, event.type)) continue;
      const key = computeConsumptionKey({ role, operationId, evidenceId });
      if (state.consumptions.has(key)) continue;
      return event;
    }
    return null;
  }

  // Diagnostics / tests only.
  async list(workflowId) {
    const state = await this._load(workflowId);
    return {
      events: Array.from(state.events.values()),
      consumptions: Array.from(state.consumptions.values()),
    };
  }
}

// ── Convenience registration helpers (§3, §8) ─────────────────────────
//
// Thin wrappers around registerEvidence() that fix the `type` and compute a
// stable `subject` for the artifacts the production pipeline actually
// produces. Every fingerprint input is reused from the EXISTING deterministic
// hashing already in the codebase (deterministicSupervisorPolicy.js /
// gateFailureIdentity.js) rather than duplicated here.

export async function registerUserInputEvidence(ledger, { workflowId, interactionId = null, text }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT,
    subject: interactionId ?? 'initial-input',
    fingerprint: sha256(String(text ?? '')),
    source: 'user',
  });
}

export async function registerTaskCardEvidence(ledger, { workflowId, taskId, taskCard }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.NEW_TASK_CARD,
    subject: taskId ?? null,
    fingerprint: sha256(JSON.stringify(taskCard ?? {})),
    source: 'planner',
  });
}

export async function registerGateFingerprintEvidence(ledger, { workflowId, taskId, fingerprint }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.NEW_GATE_FINGERPRINT,
    subject: taskId ?? null,
    fingerprint,
    source: 'gate',
  });
}

export async function registerTaskDiffEvidence(ledger, { workflowId, taskId, diffHash }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.CHANGED_TASK_DIFF,
    subject: taskId ?? null,
    fingerprint: diffHash,
    source: 'executor',
  });
}

export async function registerReviewFindingsEvidence(ledger, { workflowId, taskId, signature }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.NEW_REVIEW_FINDINGS,
    subject: taskId ?? null,
    fingerprint: signature,
    source: 'reviewer',
  });
}

export async function registerRepositoryStateEvidence(ledger, { workflowId, headFingerprint }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.CHANGED_REPOSITORY_STATE,
    subject: 'repository-head',
    fingerprint: headFingerprint,
    source: 'repository',
  });
}

export async function registerExternalResultEvidence(ledger, { workflowId, subject, fingerprint }) {
  return ledger.registerEvidence({
    workflowId,
    type: NEW_INFORMATION_EVENT_TYPES.NEW_EXTERNAL_RESULT,
    subject: subject ?? null,
    fingerprint,
    source: 'external',
  });
}
