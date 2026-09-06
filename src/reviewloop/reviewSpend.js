// ReviewLoop Token Safety — scoped to ReviewLoop-owned model spend only.
//
// Active metered internal roles: Reviewer, Supervisor. (No Planner, no
// Executor — the Worker's own token usage is external and NOT observable by
// ReviewLoop; it is reported as "external / not observable", never as zero.)
//
// Preserved invariants:
//   UNKNOWN != ZERO
//   CallIntent -> authorize -> PhysicalCallPermit -> dispatch -> SETTLED_KNOWN | UNRESOLVED
//   NO NEW INFORMATION -> NO NEW MODEL CALL
//
// The aggregate ReviewLoop budget (call counts, usageVolume, costUsd) is
// DURABLE and keyed by loopId: it accumulates across every reviewloop_review
// round, across the Supervisor call, and across a process restart/resume. A
// crash after provider settlement but before controller state save can never
// reset the budget to zero — the durable reservation ledger is cross-checked
// on load and any settled/blocking reservation without a matching spend record
// is counted conservatively (call counted, usage UNKNOWN).
//
// External model spend (@codex review / @claude review) is NOT routed here —
// it crosses ExternalModelTriggerAuthority (prReviewController.js).

import { ModelSpendAuthority } from '../orchestrator/modelSpendAuthority.js';
import { ReservationLedger, ReservationStore } from '../orchestrator/modelSpendReservation.js';
import {
  NewInformationLedger,
  InformationStore,
  registerTaskDiffEvidence,
  registerReviewFindingsEvidence,
  registerGateFingerprintEvidence,
  registerExternalResultEvidence,
} from '../orchestrator/newInformation.js';

export const REVIEWLOOP_ENV = Object.freeze({
  MAX_COST_USD: 'REVIEWLOOP_MAX_COST_USD',
  MAX_USAGE_VOLUME: 'REVIEWLOOP_MAX_USAGE_VOLUME',
  MAX_REVIEW_ROUNDS: 'REVIEWLOOP_MAX_REVIEW_ROUNDS',
  MAX_REVIEWER_CALLS: 'REVIEWLOOP_MAX_REVIEWER_CALLS',
  MAX_SUPERVISOR_CALLS: 'REVIEWLOOP_MAX_SUPERVISOR_CALLS',
  MAX_EXTERNAL_REVIEW_TRIGGERS: 'REVIEWLOOP_MAX_EXTERNAL_REVIEW_TRIGGERS',
});

export const REVIEWLOOP_DEFAULTS = Object.freeze({
  MAX_COST_USD: 5,
  MAX_USAGE_VOLUME: 400_000,
  MAX_REVIEW_ROUNDS: 3,
  // One review round can legitimately need several physical Reviewer calls
  // when a large diff is deterministically chunked (each chunk is separately
  // metered / New-Information-gated). This is a coarse backstop; MAX_COST_USD
  // and MAX_USAGE_VOLUME are the real runaway guards. Default headroom is
  // (rounds) x (max chunks + 1).
  MAX_REVIEWER_CALLS: 3 * 13,
  MAX_SUPERVISOR_CALLS: 2,
  MAX_EXTERNAL_REVIEW_TRIGGERS: 7,
});

const SPEND_STATE_KEY = 'reviewLoopSpend';
const METERED_ROLES = new Set(['reviewer', 'supervisor']);

// Error codes that PROVE the physical provider call never reached the provider
// (spawn failure, transport unavailable, pre-send abort). For these — and only
// these — the token spend is mechanically, provably zero (the one carve-out
// modelSpendAuthority.js's extractSettlementUsage already recognises). The
// business error is still thrown so the caller can fail over.
const PRE_SEND_ZERO_CODES = new Set([
  'PROVIDER_UNAVAILABLE', 'ENOENT', 'AGY_BAD_INPUT', 'PROVIDER_NOT_STARTED',
]);

function num(env, key, fallback) {
  const raw = env?.[key];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveReviewLoopLimits(env = process.env) {
  return {
    maxCostUsd: num(env, REVIEWLOOP_ENV.MAX_COST_USD, REVIEWLOOP_DEFAULTS.MAX_COST_USD),
    maxUsageVolume: num(env, REVIEWLOOP_ENV.MAX_USAGE_VOLUME, REVIEWLOOP_DEFAULTS.MAX_USAGE_VOLUME),
    maxReviewRounds: num(env, REVIEWLOOP_ENV.MAX_REVIEW_ROUNDS, REVIEWLOOP_DEFAULTS.MAX_REVIEW_ROUNDS),
    maxReviewerCalls: num(env, REVIEWLOOP_ENV.MAX_REVIEWER_CALLS, REVIEWLOOP_DEFAULTS.MAX_REVIEWER_CALLS),
    maxSupervisorCalls: num(env, REVIEWLOOP_ENV.MAX_SUPERVISOR_CALLS, REVIEWLOOP_DEFAULTS.MAX_SUPERVISOR_CALLS),
    maxExternalReviewTriggers: num(
      env, REVIEWLOOP_ENV.MAX_EXTERNAL_REVIEW_TRIGGERS, REVIEWLOOP_DEFAULTS.MAX_EXTERNAL_REVIEW_TRIGGERS,
    ),
  };
}

// usageVolume = input + output + cache_creation_input + cache_read_input
// (whichever fields the provider telemetry reports). UNKNOWN != ZERO: a call
// with no usage object at all contributes 0 volume but is flagged
// usageKnown=false and still counts as a physical call.
export function usageVolumeOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const f = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (Number.isFinite(v)) return v;
    }
    return 0;
  };
  return f('input_tokens', 'inputTokens')
    + f('output_tokens', 'outputTokens')
    + f('cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_creation_input')
    + f('cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_input');
}

// Durable append-only spend log over the existing workflow-state snapshot,
// keyed by loopId. No parallel database.
export class ReviewLoopSpendStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return [];
    const state = await this._persistence.readWorkflowState(loopId);
    const raw = state?.[SPEND_STATE_KEY];
    return Array.isArray(raw?.records) ? raw.records : [];
  }

  async append(loopId, record) {
    if (!loopId || !this._persistence || typeof this._persistence.updateWorkflowState !== 'function') return;
    const existing = await this.load(loopId);
    await this._persistence.updateWorkflowState(loopId, {
      [SPEND_STATE_KEY]: { records: [...existing, record] },
    });
  }
}

function foldTotals(records) {
  return records.reduce((acc, r) => ({
    reviewerCalls: acc.reviewerCalls + (r.role === 'reviewer' ? 1 : 0),
    supervisorCalls: acc.supervisorCalls + (r.role === 'supervisor' ? 1 : 0),
    usageVolume: acc.usageVolume + (Number.isFinite(r.usageVolume) ? r.usageVolume : 0),
    costUsd: acc.costUsd + (Number.isFinite(r.costUsd) ? r.costUsd : 0),
    unknownUsageCalls: acc.unknownUsageCalls + (r.usageKnown ? 0 : 1),
  }), { reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0, unknownUsageCalls: 0 });
}

// Build the ReviewLoop spend surface. `persistence` (optional) makes the
// reservation + information + spend ledgers durable, keyed by loopId. Without
// it the surface is in-memory-only for the process (unit tests).
export function createReviewLoopSpend({
  loopId,
  persistence = null,
  env = process.env,
  onEvent,
  recordSafetyEvent,
} = {}) {
  const limits = resolveReviewLoopLimits(env);
  const spendStore = new ReviewLoopSpendStore(persistence);

  // Session-local records for calls made in THIS process; prior durable
  // records are loaded lazily and cached on first budget check.
  const sessionRecords = [];
  let priorRecords = null;

  const reservationLedger = new ReservationLedger({
    store: persistence ? new ReservationStore(persistence) : null,
    onEvent,
    recordSafetyEvent,
  });
  const informationLedger = new NewInformationLedger({
    store: persistence ? new InformationStore(persistence) : null,
  });

  // Promote any DISPATCHING reservation left behind by a crash to UNRESOLVED
  // so the very first authorize() this session blocks on it.
  let reconciled = false;
  async function ensureReconciled() {
    if (reconciled) return;
    reconciled = true;
    try { await reservationLedger.reconcileOnResume(loopId); } catch { /* best effort */ }
  }

  // Cross-check the durable reservation ledger against the durable spend log:
  // any SETTLED_KNOWN / blocking metered reservation with no matching spend
  // record (crash after settlement, before the spend-log append) is counted
  // conservatively — the call happened, its usage is UNKNOWN (never zero).
  async function loadPriorRecords() {
    if (priorRecords) return priorRecords;
    await ensureReconciled();
    const logged = await spendStore.load(loopId);
    let reservations = [];
    try { reservations = await reservationLedger.list(loopId); } catch { reservations = []; }
    const meteredReservations = reservations.filter((r) => METERED_ROLES.has(r.role ?? r.intent?.role));
    const reconciledRecords = [...logged];
    const settledCount = meteredReservations.filter((r) => r.status === 'SETTLED_KNOWN' || r.status === 'UNRESOLVED' || r.status === 'DISPATCHING').length;
    let missing = settledCount - logged.length;
    for (const r of meteredReservations) {
      if (missing <= 0) break;
      if (r.status === 'SETTLED_KNOWN' || r.status === 'UNRESOLVED' || r.status === 'DISPATCHING') {
        reconciledRecords.push({
          role: r.role ?? r.intent?.role ?? 'reviewer',
          model: null,
          usageKnown: false,
          usageVolume: 0,
          costUsd: 0,
          reconstructedFromReservation: true,
          at: r.settledAt ?? new Date().toISOString(),
        });
        missing -= 1;
      }
    }
    priorRecords = reconciledRecords;
    return priorRecords;
  }

  async function currentTotals() {
    const prior = await loadPriorRecords();
    return foldTotals([...prior, ...sessionRecords]);
  }

  // Aggregate deterministic ceiling policy. Runs inside authorize(), before a
  // permit is minted. Denies against the DURABLE aggregate (loaded and stashed
  // by meteredCall() immediately before authorize()), never a process-local
  // counter, and never estimates. meteredCall() is the only caller and issues
  // one authorize() at a time, so this closure var is never raced.
  let pendingTotals = { reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0 };
  const policy = (intent) => {
    const totals = pendingTotals;
    if (intent.role === 'reviewer' && totals.reviewerCalls >= limits.maxReviewerCalls) {
      return { allow: false, reason: `ReviewLoop reviewer call ceiling (${limits.maxReviewerCalls}) reached` };
    }
    if (intent.role === 'supervisor' && totals.supervisorCalls >= limits.maxSupervisorCalls) {
      return { allow: false, reason: `ReviewLoop supervisor call ceiling (${limits.maxSupervisorCalls}) reached` };
    }
    if (totals.usageVolume >= limits.maxUsageVolume) {
      return { allow: false, reason: `ReviewLoop usage-volume ceiling (${limits.maxUsageVolume}) reached` };
    }
    if (totals.costUsd >= limits.maxCostUsd) {
      return { allow: false, reason: `ReviewLoop cost ceiling ($${limits.maxCostUsd}) reached` };
    }
    return { allow: true };
  };

  const authority = new ModelSpendAuthority({
    policy, onEvent, reservationLedger, recordSafetyEvent, informationLedger,
  });

  async function registerEvidence({ kind, ...args }) {
    const wf = { workflowId: loopId, ...args };
    if (kind === 'diff') return registerTaskDiffEvidence(informationLedger, wf);
    if (kind === 'findings') return registerReviewFindingsEvidence(informationLedger, wf);
    if (kind === 'gate') return registerGateFingerprintEvidence(informationLedger, wf);
    if (kind === 'external') return registerExternalResultEvidence(informationLedger, wf);
    throw new Error(`unknown evidence kind ${kind}`);
  }

  // metered call: resolve durable aggregate -> authorize -> dispatch -> settle
  // -> durably append the spend record BEFORE returning. `call()` returns
  // { value, usage?, costUsd?, model? }. UNRESOLVED usage throws from dispatch.
  async function meteredCall({
    role, family = 'agy:gpt-oss', provider = 'agy', model = null,
    operationId, attempt = 1, evidenceIds = [], call,
  }) {
    pendingTotals = await currentTotals();
    const intent = {
      role, family, provider,
      operationId: operationId ?? loopId,
      attempt,
      workflowId: loopId,
      evidenceIds,
    };
    const permit = await authority.authorize(intent);
    const result = await authority.dispatch(permit, intent, async () => {
      let out;
      try {
        out = await call();
      } catch (err) {
        const code = err?.code ?? err?.providerFailure ?? '';
        if (PRE_SEND_ZERO_CODES.has(code) && !(err?.details?.usage) && !err?.usage) {
          // Mechanically zero — attach it so the reservation settles KNOWN and
          // the business error is re-thrown normally for failover.
          err.details = { ...(err.details ?? {}), usage: { input_tokens: 0, output_tokens: 0 } };
        }
        throw err;
      }
      return {
        value: out?.value ?? out,
        usage: out?.usage ?? null,
        model: out?.model ?? model ?? null,
        costUsd: Number.isFinite(out?.costUsd) ? out.costUsd : 0,
      };
    });
    const record = {
      role,
      model: result?.model ?? model ?? null,
      usageKnown: result?.usage != null,
      usageVolume: usageVolumeOf(result?.usage),
      costUsd: Number.isFinite(result?.costUsd) ? result.costUsd : 0,
      at: new Date().toISOString(),
    };
    // Durable-before-return: the aggregate must reflect this call even if the
    // controller crashes before it saves loop state.
    await spendStore.append(loopId, record);
    sessionRecords.push(record);
    return result?.value ?? result;
  }

  async function telemetry() {
    const t = await currentTotals();
    return {
      reviewerCalls: t.reviewerCalls,
      supervisorCalls: t.supervisorCalls,
      usageVolume: t.usageVolume,
      costUsd: t.costUsd,
      unknownUsageCalls: t.unknownUsageCalls,
      limits,
      workerUsage: 'external / not observable by ReviewLoop',
    };
  }

  return {
    limits,
    authority,
    reservationLedger,
    informationLedger,
    registerEvidence,
    meteredCall,
    currentTotals,
    telemetry,
  };
}
