import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { RoleRouter, QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { createGateRunner } from '../src/orchestrator/adapters/gateRunner.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

// These two tests exercise the GENERIC productionRoleRuntime failover
// mechanism across families, not the current SuperGPT production policy
// (Sonnet-only Executor — see providerCapabilities.js). ModelSpendAuthority
// always enforces provider eligibility regardless of rolePolicy, so a
// TEST-ONLY permissive capability source is injected explicitly; production
// code never does this.
const testOnlyPermissiveCapabilities = {
  isExecutorEligible: (family) => ['claude:sonnet', 'codex:default', 'claude:opus'].includes(family),
};

test('ProviderHealthRegistry: candidate-level failure does not disable other models of the same provider', () => {
  const health = new ProviderHealthRegistry();

  // claude:sonnet experiences a timeout/failure
  health.record('claude:sonnet', 'UNAVAILABLE', 'PROVIDER_TIMEOUT');

  // claude:sonnet is not usable
  assert.equal(health.usable('claude:sonnet', 'claude'), false);

  // claude:opus is still usable
  assert.equal(health.usable('claude:opus', 'claude'), true);

  // codex:default is still usable
  assert.equal(health.usable('codex:default', 'codex'), true);
});

test('RoleRouter & Runtime: claude:sonnet timeout allows failover to codex and then claude:opus', async () => {
  const rolePolicy = {
    executor: [
      { family: 'claude:sonnet' },
      { family: 'codex:default' },
      { family: 'claude:opus' },
    ],
  };

  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();
  const attempted = [];
  const events = [];

  const adapters = {
    executor: {
      // Reservation Case A — each timeout carries reliable usage evidence,
      // so settlement is SETTLED_KNOWN and failover proceeds (see
      // modelSpendReservation.js).
      'claude:sonnet': async () => {
        attempted.push('claude:sonnet');
        throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'executor "claude" did not respond within 600000ms', { usage: { input_tokens: 10, output_tokens: 0 } });
      },
      'codex:default': async () => {
        attempted.push('codex:default');
        throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'executor "codex" did not respond within 600000ms', { usage: { input_tokens: 10, output_tokens: 0 } });
      },
      'claude:opus': async () => {
        attempted.push('claude:opus');
        return { status: 'DONE', model: 'opus' };
      },
    },
  };

  const runtime = createProductionRoleRuntime({
    rolePolicy,
    quotaRegistry,
    providerHealth,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family.split(':')[1] || family,
      provider: family.split(':')[0],
      capabilities: { roles: ['executor'] },
    }),
    adapters,
    onEvent: (e) => events.push(e),
    spendAuthority: new ModelSpendAuthority({ providerCapabilities: testOnlyPermissiveCapabilities }),
  });

  const result = await runtime.invoke('executor', { taskCard: { task_id: 't-1' } });

  assert.deepEqual(attempted, ['claude:sonnet', 'codex:default', 'claude:opus']);
  assert.equal(result.value.status, 'DONE');
  assert.equal(result.value.model, 'opus');
  assert.equal(result.selection.requestedFamily, 'claude:opus');

  // Implementation-retry accounting: candidate-level failover only. Each family
  // is invoked exactly once (no duplicates in `attempted`), the two timeouts are
  // classified as PROVIDER_TIMEOUT failover events, and exactly one candidate
  // succeeds — the runtime never re-runs a family, i.e. never spends an
  // implementation retry to recover a timed-out provider.
  assert.equal(new Set(attempted).size, attempted.length, 'no candidate retried');
  const failed = events.filter((e) => e.type === 'ROLE_INVOCATION_FAILED');
  assert.deepEqual(failed.map((e) => e.failure), ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT']);
  assert.equal(events.filter((e) => e.type === 'ROLE_INVOCATION_SUCCEEDED').length, 1);
});

test('RoleRouter & Runtime: when all candidates are exhausted, throws identifiable error', async () => {
  const rolePolicy = {
    executor: [
      { family: 'claude:sonnet' },
      { family: 'codex:default' },
    ],
  };

  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();
  const attempted = [];

  const adapters = {
    executor: {
      // Reservation Case A — usage known on both, so failover reaches codex
      // before the whole invocation is exhausted (see
      // modelSpendReservation.js).
      'claude:sonnet': async () => {
        attempted.push('claude:sonnet');
        throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'sonnet timeout', { usage: { input_tokens: 10, output_tokens: 0 } });
      },
      'codex:default': async () => {
        attempted.push('codex:default');
        throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, 'codex timeout', { usage: { input_tokens: 10, output_tokens: 0 } });
      },
    },
  };

  const runtime = createProductionRoleRuntime({
    rolePolicy,
    quotaRegistry,
    providerHealth,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.split(':')[0],
      capabilities: { roles: ['executor'] },
    }),
    adapters,
    spendAuthority: new ModelSpendAuthority({ providerCapabilities: testOnlyPermissiveCapabilities }),
  });

  await assert.rejects(
    runtime.invoke('executor', { taskCard: { task_id: 't-1' } }),
    (err) => {
      assert.match(err.message, /timeout/i);
      return true;
    }
  );

  assert.deepEqual(attempted, ['claude:sonnet', 'codex:default']);
});

test('gateRunner: times out hung verification command and returns COMMAND_TIMEOUT in evidence', async () => {
  let killed = false;
  const fakeSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = null; // direct child fallback for test mocks
    child.kill = (sig) => {
      killed = true;
      child.emit('close', null, sig);
    };
    return child;
  };

  const gitEvidenceCollector = {
    collect_evidence({ testResults }) {
      return {
        pass: testResults.pass,
        results: testResults.results,
        changed_files: [],
        git_diff: '',
      };
    },
  };

  const runner = createGateRunner({
    gitEvidenceCollector,
    spawn: fakeSpawn,
    timeoutMs: 25,
  });

  const evidence = await runner.run(['node scripts/live-smoke-active-pools.js']);

  assert.equal(evidence.pass, false);
  assert.equal(evidence.results.length, 1);
  assert.equal(evidence.results[0].pass, false);
  assert.match(evidence.results[0].output, /COMMAND_TIMEOUT/);
  assert.equal(killed, true, 'process tree should be killed on timeout');
});
