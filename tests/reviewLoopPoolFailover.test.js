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
      'claude:opus': { available: false, reason: 'not authenticated' },
    },
  });
  assert.equal(pool.runtimeStatus['codex:default'].runtimeAvailable, false);
  assert.match(pool.runtimeStatus['codex:default'].reason, /runtime unavailable: CLI not installed/);
  assert.match(pool.runtimeStatus['claude:opus'].reason, /not authenticated/);
  assert.equal(pool.route('supervisor').family, 'agy:gpt-oss'); // gemini high-context: excluded from automatic routing
});

test('controller: post-dispatch AUTH_REJECTED has unknown spend and MUST NOT fail over', async () => {
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
      n += 1;
      throw Object.assign(new Error('codex exec failed after prompt-bearing invocation: 401'), { code: CLI_FAILURE.AUTH_REJECTED });
    },
    captureBaselineFn: async () => ({ head: 'B', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ fingerprint: 'd', diff: 'x', changedFiles: ['a.js'], currentHead: 'B', evidenceComplete: true, noWorkerChangeYet: false }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.deepEqual(tried, ['codex:default'], 'unknown-spend auth rejection must not reach a second family');

  const state = await persistence.readWorkflowState(loopId);
  const reservations = Object.values(state.modelSpendReservations ?? {});
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].family, 'codex:default');
  assert.equal(reservations[0].status, 'UNRESOLVED');
});

test('pool: locally unauthenticated CLI families are skipped deterministically before model dispatch', () => {
  const health = new ProviderHealthRegistry();
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    providerHealth: health,
    transportRuntime: {
      'codex:default': { available: false, reason: 'not authenticated' },
      'claude:opus': { available: false, reason: 'not authenticated' },
    },
  });
  assert.equal(pool.runtimeStatus['codex:default'].runtimeAvailable, false);
  assert.equal(pool.runtimeStatus['claude:opus'].runtimeAvailable, false);
  assert.equal(pool.route('reviewer').family, 'agy:gpt-oss');
  assert.equal(pool.route('supervisor').family, 'agy:gpt-oss'); // gemini high-context: excluded from automatic routing
});
