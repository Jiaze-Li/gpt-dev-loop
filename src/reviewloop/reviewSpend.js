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
import { AuthorizationError, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../orchestrator/errors.js';
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
  MAX_SINGLE_CALL_USAGE: 'REVIEWLOOP_MAX_SINGLE_CALL_USAGE',
  MAX_CONTEXT_OVERHEAD_TOKENS: 'REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS',
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
  // The Supervisor is invoked at most ONCE per loop (controller guards on
  // supervisorInvoked), but that single invocation drives automatic
  // provider failover across the whole Supervisor pool. This ceiling must
  // therefore be >= the Supervisor pool candidate count (currently 4:
  // agy:gemini, codex:default, agy:sonnet, claude:opus) so the tail candidate
  // stays mechanically reachable when every earlier one fails safely.
  // MAX_COST_USD / MAX_USAGE_VOLUME remain the real runaway guards.
  MAX_SUPERVISOR_CALLS: 4,
  MAX_EXTERNAL_REVIEW_TRIGGERS: 7,
  // ---- post-settlement single-call Token Sentinel -------------------------
  // A runaway guard for ONE physical call: the durable aggregate ceilings
  // (MAX_USAGE_VOLUME / MAX_COST_USD) only fire once the running total crosses
  // the line, so a single call that suddenly balloons (10k running total -> a
  // 150k call) has already spent the 150k before the aggregate would block the
  // NEXT call. The Sentinel is POST-settlement: it cannot un-spend the
  // anomalous call, it fully accounts it, records a BLOCKING safety event, and
  // latches the loop so every further Reviewer/Supervisor model call fails
  // closed (across a restart). See createReviewLoopSpend / maybeTripSentinel.
  MAX_SINGLE_CALL_USAGE: 40_000,
  MAX_CONTEXT_OVERHEAD_TOKENS: 30_000,
});

// Env overrides for the Token Sentinel are clamped to (0, HARD_CAP]: an
// illegal value (non-finite, <= 0, unparseable) falls back to the default and
// NEVER disables the protection, and a value above the hard cap is clamped so
// a misconfiguration cannot effectively turn the ceiling into infinity.
export const TOKEN_SENTINEL_HARD_CAPS = Object.freeze({
  MAX_SINGLE_CALL_USAGE: 250_000,
  MAX_CONTEXT_OVERHEAD_TOKENS: 200_000,
});

const SPEND_STATE_KEY = 'reviewLoopSpend';
// Durable, restart-surviving latch for the post-settlement Token Sentinel.
// One record per loop; once written with `tripped: true` every further metered
// call in the loop is refused at the authorization stage.
const TOKEN_ANOMALY_STATE_KEY = 'reviewLoopTokenAnomaly';
const METERED_ROLES = new Set(['reviewer', 'supervisor']);

// Error codes that PROVE the physical provider call never reached the provider
// (spawn failure, transport unavailable, pre-send abort / bad input). For these
// — and only these — the token spend is mechanically, provably zero. A
// mechanically-zero attempt STILL settles the reservation SETTLED_KNOWN and
// STILL writes a durable accounting record (usage 0); the business error is
// re-thrown so the caller can fail over, and a normal failover therefore never
// leaves a settled reservation without a matching spend record (no false
// "unaccounted spend" block after a restart). Unified across the agy transport
// (AGY_ENOENT / AGY_SPAWN_FAILED / AGY_BAD_INPUT) and the generic pool.
// PROVIDER_AUTH_FAILED is mechanically pre-send zero: a CLI transport rejected
// at its own auth check (`codex` / `claude` not logged in, no/invalid API key)
// or the provider API returned 401/403 at the auth boundary — no prompt was
// ever billed. The `!err.usage` guard in isMechanicallyZeroPreSend still
// excludes any (impossible-by-construction) case where a transport attached
// real usage alongside an auth error.
export const PRE_SEND_ZERO_CODES = new Set([
  'PROVIDER_UNAVAILABLE', 'PROVIDER_NOT_STARTED', 'PROVIDER_AUTH_FAILED',
  'ENOENT', 'AGY_ENOENT', 'AGY_SPAWN_FAILED', 'AGY_BAD_INPUT',
]);

export function isMechanicallyZeroPreSend(err) {
  const code = err?.code ?? err?.providerFailure ?? '';
  return PRE_SEND_ZERO_CODES.has(code) && !err?.details?.usage && !err?.usage;
}

function num(env, key, fallback) {
  const raw = env?.[key];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Token Sentinel threshold: positive-finite env override, clamped to a hard
// cap. An illegal value can never DISABLE the protection (it falls back to the
// default) and can never be inflated past the hard cap.
function boundedThreshold(env, key, fallback, hardCap) {
  const raw = env?.[key];
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, hardCap);
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
    maxSingleCallUsage: boundedThreshold(
      env, REVIEWLOOP_ENV.MAX_SINGLE_CALL_USAGE,
      REVIEWLOOP_DEFAULTS.MAX_SINGLE_CALL_USAGE, TOKEN_SENTINEL_HARD_CAPS.MAX_SINGLE_CALL_USAGE,
    ),
    maxContextOverheadTokens: boundedThreshold(
      env, REVIEWLOOP_ENV.MAX_CONTEXT_OVERHEAD_TOKENS,
      REVIEWLOOP_DEFAULTS.MAX_CONTEXT_OVERHEAD_TOKENS, TOKEN_SENTINEL_HARD_CAPS.MAX_CONTEXT_OVERHEAD_TOKENS,
    ),
  };
}

// ---- provider/family-aware token accounting --------------------------------
//
// `usageVolume` is the HARD safety ceiling (REVIEWLOOP_MAX_USAGE_VOLUME), so it
// MUST NOT double-count. Cache semantics differ per provider family:
//
//   OpenAI / Codex : `cached` (a.k.a. cache_read) tokens are a SUBSET of the
//                    input/prompt tokens, and reasoning tokens are a subset of
//                    output. `input + output + cache_read` bills the cached
//                    prefix twice. Codex live evidence: input 16922
//                    (cache_read 10624 of it) + output 9 -> volume 16931.
//   Anthropic      : cache_creation and cache_read are SEPARATE billing
//                    categories from uncached input; thinking is already inside
//                    output. All three input categories add.
//   AGY (Gemini /  : the CLI surfaces a provider-reported authoritative total
//   gpt-oss)         that is the source of truth (Gemini live: input 6713 +
//                    output 539 == reported total 7252; cache_read 8128 is NOT
//                    additive and is not even mechanically a subset of input).
//
// Precedence for every family:
//   1. an authoritative provider-reported total, ONLY from a token-total field
//      mechanically confirmed for THIS provider/family schema -> use it verbatim
//   2. else a family-specific deterministic fallback (semantics confirmed) —
//      reported semanticsKnown:true ONLY when every field that fallback
//      mechanically requires is actually present. A required field that is
//      absent is UNKNOWN, never 0: the accounting is marked volumeResolved:false
//      and the caller routes it into the existing UNRESOLVED / fail-closed
//      spend path (it must not settle as precise known spend).
//   3. else a conservative additive sum, FLAGGED semanticsKnown:false —
//      UNKNOWN != ZERO: never under-count a safety ceiling, never pretend the
//      number is an exact provider figure. This is the accepted floor-safe
//      posture for AGY-without-total / unknown providers (volumeResolved:true,
//      but explicitly not exact).
//
// The raw per-field breakdown is ALWAYS preserved for telemetry regardless of
// which method produced the volume.

const ACCOUNTING_CLASS_BY_FAMILY = Object.freeze({
  'codex:default': 'openai',
  'claude:opus': 'anthropic',
  'agy:gemini': 'agy',
  'agy:gpt-oss': 'agy',
  'agy:sonnet': 'agy',
});

const ACCOUNTING_CLASS_BY_PROVIDER = Object.freeze({
  codex: 'openai',
  openai: 'openai',
  claude: 'anthropic',
  anthropic: 'anthropic',
  'agy-gemini': 'agy',
  'agy-gpt-oss': 'agy',
  'agy-claude-gpt': 'agy',
  agy: 'agy',
});

// Token-total field names that are MECHANICALLY CONFIRMED to be an authoritative
// aggregate token total for a given accounting class. A bare `total` is never
// trusted; an unknown provider has no trusted total field at all.
//   - openai   : OpenAI usage envelopes / Codex `token_count` events -> total_tokens
//   - anthropic: the Anthropic Messages API returns NO aggregate token total
//                (only input/output/cache_* categories) -> always fall through
//   - agy      : the AGY CLI envelope surfaces a provider total (Gemini live:
//                input 6713 + output 539 == 7252); Gemini-native is
//                totalTokenCount
const AUTHORITATIVE_TOTAL_ALIASES = Object.freeze({
  openai: ['total_tokens', 'totalTokens'],
  anthropic: [],
  agy: ['total_tokens', 'totalTokens', 'total_token_count', 'totalTokenCount'],
  unknown: [],
});

function pickFinite(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Deterministic accounting class from the ACTUAL family/provider bound into the
// CallIntent — never guessed from a model-name string.
export function accountingClassOf({ family = null, provider = null } = {}) {
  if (typeof family === 'string' && ACCOUNTING_CLASS_BY_FAMILY[family]) {
    return ACCOUNTING_CLASS_BY_FAMILY[family];
  }
  if (typeof provider === 'string') {
    const p = provider.toLowerCase();
    if (ACCOUNTING_CLASS_BY_PROVIDER[p]) return ACCOUNTING_CLASS_BY_PROVIDER[p];
    if (p.startsWith('agy')) return 'agy';
    if (p.startsWith('codex') || p.startsWith('openai')) return 'openai';
    if (p.startsWith('claude') || p.startsWith('anthropic')) return 'anthropic';
  }
  return 'unknown';
}

// Raw provider usage fields, null (never 0) when unreported.
function rawUsageFields(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: null, outputTokens: null, thinkingTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null, reportedTotalTokens: null,
    };
  }
  const g = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  return {
    inputTokens: g('input_tokens', 'inputTokens', 'prompt_tokens'),
    outputTokens: g('output_tokens', 'outputTokens', 'completion_tokens'),
    thinkingTokens: g(
      'thinking_tokens', 'thinkingTokens', 'reasoning_tokens', 'reasoningTokens',
      'thoughts_token_count', 'thoughtsTokenCount',
    ),
    cacheReadTokens: g(
      'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_input', 'cache_read_tokens',
      'cached_input_tokens', 'cached_content_token_count', 'cachedContentTokenCount',
    ),
    cacheCreationTokens: g(
      'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_creation_input', 'cache_creation_tokens',
    ),
    reportedTotalTokens: g(
      'total_tokens', 'totalTokens', 'total', 'total_token_count', 'totalTokenCount',
    ),
  };
}

const tok = (v) => (Number.isFinite(v) ? v : 0);

// Provider/family-aware deterministic accounting. Returns the budget
// `usageVolume`, the method used to derive it, whether the cache semantics are
// mechanically confirmed for this family (`semanticsKnown`), whether a
// mechanically-precise volume could actually be computed from the reported
// fields (`volumeResolved` — false means a required field was absent and the
// caller must fail closed, NOT treat the gap as 0), the authoritative provider
// total actually trusted (or null), and the raw breakdown. Callers MUST pass
// the real family + provider bound into the CallIntent.
export function usageAccountingOf({ usage = null, family = null, provider = null } = {}) {
  const cls = accountingClassOf({ family, provider });
  const b = rawUsageFields(usage);
  const has = usage != null && typeof usage === 'object';
  const build = (usageVolume, method, semanticsKnown, volumeResolved, trustedTotal = null) => ({
    usageVolume,
    usageAccountingMethod: method,
    semanticsKnown,
    volumeResolved,
    accountingClass: cls,
    // the total actually TRUSTED for the volume (null unless method is
    // provider_total from a confirmed alias)
    reportedTotalTokens: Number.isFinite(trustedTotal) ? trustedTotal : null,
    // raw diagnostic: any total-ish field the envelope carried, trusted or not
    rawReportedTotalField: b.reportedTotalTokens,
    breakdown: b,
  });

  if (!has) return build(0, 'no_usage_reported', false, false);

  // 1. authoritative provider-reported total — ONLY from a token-total field
  //    mechanically confirmed for this provider/family schema. An unknown
  //    provider (or a bare `total`) never reaches this branch.
  const trustedTotal = pickFinite(usage, AUTHORITATIVE_TOTAL_ALIASES[cls] ?? []);
  if (Number.isFinite(trustedTotal)) {
    return build(trustedTotal, 'provider_total', true, true, trustedTotal);
  }

  // 2. family-specific deterministic fallback. `semanticsKnown` / `volumeResolved`
  //    are true ONLY when every field the fallback mechanically requires is
  //    actually present — an absent required field is UNKNOWN, never 0.
  if (cls === 'openai') {
    // OpenAI/Codex: cache_read ⊂ input, reasoning ⊂ output — add neither.
    // Required: input_tokens AND output_tokens.
    const resolved = Number.isFinite(b.inputTokens) && Number.isFinite(b.outputTokens);
    return build(
      tok(b.inputTokens) + tok(b.outputTokens),
      'openai_input_plus_output', resolved, resolved,
    );
  }
  if (cls === 'anthropic') {
    // Anthropic: uncached input + output + the two SEPARATE cache categories.
    // The Messages API always emits input_tokens + output_tokens; the two
    // cache_* categories appear iff prompt caching was used and their absence
    // is a schema-defined 0 (not "unknown"). A missing input/output means the
    // envelope is incomplete.
    const resolved = Number.isFinite(b.inputTokens) && Number.isFinite(b.outputTokens);
    return build(
      tok(b.inputTokens) + tok(b.outputTokens) + tok(b.cacheCreationTokens) + tok(b.cacheReadTokens),
      'anthropic_cache_additive', resolved, resolved,
    );
  }

  // 3. AGY without a confirmed total, or a fully unknown provider: we cannot
  //    prove whether cache_read is a subset or a separate category. Sum every
  //    reported field (conservative — never under-count a safety ceiling) and
  //    flag the semantics UNKNOWN. This is the ACCEPTED floor-safe posture for
  //    these families, so volumeResolved stays true (the number is usable as a
  //    ceiling input, just never asserted as exact).
  return build(
    tok(b.inputTokens) + tok(b.outputTokens) + tok(b.thinkingTokens)
      + tok(b.cacheCreationTokens) + tok(b.cacheReadTokens),
    'conservative_additive_unknown', false, true,
  );
}

// True when a post-dispatch usage object IS present but the confirmed accounting
// method for this family cannot derive a mechanically-known volume from it
// (a required field is absent). UNKNOWN != ZERO: such a call must settle
// UNRESOLVED, exactly like a missing usage object.
export function usagePresentButUnresolved({ usage, family, provider }) {
  if (usage == null || typeof usage !== 'object') return false;
  return usageAccountingOf({ usage, family, provider }).volumeResolved === false;
}

// Back-compat helper: the budget volume alone. Pass { family, provider } for
// provider-aware accounting; without them the conservative additive path is
// used (UNKNOWN != ZERO, may over-count — never silently under-count).
export function usageVolumeOf(usage, { family = null, provider = null } = {}) {
  return usageAccountingOf({ usage, family, provider }).usageVolume;
}

// Compact provenance persisted on every durable spend record: given a later
// `usageVolume`, this says exactly how it was derived.
export function accountingProvenanceOf(accounting) {
  return {
    method: accounting.usageAccountingMethod,
    semanticsKnown: accounting.semanticsKnown === true,
    volumeResolved: accounting.volumeResolved === true,
    accountingClass: accounting.accountingClass,
    // the token total actually TRUSTED for usageVolume (null unless method is
    // provider_total from a confirmed alias for this family)
    reportedTotalTokens: Number.isFinite(accounting.reportedTotalTokens)
      ? accounting.reportedTotalTokens
      : null,
  };
}

// Provider-reported usage broken out per field. UNKNOWN != ZERO: a field the
// provider did not report is `null`, never 0. Persisted per physical call so
// transport-context overhead ("diff 20k chars, yet input 120k tokens") is
// diagnosable after the fact — never estimated into a hard number.
//   - `reportedTotalTokens` : STRICTLY a total-ish field the provider put in the
//                             envelope (null if none). NOT necessarily the
//                             authoritative total for this family (see
//                             usageAccountingOf / AUTHORITATIVE_TOTAL_ALIASES),
//                             and NOT necessarily equal to usageVolume.
//   - `rawFieldSumTokens`   : a DIAGNOSTIC arithmetic sum of the raw numeric
//                             usage fields. It is NOT a token-accounting total,
//                             double-counts cache for subset-semantics
//                             providers, and must never be read as usageVolume.
export function usageBreakdownOf(usage) {
  const b = rawUsageFields(usage);
  const parts = [b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheCreationTokens]
    .filter((v) => Number.isFinite(v));
  return {
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    thinkingTokens: b.thinkingTokens,
    cacheReadTokens: b.cacheReadTokens,
    cacheCreationTokens: b.cacheCreationTokens,
    reportedTotalTokens: b.reportedTotalTokens,
    rawFieldSumTokens: parts.length ? parts.reduce((a, c) => a + c, 0) : null,
  };
}

// Mechanical payload-size metadata for a review/supervise physical call. Only
// lengths and machine metadata — never prompt text. `estimatedPayloadTokens`
// is a deliberately coarse chars/4 proxy so a caller can compare it to the
// provider's reported input token count and see transport context tax.
export function payloadMetaOf(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  const promptChars = n(meta.promptChars);
  const out = {
    promptChars,
    diffChars: n(meta.diffChars),
    reviewPayloadChars: n(meta.reviewPayloadChars ?? meta.promptChars),
    estimatedPayloadTokens: Number.isFinite(promptChars) ? Math.round(promptChars / 4) : null,
  };
  return out;
}

// input tokens the provider billed that are NOT explained by the payload we
// sent — the transport context tax (system prompt, tools, workspace preload).
// null when either side is UNKNOWN; never negative.
export function contextOverheadTokens(breakdown, payloadMeta) {
  const input = breakdown?.inputTokens;
  const est = payloadMeta?.estimatedPayloadTokens;
  if (!Number.isFinite(input) || !Number.isFinite(est)) return null;
  return Math.max(0, input - est);
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

// Durable latch for the post-settlement Token Sentinel, over the same
// workflow-state snapshot. Read on every metered call so the block survives a
// process restart; written exactly once, when the anomaly is first detected.
export class ReviewLoopTokenAnomalyStore {
  constructor(persistence) {
    this._persistence = persistence;
  }

  async load(loopId) {
    if (!loopId || !this._persistence || typeof this._persistence.readWorkflowState !== 'function') return null;
    const state = await this._persistence.readWorkflowState(loopId);
    const raw = state?.[TOKEN_ANOMALY_STATE_KEY];
    return raw && raw.tripped === true ? raw : null;
  }

  // Returns { persisted } — `persisted:true` ONLY when the latch is durably on
  // record (freshly written, or already present). `persisted:false` means no
  // durable store is backing this call: a bare in-memory surface (fine — the
  // whole surface is ephemeral), OR a persistence object that does not
  // implement the workflow-state interface (a misconfiguration the caller must
  // fail closed on).
  async latch(loopId, record) {
    if (!loopId || !this._persistence) return { persisted: false, backed: false };
    if (typeof this._persistence.updateWorkflowState !== 'function'
      || typeof this._persistence.readWorkflowState !== 'function') {
      return { persisted: false, backed: false };
    }
    // First write wins: never overwrite the record of the ORIGINAL anomaly.
    const existing = await this.load(loopId);
    if (existing) return { persisted: true, backed: true };
    await this._persistence.updateWorkflowState(loopId, { [TOKEN_ANOMALY_STATE_KEY]: record });
    return { persisted: true, backed: true };
  }
}

// Post-settlement Token Sentinel decision. Runs ONLY against a call whose usage
// settled reliably (`volumeResolved === true`) — an UNKNOWN / unresolved usage
// keeps the existing UNRESOLVED fail-closed path and is never guessed at here.
// Returns null (no anomaly) or the trip detail.
export function detectSingleCallTokenAnomaly({ accounting, contextOverhead, limits }) {
  if (!accounting || accounting.volumeResolved !== true) return null;
  const usageVolume = Number.isFinite(accounting.usageVolume) ? accounting.usageVolume : null;
  const overhead = Number.isFinite(contextOverhead) ? contextOverhead : null;
  const usageTrip = usageVolume != null && usageVolume > limits.maxSingleCallUsage;
  const overheadTrip = overhead != null && overhead > limits.maxContextOverheadTokens;
  if (!usageTrip && !overheadTrip) return null;
  return {
    trigger: usageTrip ? 'SINGLE_CALL_USAGE' : 'CONTEXT_OVERHEAD',
    usageVolume,
    contextOverheadTokens: overhead,
    threshold: usageTrip ? limits.maxSingleCallUsage : limits.maxContextOverheadTokens,
  };
}

function foldTotals(records) {
  return records.reduce((acc, r) => ({
    reviewerCalls: acc.reviewerCalls + (r.role === 'reviewer' ? 1 : 0),
    supervisorCalls: acc.supervisorCalls + (r.role === 'supervisor' ? 1 : 0),
    usageVolume: acc.usageVolume + (Number.isFinite(r.usageVolume) ? r.usageVolume : 0),
    // Sum of KNOWN dollar cost only. A call whose provider reported no cost
    // contributes 0 to the sum but increments unknownCostCalls — the dollar
    // figure is then a lower bound, never asserted as the true spend.
    costUsd: acc.costUsd + (r.costKnown !== false && Number.isFinite(r.costUsd) ? r.costUsd : 0),
    unknownUsageCalls: acc.unknownUsageCalls + (r.usageKnown ? 0 : 1),
    unknownCostCalls: acc.unknownCostCalls + (r.costKnown === false ? 1 : 0),
    // A call whose usage WAS reported but whose cache semantics could not be
    // mechanically confirmed for its provider family — its usageVolume is a
    // conservative additive over-count, not an exact provider figure.
    unknownSemanticsCalls: acc.unknownSemanticsCalls
      + (r.usageKnown && r.usageAccounting && r.usageAccounting.semanticsKnown === false ? 1 : 0),
  }), {
    reviewerCalls: 0, supervisorCalls: 0, usageVolume: 0, costUsd: 0,
    unknownUsageCalls: 0, unknownCostCalls: 0, unknownSemanticsCalls: 0,
  });
}

// Aggregate provider usage breakdown + payload/overhead metadata across all
// durable spend records. A field only sums where it was actually reported;
// `*Unknown` counts the calls where it was not (UNKNOWN != 0).
function foldBreakdown(records) {
  const F = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reportedTotalTokens', 'rawFieldSumTokens'];
  const sums = Object.fromEntries(F.map((k) => [k, 0]));
  const unknown = Object.fromEntries(F.map((k) => [`${k}Unknown`, 0]));
  let promptChars = 0;
  let diffChars = 0;
  let estimatedPayloadTokens = 0;
  let contextOverheadTokens = 0;
  let contextOverheadKnownCalls = 0;
  for (const r of records) {
    const b = r.usageBreakdown ?? {};
    for (const k of F) {
      if (Number.isFinite(b[k])) sums[k] += b[k];
      else unknown[`${k}Unknown`] += 1;
    }
    const p = r.payloadMeta ?? {};
    if (Number.isFinite(p.promptChars)) promptChars += p.promptChars;
    if (Number.isFinite(p.diffChars)) diffChars += p.diffChars;
    if (Number.isFinite(p.estimatedPayloadTokens)) estimatedPayloadTokens += p.estimatedPayloadTokens;
    if (Number.isFinite(r.contextOverheadTokens)) {
      contextOverheadTokens += r.contextOverheadTokens;
      contextOverheadKnownCalls += 1;
    }
  }
  return {
    ...sums, ...unknown,
    promptChars, diffChars, estimatedPayloadTokens,
    contextOverheadTokens, contextOverheadKnownCalls,
  };
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
  const anomalyStore = new ReviewLoopTokenAnomalyStore(persistence);

  // Post-settlement Token Sentinel latch. Once tripped it is cached (a latch
  // never un-trips), and it is also set in-process the moment maybeTripSentinel
  // fires so a persistence-less (unit-test) surface still blocks the next call.
  // A CLEAN result is deliberately NOT cached: the durable latch is re-read on
  // every metered call, so a latch written after this surface's first read
  // (a crash-recovered sibling, a prior round on a shared loopId) still blocks
  // — a stale "clean" cache must never outrank a durable latch.
  let anomalyLatched = null;

  // Raw read. THROWS on a durable-read failure — the caller must fail closed:
  // "cannot read the latch" is never "no anomaly".
  async function readAnomaly() {
    if (anomalyLatched) return anomalyLatched;
    let loaded;
    try {
      loaded = await anomalyStore.load(loopId);
    } catch (error) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
        `single-call token anomaly latch could not be read: ${error?.message ?? error}`,
        { loopId },
      );
    }
    if (loaded) anomalyLatched = loaded;
    return anomalyLatched || null;
  }

  // Best-effort variant for telemetry / diagnostics: never throws.
  async function loadAnomaly() {
    try { return await readAnomaly(); } catch { return null; }
  }

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

  // Cross-check the durable reservation ledger against the durable spend log.
  // A physical metered call ALWAYS reserves+dispatches+settles durably in the
  // reservation ledger; its usage/cost numbers live ONLY in the spend log,
  // written durably-before-return. So:
  //
  //   settled/blocking metered reservations  >  spend-log records
  //     => at least one physical call whose real usage AND cost were lost to a
  //        crash between settlement and the spend-log append.
  //
  // UNKNOWN != ZERO: we do NOT substitute 0 and keep spending. `unaccounted`
  // is a fail-closed condition — every subsequent metered call is refused
  // until a human acknowledges it (REVIEWLOOP_ACK_UNACCOUNTED_SPEND). The
  // reconstructed records are kept only so telemetry can show WHY.
  let cachedUnaccounted = 0;
  async function loadPriorRecords() {
    if (priorRecords) return priorRecords;
    await ensureReconciled();
    const logged = await spendStore.load(loopId);
    let reservations = [];
    try { reservations = await reservationLedger.list(loopId); } catch { reservations = []; }
    const meteredReservations = reservations.filter((r) => METERED_ROLES.has(r.role ?? r.intent?.role));
    const reconciledRecords = [...logged];
    // An UNRESOLVED / DISPATCHING reservation is already a blocking condition
    // that ModelSpendAuthority.authorize() enforces (hasUnresolved). Here we
    // only look for SETTLED_KNOWN calls whose durable accounting record was
    // lost to a crash between settlement and the spend-log append.
    //
    // Every metered attempt — success, known-usage failure, OR mechanically-
    // zero pre-send failure — now writes a spend-log record tagged with its
    // reservationId, so a NORMAL failover never shows up here. An orphan is a
    // SETTLED_KNOWN reservation with no spend-log record carrying its id.
    const settled = meteredReservations.filter((r) => r.status === 'SETTLED_KNOWN');
    const loggedIds = new Set(logged.map((rec) => rec.reservationId).filter(Boolean));
    const idTrackingActive = logged.length === 0 || loggedIds.size > 0;

    let orphans;
    if (idTrackingActive) {
      orphans = settled.filter((r) => !loggedIds.has(r.reservationId));
    } else {
      // Legacy spend log written before reservationId tagging — fall back to a
      // count comparison.
      const gap = settled.length - logged.length;
      orphans = gap > 0 ? settled.slice(0, gap) : [];
    }
    cachedUnaccounted = orphans.length;
    for (const r of orphans) {
      reconciledRecords.push({
        role: r.role ?? r.intent?.role ?? 'reviewer',
        model: null,
        usageKnown: false,
        usageVolume: 0,
        costUsd: 0,
        reservationId: r.reservationId ?? null,
        reconstructedFromReservation: true,
        at: r.settledAt ?? new Date().toISOString(),
      });
    }
    priorRecords = reconciledRecords;
    return priorRecords;
  }

  function unaccountedAcknowledged() {
    const ack = env?.REVIEWLOOP_ACK_UNACCOUNTED_SPEND;
    return ack === '1' || ack === 'true' || ack === loopId;
  }

  async function hasUnaccountedSpend() {
    await loadPriorRecords();
    return cachedUnaccounted > 0 && !unaccountedAcknowledged();
  }

  async function currentTotals() {
    const prior = await loadPriorRecords();
    return {
      ...foldTotals([...prior, ...sessionRecords]),
      unaccountedSpendCalls: cachedUnaccounted,
    };
  }

  // Post-settlement single-call Token Sentinel. Called AFTER the anomalous
  // call's durable accounting record has already been appended, so the real
  // usage is fully accounted (never treated as 0). On a trip it:
  //   - durably latches the anomaly for the loop (survives a restart),
  //   - records a BLOCKING MODEL_SPEND_TOKEN_ANOMALY safety event,
  //   - throws MODEL_SPEND_TOKEN_ANOMALY_BLOCKED (an AuthorizationError, so the
  //     controller performs ZERO failover and never mutates provider
  //     health/quota — it is not disguised as a provider failure).
  async function maybeTripSentinel({
    role, family, provider, resolvedModel, accounting, contextOverhead,
  }) {
    const hit = detectSingleCallTokenAnomaly({ accounting, contextOverhead, limits });
    if (!hit) return;
    const reason = hit.trigger === 'SINGLE_CALL_USAGE'
      ? `single physical ${role} call usageVolume ${hit.usageVolume} exceeds `
        + `REVIEWLOOP_MAX_SINGLE_CALL_USAGE (${limits.maxSingleCallUsage})`
      : `single physical ${role} call transport context overhead ${hit.contextOverheadTokens} `
        + `tokens exceeds REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS (${limits.maxContextOverheadTokens})`;
    const actionTaken = 'anomalous call fully accounted; anomaly latched durably; all further '
      + 'ReviewLoop Reviewer/Supervisor model spend for this loop is blocked (no auto-failover, '
      + 'provider health/quota untouched) until a human clears it';
    const record = Object.freeze({
      tripped: true,
      at: new Date().toISOString(),
      role,
      family: family ?? null,
      provider: provider ?? null,
      resolvedModel: resolvedModel ?? null,
      usageVolume: hit.usageVolume,
      contextOverheadTokens: hit.contextOverheadTokens,
      trigger: hit.trigger,
      threshold: hit.threshold,
      thresholds: {
        maxSingleCallUsage: limits.maxSingleCallUsage,
        maxContextOverheadTokens: limits.maxContextOverheadTokens,
      },
      reason,
      actionTaken,
    });
    anomalyLatched = record;
    // A surface constructed WITH a persistence MUST latch durably (a restart
    // would otherwise lose the block); a bare in-memory surface has no durable
    // state at all and the in-process latch is its whole contract.
    const durableSurface = Boolean(persistence);
    let latchPersisted = true;
    let latchError = null;
    try {
      const res = await anomalyStore.latch(loopId, record);
      if (durableSurface && res?.persisted !== true) latchPersisted = false;
    } catch (error) {
      // The in-process latch (anomalyLatched) already blocks this process, but a
      // restart would lose it. Do NOT swallow: surface it as its own
      // fail-closed authorization error below so the loss of durability is
      // loud, not silent.
      latchPersisted = false;
      latchError = error;
    }
    recordSafetyEvent?.({
      code: 'MODEL_SPEND_TOKEN_ANOMALY',
      severity: 'BLOCKING',
      role,
      family: record.family,
      provider: record.provider,
      resolvedModel: record.resolvedModel,
      usageVolume: record.usageVolume,
      contextOverheadTokens: record.contextOverheadTokens,
      trigger: record.trigger,
      threshold: record.threshold,
      thresholds: record.thresholds,
      durablyLatched: latchPersisted,
      reason,
      actionTaken,
    });
    onEvent?.({ type: 'MODEL_SPEND_TOKEN_ANOMALY', loopId, durablyLatched: latchPersisted, ...record });
    if (!latchPersisted) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_STATE_UNAVAILABLE,
        `single-call token anomaly detected (${reason}) but the durable latch could not be `
          + `persisted (${latchError ? (latchError.message ?? latchError) : 'the configured persistence does not implement durable workflow state'}); `
          + 'this process is blocked; a restart is NOT guaranteed to stay blocked by this latch alone',
        { loopId, anomaly: record },
      );
    }
    throw new AuthorizationError(
      AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED,
      `${reason}; the call was fully accounted but further internal model spend for `
        + `${JSON.stringify(loopId)} is blocked until a human clears the token anomaly`,
      { loopId, anomaly: record },
    );
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
    // usageVolume is the HARD runaway guard — it is provider-reported token
    // volume and UNKNOWN volume already counts as a physical call elsewhere.
    if (totals.usageVolume >= limits.maxUsageVolume) {
      return { allow: false, reason: `ReviewLoop usage-volume ceiling (${limits.maxUsageVolume}) reached` };
    }
    // Cost ceiling semantics (UNKNOWN != $0): `totals.costUsd` is the sum of
    // KNOWN dollar cost only. It fires when the known sum alone reaches the
    // ceiling. When some calls had no provider-reported cost the known sum is a
    // lower bound — so also deny once the KNOWN sum passes a conservative
    // fraction of the ceiling while unknown-cost calls exist, rather than
    // letting unpriced calls run indefinitely under a $0 assumption.
    if (totals.costUsd >= limits.maxCostUsd) {
      return { allow: false, reason: `ReviewLoop cost ceiling ($${limits.maxCostUsd}) reached` };
    }
    if ((totals.unknownCostCalls ?? 0) > 0 && totals.costUsd >= limits.maxCostUsd * 0.5) {
      return {
        allow: false,
        reason: `ReviewLoop cost ceiling: known spend $${totals.costUsd.toFixed(2)} plus `
          + `${totals.unknownCostCalls} call(s) of unknown cost — refusing to keep spending against an unpriced ceiling`,
      };
    }
    return { allow: true };
  };

  const authority = new ModelSpendAuthority({
    policy, onEvent, reservationLedger, recordSafetyEvent, informationLedger,
  });

  async function registerEvidence({ kind, ...args }) {
    const wf = { workflowId: loopId, ...args };
    // A composite (diff chunk + gate fingerprint) logical review state. Shares
    // the CHANGED_TASK_DIFF taxonomy — it IS a "the reviewable state changed"
    // event — but its fingerprint folds in the gate outcome so a diff that is
    // byte-identical but was gated differently is a distinct logical state.
    if (kind === 'reviewstate') return registerTaskDiffEvidence(informationLedger, wf);
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
    // Fail closed: a single earlier physical call in this loop consumed an
    // anomalous amount of tokens. It was fully accounted, but the loop is
    // latched — no more automatic model spend. Refused at the authorization
    // stage, before any permit/reservation, and it survives a process restart
    // because the latch is read from durable workflow state.
    const anomaly = await readAnomaly();
    if (anomaly) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_TOKEN_ANOMALY_BLOCKED,
        `ReviewLoop ${JSON.stringify(loopId)} latched a single-call token anomaly `
          + `(${anomaly.reason}); further internal model spend is blocked until a human clears it`,
        { loopId, anomaly },
      );
    }
    // Fail closed: a prior physical metered call whose real usage AND cost were
    // lost to a crash cannot be reconstructed. UNKNOWN != ZERO — refuse all
    // further ReviewLoop spend until a human acknowledges it.
    if (await hasUnaccountedSpend()) {
      throw new AuthorizationError(
        AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
        `ReviewLoop ${loopId} has ${cachedUnaccounted} settled metered call(s) whose usage/cost `
          + 'could not be recovered after a crash; further model spend is blocked until a human '
          + 'clears it (REVIEWLOOP_ACK_UNACCOUNTED_SPEND)',
        { loopId, unaccountedSpendCalls: cachedUnaccounted },
      );
    }
    pendingTotals = await currentTotals();
    const intent = {
      role, family, provider,
      operationId: operationId ?? loopId,
      attempt,
      workflowId: loopId,
      evidenceIds,
    };
    const permit = await authority.authorize(intent);
    const reservationId = typeof authority.reservationIdFor === 'function'
      ? authority.reservationIdFor(permit)
      : null;

    const appendRecord = async (rec) => {
      const full = { ...rec, role, reservationId, at: new Date().toISOString() };
      // Durable-before-return: the aggregate must reflect this attempt even if
      // the controller crashes before it saves loop state.
      await spendStore.append(loopId, full);
      sessionRecords.push(full);
    };

    let result;
    try {
      result = await authority.dispatch(permit, intent, async () => {
        let out;
        try {
          out = await call();
        } catch (err) {
          if (isMechanicallyZeroPreSend(err)) {
            // Attach mechanically-zero usage so the reservation settles KNOWN
            // and the business error is re-thrown normally for failover. Also
            // attach an EXPLICIT pre-send provenance flag: this is a spawn /
            // transport abort before any bytes were sent (isMechanicallyZeroPreSend
            // already required a PRE_SEND_ZERO_CODES code AND the absence of any
            // provider-supplied usage). ModelSpendAuthority.dispatch() persists
            // this as settlementReason PROVEN_PRE_SEND_ZERO — the ONLY durable
            // basis for a later attempt to reuse the same New Information claim.
            // A plain provider `{0,0}` usage NEVER earns this flag.
            err.details = {
              ...(err.details ?? {}),
              usage: { input_tokens: 0, output_tokens: 0 },
              preSendZeroProven: true,
            };
          } else if (usagePresentButUnresolved({
            usage: err?.details?.usage ?? err?.usage ?? null, family, provider,
          })) {
            // The provider threw WITH a usage object, but it is missing a field
            // this family's confirmed accounting needs. UNKNOWN != ZERO: strip
            // the partial usage so ModelSpendAuthority settles the reservation
            // UNRESOLVED (fail closed) rather than recording a false precise
            // spend. The business error itself still propagates.
            if (err?.details) delete err.details.usage;
            delete err.usage;
          }
          throw err;
        }
        // A post-dispatch usage object that is present but insufficient for a
        // mechanically-known volume for this family MUST NOT settle as precise
        // known spend. Throw WITHOUT usage so dispatch() settles the
        // reservation UNRESOLVED — the existing MODEL_SPEND_USAGE_UNRESOLVED /
        // fail-closed path then blocks further internal model spend until a
        // human clears it.
        if (usagePresentButUnresolved({ usage: out?.usage ?? null, family, provider })) {
          const e = new Error(
            `ReviewLoop ${loopId}: post-dispatch usage for ${provider}/${family} is present but `
              + 'missing a field required for mechanically-known token accounting; UNKNOWN != ZERO',
          );
          e.code = 'PROVIDER_USAGE_INCOMPLETE';
          throw e;
        }
        return {
          value: out?.value ?? out,
          usage: out?.usage ?? null,
          model: out?.model ?? model ?? null,
          // Pass the provider cost through UNCHANGED (undefined when unknown) —
          // UNKNOWN != $0. The record layer marks costKnown accordingly.
          costUsd: out?.costUsd,
          // Mechanical payload-size metadata (lengths only, never prompt text).
          meta: out?.meta ?? null,
        };
      });
    } catch (err) {
      // dispatch threw. A spend/authorization denial (SPEND_DENIED,
      // MODEL_SPEND_USAGE_UNRESOLVED, ...) means there is NO reliably-settled
      // physical attempt to account for — re-throw untouched. Any other error
      // that made it past dispatch's settlement means the reservation is
      // SETTLED_KNOWN (a provider/business failure with known usage, or a
      // mechanically-zero pre-send failure): write its durable accounting
      // record NOW so a normal failover never looks like unaccounted spend on
      // the next load.
      if (!isAuthorizationFailure(err)) {
        const usage = err?.details?.usage ?? err?.usage
          ?? (isMechanicallyZeroPreSend(err) ? { input_tokens: 0, output_tokens: 0 } : null);
        // A mechanically-zero pre-send failure genuinely cost $0; any other
        // failure's cost is only known if the error carried it.
        const failCost = err?.details?.costUsd;
        const costKnown = Number.isFinite(failCost) || isMechanicallyZeroPreSend(err);
        const failMeta = payloadMetaOf(err?.details?.meta ?? null);
        const failBreakdown = usageBreakdownOf(usage);
        const failAccounting = usageAccountingOf({ usage, family, provider });
        await appendRecord({
          model: model ?? null,
          family,
          provider,
          usageKnown: usage != null,
          usageVolume: failAccounting.usageVolume,
          usageBreakdown: failBreakdown,
          usageAccounting: accountingProvenanceOf(failAccounting),
          payloadMeta: failMeta,
          contextOverheadTokens: contextOverheadTokens(failBreakdown, failMeta),
          costUsd: Number.isFinite(failCost) ? failCost : 0,
          costKnown,
          businessOutcome: 'FAILURE',
          failureCode: err?.code ?? err?.providerFailure ?? null,
        });
        // Sentinel over a known-usage provider FAILURE too: the tokens were
        // still spent. A trip throws MODEL_SPEND_TOKEN_ANOMALY_BLOCKED in
        // place of the provider error so the controller stops (no failover).
        await maybeTripSentinel({
          role, family, provider, resolvedModel: model ?? null,
          accounting: failAccounting,
          contextOverhead: contextOverheadTokens(failBreakdown, failMeta),
        });
      }
      throw err;
    }

    const okBreakdown = usageBreakdownOf(result?.usage);
    const okMeta = payloadMetaOf(result?.meta);
    const okAccounting = usageAccountingOf({ usage: result?.usage, family, provider });
    await appendRecord({
      // requestedFamily -> resolvedModel: the concrete model actually used
      // (recovered from the provider envelope when config asked for a family).
      model: result?.model ?? model ?? null,
      requestedFamily: family,
      family,
      provider,
      usageKnown: result?.usage != null,
      usageVolume: okAccounting.usageVolume,
      usageAccounting: accountingProvenanceOf(okAccounting),
      usageBreakdown: okBreakdown,
      payloadMeta: okMeta,
      contextOverheadTokens: contextOverheadTokens(okBreakdown, okMeta),
      costUsd: Number.isFinite(result?.costUsd) ? result.costUsd : 0,
      costKnown: Number.isFinite(result?.costUsd),
      businessOutcome: 'SUCCESS',
    });
    // Post-settlement Token Sentinel: the call is now fully, durably accounted.
    // If this ONE call blew past the per-call ceiling, latch the loop and throw
    // (fully accounted, then fail closed) rather than returning its result.
    await maybeTripSentinel({
      role, family, provider, resolvedModel: result?.model ?? model ?? null,
      accounting: okAccounting,
      contextOverhead: contextOverheadTokens(okBreakdown, okMeta),
    });
    return result?.value ?? result;
  }

  async function telemetry() {
    const t = await currentTotals();
    const prior = await loadPriorRecords();
    const breakdown = foldBreakdown([...prior, ...sessionRecords]);
    const anomaly = await loadAnomaly();
    return {
      usageBreakdown: breakdown,
      // Post-settlement single-call Token Sentinel latch (null = clean).
      tokenAnomaly: anomaly,
      tokenAnomalyBlocked: Boolean(anomaly),
      reviewerCalls: t.reviewerCalls,
      supervisorCalls: t.supervisorCalls,
      usageVolume: t.usageVolume,
      // costUsd is the sum of KNOWN dollar cost; a lower bound when
      // costKnown === false.
      costUsd: t.costUsd,
      costKnown: (t.unknownCostCalls ?? 0) === 0,
      unknownCostCalls: t.unknownCostCalls ?? 0,
      unknownUsageCalls: t.unknownUsageCalls,
      // usage reported but provider cache semantics unconfirmed -> that call's
      // usageVolume is a conservative additive over-count.
      unknownSemanticsCalls: t.unknownSemanticsCalls ?? 0,
      unaccountedSpendCalls: t.unaccountedSpendCalls ?? 0,
      spendBlocked: (t.unaccountedSpendCalls ?? 0) > 0 && !unaccountedAcknowledged(),
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
    hasUnaccountedSpend,
    loadTokenAnomaly: loadAnomaly,
    telemetry,
  };
}
