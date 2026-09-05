// Deterministic, zero-model Provider Capability Policy.
//
// Token-safety controls for the different provider families used to be
// scattered ad hoc across each adapter (a timeout constant here, a
// role-capability list there). This module is the single place that
// DESCRIBES what each family/provider can be trusted to enforce and for
// which role — it does not itself enforce anything. Enforcement stays where
// it already lives: workflowCostGuard.js, ModelSpendAuthority, the
// individual adapters.
//
// Every field here must trace to code this repo can prove today. A control
// this module cannot currently prove is recorded UNAVAILABLE / UNKNOWN — it
// is NEVER guessed into looking like a live guarantee, and a SOFT hint
// (something merely passed to the provider, e.g. reasoning effort) is never
// reported under a HARD_LIVE / PRE_DISPATCH / POST_RUN tier.
//
// Tiers:
//   HARD_LIVE    — provably enforced live, during the physical call, by the
//                   provider or by this repo's own process supervision
//                   (e.g. a subprocess timeout that kills the call). The
//                   call cannot exceed it and keep running.
//   PRE_DISPATCH — checked by this repo BEFORE the physical call is sent
//                   (e.g. an input-size gate).
//   SOFT         — a hint handed to the provider (effort, verbosity). The
//                   provider may or may not honor it; nothing here enforces
//                   it, and it must never be read as a hard limit.
//   POST_RUN     — checked by this repo AFTER the physical call returns,
//                   from the provider's own reported usage (budget /
//                   duplicate-call guards, workflow/task ceilings).
//   UNAVAILABLE  — no code path in this repo currently proves this control
//                   exists for this family. Treat as absent, not as "off".

export const CAPABILITY_TIERS = Object.freeze({
  HARD_LIVE: 'HARD_LIVE',
  PRE_DISPATCH: 'PRE_DISPATCH',
  SOFT: 'SOFT',
  POST_RUN: 'POST_RUN',
  UNAVAILABLE: 'UNAVAILABLE',
});

const T = CAPABILITY_TIERS;

// A capability field is always { tier, value, note? } — never a bare value —
// so a caller cannot accidentally treat a SOFT hint or an UNAVAILABLE
// placeholder as an enforced number without reading the tier first.
function field(tier, value = null, note = undefined) {
  return Object.freeze(note ? { tier, value, note } : { tier, value });
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

function entry({
  family,
  provider,
  executorEligible,
  live,
  preDispatch,
  postRun,
  soft,
  unknownUsagePolicy,
}) {
  return deepFreeze({
    family,
    provider,
    executorEligible,
    live: { ...live },
    preDispatch: { ...preDispatch },
    postRun: { ...postRun },
    soft: { ...soft },
    unknownUsagePolicy,
  });
}

// Membership/subscription-quota protection for `claude --max-budget-usd` (or
// any equivalent) is NOT mechanically provable from this repo's code today.
// Per CARD 1 instructions it must never be recorded as a hard guarantee.
const CLAUDE_PROVIDER_BUDGET_NOTE = 'membership/subscription quota protection is UNKNOWN — not provable from this repo; never treat as a hard guarantee';

// Every physical Executor call — whichever family runs it — is metered by
// UsageTracker and checked against the existing task/workflow ceilings in
// workflowCostGuard.js (executorTaskUsage / workflowUsageVolumeExceeded /
// workflowCostExceeded), plus claudeSessionManager.js's own
// EXECUTOR_BUDGET_EXCEEDED / EXECUTOR_DUPLICATE_CALL_REJECTED post-send
// guards for the Claude families. That is a real, provable POST_RUN control.
const STANDARD_EXECUTOR_USAGE_GUARD = 'UsageTracker + workflowCostGuard.js task/workflow ceilings (post-send accounting; see src/orchestrator/workflowCostGuard.js)';

const CLAUDE_SESSION_MANAGER_USAGE_GUARD = `${STANDARD_EXECUTOR_USAGE_GUARD}; claudeSessionManager.js EXECUTOR_BUDGET_EXCEEDED / EXECUTOR_DUPLICATE_CALL_REJECTED (src/orchestrator/adapters/claudeSessionManager.js)`;

export const PROVIDER_CAPABILITIES = deepFreeze({
  'claude:sonnet': entry({
    family: 'claude:sonnet',
    provider: 'claude',
    // Short-term Executor policy (see roleRouting.js DEFAULT_ROLE_POLICY /
    // PRODUCTION_ROLE_CAPABILITIES): Sonnet is the only automatic Executor
    // candidate.
    executorEligible: true,
    live: {
      maxTurns: field(T.UNAVAILABLE),
      runtimeLimit: field(T.UNAVAILABLE),
      providerBudget: field(T.UNAVAILABLE, null, CLAUDE_PROVIDER_BUDGET_NOTE),
      thinkingLimit: field(T.UNAVAILABLE),
      outputLimit: field(T.UNAVAILABLE),
    },
    preDispatch: { inputLimit: field(T.UNAVAILABLE) },
    postRun: { usageGuard: field(T.POST_RUN, CLAUDE_SESSION_MANAGER_USAGE_GUARD) },
    soft: { reasoningEffort: field(T.UNAVAILABLE), verbosity: field(T.UNAVAILABLE) },
    unknownUsagePolicy: 'FAIL_CLOSED',
  }),
  'claude:opus': entry({
    family: 'claude:opus',
    provider: 'claude',
    // Adapter exists (roleRouting.js PRODUCTION_ROLE_CAPABILITIES declares
    // 'executor'), but it is not an automatic Executor failover candidate
    // (DEFAULT_ROLE_POLICY.executor is Sonnet-only). Not deleted — just not
    // eligible for the automatic chain.
    executorEligible: false,
    live: {
      maxTurns: field(T.UNAVAILABLE),
      runtimeLimit: field(T.UNAVAILABLE),
      providerBudget: field(T.UNAVAILABLE, null, CLAUDE_PROVIDER_BUDGET_NOTE),
      thinkingLimit: field(T.UNAVAILABLE),
      outputLimit: field(T.UNAVAILABLE),
    },
    preDispatch: { inputLimit: field(T.UNAVAILABLE) },
    postRun: { usageGuard: field(T.POST_RUN, CLAUDE_SESSION_MANAGER_USAGE_GUARD) },
    soft: { reasoningEffort: field(T.UNAVAILABLE), verbosity: field(T.UNAVAILABLE) },
    unknownUsagePolicy: 'FAIL_CLOSED',
  }),
  'codex:default': entry({
    family: 'codex:default',
    provider: 'codex',
    // Adapter exists and is capability-declared for 'executor', but is not
    // an automatic Executor failover candidate today (see roleRouting.js).
    executorEligible: false,
    live: {
      maxTurns: field(T.UNAVAILABLE),
      // codexExecutorAdapter.js kills the child process if it does not
      // respond within timeoutMs — a real, mechanically enforced live
      // ceiling this repo's own process supervision proves, not a
      // provider-reported one.
      runtimeLimit: field(T.HARD_LIVE, 10 * 60 * 1000, 'src/orchestrator/adapters/codexExecutorAdapter.js timeoutMs default; enforced by this repo terminating the child process, not reported by the provider'),
      providerBudget: field(T.UNAVAILABLE),
      thinkingLimit: field(T.UNAVAILABLE),
      outputLimit: field(T.UNAVAILABLE),
    },
    preDispatch: { inputLimit: field(T.UNAVAILABLE) },
    postRun: { usageGuard: field(T.POST_RUN, STANDARD_EXECUTOR_USAGE_GUARD) },
    // providerSelection.js declares `supportsReasoningEffort: family ===
    // 'codex:default'` with supportedEfforts ['low','medium','high']. This is
    // a hint EffortPolicy passes through selection.effort — SOFT, not a hard
    // limit: nothing in this repo proves codex enforces it.
    soft: { reasoningEffort: field(T.SOFT, ['low', 'medium', 'high']), verbosity: field(T.UNAVAILABLE) },
    unknownUsagePolicy: 'FAIL_CLOSED',
  }),
  'agy:gemini': entry({
    family: 'agy:gemini',
    provider: 'agy-gemini',
    // No executor adapter is declared for this family at all (roleRouting.js
    // PRODUCTION_ROLE_CAPABILITIES has no 'executor' entry for agy:gemini).
    executorEligible: false,
    live: {
      maxTurns: field(T.UNAVAILABLE),
      runtimeLimit: field(T.UNAVAILABLE),
      providerBudget: field(T.UNAVAILABLE),
      thinkingLimit: field(T.UNAVAILABLE),
      outputLimit: field(T.UNAVAILABLE),
    },
    preDispatch: { inputLimit: field(T.UNAVAILABLE) },
    postRun: { usageGuard: field(T.UNAVAILABLE) },
    soft: { reasoningEffort: field(T.UNAVAILABLE), verbosity: field(T.UNAVAILABLE) },
    unknownUsagePolicy: 'FAIL_CLOSED',
  }),
  'agy:gpt-oss': entry({
    family: 'agy:gpt-oss',
    provider: 'agy-claude-gpt',
    executorEligible: false,
    live: {
      maxTurns: field(T.UNAVAILABLE),
      runtimeLimit: field(T.UNAVAILABLE),
      providerBudget: field(T.UNAVAILABLE),
      thinkingLimit: field(T.UNAVAILABLE),
      outputLimit: field(T.UNAVAILABLE),
    },
    preDispatch: { inputLimit: field(T.UNAVAILABLE) },
    postRun: { usageGuard: field(T.UNAVAILABLE) },
    soft: { reasoningEffort: field(T.UNAVAILABLE), verbosity: field(T.UNAVAILABLE) },
    unknownUsagePolicy: 'FAIL_CLOSED',
  }),
});

// Returns the frozen capability record for `family`, or null when the
// family carries no declared policy at all. Callers must fail closed on
// null, never assume a default.
export function getProviderCapabilities(family) {
  return PROVIDER_CAPABILITIES[family] ?? null;
}

// Fail-closed executor-eligibility check: an unregistered / unknown family
// is never eligible, and a family whose record exists but does not
// explicitly set executorEligible === true is never eligible either.
export function isExecutorEligible(family) {
  const record = PROVIDER_CAPABILITIES[family];
  return Boolean(record) && record.executorEligible === true;
}
