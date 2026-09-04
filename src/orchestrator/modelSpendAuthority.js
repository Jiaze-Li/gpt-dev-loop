// Token-Safety authorization boundary.
//
//   CallIntent -> ModelSpendAuthority.authorize() -> PhysicalCallPermit
//              -> ModelSpendAuthority.dispatch(permit, intent, fn)  [default-deny]
//              -> provider dispatch
//
// authorize()/dispatch() also drive Persistent Model Spend Reservation (see
// modelSpendReservation.js): authorize() durably persists a RESERVED
// reservation before a permit ever exists; dispatch() durably persists the
// DISPATCHING boundary before the physical provider call, then settles the
// reservation SETTLED_KNOWN or UNRESOLVED once the call completes. An
// UNRESOLVED reservation blocks every further internal model spend attempt
// in that workflow (see authorize()'s MODEL_SPEND_USAGE_UNRESOLVED gate).
//
// This module establishes the invariant "every real internal provider
// invocation must hold a valid, single-use PhysicalCallPermit before
// dispatch". It carries NO token-budget policy yet: the default injected
// policy is allow-all (budget authorization is a later task; see Card 3 for
// per-physical-call budget rechecks). It DOES enforce one built-in
// invariant ahead of the injected `policy` callback — provider eligibility
// for the requested role, decided by an explicit `providerCapabilities`
// source (default: the PRODUCTION Provider Capability Policy in
// providerCapabilities.js) — so an Executor CallIntent for a family not
// declared executorEligible (e.g. codex:default, claude:opus while the
// automatic Executor chain is Sonnet-only) is denied before any `policy`
// or permit exists, REGARDLESS of what rolePolicy routed it here. This is
// not a bypassable flag: there is no "skip eligibility" switch, only which
// capability source answers "is this family eligible" — production code
// always uses the production source; only test fixtures that need to
// exercise the generic multi-provider failover mechanism inject an
// explicit TEST-ONLY permissive source. Even so it still enforces:
//
//   * permit issuance   — a permit is minted only by authorize(); an ordinary
//                          caller cannot synthesize one (the token is held in
//                          the authority's private map, never on the object in
//                          an enumerable / forgeable way).
//   * intent binding    — a permit authorizes exactly the { role, family,
//                          provider, operationId, attempt } it was issued for.
//   * single use        — one permit authorizes exactly one physical dispatch.
//   * default deny      — dispatch() runs the provided dispatch fn ONLY after a
//                          valid, unconsumed, intent-matched permit is proven.
//
// Failover to another provider must obtain a FRESH permit: the runtime issues
// one permit per physical attempt, never one per logical role invocation.

import { randomUUID } from 'node:crypto';
import { AuthorizationError, AUTHORIZATION_ERROR_CODES } from './errors.js';
import { isExecutorEligible as productionIsExecutorEligible } from './providerCapabilities.js';
import { ReservationLedger } from './modelSpendReservation.js';

// The strongest invocation identifiers mechanically available at the role
// runtime boundary. Missing semantic IDs are bound as null rather than
// invented — a permit issued with operationId:null still only matches another
// intent whose operationId is null.
//
// `workflowId` is an explicit minimal extension (not inferred from
// `operationId`'s "${workflowId}:${taskId}" convention) so Persistent Model
// Spend Reservation can key deterministically on the workflow a physical
// call belongs to, regardless of how `operationId` happens to be formatted
// by a given caller.
export const CALL_INTENT_KEYS = Object.freeze(['role', 'family', 'provider', 'operationId', 'attempt', 'workflowId']);

export function normalizeCallIntent(intent = {}) {
  const out = {};
  for (const key of CALL_INTENT_KEYS) {
    const value = intent[key];
    out[key] = value === undefined ? null : value;
  }
  if (!out.role || !out.family) {
    throw new AuthorizationError(
      AUTHORIZATION_ERROR_CODES.INTENT_INCOMPLETE,
      'CallIntent must carry at least a role and a provider family',
      { intent: out },
    );
  }
  return out;
}

function intentMatches(a, b) {
  return CALL_INTENT_KEYS.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

// Opaque authorization token. The secret that ties it back to the issuing
// authority (`#token`) is a true private field: it is not enumerable, not
// serialized, and cannot be read or reconstructed by a caller, so a permit
// cannot be forged or copied by an ordinary caller.
export class PhysicalCallPermit {
  #token;

  constructor(token, intent) {
    this.#token = token;
    this.intent = Object.freeze({ ...intent });
    this.issuedAt = intent.issuedAt ?? null;
    Object.freeze(this);
  }

  // Package-private: only ModelSpendAuthority calls this, passing its own
  // brand object. Any other caller gets undefined and cannot lift the token.
  _revealTokenTo(brand) {
    return brand === PhysicalCallPermit._brand ? this.#token : undefined;
  }
}
PhysicalCallPermit._brand = Symbol('PhysicalCallPermit.brand');

// Extracts whatever usage evidence a dispatch outcome carries, WITHOUT ever
// estimating a token amount (UNKNOWN USAGE != ZERO).
//
// A successful functional result proves the provider responded; it does NOT
// by itself prove the token spend was reliably accounted for. Settlement is
// therefore known ONLY when reliable usage evidence is actually present —
// on success or on failure alike:
//
//   - success: known iff the resolved value carries a `usage` field. The
//     bare existence of a return value (or a callId with no usage) is NOT
//     sufficient — it proves the call happened, not that its cost is known.
//   - failure: known ONLY when the thrown error itself carries explicit
//     usage evidence (`error.details.usage` / `error.usage`) — the shape
//     every adapter that reaches this call already uses when a post-send
//     guard (budget / duplicate-call / invalid-output) fires with real
//     provider usage in hand. Any other failure (timeout, killed process,
//     transport failure, missing usage telemetry, ...) is conservatively
//     UNRESOLVED: a business/protocol error never implies the spend was
//     zero.
//
// Neither branch estimates or synthesizes a usage value; both simply report
// whether one was actually supplied.
function extractSettlementUsage(outcome) {
  if (outcome.ok) {
    const usage = outcome.value?.usage ?? outcome.value?.value?.usage ?? null;
    return { known: usage !== null && usage !== undefined, usage, callId: usage?.callId ?? outcome.value?.callId ?? null };
  }
  const usage = outcome.error?.details?.usage ?? outcome.error?.usage ?? null;
  return { known: usage !== null && usage !== undefined, usage, callId: usage?.callId ?? null };
}

export class ModelSpendAuthority {
  // `policy(intent) -> { allow: boolean, reason?: string }`. The default is a
  // deterministic allow-all: budget authorization is a later task. Swapping in
  // a real policy does not change any of the permit mechanics below.
  //
  // `providerCapabilities` — an explicit { isExecutorEligible(family) ->
  // boolean } source for the built-in eligibility invariant below. Defaults
  // to the PRODUCTION Provider Capability Policy
  // (providerCapabilities.js — Sonnet-only Executor). This is deliberately
  // NOT a bypass flag: there is no "skip eligibility" option, only "which
  // capability source decides eligibility". Production code must never
  // override it; only test fixtures that explicitly need to exercise the
  // generic multi-provider failover mechanism inject a TEST-ONLY permissive
  // source here — production `rolePolicy` choices never do.
  //
  // `reservationLedger` — the Persistent Model Spend Reservation lifecycle
  // (see modelSpendReservation.js). Defaults to an in-memory-only ledger
  // (no filesystem I/O; fine for unit tests). Production callers inject one
  // backed by a `ReservationStore(persistence)` so a reservation survives
  // the same restart/resume path as the rest of the workflow.
  //
  // `recordSafetyEvent` — optional `(event) => void` forwarded to the ledger
  // so an UNRESOLVED reservation's BLOCKING safety event reaches the
  // workflow's user-visible terminal result (see safetyEvents.js /
  // workflowState.js#recordSafetyEvent) without this Authority needing to
  // know how a workflow's terminal state is assembled.
  constructor({
    policy = () => ({ allow: true }), onEvent, providerCapabilities, reservationLedger, recordSafetyEvent,
  } = {}) {
    this._policy = policy;
    this._onEvent = onEvent;
    this._isExecutorEligible = providerCapabilities?.isExecutorEligible ?? productionIsExecutorEligible;
    this._issued = new Map(); // token -> { intent, consumed, consumedAt, reservationId }
    this._reservationLedger = reservationLedger
      ?? new ReservationLedger({ onEvent, recordSafetyEvent });
  }

  get reservationLedger() {
    return this._reservationLedger;
  }

  // CallIntent -> PhysicalCallPermit. Throws AuthorizationError (SPEND_DENIED /
  // INTENT_INCOMPLETE / MODEL_SPEND_USAGE_UNRESOLVED / RESERVATION_PERSIST_FAILED)
  // before any permit exists if the intent is rejected.
  //
  // Ordering is safety-critical: the reservation is created and durably
  // PERSISTED (RESERVED) BEFORE this returns a permit. A caller can never
  // reach dispatch() without a durably persisted reservation already on
  // record, and a persistence failure here means zero physical provider
  // calls (fail closed) — no permit is ever minted.
  async authorize(rawIntent) {
    const intent = normalizeCallIntent(rawIntent);
    // Persistent Model Spend Reservation safety gate — checked before every
    // other decision, for EVERY internal role (not only Executor): a prior
    // physical call in this workflow whose usage could not be reliably
    // settled blocks all further internal model spend until a human clears
    // it. This is an orchestrator safety decision, never provider failure.
    if (await this._reservationLedger.hasUnresolved(intent.workflowId)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
        `workflow ${JSON.stringify(intent.workflowId)} has an unresolved model spend reservation; `
          + 'further internal model spend is blocked until a human clears it',
        { intent },
      );
    }
    // Provider eligibility is a built-in Authority invariant, not a
    // caller-overridable policy choice: it is checked BEFORE the injected
    // policy callback, so no custom policy can accidentally re-open a
    // provider that providerCapabilities.js does not declare eligible for
    // this role. Today this only constrains role === 'executor' (Executor
    // automatic chain is Sonnet-only); other roles are unaffected even when
    // routed to codex/agy families.
    if (intent.role === 'executor' && !this._isExecutorEligible(intent.family)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PROVIDER_NOT_ELIGIBLE_FOR_ROLE,
        `provider family "${intent.family}" is not executorEligible; the automatic Executor chain does not include it`,
        { intent },
      );
    }
    let decision;
    try {
      decision = this._policy(intent);
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
        `spend policy threw for ${intent.role}/${intent.family}: ${error?.message ?? error}`,
        { intent },
      );
    }
    if (!decision || decision.allow !== true) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.SPEND_DENIED,
        decision?.reason || `spend denied for ${intent.role}/${intent.family}`,
        { intent },
      );
    }
    const reservationId = randomUUID();
    try {
      await this._reservationLedger.reserve({ workflowId: intent.workflowId, intent, physicalAttempt: intent.attempt, reservationId });
    } catch (error) {
      // Fail closed: reservation persistence failed, so no permit is ever
      // minted and the physical call count for this attempt is zero.
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
        `model spend reservation could not be durably persisted: ${error?.message ?? error}`,
        { intent },
      );
    }
    const token = randomUUID();
    this._issued.set(token, {
      intent, consumed: false, consumedAt: null, reservationId,
    });
    this._onEvent?.({ type: 'PERMIT_ISSUED', ...intent });
    return new PhysicalCallPermit(token, intent);
  }

  // Default-deny protected dispatch. Runs `dispatchFn` (the real provider
  // call) ONLY when `permit` is a permit this authority issued, is not yet
  // consumed, and is bound to this exact CallIntent. The permit is consumed
  // BEFORE the dispatch fn runs, so a throwing / failing provider call can
  // never be retried on the same permit — the failover attempt must
  // authorize() again.
  //
  // The reservation's durable DISPATCHING boundary is persisted BEFORE
  // dispatchFn is ever invoked (a persistence failure here means dispatchFn
  // is never called — fail closed). After dispatchFn settles (success or
  // throw), the reservation is settled: SETTLED_KNOWN when reliable usage
  // evidence exists, UNRESOLVED otherwise (never estimated, never treated as
  // zero — see extractSettlementUsage above).
  async dispatch(permit, rawIntent, dispatchFn) {
    const intent = normalizeCallIntent(rawIntent);
    const token = permit instanceof PhysicalCallPermit
      ? permit._revealTokenTo(PhysicalCallPermit._brand)
      : undefined;
    if (typeof token !== 'string') {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_MISSING,
        'provider dispatch attempted without a PhysicalCallPermit',
        { intent },
      );
    }
    const record = this._issued.get(token);
    if (!record) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_UNKNOWN,
        'PhysicalCallPermit was not issued by this authority',
        { intent },
      );
    }
    if (record.consumed) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_CONSUMED,
        'PhysicalCallPermit already consumed; one permit authorizes exactly one dispatch',
        { intent },
      );
    }
    if (!intentMatches(record.intent, intent)) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.PERMIT_INTENT_MISMATCH,
        'PhysicalCallPermit does not authorize this CallIntent',
        { intent, permitIntent: record.intent },
      );
    }
    try {
      await this._reservationLedger.markDispatching({ workflowId: intent.workflowId, reservationId: record.reservationId });
    } catch (error) {
      // Fail closed: the durable "dispatch may begin" boundary could not be
      // persisted, so dispatchFn (the physical provider call) never runs.
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.RESERVATION_PERSIST_FAILED,
        `model spend reservation dispatch boundary could not be durably persisted: ${error?.message ?? error}`,
        { intent },
      );
    }
    record.consumed = true;
    record.consumedAt = Date.now();
    this._onEvent?.({ type: 'PERMIT_CONSUMED', ...intent });

    // The physical call itself is isolated from settlement bookkeeping below:
    // `outcome` captures success/failure WITHOUT yet deciding anything about
    // the reservation, so a settlement-persistence failure is never
    // misclassified as "the provider call failed" (and vice versa).
    let outcome;
    try {
      outcome = { ok: true, value: await dispatchFn() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const settlement = extractSettlementUsage(outcome);

    if (settlement.known) {
      try {
        await this._reservationLedger.settleKnown({
          workflowId: intent.workflowId,
          reservationId: record.reservationId,
          usageCallId: settlement.callId,
          usageReference: settlement.usage,
          reason: outcome.ok ? 'PROVIDER_CALL_SUCCEEDED' : 'PROVIDER_CALL_FAILED_WITH_KNOWN_USAGE',
        });
      } catch (persistError) {
        // Settlement persistence failure (§ Failure 2). The provider
        // physically ran and its usage WAS known, but the durable
        // SETTLED_KNOWN write itself failed — the ledger's own cache is
        // guaranteed to still read as DISPATCHING (see
        // ReservationLedger.settleKnown), which already blocks further
        // spend for this workflow. This is an orchestrator persistence
        // failure, never provider failure: it must never be classified as
        // a provider outcome, never trigger failover, and never mark the
        // provider unhealthy — it is thrown as an AuthorizationError,
        // exactly like every other Reservation fail-closed path, so the
        // generic failover mechanism (which only ever failsover on
        // provider/AdapterError outcomes) does not see it as one.
        throw new AuthorizationError(
          AUTHORIZATION_ERROR_CODES.MODEL_SPEND_SETTLEMENT_PERSIST_FAILED,
          `model spend settlement could not be durably persisted: ${persistError?.message ?? persistError}`,
          { intent, providerOutcome: outcome.ok ? 'SUCCESS' : 'FAILURE' },
        );
      }
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }

    // Usage was not reliably known — UNRESOLVED regardless of whether the
    // provider call itself succeeded or failed (§ Failure 1). A successful
    // functional result never implies the token spend was accounted for.
    await this._reservationLedger.markUnresolved({
      workflowId: intent.workflowId,
      reservationId: record.reservationId,
      reason: outcome.ok
        ? 'PROVIDER_CALL_SUCCEEDED_NO_RELIABLE_USAGE'
        : (outcome.error?.code ?? outcome.error?.message ?? 'USAGE_UNKNOWN_AFTER_DISPATCH'),
    });
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  // Test / diagnostics only.
  stats() {
    let issued = 0;
    let consumed = 0;
    for (const record of this._issued.values()) {
      issued += 1;
      if (record.consumed) consumed += 1;
    }
    return { issued, consumed, outstanding: issued - consumed };
  }
}
