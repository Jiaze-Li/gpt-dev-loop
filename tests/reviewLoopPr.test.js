// PR target: reviewed by the ONE unified ReviewLoop engine.
//
// A PR is a review TARGET (PR base -> exact PR HEAD), never a reviewer
// transport. The same deterministic Gate, internal Reviewer routing,
// Supervisor, spend accounting and 3-round convergence policy that judge a
// LOCAL target judge a PR target. There is no `@codex review` / `@claude
// review`, no external-review polling, no reaction-as-clean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence, mockPrBackend, finding } from './helpers/reviewLoopHarness.js';

function build({
  prBackend, reviews = [], gates = [], supervisorReplies = [], onReviewer, persistence = new MemoryPersistence(),
} = {}) {
  const calls = { reviewer: 0, supervisor: 0, gate: 0 };
  let ri = 0;
  let gi = 0;
  let si = 0;
  const controller = createReviewLoopController({
    persistence,
    prBackend,
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => {
      const g = gates[gi] ?? gates[gates.length - 1] ?? { verdict: 'PASS' };
      gi += 1;
      calls.gate += 1;
      return {
        pass: g.verdict !== 'FAIL', results: [], fingerprint: `g${gi}`, failureIdentities: [], ...g,
      };
    },
    reviewerFn: async (args) => {
      const r = reviews[ri] ?? reviews[reviews.length - 1] ?? { findings: [] };
      ri += 1;
      calls.reviewer += 1;
      onReviewer?.(args);
      return { value: r, usage: { input_tokens: 3, output_tokens: 2 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => {
      const s = supervisorReplies[si] ?? { guidance: 'g', recommendation: 'REWORK' };
      si += 1;
      calls.supervisor += 1;
      return { value: s, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  return { controller, persistence, calls };
}

// A -- PR target uses the internal Reviewer pool, not an external trigger.
test('A: PR review runs the internal Reviewer, not an external trigger', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller, calls } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId, ...begun } = await controller.begin({ goal: 'fix pr', cwd: '/r', prNumber: 4 });
  assert.equal(begun.mode, 'PR');
  assert.equal(begun.reviewer, 'internal');
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(calls.reviewer, 1);
  assert.equal(calls.gate, 1);
  assert.equal(typeof backend.postReviewTrigger, 'undefined');
  assert.equal(typeof backend.waitForReview, 'undefined');
});

// B -- the PR base->head delta is the Reviewer evidence.
test('B: the Reviewer sees the PR base->HEAD diff', async () => {
  const backend = mockPrBackend({
    base: 'BASE9', heads: ['H1'],
    diffByHead: { H1: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+PR_DIFF_BODY\n' },
  });
  let seen = null;
  const { controller } = build({
    prBackend: backend, reviews: [{ findings: [] }], onReviewer: (a) => { seen = a; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 7 });
  await controller.review({ loopId });
  assert.match(seen.diff, /PR_DIFF_BODY/);
  assert.deepEqual(seen.changedFiles, ['f.js']);
});

// C -- CLEAN + final HEAD unchanged -> PASS.
test('C: Reviewer CLEAN and the PR HEAD still current -> PASS', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller } = build({ prBackend: backend, reviews: [{ findings: [finding('P3')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
});

// D -- CLEAN but the PR HEAD moved during the review -> never PASS the stale review.
test('D: Reviewer CLEAN but the PR HEAD moved -> not PASS', async () => {
  // getPrHead: 1st (observed)=H1, every later call=H2 -> the pre-PASS recheck
  // and every rebind see a moving HEAD.
  const backend = mockPrBackend({ movingHead: true });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'WAITING_FOR_REVIEW');
  const st = await persistence.readWorkflowState(loopId);
  assert.notEqual(st.reviewLoop.state, 'PASS');
  // The stale-HEAD event was recorded.
  assert.ok((r.safetyEvents ?? []).some((e) => e.code === 'REVIEWLOOP_PR_HEAD_MOVED_DURING_REVIEW'));
});

// E -- blocking finding -> REWORK; a new HEAD lets the next round run.
test('E: blocking PR finding -> REWORK, then the next HEAD -> a fresh round', async () => {
  const backend = mockPrBackend({ heads: ['H1', 'H2'] });
  const { controller } = build({
    prBackend: backend,
    reviews: [{ findings: [finding('P1')] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.round, 1);
  assert.equal(r1.blockingFindings.length, 1);

  // No push yet -> PUSH_REQUIRED, Reviewer not re-run.
  const rp = await controller.review({ loopId });
  assert.equal(rp.status, 'PUSH_REQUIRED');

  backend.advanceHead(); // Worker pushed H2
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(r2.round, 2);
});

// F -- durable audit record.
test('F: every PR round writes a recoverable, tamper-evident audit record', async () => {
  const backend = mockPrBackend({ base: 'BASEabc', heads: ['H1'] });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'audit me', cwd: '/r', prNumber: 12 });
  await controller.review({ loopId });
  const audit = (await persistence.readWorkflowState(loopId)).reviewLoop.audit;
  assert.equal(audit.length, 1);
  const rec = audit[0];
  assert.equal(rec.target.type, 'PR');
  assert.equal(rec.target.repository, 'acme/repo');
  assert.equal(rec.target.prNumber, 12);
  assert.equal(rec.target.baseSha, 'BASEabc');
  assert.equal(rec.target.reviewedHeadSha, 'H1');
  assert.equal(rec.target.finalObservedHeadSha, 'H1');
  assert.equal(rec.target.headStillCurrent, true);
  assert.equal(rec.result, 'PASS');
  assert.equal(rec.review.reviewer, 'internal');
  assert.ok(rec.gate && rec.gate.verdict);
  assert.ok(rec.spend && typeof rec.spend.reviewerCalls === 'number');
  assert.ok(rec.objective.fingerprint);
  assert.ok(rec.targetFingerprint);
});

// G -- resume keeps the exact PR snapshot identity.
test('G: a resumed PR loop keeps its frozen snapshot identity', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1', 'H2'] });
  const persistence = new MemoryPersistence();
  const { controller } = build({
    prBackend: backend, persistence, reviews: [{ findings: [finding('P1')] }, { findings: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });
  const obj = (await persistence.readWorkflowState(loopId)).reviewLoop.objective;
  assert.equal(obj.prBaseSha, 'B1');
  assert.equal(obj.reviewedHeadSha, 'H1');
  assert.equal(obj.prNumber, 4);
  // A fresh controller over the SAME persistence resumes without losing identity.
  const { controller: c2 } = build({ prBackend: backend, persistence, reviews: [{ findings: [] }] });
  backend.advanceHead();
  const r = await c2.review({ loopId });
  assert.equal(r.status, 'PASS');
  const obj2 = (await persistence.readWorkflowState(loopId)).reviewLoop.objective;
  assert.equal(obj2.reviewedHeadSha, 'H1', 'the frozen begin-time HEAD is unchanged');
});

// H -- tampered persisted PR identity -> objective integrity fails closed.
test('H: editing the persisted PR base/HEAD SHA fails the objective integrity check', async () => {
  const backend = mockPrBackend({ base: 'B1', heads: ['H1'] });
  const { controller, persistence } = build({ prBackend: backend, reviews: [{ findings: [] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });

  const raw = await persistence.readWorkflowState(loopId);
  raw.reviewLoop.objective.prBaseSha = 'ATTACKER_BASE';
  await persistence.writeWorkflowState(loopId, raw);

  await assert.rejects(() => controller.review({ loopId }), /weakened|integrity|fingerprint/i);
});

// I -- no external-review path is ever taken.
test('I: the PR review path never calls an external reviewer trigger or poll', async () => {
  const backend = mockPrBackend({ heads: ['H1', 'H2', 'H3'] });
  let externalTouch = 0;
  const proxied = new Proxy(backend, {
    get(t, p) {
      if (['postReviewTrigger', 'waitForReview', 'findExistingReview', 'listIssueCommentReactions', 'listReviews'].includes(p)) {
        externalTouch += 1;
      }
      return t[p];
    },
  });
  const { controller } = build({ prBackend: proxied, reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  await controller.review({ loopId });
  backend.advanceHead();
  await controller.review({ loopId });
  assert.equal(externalTouch, 0);
});

// PR reviewer identity is always internal — no external reviewer concept.
test('PR objective reviewer is always internal', async () => {
  const { createReviewObjective } = await import('../src/reviewloop/objective.js');
  const o = createReviewObjective({
    loopId: 'l', goal: 'g', mode: 'PR', prNumber: 4, prBaseSha: 'B', reviewedHeadSha: 'H',
  });
  assert.equal(o.reviewer, 'internal');
});

// begin fails closed when the PR snapshot cannot be resolved.
test('begin fails closed when the PR base SHA cannot be resolved', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  backend.getPrBaseSha = async () => null;
  const { controller } = build({ prBackend: backend });
  await assert.rejects(
    () => controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
    /cannot resolve the base SHA/,
  );
});

// a cancelled PR review never reaches the Reviewer.
test('a cancelled PR review stops before the Reviewer', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const { controller, calls } = build({ prBackend: backend, reviews: [{ findings: [finding('P1')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const ac = new AbortController();
  ac.abort();
  const r = await controller.review({ loopId, signal: ac.signal });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.notEqual(r.terminal, true);
  assert.equal(calls.reviewer, 0);
});

// ReviewLoop still never pushes / merges.
test('the controller exposes no push / merge / force-push operation', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/reviewloop/controller.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /git push|gh pr merge|forcePush|--force\b/);
});
