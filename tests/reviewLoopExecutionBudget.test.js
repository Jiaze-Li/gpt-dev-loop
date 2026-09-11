// One user instruction == one ReviewLoop execution budget (default 3 review
// rounds). Round 3 still blocking -> HUMAN_REQUIRED, and the loop is TERMINAL:
// re-calling reviewloop_review on it cannot continue it. A separate
// reviewloop_begin (a new task) starts a fresh budget from round 1.
// Cooperative-Worker model — no crypto, no approval tokens, no reset CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence, mockPrBackend, prTestFakes } from './helpers/reviewLoopHarness.js';

const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };

// A PR-review controller wired to the ONE unified engine: deterministic Gate +
// internal Reviewer. `resultByHead` maps a PR HEAD SHA to the reviewer payload.
function prController(persistence, prBackend, {
  resultByHead = {}, defaultResult = { findings: [P1] }, supervisorFn,
} = {}) {
  return createReviewLoopController({
    persistence,
    prBackend,
    ...prTestFakes(prBackend),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, results: [], fingerprint: `g${Math.random()}`, failureIdentities: [] }),
    reviewerFn: async () => ({
      value: resultByHead[prBackend.head()] ?? defaultResult,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'test-reviewer',
    }),
    supervisorFn: supervisorFn
      ?? (async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } })),
  });
}

function localController(persistence, { reviews }) {
  let i = 0;
  return createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: `fp${i}`, diff: `diff ${i}` }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: `g${i}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo'], manifestFingerprint: 'mf' }),
    reviewerFn: async () => { const r = reviews[Math.min(i, reviews.length - 1)]; i += 1; return { value: r, usage: { input_tokens: 1, output_tokens: 1 } }; },
    supervisorFn: async () => ({ value: { guidance: 'try again', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

const PR_HEADS = ['H1', 'H2', 'H3', 'H4'];

test('PR: a loop runs at most 3 review rounds; round 3 still blocking -> HUMAN_REQUIRED', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  const r1 = await controller.review({ loopId }); assert.equal(r1.status, 'REWORK'); assert.equal(r1.round, 1);
  backend.advanceHead();
  const r2 = await controller.review({ loopId }); assert.equal(r2.status, 'REWORK'); assert.equal(r2.round, 2);
  backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.equal(r3.round, 3);
});

test('PR: HUMAN_REQUIRED is terminal — a further reviewloop_review cannot continue the loop', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId }); backend.advanceHead();
  await controller.review({ loopId }); backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');

  const diffReadsBefore = backend.state.diffReads;
  backend.advanceHead(); // "Worker pushed a new HEAD and tried again"
  const r4 = await controller.review({ loopId });
  assert.equal(r4.status, 'HUMAN_REQUIRED', 'still terminal, not REVIEWING/REWORK');
  assert.equal(r4.terminal, true);
  assert.match(r4.reason, /budget is spent|already reached HUMAN_REQUIRED/);
  assert.equal(r4.round, 3, 'the round counter did not advance');
  assert.equal(backend.state.diffReads, diffReadsBefore, 'the PR was not re-reviewed');

  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'HUMAN_REQUIRED');
});

test('PR: a new independent reviewloop_begin starts a fresh budget from round 1', async () => {
  const persistence = new MemoryPersistence();
  const b1 = mockPrBackend({ heads: PR_HEADS });
  const c1 = prController(persistence, b1);
  const first = await c1.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await c1.review({ loopId: first.loopId }); b1.advanceHead();
  await c1.review({ loopId: first.loopId }); b1.advanceHead();
  assert.equal((await c1.review({ loopId: first.loopId })).status, 'HUMAN_REQUIRED');

  // The user says "continue PR #4" -> a new task -> a new loop, fresh budget.
  const b2 = mockPrBackend({ heads: ['H9'] });
  const c2 = prController(persistence, b2, { defaultResult: { findings: [] } });
  const second = await c2.begin({ goal: 'continue PR #4', cwd: '/r', prNumber: 4 });
  assert.notEqual(second.loopId, first.loopId);
  assert.equal(second.status, 'READY');
  const r = await c2.review({ loopId: second.loopId });
  assert.equal(r.round, 1, 'the fresh loop starts at round 1');
  assert.equal(r.status, 'PASS');
});

test('PR: a settled-but-unusable Supervisor result degrades to a plain REWORK — loop not stalled, budget not spent', async () => {
  const persistence = new MemoryPersistence();
  // Same P1 on every HEAD -> round 2 triggers the Supervisor.
  const backend = mockPrBackend({ heads: PR_HEADS });
  let supCalls = 0;
  const controller = prController(persistence, backend, {
    // A call that SETTLES (known usage) but yields no usable guidance -> a
    // degradable transient failure, NOT terminal.
    supervisorFn: async () => {
      supCalls += 1;
      return { value: { guidance: '', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK', 'a transient Supervisor failure does not stall the loop');
  assert.equal(r2.round, 2);
  assert.equal(r2.supervisorGuidance, null);
  assert.ok(supCalls >= 1, 'the Supervisor was attempted');
  assert.ok(
    (r2.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE'),
    'the transient Supervisor failure is surfaced as a non-blocking safety event',
  );

  const persisted = await persistence.readWorkflowState(loopId);
  assert.notEqual(persisted.reviewLoop.budgetExhausted, true, 'the budget was not spent');
  assert.equal(persisted.reviewLoop.supervisorInvoked, false, 'a later round may retry the Supervisor');

  // Round 3 still blocking -> the round cap is still the circuit-breaker.
  backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.equal(r3.round, 3);
  assert.equal(r3.terminal, true);
});

test('PR: a Supervisor call dispatched with unresolvable usage is the deliberate fail-closed stop (not a degrade)', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: PR_HEADS });
  const controller = prController(persistence, backend, {
    // Provider threw mid-call: the reservation cannot be settled (UNKNOWN != ZERO).
    supervisorFn: async () => { throw new Error('socket hang up'); },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  assert.equal((await controller.review({ loopId })).status, 'REWORK');
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED', 'unresolved model spend fails closed');
  assert.notEqual(r2.terminal, true, 'a spend-safety stop is not budget-exhausted');
  assert.match(r2.reason, /model spend blocked/i);

  const persisted = await persistence.readWorkflowState(loopId);
  assert.notEqual(persisted.reviewLoop.budgetExhausted, true);
});

test('PR: a clean review PASSes normally', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend({ heads: ['H1'] });
  const controller = prController(persistence, backend, { defaultResult: { findings: [{ severity: 'P3', file: 'a', title: 'nit' }] } });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal((await controller.review({ loopId })).status, 'PASS');
});

test('LOCAL: 3 rounds still blocking -> HUMAN_REQUIRED, terminal; a fresh begin restarts at round 1; clean -> PASS', async () => {
  const persistence = new MemoryPersistence();
  const blocking = { findings: [{ severity: 'P1', file: 'a.js', line: 1, title: 'bug' }] };
  const c1 = localController(persistence, { reviews: [blocking, blocking, blocking] });
  const { loopId } = await c1.begin({ goal: 'g', cwd: '/r' });
  assert.equal((await c1.review({ loopId })).status, 'REWORK');
  assert.equal((await c1.review({ loopId })).status, 'REWORK');
  const r3 = await c1.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.equal(r3.round, 3);

  const r4 = await c1.review({ loopId });
  assert.equal(r4.status, 'HUMAN_REQUIRED');
  assert.equal(r4.terminal, true);
  assert.equal(r4.round, 3);

  const c2 = localController(persistence, { reviews: [{ findings: [] }] });
  const fresh = await c2.begin({ goal: 'continue', cwd: '/r' });
  const rf = await c2.review({ loopId: fresh.loopId });
  assert.equal(rf.round, 1);
  assert.equal(rf.status, 'PASS');

  // K: LOCAL is not regressed by the PR snapshot-correctness machinery — no
  // exact-HEAD worktree, no repository identity check, no PR audit trail.
  const persistedFresh = await persistence.readWorkflowState(fresh.loopId);
  assert.deepEqual(persistedFresh.reviewLoop.audit ?? [], [], 'a LOCAL loop never writes a PR audit record');
});
