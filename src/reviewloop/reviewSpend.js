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
  MAX_REVIEWER_CALLS: 4,
  MAX_SUPERVISOR_CALLS: 2,
  MAX_EXTERNAL_REVIEW_TRIGGERS: 7,
});

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

// A deterministic aggregate ceiling policy over the ReviewLoop-owned usage
// tracker. Denies before a permit is minted, never estimates.
function createReviewLoopSpendPolicy({ limits, usage }) {
  return (intent) => {
    const totals = usage.totals();
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
}

class ReviewLoopUsage {
  constructor() {
    this._records = [];
  }

  record({ role, usage = null, costUsd = 0, model = null }) {
    const input = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const output = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    this._records.push({
      role,
      model,
      usageKnown: usage != null,
      usageVolume: input + output,
      costUsd: costUsd ?? 0,
      at: new Date().toISOString(),
    });
  }

  totals() {
    return this._records.reduce((acc, r) => ({
      reviewerCalls: acc.reviewerCalls + (r.role === 'reviewer' ? 1 : 0),
      supervisorCalls: acc.supervisorCalls + (r.role === 'supervisor' ? 1 : 0),
      usageVolume: acc.usageVolume + r.usageVolume,
      costUsd: acc.costUsd + r.costUsd,
      unknownUsageCalls: acc.unknownUsageCalls + (r.usageKnown ? 0 : 1),
    }), {
      reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0, unknownUsageCalls: 0,
    });
  }

  telemetry() {
    const t = this.totals();
    return {
      reviewerUsage: this._records.filter((r) => r.role === 'reviewer'),
      supervisorUsage: this._records.filter((r) => r.role === 'supervisor'),
      reviewerCalls: t.reviewerCalls,
      supervisorCalls: t.supervisorCalls,
      usageVolume: t.usageVolume,
      costUsd: t.costUsd,
      unknownUsageCalls: t.unknownUsageCalls,
      workerUsage: 'external / not observable by ReviewLoop',
    };
  }
}

// Build the ReviewLoop spend surface. `persistence` (optional) makes the
// reservation + information ledgers durable, keyed by loopId.
export function createReviewLoopSpend({
  loopId,
  persistence = null,
  env = process.env,
  onEvent,
  recordSafetyEvent,
} = {}) {
  const limits = resolveReviewLoopLimits(env);
  const usage = new ReviewLoopUsage();
  const reservationLedger = new ReservationLedger({
    store: persistence ? new ReservationStore(persistence) : null,
    onEvent,
    recordSafetyEvent,
  });
  const informationLedger = new NewInformationLedger({
    store: persistence ? new InformationStore(persistence) : null,
  });
  const authority = new ModelSpendAuthority({
    policy: createReviewLoopSpendPolicy({ limits, usage }),
    onEvent,
    reservationLedger,
    recordSafetyEvent,
    informationLedger,
  });

  async function registerEvidence({ kind, ...args }) {
    const wf = { workflowId: loopId, ...args };
    if (kind === 'diff') return registerTaskDiffEvidence(informationLedger, wf);
    if (kind === 'findings') return registerReviewFindingsEvidence(informationLedger, wf);
    if (kind === 'gate') return registerGateFingerprintEvidence(informationLedger, wf);
    if (kind === 'external') return registerExternalResultEvidence(informationLedger, wf);
    throw new Error(`unknown evidence kind ${kind}`);
  }

  // metered call: authorize -> dispatch -> settle. `call` returns
  // { value, usage?, costUsd?, model? }. UNRESOLVED usage throws from dispatch.
  async function meteredCall({
    role, family = 'agy:gpt-oss', provider = 'agy', operationId, attempt = 1, evidenceIds = [], call,
  }) {
    const intent = { role, family, provider, operationId: operationId ?? loopId, attempt, workflowId: loopId, evidenceIds };
    const permit = await authority.authorize(intent);
    const result = await authority.dispatch(permit, intent, async () => {
      const out = await call();
      return { value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null };
    });
    usage.record({ role, usage: result?.usage ?? null, costUsd: result?.costUsd ?? 0, model: result?.model ?? null });
    return result?.value ?? result;
  }

  return {
    limits,
    authority,
    reservationLedger,
    informationLedger,
    registerEvidence,
    meteredCall,
    telemetry: () => usage.telemetry(),
  };
}
