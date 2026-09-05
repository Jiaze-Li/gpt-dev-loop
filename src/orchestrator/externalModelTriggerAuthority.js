// External Model Trigger Authority.
//
// Internal physical model calls already cross ModelSpendAuthority (see
// modelSpendAuthority.js): CallIntent -> authorize() -> PhysicalCallPermit ->
// dispatch() -> provider adapter. But a GitHub PR-review comment such as
// "@codex review" / "@claude review" causes an EXTERNAL system to spend model
// quota outside that internal provider runtime entirely. That is a distinct
// spend action — an External Model Trigger — and it needs its own
// deterministic, zero-model, durable, fail-closed authority. It must never be
// routed through ModelSpendAuthority merely to reuse names, and a GitHub
// comment must never be treated as though it were an internal provider
// invocation.
//
//   TriggerIntent -> ExternalModelTriggerAuthority.authorize()
//                 -> { outcome: 'ALLOW', permit } | { outcome: 'REUSE', trigger }
//                 -> (ALLOW only) .dispatch(permit, intent, dispatchFn)
//                 -> persist DISPATCHING (before dispatchFn runs)
//                 -> dispatchFn() -- the real GitHub postReviewTrigger call
//                 -> persist TRIGGERED | UNRESOLVED
//
// Core principles (mirrors Token Safety's Global New Information Policy):
//
//   UNKNOWN TRIGGER OUTCOME != ZERO
//   provider/reviewer failure != new information
//   reviewer change alone != new information
//   timeout != new information
//   polling != a model trigger
//
// Semantic dedupe identity is workflow + PR + review purpose + reviewed HEAD
// — NEVER reviewer identity, comment id, attempt number, or timestamp. So:
//
//   @codex review on H1 (dispatch may have begun)
//     -> @claude review on the SAME H1 is DENIED. Reviewer change alone is
//        never fresh information for the SAME reviewable state.
//
// The one zero-spend exception: a mechanical pre-dispatch "is this reviewer
// available" probe that proves a reviewer unavailable BEFORE authorize() /
// dispatch() ever ran for that reviewer never touches this ledger and never
// consumes anything — callers should complete that probe BEFORE requesting
// authorization, exactly as they already do for internal role selection.

import { randomUUID } from 'node:crypto';
import { ExternalTriggerError, EXTERNAL_TRIGGER_ERROR_CODES } from './errors.js';
import { DEFAULT_MAX_REPAIR_ROUNDS, DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS } from './prCloseoutPolicy.js';

export const EXTERNAL_TRIGGER_STATUS = Object.freeze({
  // Authorization state persisted. Physical GitHub trigger dispatch has
  // definitely not begun.
  RESERVED: 'RESERVED',
  // Durably persisted "dispatch may begin" boundary. Once here, assume an
  // external model trigger MAY have occurred.
  DISPATCHING: 'DISPATCHING',
  // postReviewTrigger() returned success and the trigger identity (comment
  // id) was durably persisted.
  TRIGGERED: 'TRIGGERED',
  // A trusted, matching review result has been observed for this trigger.
  // Audit only — does NOT make the same HEAD triggerable again.
  RESULT_RECEIVED: 'RESULT_RECEIVED',
  // Trigger dispatch may have occurred but reliable settlement cannot be
  // proven. Blocks another trigger for the same semantic review state.
  UNRESOLVED: 'UNRESOLVED',
  // A RESERVED reservation provably superseded/abandoned before physical
  // dispatch was ever attempted. Safe to close without treating it as
  // unknown external spend.
  CANCELLED_PRE_DISPATCH: 'CANCELLED_PRE_DISPATCH',
});

// Statuses that prove a physical external trigger dispatch MAY have begun.
// A record in one of these consumed this semantic HEAD's one-trigger budget
// and counts against the round / total-trigger ceilings, regardless of
// whether it eventually resolves cleanly.
const DISPATCH_OR_LATER = new Set([
  EXTERNAL_TRIGGER_STATUS.DISPATCHING,
  EXTERNAL_TRIGGER_STATUS.TRIGGERED,
  EXTERNAL_TRIGGER_STATUS.RESULT_RECEIVED,
  EXTERNAL_TRIGGER_STATUS.UNRESOLVED,
]);

export function isDispatchOrLaterStatus(status) {
  return DISPATCH_OR_LATER.has(status);
}

// ---------------------------------------------------------------------------
// Production default derivation (§ trigger count / round ceilings).
//
// MAX EXTERNAL REVIEW ROUNDS: a "round" is one genuinely new reviewable PR
// state (normally a new HEAD), never a per-provider attempt. The bounded
// PR-closeout loop (prCloseoutPolicy.js) already caps how many new HEADs an
// automatic repair sequence can ever produce:
//
//   1 initial review
//   + DEFAULT_MAX_REPAIR_ROUNDS ordinary repair rounds (each produces one
//     new HEAD -> one new re-review)
//   + DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS Supervisor-escalation repair
//     rounds (each also produces one new HEAD -> one new re-review)
//
// so the deterministic ceiling on genuinely new reviewable states in a
// single PR-closeout workflow is exactly that sum. This leaves the entire
// happy path (initial review + every repair round the closeout policy can
// ever schedule) room to complete, while an abnormal loop that somehow kept
// manufacturing "new" heads still stops deterministically.
export const DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS = 1 + DEFAULT_MAX_REPAIR_ROUNDS + DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS;

// MAX EXTERNAL MODEL TRIGGERS: Part D makes AT MOST ONE external trigger
// dispatch possible per semantic HEAD state (workflow + PR + HEAD), across
// every reviewer — a duplicate is denied at authorize() before dispatch()
// can ever run again for that HEAD. So in the worst case exactly one trigger
// dispatch happens per review round, and the total-trigger ceiling can equal
// the round ceiling without starving the happy path.
export const DEFAULT_MAX_EXTERNAL_MODEL_TRIGGERS = DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS;

// WALL CLOCK: the adapter's own per-request wait (githubPrReviewAdapter.js —
// DEFAULT_MAX_WAIT_MS = 15 minutes; production's requestTrustedReview uses a
// tighter 30s-per-reviewer budget) already bounds a SINGLE review wait. This
// is a separate, OUTER, cumulative ceiling across the whole bounded review
// sequence (every round above) and must survive a process restart. One hour
// gives every round several multiples of the existing per-request wait
// without keeping the workflow open indefinitely.
export const DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS = 60 * 60 * 1000;

const WORKFLOW_STATE_KEY = 'externalModelTriggers';

function iso(ms) {
  return new Date(ms).toISOString();
}

function makeSubjectKey({ workflowId, prNumber, triggerKind }) {
  return `${workflowId ?? 'null'}::${prNumber ?? 'null'}::${triggerKind ?? 'PR_REVIEW'}`;
}

// Structured TriggerIntent normalization. Semantic dedupe identity is
// workflow + PR + review purpose + reviewed HEAD (subjectKey + headSha) —
// NEVER reviewer, comment id, attempt, or timestamp; those are carried only
// as audit metadata.
export function normalizeTriggerIntent(raw = {}) {
  const workflowId = raw.workflowId ?? null;
  const prNumber = raw.prNumber ?? null;
  const headSha = String(raw.headSha ?? '').trim();
  const triggerKind = String(raw.triggerKind ?? 'PR_REVIEW').trim() || 'PR_REVIEW';
  const semanticAction = String(raw.semanticAction ?? 'EXTERNAL_PR_REVIEW').trim() || 'EXTERNAL_PR_REVIEW';
  const reviewer = raw.reviewer ?? null;
  if (!workflowId || prNumber === null || prNumber === undefined || String(prNumber).trim() === '' || !headSha) {
    throw new ExternalTriggerError(
      EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_INTENT_INCOMPLETE,
      'TriggerIntent requires workflowId, prNumber, and headSha',
      { raw },
    );
  }
  return {
    workflowId, prNumber, headSha, triggerKind, semanticAction, reviewer,
  };
}

// Fields dispatch() re-checks a permit against. Deliberately excludes
// `reviewer` (§ Part B — reviewer identity must never itself change what a
// permit authorizes) and excludes createdAt/attempt-shaped fields entirely
// (there are none here — this authority has no physical-attempt counter).
const BINDING_KEYS = ['workflowId', 'prNumber', 'headSha', 'triggerKind', 'semanticAction'];

function bindingMatches(a, b) {
  return BINDING_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

// Persistence adapter over the existing workflow-scoped snapshot
// (Persistence.readWorkflowState / updateWorkflowState — see persistence.js),
// exactly like ReservationStore (modelSpendReservation.js). No parallel
// database: an external trigger record survives the identical restart/resume
// path as the rest of the workflow, under the `externalModelTriggers` key.
export class ExternalTriggerStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(workflowId) {
    if (!workflowId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return {};
    const state = await this._persistence.readWorkflowState(workflowId);
    const raw = state?.[WORKFLOW_STATE_KEY];
    return raw && typeof raw === 'object' ? { ...raw } : {};
  }

  async save(workflowId, subjects) {
    if (!workflowId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    await this._persistence.updateWorkflowState(workflowId, { [WORKFLOW_STATE_KEY]: subjects });
  }
}

// Opaque, single-use, intent-bound authorization token. The secret tying it
// back to the issuing authority is a true private field — never enumerable,
// never serializable, never reconstructable by an ordinary caller — so a
// permit can never be forged or copied.
export class ExternalTriggerPermit {
  #token;

  constructor(token, intent) {
    this.#token = token;
    this.intent = Object.freeze({ ...intent });
    Object.freeze(this);
  }

  _revealTokenTo(brand) {
    return brand === ExternalTriggerPermit._brand ? this.#token : undefined;
  }
}
ExternalTriggerPermit._brand = Symbol('ExternalTriggerPermit.brand');

function getOrInitBucket(map, subjectKey) {
  const existing = map.get(subjectKey);
  const bucket = existing
    ? structuredClone(existing)
    : { triggers: {}, wallClock: { startedAt: null, deadlineAt: null }, dispatchCount: 0 };
  map.set(subjectKey, bucket);
  return bucket;
}

// The single centralized, deterministic, zero-model authority every
// production "@codex review" / "@claude review" trigger must cross. No
// AI/LLM decides whether another AI may be triggered — every decision here
// is a pure function of durably persisted state.
export class ExternalModelTriggerAuthority {
  constructor({
    store = null,
    clock = {},
    maxExternalModelTriggers = DEFAULT_MAX_EXTERNAL_MODEL_TRIGGERS,
    maxExternalReviewRounds = DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS,
    wallClockMs = DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS,
    recordSafetyEvent,
    onEvent,
  } = {}) {
    this._store = store;
    this._now = typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
    this._maxTriggers = Number.isInteger(maxExternalModelTriggers) && maxExternalModelTriggers > 0
      ? maxExternalModelTriggers : DEFAULT_MAX_EXTERNAL_MODEL_TRIGGERS;
    this._maxRounds = Number.isInteger(maxExternalReviewRounds) && maxExternalReviewRounds > 0
      ? maxExternalReviewRounds : DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS;
    this._wallClockMs = Number.isFinite(wallClockMs) && wallClockMs > 0
      ? wallClockMs : DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS;
    this._recordSafetyEvent = recordSafetyEvent;
    this._onEvent = onEvent;
    this._cache = new Map(); // workflowId -> Map(subjectKey -> bucket)
    this._issued = new Map(); // token -> { intent, subjectKey, headSha, consumed }
  }

  async _loadWorkflow(workflowId) {
    const key = workflowId ?? null;
    if (this._cache.has(key)) return this._cache.get(key);
    const persisted = this._store ? await this._store.load(key) : {};
    const map = new Map(Object.entries(persisted ?? {}));
    this._cache.set(key, map);
    return map;
  }

  // Durable-before-cache (same discipline as ReservationLedger): `mutator`
  // receives the top-level Map and must call getOrInitBucket() to obtain a
  // freshly cloned bucket before mutating it. Persistence happens BEFORE the
  // cache is ever updated; a persistence failure leaves the cache completely
  // untouched.
  async _mutateWorkflow(workflowId, mutator) {
    const key = workflowId ?? null;
    const map = await this._loadWorkflow(key);
    const candidateMap = new Map(map);
    const result = mutator(candidateMap);
    if (this._store) {
      await this._store.save(key, Object.fromEntries(candidateMap.entries()));
    }
    this._cache.set(key, candidateMap);
    return result;
  }

  _stateUnavailable(intent, error) {
    return new ExternalTriggerError(
      EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_STATE_UNAVAILABLE,
      `external trigger state could not be durably read or written: ${error?.message ?? error}`,
      { intent },
    );
  }

  // TriggerIntent -> { outcome: 'ALLOW', permit } | { outcome: 'REUSE', trigger }.
  // Throws ExternalTriggerError (fail closed, zero permit minted) for every
  // denial: duplicate / limit / round / wall-clock / unreadable state.
  async authorize(rawIntent) {
    const intent = normalizeTriggerIntent(rawIntent);
    const subjectKey = makeSubjectKey(intent);
    const now = this._now();

    let map;
    try {
      map = await this._loadWorkflow(intent.workflowId);
    } catch (error) {
      throw this._stateUnavailable(intent, error);
    }
    let bucket = map.get(subjectKey) ?? { triggers: {}, wallClock: { startedAt: null, deadlineAt: null }, dispatchCount: 0 };

    // Wall-clock ceiling: initialized once, durably, on first authorize() for
    // this subject; a process restart never resets it (elapsed time alone
    // never authorizes a new trigger, and never re-arms a spent one).
    if (!bucket.wallClock?.startedAt) {
      try {
        bucket = await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
          const b = getOrInitBucket(candidateMap, subjectKey);
          if (!b.wallClock?.startedAt) {
            b.wallClock = { startedAt: iso(now), deadlineAt: iso(now + this._wallClockMs) };
          }
          return b;
        });
      } catch (error) {
        throw this._stateUnavailable(intent, error);
      }
    }
    const deadlineMs = Date.parse(bucket.wallClock.deadlineAt);
    if (Number.isFinite(deadlineMs) && now > deadlineMs) {
      this._recordSafetyEvent?.({
        code: 'EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED',
        severity: 'BLOCKING',
        role: 'external-review',
        reason: `external review wall-clock ceiling exceeded for ${subjectKey}`,
        actionTaken: 'no new external model trigger posted',
      });
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED,
        `external review wall-clock ceiling (${this._wallClockMs}ms) exceeded for ${subjectKey}`,
        { intent },
      );
    }

    const existing = bucket.triggers[intent.headSha];
    if (existing) {
      if (existing.status === EXTERNAL_TRIGGER_STATUS.TRIGGERED) {
        // Already posted for this exact HEAD (by whichever reviewer) — the
        // caller must reuse the persisted trigger and resume polling, never
        // post again.
        return {
          outcome: 'REUSE',
          trigger: {
            commentId: existing.commentId,
            triggeredAt: existing.triggeredAt,
            reviewer: existing.reviewerRequested,
            headSha: existing.headSha,
          },
        };
      }
      if (DISPATCH_OR_LATER.has(existing.status)) {
        // DISPATCHING / RESULT_RECEIVED / UNRESOLVED — a physical dispatch
        // has already (or may already have) consumed this HEAD's one-trigger
        // budget. Reviewer change, timeout, or retry is never fresh
        // information for the same semantic review state.
        this._recordSafetyEvent?.({
          code: 'EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED',
          severity: 'BLOCKING',
          role: 'external-review',
          reason: `external model trigger already ${existing.status} for ${subjectKey} @ ${intent.headSha}`,
          actionTaken: 'no new external model trigger posted',
        });
        throw new ExternalTriggerError(
          EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
          `external model trigger already ${existing.status} for workflow=${intent.workflowId} pr=${intent.prNumber} `
            + `head=${intent.headSha}; reviewer change, timeout, or retry alone is not new information`,
          { intent, existingStatus: existing.status },
        );
      }
      if (existing.status === EXTERNAL_TRIGGER_STATUS.RESERVED) {
        // Provably pre-dispatch (DISPATCHING is always durably persisted
        // BEFORE any physical post — see dispatch() below), so this
        // reservation is safe to supersede: cancel it and mint a fresh one.
        try {
          bucket = await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
            const b = getOrInitBucket(candidateMap, subjectKey);
            const rec = b.triggers[intent.headSha];
            if (rec && rec.status === EXTERNAL_TRIGGER_STATUS.RESERVED) {
              rec.status = EXTERNAL_TRIGGER_STATUS.CANCELLED_PRE_DISPATCH;
              rec.settledAt = iso(this._now());
              rec.reason = 'SUPERSEDED_BEFORE_DISPATCH';
            }
            return b;
          });
        } catch (error) {
          throw this._stateUnavailable(intent, error);
        }
      }
      // CANCELLED_PRE_DISPATCH falls through unchanged — safe to re-reserve.
    }

    const roundCount = Object.values(bucket.triggers).filter((r) => DISPATCH_OR_LATER.has(r.status)).length;
    if (roundCount >= this._maxRounds) {
      this._recordSafetyEvent?.({
        code: 'EXTERNAL_MODEL_REVIEW_ROUND_LIMIT_EXCEEDED',
        severity: 'BLOCKING',
        role: 'external-review',
        reason: `external review round ceiling (${this._maxRounds}) reached for ${subjectKey}`,
        actionTaken: 'no new external model trigger posted',
      });
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_REVIEW_ROUND_LIMIT_EXCEEDED,
        `external review round ceiling (${this._maxRounds}) reached for ${subjectKey}; a fresh HEAD does not bypass it`,
        { intent, roundCount },
      );
    }
    if ((bucket.dispatchCount ?? 0) >= this._maxTriggers) {
      this._recordSafetyEvent?.({
        code: 'EXTERNAL_MODEL_TRIGGER_LIMIT_EXCEEDED',
        severity: 'BLOCKING',
        role: 'external-review',
        reason: `external model trigger ceiling (${this._maxTriggers}) reached for ${subjectKey}`,
        actionTaken: 'no new external model trigger posted',
      });
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_LIMIT_EXCEEDED,
        `external model trigger ceiling (${this._maxTriggers}) reached for ${subjectKey}; a fresh HEAD does not bypass it`,
        { intent, dispatchCount: bucket.dispatchCount ?? 0 },
      );
    }

    const triggerId = randomUUID();
    const record = {
      triggerId,
      workflowId: intent.workflowId,
      prNumber: intent.prNumber,
      headSha: intent.headSha,
      triggerKind: intent.triggerKind,
      semanticAction: intent.semanticAction,
      reviewerRequested: intent.reviewer,
      status: EXTERNAL_TRIGGER_STATUS.RESERVED,
      roundNumber: roundCount + 1,
      triggerSequence: (bucket.dispatchCount ?? 0) + 1,
      createdAt: iso(now),
      dispatchStartedAt: null,
      triggeredAt: null,
      commentId: null,
      resultReceivedAt: null,
      settledAt: null,
      reason: null,
    };
    try {
      await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
        const b = getOrInitBucket(candidateMap, subjectKey);
        b.triggers[intent.headSha] = record;
        return b;
      });
    } catch (error) {
      throw this._stateUnavailable(intent, error);
    }

    const token = randomUUID();
    this._issued.set(token, {
      intent, subjectKey, headSha: intent.headSha, consumed: false,
    });
    this._onEvent?.({
      type: 'EXTERNAL_TRIGGER_RESERVED', triggerId, subjectKey, headSha: intent.headSha, roundNumber: record.roundNumber,
    });
    return { outcome: 'ALLOW', permit: new ExternalTriggerPermit(token, intent) };
  }

  // Default-deny protected dispatch. `dispatchFn` is the real external
  // action (posting the "@codex review" / "@claude review" GitHub comment).
  // The durable DISPATCHING boundary is persisted BEFORE dispatchFn ever
  // runs; a persistence failure here means dispatchFn is NEVER called (fail
  // closed). Resolves to { commentId, triggeredAt, reviewer, headSha } on a
  // confirmed, durably persisted TRIGGERED outcome; throws
  // EXTERNAL_MODEL_TRIGGER_UNRESOLVED for every ambiguous outcome (dispatchFn
  // threw, returned no usable id, or the durable TRIGGERED write itself
  // failed) — never assuming zero external spend.
  async dispatch(permit, rawIntent, dispatchFn) {
    const intent = normalizeTriggerIntent(rawIntent);
    const token = permit instanceof ExternalTriggerPermit
      ? permit._revealTokenTo(ExternalTriggerPermit._brand)
      : undefined;
    if (typeof token !== 'string') {
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_MISSING,
        'external trigger dispatch attempted without an ExternalTriggerPermit',
        { intent },
      );
    }
    const record = this._issued.get(token);
    if (!record) {
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_UNKNOWN,
        'ExternalTriggerPermit was not issued by this authority',
        { intent },
      );
    }
    if (record.consumed) {
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_CONSUMED,
        'ExternalTriggerPermit already consumed; one permit authorizes exactly one dispatch',
        { intent },
      );
    }
    if (!bindingMatches(record.intent, intent)) {
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_INTENT_MISMATCH,
        'ExternalTriggerPermit does not authorize this TriggerIntent',
        { intent, permitIntent: record.intent },
      );
    }
    record.consumed = true;
    const { subjectKey, headSha } = record;

    try {
      await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
        const b = getOrInitBucket(candidateMap, subjectKey);
        const rec = b.triggers[headSha];
        if (!rec) throw new Error(`external trigger record missing for ${subjectKey} @ ${headSha}`);
        rec.status = EXTERNAL_TRIGGER_STATUS.DISPATCHING;
        rec.dispatchStartedAt = iso(this._now());
        b.dispatchCount = (b.dispatchCount ?? 0) + 1;
        return b;
      });
    } catch (error) {
      throw this._stateUnavailable(intent, error);
    }
    this._onEvent?.({ type: 'EXTERNAL_TRIGGER_DISPATCHING', subjectKey, headSha });

    let outcome;
    try {
      outcome = { ok: true, value: await dispatchFn() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    const commentId = outcome.ok ? (outcome.value?.id ?? null) : null;
    if (outcome.ok && commentId != null) {
      const triggeredAt = outcome.value?.createdAt ?? iso(this._now());
      try {
        await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
          const b = getOrInitBucket(candidateMap, subjectKey);
          const rec = b.triggers[headSha];
          if (!rec) throw new Error(`external trigger record missing for ${subjectKey} @ ${headSha}`);
          rec.status = EXTERNAL_TRIGGER_STATUS.TRIGGERED;
          rec.commentId = commentId;
          rec.triggeredAt = triggeredAt;
          return b;
        });
      } catch (error) {
        // GitHub accepted the comment but the durable TRIGGERED write itself
        // failed. Durable state remains DISPATCHING (already blocking) —
        // never revert to fresh, never retry the post.
        this._recordSafetyEvent?.({
          code: 'EXTERNAL_MODEL_TRIGGER_UNRESOLVED',
          severity: 'BLOCKING',
          role: 'external-review',
          reason: `external trigger posted (comment ${commentId}) but TRIGGERED state could not be durably persisted: ${error?.message ?? error}`,
          actionTaken: 'external review blocked for this HEAD until a human clears it',
        });
        throw new ExternalTriggerError(
          EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_UNRESOLVED,
          `external trigger for ${subjectKey} @ ${headSha} was posted but its TRIGGERED state could not be durably `
            + 'persisted; treating as unresolved rather than assuming zero external spend',
          { intent, commentId },
        );
      }
      this._onEvent?.({
        type: 'EXTERNAL_TRIGGER_TRIGGERED', subjectKey, headSha, commentId,
      });
      return {
        commentId, triggeredAt, reviewer: intent.reviewer, headSha: intent.headSha,
      };
    }

    // dispatchFn threw, or returned no usable comment id: the GitHub server
    // may have accepted the comment before the client observed the failure.
    // A generic error here is ambiguous, never proof of zero external spend.
    const reason = outcome.ok
      ? 'EXTERNAL_TRIGGER_DISPATCH_RETURNED_NO_ID'
      : String(outcome.error?.code ?? outcome.error?.message ?? 'EXTERNAL_TRIGGER_DISPATCH_ERROR');
    try {
      await this._mutateWorkflow(intent.workflowId, (candidateMap) => {
        const b = getOrInitBucket(candidateMap, subjectKey);
        const rec = b.triggers[headSha];
        if (!rec) throw new Error(`external trigger record missing for ${subjectKey} @ ${headSha}`);
        rec.status = EXTERNAL_TRIGGER_STATUS.UNRESOLVED;
        rec.settledAt = iso(this._now());
        rec.reason = reason;
        return b;
      });
    } catch (persistError) {
      // Even the UNRESOLVED write failed. Durable state remains DISPATCHING,
      // itself already blocking — surface a dedicated error rather than the
      // raw persistence error or the original dispatch error.
      this._recordSafetyEvent?.({
        code: 'EXTERNAL_MODEL_TRIGGER_UNRESOLVED',
        severity: 'BLOCKING',
        role: 'external-review',
        reason: `external trigger dispatch for ${subjectKey} @ ${headSha} is ambiguous and its UNRESOLVED state could `
          + `not be durably persisted either: ${persistError?.message ?? persistError}`,
        actionTaken: 'external review blocked for this HEAD until a human clears it',
      });
      throw new ExternalTriggerError(
        EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_UNRESOLVED,
        `external trigger dispatch for ${subjectKey} @ ${headSha} could not be reliably confirmed, and its `
          + 'UNRESOLVED state could not be durably persisted either',
        { intent },
      );
    }
    this._recordSafetyEvent?.({
      code: 'EXTERNAL_MODEL_TRIGGER_UNRESOLVED',
      severity: 'BLOCKING',
      role: 'external-review',
      reason: `external model trigger dispatch for ${subjectKey} @ ${headSha} may have occurred but could not be `
        + `reliably confirmed (${reason})`,
      actionTaken: 'no cross-reviewer fallback and no retry for this HEAD; a human must clear it',
    });
    throw new ExternalTriggerError(
      EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_UNRESOLVED,
      `external model trigger dispatch for ${subjectKey} @ ${headSha} may have occurred but could not be reliably `
        + `confirmed (${reason}); further automatic triggering for this HEAD is blocked until a human clears it`,
      { intent, originalErrorMessage: outcome.ok ? null : (outcome.error?.message ?? String(outcome.error)) },
    );
  }

  // Best-effort audit transition: a trusted, matching review result has been
  // observed for a TRIGGERED record. Never throws — the same-HEAD dedupe
  // already holds regardless of whether this succeeds (TRIGGERED itself is
  // already untriggerable), so a persistence hiccup here must never mask the
  // otherwise-successful review result reaching the caller.
  async recordResult({
    workflowId, prNumber, headSha, triggerKind = 'PR_REVIEW', resultMeta = {},
  }) {
    const subjectKey = makeSubjectKey({ workflowId, prNumber, triggerKind });
    try {
      await this._mutateWorkflow(workflowId, (candidateMap) => {
        const b = getOrInitBucket(candidateMap, subjectKey);
        const rec = b.triggers[headSha];
        if (rec && rec.status === EXTERNAL_TRIGGER_STATUS.TRIGGERED) {
          rec.status = EXTERNAL_TRIGGER_STATUS.RESULT_RECEIVED;
          rec.resultReceivedAt = iso(this._now());
          rec.resultMeta = resultMeta && typeof resultMeta === 'object' ? { ...resultMeta } : null;
        }
        return b;
      });
    } catch { /* best effort — same-HEAD dedupe already holds regardless */ }
  }

  // Resume reconciliation, same shape as ReservationLedger#reconcileOnResume:
  //   RESERVED, never DISPATCHING -> CANCELLED_PRE_DISPATCH (provably safe:
  //     DISPATCHING is always durably persisted before any physical post).
  //   DISPATCHING, never settled   -> UNRESOLVED (conservative: the process
  //     may have physically posted before crashing).
  //   TRIGGERED / RESULT_RECEIVED / UNRESOLVED -> unchanged.
  async reconcileOnResume(workflowId) {
    let changed = false;
    await this._mutateWorkflow(workflowId, (candidateMap) => {
      for (const [subjectKey, bucket] of candidateMap.entries()) {
        const b = structuredClone(bucket);
        let localChanged = false;
        for (const rec of Object.values(b.triggers)) {
          if (rec.status === EXTERNAL_TRIGGER_STATUS.DISPATCHING) {
            rec.status = EXTERNAL_TRIGGER_STATUS.UNRESOLVED;
            rec.settledAt = iso(this._now());
            rec.reason = 'RESUME_RECONCILE_DISPATCHING_UNSETTLED';
            localChanged = true;
            this._recordSafetyEvent?.({
              code: 'EXTERNAL_MODEL_TRIGGER_UNRESOLVED',
              severity: 'BLOCKING',
              role: 'external-review',
              reason: `resume found an external trigger for ${subjectKey} @ ${rec.headSha} that crossed the dispatch `
                + 'boundary with no durable settlement',
              actionTaken: 'external review blocked for this HEAD until a human clears it',
            });
          } else if (rec.status === EXTERNAL_TRIGGER_STATUS.RESERVED) {
            rec.status = EXTERNAL_TRIGGER_STATUS.CANCELLED_PRE_DISPATCH;
            rec.settledAt = iso(this._now());
            rec.reason = 'RESUME_RECONCILE_NEVER_DISPATCHED';
            localChanged = true;
          }
        }
        if (localChanged) {
          candidateMap.set(subjectKey, b);
          changed = true;
        }
      }
      return null;
    });
    return changed;
  }

  // Test / diagnostics only.
  async list(workflowId) {
    const map = await this._loadWorkflow(workflowId);
    const out = [];
    for (const bucket of map.values()) out.push(...Object.values(bucket.triggers));
    return out;
  }
}
