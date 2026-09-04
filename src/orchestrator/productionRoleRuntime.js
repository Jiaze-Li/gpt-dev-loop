// The production role boundary.  This is deliberately small: protocols and
// physical transports stay in their existing adapters; this module is the
// only place that selects a provider and retries another family.
import { RoleRouter, QuotaPoolRegistry, ProviderHealthRegistry } from './roleRouting.js';
import { isCancellation, isAuthorizationFailure, ProviderCancelledError } from './errors.js';
import { ModelSpendAuthority } from './modelSpendAuthority.js';

const RETRYABLE = new Set([
  'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH_FAILED',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_PROTOCOL_ERROR',
  'EXECUTOR_TIMEOUT', 'COMMAND_TIMEOUT',
]);

export function providerFailure(error) {
  const code = error?.details?.providerFailure ?? error?.providerFailure ?? error?.code;
  // Executor correctness/protocol/budget errors are post-send outcomes. They
  // must become REWORK/new attempt, never a hidden full rerun on another model.
  if (code === 'EXECUTOR_BUDGET_EXCEEDED' || code === 'EXECUTOR_DUPLICATE_CALL_REJECTED' || code === 'EXECUTOR_INVALID_OUTPUT') {
    return { code: 'EXECUTOR_IMPLEMENTATION_FAILURE' };
  }
  // A context-budget overflow is deterministic: every provider builds the
  // Supervisor / Reviewer prompt through the same assembler, so failing over
  // to the next provider would overflow identically and burn another call.
  // Classify it non-retryable so the invocation surfaces the guard
  // immediately, exactly like the Executor budget brake.
  if (code === 'SUPERVISOR_CONTEXT_BUDGET_EXCEEDED' || code === 'REVIEWER_CONTEXT_BUDGET_EXCEEDED') {
    return { code };
  }
  if (code === 'EXECUTOR_TIMEOUT') {
    return { code: 'PROVIDER_TIMEOUT', resetAt: error?.details?.resetAt ?? error?.resetAt ?? null, retryAfter: error?.details?.retryAfter ?? error?.retryAfter ?? null };
  }
  if (RETRYABLE.has(code)) return { code, resetAt: error?.details?.resetAt ?? error?.resetAt ?? null, retryAfter: error?.details?.retryAfter ?? error?.retryAfter ?? null };
  const diagnostic = `${error?.message ?? ''} ${error?.details?.stderr ?? ''}`;
  if (/timeout|did not respond within/i.test(diagnostic)) {
    return { code: 'PROVIDER_TIMEOUT', resetAt: error?.details?.resetAt ?? null, retryAfter: error?.details?.retryAfter ?? null };
  }
  if (/quota|usage.?limit|rate.?limit|too many requests/i.test(diagnostic)) {
    return { code: /rate.?limit|too many requests/i.test(diagnostic) ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_QUOTA_EXHAUSTED', resetAt: error?.details?.resetAt ?? null, retryAfter: error?.details?.retryAfter ?? null };
  }
  if (/auth|login|credential|unauthori[sz]ed/i.test(diagnostic)) return { code: 'PROVIDER_AUTH_FAILED' };
  // Adapter errors without a native classification are transport failures,
  // never quota failures.
  return { code: 'PROVIDER_UNAVAILABLE' };
}

export function createProductionRoleRuntime({
  router,
  rolePolicy,
  quotaRegistry = new QuotaPoolRegistry(),
  providerHealth = new ProviderHealthRegistry(),
  resolveFamily,
  adapters = {},
  onEvent,
  signal,
  // The Token-Safety authorization boundary. Default: an allow-all authority
  // that still enforces permit issuance / binding / single-use / default-deny.
  spendAuthority = new ModelSpendAuthority({ onEvent }),
} = {}) {
  const capabilityResolver = resolveFamily ?? ((family) => ({
    requestedFamily: family,
    resolvedModel: null,
    provider: family.split(':')[0],
    capabilities: { roles: Object.entries(adapters).filter(([, byFamily]) => typeof byFamily?.[family] === 'function').map(([role]) => role) },
  }));
  const roleRouter = router ?? new RoleRouter({ rolePolicy, quotaRegistry, providerHealth, resolveFamily: capabilityResolver, onEvent });

  async function invoke(role, payload, {
    signals = {}, operationId = null, signal: callSignal = null, workflowId = null,
  } = {}) {
    const abortSignal = callSignal ?? signal;
    const attempted = new Set();
    let lastError = null;
    while (true) {
      // A cancellation between provider attempts terminates the whole
      // invocation immediately — it never selects "the next provider".
      if (abortSignal?.aborted) {
        throw new ProviderCancelledError(`${role} invocation cancelled`, { operationId });
      }
      const selection = roleRouter.route(role, signals);
      if (!selection || attempted.has(selection.requestedFamily)) {
        if (lastError) throw lastError;
        throw new Error(`No usable ${role} provider remains`);
      }
      attempted.add(selection.requestedFamily);
      const adapter = adapters[role]?.[selection.requestedFamily];
      if (typeof adapter !== 'function') {
        // A resolver normally prevents this.  Treat a stale capability map as
        // unavailable instead of silently falling back to a fixed provider.
        roleRouter.recordFailure(selection, { code: 'PROVIDER_UNAVAILABLE' });
        continue;
      }
      // One CallIntent per PHYSICAL attempt. `attempted.size` is the 1-based
      // physical-attempt counter for this invoke(), so provider B on failover
      // is bound to attempt:2 and cannot reuse provider A's permit.
      const callIntent = {
        role,
        family: selection.requestedFamily,
        provider: selection.provider,
        operationId,
        attempt: attempted.size,
        workflowId,
      };
      let permit;
      try {
        permit = await spendAuthority.authorize(callIntent);
      } catch (error) {
        // Authorization failure is an orchestrator decision, NOT provider
        // failure: no recordFailure, no health/quota mutation, no failover.
        onEvent?.({ type: 'ROLE_INVOCATION_DENIED', role, operationId, ...selection, reason: error.code });
        throw error;
      }
      try {
        const value = await spendAuthority.dispatch(permit, callIntent, () => adapter(payload, selection));
        onEvent?.({ type: 'ROLE_INVOCATION_SUCCEEDED', role, operationId, ...selection });
        return { value, selection };
      } catch (error) {
        // Cancellation is not provider unavailability. Bail out BEFORE any
        // failure classification, recordFailure, provider-health/quota
        // mutation, or failover — and propagate the original error.
        if (isCancellation(error, abortSignal)) {
          onEvent?.({ type: 'ROLE_INVOCATION_CANCELLED', role, operationId, ...selection });
          throw error;
        }
        // A permit / spend-authorization failure is likewise NOT provider
        // failure. Propagate immediately, before any classification or
        // provider-health / quota mutation, and never fail over.
        if (isAuthorizationFailure(error)) {
          onEvent?.({ type: 'ROLE_INVOCATION_DENIED', role, operationId, ...selection, reason: error.code });
          throw error;
        }
        lastError = error;
        const failure = providerFailure(error);
        roleRouter.recordFailure(selection, failure);
        onEvent?.({ type: 'ROLE_INVOCATION_FAILED', role, operationId, ...selection, failure: failure.code });
        if (!RETRYABLE.has(failure.code)) throw error;
      }
    }
  }

  return { router: roleRouter, quotaRegistry, providerHealth, spendAuthority, invoke };
}
