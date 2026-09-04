// Token-Safety authorization boundary.
//
//   CallIntent -> ModelSpendAuthority.authorize() -> PhysicalCallPermit
//              -> ModelSpendAuthority.dispatch(permit, intent, fn)  [default-deny]
//              -> provider dispatch
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

// The strongest invocation identifiers mechanically available at the role
// runtime boundary. Missing semantic IDs are bound as null rather than
// invented — a permit issued with operationId:null still only matches another
// intent whose operationId is null.
export const CALL_INTENT_KEYS = Object.freeze(['role', 'family', 'provider', 'operationId', 'attempt']);

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
  constructor({ policy = () => ({ allow: true }), onEvent, providerCapabilities } = {}) {
    this._policy = policy;
    this._onEvent = onEvent;
    this._isExecutorEligible = providerCapabilities?.isExecutorEligible ?? productionIsExecutorEligible;
    this._issued = new Map(); // token -> { intent, consumed, consumedAt }
  }

  // CallIntent -> PhysicalCallPermit. Throws AuthorizationError (SPEND_DENIED /
  // INTENT_INCOMPLETE) before any permit exists if the intent is rejected.
  authorize(rawIntent) {
    const intent = normalizeCallIntent(rawIntent);
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
    const token = randomUUID();
    this._issued.set(token, { intent, consumed: false, consumedAt: null });
    this._onEvent?.({ type: 'PERMIT_ISSUED', ...intent });
    return new PhysicalCallPermit(token, intent);
  }

  // Default-deny protected dispatch. Runs `dispatchFn` (the real provider
  // call) ONLY when `permit` is a permit this authority issued, is not yet
  // consumed, and is bound to this exact CallIntent. The permit is consumed
  // BEFORE the dispatch fn runs, so a throwing / failing provider call can
  // never be retried on the same permit — the failover attempt must
  // authorize() again.
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
    record.consumed = true;
    record.consumedAt = Date.now();
    this._onEvent?.({ type: 'PERMIT_CONSUMED', ...intent });
    return dispatchFn();
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
