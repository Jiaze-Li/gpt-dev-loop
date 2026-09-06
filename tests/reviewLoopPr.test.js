import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function mockPrBackend({ heads = ['H1'], existing = {}, results = {} } = {}) {
  const state = { headIdx: 0, triggers: [], waits: 0 };
  return {
    state,
    async getPrHead() { return heads[Math.min(state.headIdx, heads.length - 1)]; },
    advanceHead() { state.headIdx += 1; },
    async findExistingReview({ headSha }) { return existing[headSha] ?? null; },
    async postReviewTrigger({ headSha, reviewer }) { state.triggers.push({ headSha, reviewer }); return { id: `comment-${headSha}` }; },
    async waitForReview({ headSha }) {
      state.waits += 1;
      return results[headSha] ?? null; // null => detach -> WAITING_FOR_REVIEW
    },
  };
}

function build({ prBackend }) {
  const persistence = new MemoryPersistence();
  const calls = { supervisor: 0 };
  const controller = createReviewLoopController({
    persistence,
    prBackend,
    supervisorFn: async () => { calls.supervisor += 1; return { value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  return { controller, persistence, calls };
}

test('existing current-head review is reused — no new @codex trigger', async () => {
  const backend = mockPrBackend({
    heads: ['H1'],
    existing: { H1: { findings: [{ severity: 'P3', file: 'a.js', title: 'nit' }], head_sha: 'H1' } },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'fix pr', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(backend.state.triggers.length, 0);
});

test('no current-head review -> exactly one trigger, then findings', async () => {
  const backend = mockPrBackend({
    heads: ['H1'],
    results: { H1: { findings: [{ severity: 'P1', file: 'a.js', title: 'bug' }], head_sha: 'H1' } },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'fix pr', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(backend.state.triggers.length, 1);
  assert.equal(r.status, 'REWORK');
  assert.equal(r.blockingFindings.length, 1);
});

test('P3-only PR review -> PASS', async () => {
  const backend = mockPrBackend({ heads: ['H1'], results: { H1: { findings: [{ severity: 'P3', file: 'a', title: 'n' }], head_sha: 'H1' } } });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal((await controller.review({ loopId })).status, 'PASS');
});

test('detached wait -> WAITING_FOR_REVIEW is durable and does not re-trigger on resume', async () => {
  const backend = mockPrBackend({ heads: ['H1'], results: { H1: null } });
  const { controller, persistence } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'WAITING_FOR_REVIEW');
  assert.equal(backend.state.triggers.length, 1);
  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.state, 'WAITING_FOR_REVIEW');
  assert.equal(persisted.reviewLoop.pendingExternalTrigger.head, 'H1');
  // resume: still no result -> still WAITING, still no duplicate trigger
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'WAITING_FOR_REVIEW');
  assert.equal(backend.state.triggers.length, 1);
});

test('local fix not pushed (PR head unchanged, prior actionable) -> PUSH_REQUIRED, no re-review', async () => {
  const backend = mockPrBackend({
    heads: ['H1'],
    results: { H1: { findings: [{ severity: 'P1', file: 'a.js', title: 'bug' }], head_sha: 'H1' } },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });                 // round 1: REWORK on H1
  const r2 = await controller.review({ loopId });       // head still H1
  assert.equal(r2.status, 'PUSH_REQUIRED');
  assert.equal(backend.state.triggers.length, 1);       // no second trigger
});

test('new head after push -> old review invalidated, one fresh trigger for H2', async () => {
  const backend = mockPrBackend({
    heads: ['H1', 'H2'],
    results: {
      H1: { findings: [{ severity: 'P1', file: 'a.js', title: 'bug' }], head_sha: 'H1' },
      H2: { findings: [{ severity: 'P3', file: 'a.js', title: 'nit' }], head_sha: 'H2' },
    },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });            // H1 REWORK
  backend.advanceHead();                          // worker pushed H2
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.triggers.map((t) => t.headSha), ['H1', 'H2']);
});

test('round 3 still blocking -> HUMAN_REQUIRED', async () => {
  const backend = mockPrBackend({
    heads: ['H1', 'H2', 'H3'],
    results: {
      H1: { findings: [{ severity: 'P1', file: 'a.js', title: 'b' }], head_sha: 'H1' },
      H2: { findings: [{ severity: 'P1', file: 'a.js', title: 'b' }], head_sha: 'H2' },
      H3: { findings: [{ severity: 'P1', file: 'a.js', title: 'b' }], head_sha: 'H3' },
    },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId }); backend.advanceHead();
  await controller.review({ loopId }); backend.advanceHead();
  const r3 = await controller.review({ loopId });
  assert.equal(r3.status, 'HUMAN_REQUIRED');
});

test('ReviewLoop never pushes / merges — controller exposes no such op', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/reviewloop/prReviewController.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /git push|gh pr merge|forcePush|--force/);
});
