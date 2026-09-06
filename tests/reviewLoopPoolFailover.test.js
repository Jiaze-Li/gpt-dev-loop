// Stage 4 — pool composition + bounded failover across the CLI-backed families,
// plus Supervisor deterministic routing regressions. No real provider call:
// every transport is a deterministic fake or an injected function.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { ProviderHealthRegistry, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { CLI_FAILURE } from '../src/reviewloop/adapters/boundedCli.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const RUNTIME_BOTH = {
  'codex:default': { available: true, reason: 'ok' },
  'claude:opus': { available: true, reason: 'ok' },
};

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = (s) => { (child.killCalls ??= []).push(s); return true; };
    const r = handler({ command, args }) ?? {};
    queueMicrotask(() => {
      if (r.spawnError) { child.emit('error', Object.assign(new Error('x'), { code: r.spawnError })); return; }
      if (r.writesOutFile) {
        const i = args.indexOf('-o');
        if (i !== -1) writeFileSync(args[i + 1], r.writesOutFile);
      }
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('pool: gemini unavailable + codex runtime available -> supervisor selects codex and its CLI transport is wired', async () => {
  const spawn = fakeSpawn(() => ({
    writesOutFile: '{"guidance":"do x","recommendation":"REWORK"}',
    stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }) + '\n',
  }));
  const health = new ProviderHealthRegistry();
  health.record('agy:gemini', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}), providerHealth: health, transportRuntime: RUNTIME_BOTH, spawn,
  });
  const sel = pool.route('supervisor');
  assert.equal(sel.family, 'codex:default');
  assert.equal(typeof sel.transport, 'function');
  const out = await sel.transport('P');
  assert.match(out.text, /guidance/);
  assert.equal(spawn.calls[0].command, 'codex');
  assert.ok(spawn.calls[0].args.includes('--ephemeral'));
});

test('pool: runtimeStatus is a pure function of its inputs (deterministic)', () => {
  const mk = () => createReviewLoopProviderPool({
    callAgy: async () => ({}), transportRuntime: RUNTIME_BOTH, spawn: fakeSpawn(() => ({})),
  }).runtimeStatus;
  assert.deepEqual(mk(), mk());
});

test('pool: an unavailable CLI runtime records UNAVAILABLE health and is never selected', () => {
  const health = new ProviderHealthRegistry();
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    providerHealth: health,
    transportRuntime: {
      'codex:default': { available: false, reason: 'CLI not installed' },
      'claude:opus': { available: false, reason: 'not logged in' },
    },
  });
  assert.equal(pool.runtimeStatus['codex:default'].runtimeAvailable, false);
  assert.match(pool.runtimeStatus['codex:default'].reason, /runtime unavailable: CLI not installed/);
  // supervisor still resolves, skipping both CLI families
  assert.equal(pool.route('supervisor').family, 'agy:gemini');
});

test('controller: a CLI AUTH_FAILED (not logged in) fails over to the next family', async () => {
  const persistence = new MemoryPersistence();
  const tried = [];
  let n = 0;
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => {
      const family = n === 0 ? 'codex:default' : 'agy:gpt-oss';
      return { family, provider: n === 0 ? 'codex' : 'agy', model: null, transport: async () => ({}) };
    },
    recordProviderFailure: () => {},
    reviewerFn: async ({ selection }) => {
      tried.push(selection.family);
      if (n++ === 0) {
        throw Object.assign(new Error('codex exec failed (exit 1)'), { code: CLI_FAILURE.AUTH_FAILED });
      }
      return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(tried, ['codex:default', 'agy:gpt-oss']);

  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map((x) => x.family).sort(), ['agy:gpt-oss', 'codex:default']);
});

test('controller: every family unauthenticated -> failover exhausts and rethrows the last error', async () => {
  const persistence = new MemoryPersistence();
  const families = ['agy:gpt-oss', 'codex:default', 'claude:opus'];
  let i = 0;
  const controller = createReviewLoopController({
    persistence,
    routeReviewerFn: () => (i < families.length ? { family: families[i], provider: 'x', model: null, transport: async () => ({}) } : null),
    recordProviderFailure: () => {},
    reviewerFn: async () => {
      i += 1;
      throw Object.assign(new Error('not logged in'), { code: CLI_FAILURE.AUTH_FAILED });
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  // no eligible provider -> fail-closed, never PASS
  assert.notEqual(r.status, 'PASS');
});
