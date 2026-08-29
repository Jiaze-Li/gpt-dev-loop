import test from 'node:test';
import assert from 'node:assert/strict';

import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { isCancellation } from '../src/orchestrator/errors.js';
import { QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { callCodex } from '../src/orchestrator/adapters/codexSupervisorProvider.js';

// P1-2: a cancellation (AbortSignal / AGY_ABORTED) must terminate the whole
// role invocation immediately. It must trigger ZERO provider failover, must
// NOT poison provider-health/quota state, and must NOT be classified as
// PROVIDER_UNAVAILABLE.

function buildRuntime({ adapters, signal } = {}) {
  const quotaRegistry = new QuotaPoolRegistry({
    filePath: null,
    topology: { p1: ['p1'], p2: ['p2'], p3: ['p3'] },
  });
  const providerHealth = new ProviderHealthRegistry();
  const events = [];
  const runtime = createProductionRoleRuntime({
    rolePolicy: { supervisor: [{ family: 'p1' }, { family: 'p2' }, { family: 'p3' }] },
    quotaRegistry,
    providerHealth,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family,
      capabilities: { roles: ['supervisor'] },
    }),
    adapters: { supervisor: adapters },
    onEvent: (e) => events.push(e),
    signal,
  });
  return { runtime, quotaRegistry, providerHealth, events };
}

test('P1-2. AbortSignal during provider 1 aborts the invocation with zero failover and no health penalty', async () => {
  const controller = new AbortController();
  let p2Calls = 0;
  let p3Calls = 0;
  let p1Started = false;

  const adapters = {
    p1: async () => {
      p1Started = true;
      // Block until aborted, then surface a typed cancellation like a real
      // transport (agy AGY_ABORTED).
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('agy call cancelled'), { code: 'AGY_ABORTED' });
    },
    p2: async () => { p2Calls += 1; return { action: 'WORKFLOW_DONE' }; },
    p3: async () => { p3Calls += 1; return { action: 'WORKFLOW_DONE' }; },
  };

  const { runtime, quotaRegistry, providerHealth } = buildRuntime({ adapters, signal: controller.signal });

  const invocation = runtime.invoke('supervisor', {}, { operationId: 'wf-abort' });
  // Let p1 start, then abort.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(p1Started, true);
  controller.abort();

  await assert.rejects(invocation, (err) => {
    assert.ok(isCancellation(err, controller.signal));
    return true;
  });

  // Zero failover.
  assert.equal(p2Calls, 0, 'provider 2 must never be called after cancellation');
  assert.equal(p3Calls, 0, 'provider 3 must never be called after cancellation');

  // No provider-health penalty, no quota cooldown from the cancellation.
  assert.equal(providerHealth.get('p1').status, 'UNKNOWN');
  assert.equal(quotaRegistry.get('p1').status, 'UNKNOWN');
});

test('P1-2. AGY_ABORTED error code alone stops failover even without an aborted signal', async () => {
  let p2Calls = 0;
  let p3Calls = 0;

  const adapters = {
    p1: async () => {
      throw Object.assign(new Error('agy call cancelled'), { code: 'AGY_ABORTED' });
    },
    p2: async () => { p2Calls += 1; return { action: 'WORKFLOW_DONE' }; },
    p3: async () => { p3Calls += 1; return { action: 'WORKFLOW_DONE' }; },
  };

  const { runtime, quotaRegistry, providerHealth } = buildRuntime({ adapters });

  await assert.rejects(
    runtime.invoke('supervisor', {}, { operationId: 'wf-agy-aborted' }),
    (err) => err.code === 'AGY_ABORTED'
  );

  assert.equal(p2Calls, 0);
  assert.equal(p3Calls, 0);
  assert.equal(providerHealth.get('p1').status, 'UNKNOWN', 'AGY_ABORTED must not be classified as PROVIDER_UNAVAILABLE');
  assert.equal(quotaRegistry.get('p1').status, 'UNKNOWN');
});

test('P1-2. callCodex rejects with a cancellation before launch when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    callCodex({ prompt: 'x', spawn: () => { spawned = true; throw new Error('should not spawn'); }, signal: controller.signal }),
    (err) => {
      assert.equal(err.cancelled, true);
      assert.equal(err.code, 'PROVIDER_CANCELLED');
      return true;
    }
  );
  assert.equal(spawned, false);
});

test('P1-2. callCodex kills an in-flight child on abort instead of running to timeout', async () => {
  const controller = new AbortController();
  const child = new (await import('node:events')).EventEmitter();
  child.stdout = new (await import('node:events')).EventEmitter();
  child.stderr = new (await import('node:events')).EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null, 'SIGKILL'); };

  const started = Date.now();
  const p = callCodex({
    prompt: 'x',
    timeoutMs: 60_000,
    spawn: () => child,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(p, (err) => {
    assert.equal(err.cancelled, true);
    return true;
  });
  assert.equal(killed, true);
  assert.ok(Date.now() - started < 5_000, 'must not wait for the full timeout');
});
