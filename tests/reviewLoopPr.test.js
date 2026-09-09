import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const TRUSTED_LOGIN = { codex: 'chatgpt-codex-connector[bot]', claude: 'claude[bot]' };

// A raw review carries a real trusted GitHub login + the exact reviewed HEAD,
// exactly as the real GitHub backend surfaces before checkPrReviewTrust().
function stamp(raw, headSha, reviewer) {
  if (!raw) return raw;
  return { login: TRUSTED_LOGIN[reviewer], headSha, head_sha: headSha, ...raw };
}

function mockPrBackend({ heads = ['H1'], existing = {}, results = {}, reviewer = 'codex' } = {}) {
  const state = { headIdx: 0, triggers: [], waits: 0 };
  return {
    state,
    async getPrHead() { return heads[Math.min(state.headIdx, heads.length - 1)]; },
    advanceHead() { state.headIdx += 1; },
    async findExistingReview({ headSha }) { return stamp(existing[headSha], headSha, reviewer); },
    async postReviewTrigger({ headSha, reviewer: r }) { state.triggers.push({ headSha, reviewer: r }); return { id: `comment-${headSha}` }; },
    async waitForReview({ headSha }) {
      state.waits += 1;
      return stamp(results[headSha], headSha, reviewer); // null => detach -> WAITING_FOR_REVIEW
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

// B9 — PR reviewer default is codex, never internal.
test('reviewloop_begin({ prNumber }) with no reviewer defaults to codex', async () => {
  const backend = mockPrBackend({ heads: ['H1'], results: { H1: { findings: [] } } });
  const { controller, persistence } = build({ prBackend: backend });
  const begun = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 }); // no reviewer
  assert.equal(begun.reviewer, 'codex');
  const state = await persistence.readWorkflowState(begun.loopId);
  assert.equal(state.reviewLoop.objective.reviewer, 'codex');
  await controller.review({ loopId: begun.loopId });
  assert.deepEqual(backend.state.triggers.map((t) => t.reviewer), ['codex']);
});

test('a cancelled PR review never posts an external trigger', async () => {
  const backend = mockPrBackend({
    heads: ['H1'],
    results: { H1: { findings: [{ severity: 'P1', file: 'a.js', title: 'bug' }], head_sha: 'H1' } },
  });
  const { controller } = build({ prBackend: backend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const ac = new AbortController();
  ac.abort();
  const r = await controller.review({ loopId, signal: ac.signal });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.notEqual(r.terminal, true, 'a cancellation is not budget-exhausted');
  assert.equal(backend.state.triggers.length, 0, 'no @codex trigger posted for an abandoned request');
  assert.equal(backend.state.waits, 0, 'never waited on a review');
});

test('reviewloop_begin threads the caller AbortSignal into the baseline Gate', async () => {
  const persistence = new MemoryPersistence();
  let gateSawSignal = 'not-called';
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo hi'], manifestFingerprint: 'mf' }),
    runGateFn: async ({ signal }) => { gateSawSignal = signal ? 'yes' : 'no'; return { verdict: 'PASS', pass: true, results: [], evidence: {} }; },
  });
  const ok = new AbortController();
  await controller.begin({ goal: 'g', cwd: '/r', signal: ok.signal });
  assert.equal(gateSawSignal, 'yes', 'the Gate invocation received the request signal');

  // An already-cancelled begin aborts before the Gate runs at all.
  gateSawSignal = 'not-called';
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => controller.begin({ goal: 'g', cwd: '/r', signal: cancelled.signal }),
    /cancelled by the caller/,
  );
  assert.equal(gateSawSignal, 'not-called', 'the Gate never ran for a cancelled begin');
});

test('an internal identity can never be a PR reviewer', async () => {
  const { createReviewObjective } = await import('../src/reviewloop/objective.js');
  assert.throws(() => createReviewObjective({ loopId: 'l', goal: 'g', mode: 'PR', prNumber: 4, reviewer: 'internal' }), /PR reviewer must be one of/);
});

test('PR mode with an unknown reviewer is rejected', async () => {
  const { createReviewObjective } = await import('../src/reviewloop/objective.js');
  assert.throws(() => createReviewObjective({ loopId: 'l', goal: 'g', mode: 'PR', prNumber: 4, reviewer: 'gpt-9' }), /PR reviewer must be one of/);
});
