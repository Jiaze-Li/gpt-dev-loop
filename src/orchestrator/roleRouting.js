// Deterministic, zero-token role routing.  Policy, quota, transport health,
// effort and physical-session decisions deliberately live in separate modules.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_ROLE_POLICY = Object.freeze({
  planner: Object.freeze([{ family: 'codex:default', effort: 'medium' }, { family: 'agy:gemini', effort: 'medium' }, { family: 'claude:opus', effort: 'medium' }, { family: 'agy:gpt-oss', effort: 'medium', degraded: true }]),
  supervisor: Object.freeze([{ family: 'agy:gemini', effort: 'medium' }, { family: 'codex:default', effort: 'medium' }, { family: 'claude:opus', effort: 'medium' }, { family: 'agy:gpt-oss', effort: 'medium', degraded: true }]),
  reviewer: Object.freeze([{ family: 'agy:gpt-oss', effort: 'medium' }, { family: 'codex:default', effort: 'medium' }, { family: 'agy:gemini', effort: 'medium' }, { family: 'claude:opus', effort: 'medium' }]),
  executor: Object.freeze([{ family: 'claude:sonnet' }, { family: 'codex:default', effort: 'medium' }, { family: 'claude:opus' }]),
});

export const DEFAULT_QUOTA_TOPOLOGY = Object.freeze({
  'codex:default': ['codex'],
  'claude:sonnet': ['claude'],
  'claude:opus': ['claude'],
  'agy:gemini': ['agy-gemini'],
  'agy:gpt-oss': ['agy-claude-gpt'],
});

// This is a declaration of *protocol adapters*, not of installed CLIs or
// accounts.  A family is eligible for a role only when the production
// composition supplies an adapter implementing that role's wire protocol.
// Keep unsupported pairs in DEFAULT_ROLE_POLICY: policy can enable a future
// adapter without pretending it exists today.
export const PRODUCTION_ROLE_CAPABILITIES = Object.freeze({
  'codex:default': Object.freeze(['planner', 'supervisor', 'reviewer', 'executor']),
  'agy:gemini': Object.freeze(['planner', 'supervisor', 'reviewer']),
  'agy:gpt-oss': Object.freeze(['planner', 'supervisor', 'reviewer']),
  'claude:sonnet': Object.freeze(['executor']),
  'claude:opus': Object.freeze(['planner', 'supervisor', 'reviewer', 'executor']),
});

export function supportsProductionRole(family, role) {
  return PRODUCTION_ROLE_CAPABILITIES[family]?.includes(role) ?? false;
}

export const POOL_STATUS = Object.freeze({ READY: 'READY', UNKNOWN: 'UNKNOWN', COOLDOWN: 'COOLDOWN' });
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function nowIso(now) { return new Date(now).toISOString(); }

export class QuotaPoolRegistry {
  constructor({ filePath = path.join(os.homedir(), '.supergpt', 'quota-pools.json'), topology = DEFAULT_QUOTA_TOPOLOGY, now = () => Date.now(), baseBackoffMs = DEFAULT_BACKOFF_MS } = {}) {
    this.filePath = filePath; this.topology = { ...topology }; this.now = now; this.baseBackoffMs = baseBackoffMs;
    this.pools = {};
    if (filePath && existsSync(filePath)) {
      try { this.pools = JSON.parse(readFileSync(filePath, 'utf8')).pools ?? {}; } catch { this.pools = {}; }
    }
  }
  persist() {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ schema: 'supergpt.quota-pools/v1', pools: this.pools }, null, 2)}\n`);
  }
  poolsFor(family) { return [...(this.topology[family] ?? [])]; }
  setTopology(family, poolIds) { this.topology[family] = [...new Set(poolIds)]; }
  get(poolId) {
    const pool = this.pools[poolId] ?? { poolId, status: POOL_STATUS.UNKNOWN, reason: 'unknown', checkedAt: null, cooldownSince: null, resetAt: null, retryAfter: null, source: 'cached', failures: 0 };
    if (pool.status === POOL_STATUS.COOLDOWN && pool.resetAt && Date.parse(pool.resetAt) <= this.now()) {
      pool.status = POOL_STATUS.UNKNOWN; pool.reason = 'unknown'; pool.checkedAt = nowIso(this.now()); pool.resetAt = null; pool.retryAfter = null;
      this.pools[poolId] = pool; this.persist();
    }
    return copy(pool);
  }
  usable(family) { return this.poolsFor(family).every((poolId) => this.get(poolId).status !== POOL_STATUS.COOLDOWN); }
  recordReady(poolId, { source = 'runtime_probe' } = {}) {
    this.pools[poolId] = { ...this.get(poolId), status: POOL_STATUS.READY, reason: null, checkedAt: nowIso(this.now()), cooldownSince: null, resetAt: null, retryAfter: null, source, failures: 0 }; this.persist();
  }
  recordCooldown(poolId, { reason = 'quota_exhausted', resetAt = null, retryAfter = null, source = 'provider_error' } = {}) {
    const prior = this.get(poolId); const failures = (prior.failures ?? 0) + 1;
    const resetMillis = resetAt ? Date.parse(resetAt) : (Number.isFinite(retryAfter) ? this.now() + retryAfter : this.now() + this.baseBackoffMs * (2 ** Math.min(failures - 1, 5)));
    this.pools[poolId] = { poolId, status: POOL_STATUS.COOLDOWN, reason, checkedAt: nowIso(this.now()), cooldownSince: nowIso(this.now()), resetAt: Number.isFinite(resetMillis) ? nowIso(resetMillis) : null, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null, source: resetAt || retryAfter ? source : 'inferred_backoff', failures }; this.persist();
  }
  recordProviderFailure(family, failure = {}) {
    if (!['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMITED'].includes(failure.code)) return;
    for (const poolId of this.poolsFor(family)) this.recordCooldown(poolId, { reason: failure.code === 'PROVIDER_RATE_LIMITED' ? 'rate_limited' : 'quota_exhausted', resetAt: failure.resetAt, retryAfter: failure.retryAfter, source: 'provider_error' });
  }
  summary() { return [...new Set(Object.values(this.topology).flat())].map((poolId) => this.get(poolId)); }
}

export class ProviderHealthRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.providers = new Map();
    this.candidates = new Map();
  }
  get(target) {
    return this.candidates.get(target) ?? this.providers.get(target) ?? { provider: target, status: 'UNKNOWN', checkedAt: null, reason: null };
  }
  record(target, status, reason = null) {
    const entry = { provider: target, status, reason, checkedAt: nowIso(this.now()) };
    if (typeof target === 'string' && target.includes(':')) {
      this.candidates.set(target, entry);
    } else {
      this.providers.set(target, entry);
    }
  }
  usable(target, provider = null) {
    const cand = this.candidates.get(target);
    if (cand && (cand.status === 'UNAVAILABLE' || cand.status === 'AUTH_FAILED')) return false;
    if (provider) {
      const prov = this.providers.get(provider);
      if (prov && (prov.status === 'UNAVAILABLE' || prov.status === 'AUTH_FAILED')) return false;
    }
    const direct = this.providers.get(target);
    if (direct && (direct.status === 'UNAVAILABLE' || direct.status === 'AUTH_FAILED')) return false;
    return true;
  }
}

export class EffortPolicy {
  select({ candidate, capabilities = {}, signals = {} } = {}) {
    if (!capabilities.supportsReasoningEffort) return null;
    const supported = capabilities.supportedEfforts ?? ['medium'];
    const high = signals.reasoningFailures > 0 || signals.reworkCycles >= 2 || signals.highRisk === true;
    return high && supported.includes('high') ? 'high' : (candidate.effort ?? 'medium');
  }
}

export class RoleRouter {
  constructor({ rolePolicy = DEFAULT_ROLE_POLICY, quotaRegistry = new QuotaPoolRegistry(), providerHealth = new ProviderHealthRegistry(), effortPolicy = new EffortPolicy(), resolveFamily = (family) => ({ requestedFamily: family, resolvedModel: null, provider: family.split(':')[0], capabilities: {} }), onEvent } = {}) {
    this.rolePolicy = rolePolicy ?? DEFAULT_ROLE_POLICY; this.quotaRegistry = quotaRegistry; this.providerHealth = providerHealth; this.effortPolicy = effortPolicy; this.resolveFamily = resolveFamily; this.onEvent = onEvent; this.resolutions = new Map();
  }
  route(role, signals = {}) {
    const candidates = this.rolePolicy[role] ?? [];
    for (const candidate of candidates) {
      const resolved = this.resolveFamily(candidate.family) ?? {}; const provider = resolved.provider ?? candidate.family.split(':')[0];
      if (resolved.resolvedModel && this.resolutions.has(candidate.family) && this.resolutions.get(candidate.family) !== resolved.resolvedModel) this.onEvent?.({ type: 'MODEL_RESOLVED_CHANGED', requestedFamily: candidate.family, previousResolvedModel: this.resolutions.get(candidate.family), resolvedModel: resolved.resolvedModel });
      if (resolved.resolvedModel) this.resolutions.set(candidate.family, resolved.resolvedModel);
      // `roles` is an explicit adapter declaration. An empty declaration is
      // unsupported too; do not turn a missing adapter into a token-bearing
      // probe.  Resolvers that predate capability metadata remain compatible.
      if (Array.isArray(resolved.capabilities?.roles) && !resolved.capabilities.roles.includes(role)) { this.onEvent?.({ type: 'ROLE_ROUTE_SKIPPED', role, candidate: candidate.family, reason: 'capability' }); continue; }
      if (!this.quotaRegistry.usable(candidate.family)) { this.onEvent?.({ type: 'ROLE_ROUTE_SKIPPED', role, candidate: candidate.family, reason: 'quota_cooldown', pools: this.quotaRegistry.poolsFor(candidate.family) }); continue; }
      if (!this.providerHealth.usable(candidate.family, provider)) { this.onEvent?.({ type: 'ROLE_ROUTE_SKIPPED', role, candidate: candidate.family, reason: 'provider_health' }); continue; }
      const effort = this.effortPolicy.select({ candidate, capabilities: resolved.capabilities, signals });
      const selected = { role, requestedFamily: candidate.family, resolvedModel: resolved.resolvedModel ?? null, provider, quotaPools: this.quotaRegistry.poolsFor(candidate.family), effort, degraded: Boolean(candidate.degraded) };
      this.onEvent?.({ type: 'ROLE_ROUTE_SELECTED', ...selected }); return selected;
    }
    return null;
  }
  recordFailure(selection, failure) {
    this.quotaRegistry.recordProviderFailure(selection.requestedFamily, failure);
    if (['PROVIDER_AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_PROTOCOL_ERROR', 'PROVIDER_TIMEOUT', 'EXECUTOR_TIMEOUT'].includes(failure.code)) {
      // Record failure on the specific candidate family so other models under the same provider remain eligible
      this.providerHealth.record(selection.requestedFamily, failure.code === 'PROVIDER_AUTH_FAILED' ? 'AUTH_FAILED' : 'UNAVAILABLE', failure.code);
    }
    this.onEvent?.({ type: 'ROLE_PROVIDER_FAILED', role: selection.role, family: selection.requestedFamily, reason: failure.code });
  }
}
