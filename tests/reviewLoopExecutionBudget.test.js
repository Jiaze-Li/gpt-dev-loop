// One user instruction == one ReviewLoop execution budget (default 3 review
// rounds). Round 3 still blocking -> HUMAN_REQUIRED, and the loop is TERMINAL:
// re-calling reviewloop_review on it cannot continue it. A separate
// reviewloop_begin (a new task) starts a fresh budget from round 1.
// Cooperative-Worker model — no crypto, no approval tokens, no reset CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const TRUSTED = { codex: 'chatgpt-codex-connector[bot]', claude: 'claude[bot]' };
const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };

function stamp(raw, headSha, reviewer = 'codex') {
  if (!raw) return raw;
  return { login: TRUSTED[reviewer], headSha, head_sha: headSha, ...raw };
}

function mockPrBackend({ heads = ['H1', 'H2', 'H3', 'H4'], results = {} } = {}) {
  const state = { headIdx: 0, triggers: [], waits: 0 };
  return {
    state,
    async getPrHead() { return heads[Math.min(state.headIdx, heads.length - 1)]; },
    advanceHead() { state.headIdx += 1; },
    async findExistingReview() { return null; },
    async postReviewTrigger({ headSha }) { state.triggers.push(headSha); return { id: `c-${headSha}` }; },
    async waitForReview({ headSha }) { state.waits += 1; return stamp(results[headSha] ?? { findings: [P1] }, headSha); },
  };
}

function prController(persistence, prBackend) {
  return createReviewLoopController({
    persistence,
    prBackend,
    supervisorFn: async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
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

test('PR: a loop runs at most 3 review rounds; round 3 still blocking -> HUMAN_REQUIRED', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
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
  const backend = mockPrBackend();
  const controller = prController(persistence, backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId }); backend.advanceHead();
  await controller.review({ loopId }); backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');

  const triggersBefore = backend.state.triggers.length;
  const waitsBefore = backend.state.waits;
  backend.advanceHead(); // "Worker pushed a new HEAD and tried again"
  const r4 = await controller.review({ loopId });
  assert.equal(r4.status, 'HUMAN_REQUIRED', 'still terminal, not REVIEWING/REWORK');
  assert.equal(r4.terminal, true);
  assert.match(r4.reason, /budget is spent|already reached HUMAN_REQUIRED/);
  assert.equal(r4.round, 3, 'the round counter did not advance');
  assert.equal(backend.state.triggers.length, triggersBefore, 'no new external review trigger');
  assert.equal(backend.state.waits, waitsBefore, 'the Reviewer was not re-run');

  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'HUMAN_REQUIRED');
});

test('PR: a new independent reviewloop_begin starts a fresh budget from round 1', async () => {
  const persistence = new MemoryPersistence();
  const b1 = mockPrBackend();
  const c1 = prController(persistence, b1);
  const first = await c1.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await c1.review({ loopId: first.loopId }); b1.advanceHead();
  await c1.review({ loopId: first.loopId }); b1.advanceHead();
  assert.equal((await c1.review({ loopId: first.loopId })).status, 'HUMAN_REQUIRED');

  // The user says "continue PR #4" -> a new task -> a new loop, fresh budget.
  const b2 = mockPrBackend({ heads: ['H9'], results: { H9: { findings: [] } } });
  const c2 = prController(persistence, b2);
  const second = await c2.begin({ goal: 'continue PR #4', cwd: '/r', prNumber: 4 });
  assert.notEqual(second.loopId, first.loopId);
  assert.equal(second.status, 'READY');
  const r = await c2.review({ loopId: second.loopId });
  assert.equal(r.round, 1, 'the fresh loop starts at round 1');
  assert.equal(r.status, 'PASS');
});

test('PR: a settled-but-unusable Supervisor result degrades to a plain REWORK — loop not stalled, budget not spent', async () => {
  const persistence = new MemoryPersistence();
  // Same P1 on H1 and H2 -> round 2 triggers the Supervisor.
  const backend = mockPrBackend({ heads: ['H1', 'H2', 'H3', 'H4'] });
  let supCalls = 0;
  const controller = createReviewLoopController({
    persistence,
    prBackend: backend,
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
  const backend = mockPrBackend({ heads: ['H1', 'H2', 'H3', 'H4'] });
  const controller = createReviewLoopController({
    persistence,
    prBackend: backend,
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
  const backend = mockPrBackend({ heads: ['H1'], results: { H1: { findings: [{ severity: 'P3', file: 'a', title: 'nit' }] } } });
  const controller = prController(persistence, backend);
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
});
