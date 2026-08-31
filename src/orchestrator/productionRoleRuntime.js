// The production role boundary.  This is deliberately small: protocols and
// physical transports stay in their existing adapters; this module is the
// only place that selects a provider and retries another family.
import { RoleRouter, QuotaPoolRegistry, ProviderHealthRegistry } from './roleRouting.js';
import { isCancellation, ProviderCancelledError } from './errors.js';

const RETRYABLE = new Set([
  'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH_FAILED',
  'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_PROTOCOL_ERROR',
  'EXECUTOR_TIMEOUT', 'COMMAND_TIMEOUT',
]);

export function providerFailure(error) {
  const code = error?.details?.providerFailure ?? error?.providerFailure ?? error?.code;
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
} = {}) {
  const capabilityResolver = resolveFamily ?? ((family) => ({
    requestedFamily: family,
    resolvedModel: null,
    provider: family.split(':')[0],
    capabilities: { roles: Object.entries(adapters).filter(([, byFamily]) => typeof byFamily?.[family] === 'function').map(([role]) => role) },
  }));
  const roleRouter = router ?? new RoleRouter({ rolePolicy, quotaRegistry, providerHealth, resolveFamily: capabilityResolver, onEvent });

  async function invoke(role, payload, { signals = {}, operationId = null, signal: callSignal = null } = {}) {
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
      try {
        const value = await adapter(payload, selection);
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
        lastError = error;
        const failure = providerFailure(error);
        roleRouter.recordFailure(selection, failure);
        onEvent?.({ type: 'ROLE_INVOCATION_FAILED', role, operationId, ...selection, failure: failure.code });
        if (!RETRYABLE.has(failure.code)) throw error;
      }
    }
  }

  return { router: roleRouter, quotaRegistry, providerHealth, invoke };
}
