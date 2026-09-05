// Developer/test/diagnostic real-provider-call guard.
//
// This is NOT part of the production ModelSpendAuthority / Token Safety
// architecture. Normal `supergpt ...` / `runSuperGPT()` operation never calls
// this module and never requires its env variable. This guard exists solely
// for developer entrypoints under scripts/ and bin/ that are capable of
// making a real, quota-spending call to a provider (agy/Gemini, Claude,
// Codex) when run directly — accidental execution (for example a bare
// `node --test` picking up a live script's top-level/main code instead of
// the repository's scoped `npm test`) must never reach that call.
//
// Authorization is double opt-in by design:
//   1. explicit live intent (a CLI flag the caller had to type on purpose)
//   2. the SUPERGPT_ALLOW_REAL_PROVIDER_CALLS=1 environment variable
// Both are required. Neither alone is sufficient.

export const REAL_PROVIDER_CALL_ENV = 'SUPERGPT_ALLOW_REAL_PROVIDER_CALLS';
export const REAL_PROVIDER_CALL_FLAG = '--allow-real-provider-calls';
export const REAL_PROVIDER_CALL_NOT_AUTHORIZED = 'REAL_PROVIDER_CALL_NOT_AUTHORIZED';

export class RealProviderCallNotAuthorizedError extends Error {
  constructor(message, { entrypoint } = {}) {
    super(message);
    this.name = 'RealProviderCallNotAuthorizedError';
    this.code = REAL_PROVIDER_CALL_NOT_AUTHORIZED;
    this.entrypoint = entrypoint ?? null;
  }
}

// Pure predicate — no I/O, no logging. `env` defaults to process.env only at
// the call site inside assert*, never here, so this stays trivially testable.
export function realProviderCallsAuthorized({ env, explicitLiveIntent } = {}) {
  const envFlagSet = String(env?.[REAL_PROVIDER_CALL_ENV] ?? '') === '1';
  return Boolean(explicitLiveIntent) && envFlagSet;
}

// Throws RealProviderCallNotAuthorizedError unless both conditions hold.
// Call this BEFORE constructing/making the real provider call — never after.
export function assertRealProviderCallsAuthorized({
  env = process.env,
  explicitLiveIntent = false,
  entrypoint = 'unknown',
} = {}) {
  if (realProviderCallsAuthorized({ env, explicitLiveIntent })) return;

  const reasons = [];
  if (!explicitLiveIntent) reasons.push('no explicit CLI live intent was supplied');
  if (String(env?.[REAL_PROVIDER_CALL_ENV] ?? '') !== '1') {
    reasons.push(`${REAL_PROVIDER_CALL_ENV}=1 is not set`);
  }

  throw new RealProviderCallNotAuthorizedError(
    `${REAL_PROVIDER_CALL_NOT_AUTHORIZED}: live provider execution requires explicit CLI live ` +
      `intent (e.g. ${REAL_PROVIDER_CALL_FLAG}) AND ${REAL_PROVIDER_CALL_ENV}=1 ` +
      `(entrypoint: ${entrypoint}; blocked because ${reasons.join(' and ')}).`,
    { entrypoint },
  );
}

// Known developer/test/diagnostic entrypoints capable of a real provider
// call, kept here as an explicit registry rather than a filename heuristic —
// a mechanical inventory test asserts every one of these actually calls the
// shared guard before reaching its provider boundary.
export const REAL_PROVIDER_CALL_ENTRYPOINTS = Object.freeze([
  'scripts/test-agy-live.js',
  'scripts/test-agy-conversations-live.js',
  'scripts/test-agy-reviewer-live.js',
  'scripts/live-smoke-active-pools.js',
  'scripts/run-final-e2e.js',
  'scripts/test-rework-live-e2e.js',
  'scripts/measure-supervisor-decisions.js',
  'bin/benchmark-tokens.js --live',
  'bin/probe-provider-overhead.js',
]);
