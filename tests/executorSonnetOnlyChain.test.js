// Executor automatic provider topology is temporarily Sonnet-only.
//
// The codex:default and claude:opus Executor adapters remain implemented and
// capability-declared, but are NOT automatic failover candidates. A retryable
// Sonnet failure fails the Executor invocation back to the upper workflow
// layer instead of silently rerunning on another model.
//
// Planner / Supervisor / Reviewer routing is unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  AdapterError, ADAPTER_ERROR_CODES, AUTHORIZATION_ERROR_CODES, isAuthorizationFailure,
} from '../src/orchestrator/errors.js';

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

function makeRuntime(executorAdapters) {
  const attempts = { 'claude:sonnet': 0, 'codex:default': 0, 'claude:opus': 0 };
  const wrap = (family, impl) => async (...args) => { attempts[family] += 1; return impl(...args); };
  const runtime = createProductionRoleRuntime({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
    adapters: {
      executor: {
        'claude:sonnet': wrap('claude:sonnet', executorAdapters['claude:sonnet']),
        'codex:default': wrap('codex:default', executorAdapters['codex:default'] ?? (() => { throw new Error('codex must not run'); })),
        'claude:opus': wrap('claude:opus', executorAdapters['claude:opus'] ?? (() => { throw new Error('opus must not run'); })),
      },
    },
  });
  return { runtime, attempts };
}

// A. Executor provider pool
test('A: production Executor automatic candidate pool is claude:sonnet only', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.executor.map((c) => c.family), ['claude:sonnet']);
  const families = DEFAULT_ROLE_POLICY.executor.map((c) => c.family);
  assert.ok(!families.includes('codex:default'));
  assert.ok(!families.includes('claude:opus'));
});

// B. Sonnet success
test('B: Sonnet success invokes Sonnet exactly once and no other provider', async () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const { runtime, attempts } = makeRuntime({
    'claude:sonnet': async () => ({ ok: true, report: 'done', usage }),
  });
  const { value, selection } = await runtime.invoke('executor', { taskId: 't1' }, { operationId: 'wf:t1' });
  assert.deepEqual(value, { ok: true, report: 'done', usage });
  assert.equal(selection.requestedFamily, 'claude:sonnet');
  assert.equal(attempts['claude:sonnet'], 1);
  assert.equal(attempts['codex:default'], 0);
  assert.equal(attempts['claude:opus'], 0);
});

// C. Sonnet retryable failure
test('C: retryable Sonnet failure fails back upward with no codex/opus failover', async () => {
  const { runtime, attempts } = makeRuntime({
    'claude:sonnet': async () => {
      throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'executor "claude" did not respond within 600000ms');
    },
  });
  // A timeout carries no reliable usage evidence, so this is now an
  // IMMEDIATE Token Safety block (AuthorizationError), not merely "Sonnet
  // failed, no failover" — the original EXECUTOR_TIMEOUT is preserved only
  // as diagnostic metadata on the thrown AuthorizationError.
  await assert.rejects(
    runtime.invoke('executor', { taskId: 't2' }, { operationId: 'wf:t2' }),
    (err) => isAuthorizationFailure(err)
      && err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED
      && err.details?.originalErrorCode === ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT,
  );
  assert.equal(attempts['claude:sonnet'], 1);
  assert.equal(attempts['codex:default'], 0);
  assert.equal(attempts['claude:opus'], 0);
});

// D. Other roles unchanged
test('D: Planner / Supervisor / Reviewer automatic chains are unchanged', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.planner.map((c) => c.family), [
    'codex:default', 'agy:gemini', 'claude:opus', 'agy:gpt-oss',
  ]);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), [
    'agy:gemini', 'codex:default', 'claude:opus', 'agy:gpt-oss',
  ]);
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), [
    'agy:gpt-oss', 'codex:default', 'agy:gemini', 'claude:opus',
  ]);
});

// Non-goal guard: adapters remain implemented / capability-declared.
test('codex:default and claude:opus keep their executor adapter capability declaration', () => {
  assert.ok(PRODUCTION_ROLE_CAPABILITIES['codex:default'].includes('executor'));
  assert.ok(PRODUCTION_ROLE_CAPABILITIES['claude:opus'].includes('executor'));
});
