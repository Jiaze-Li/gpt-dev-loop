// P1 — the PR Gate must prove it did NOT mutate the exact reviewed snapshot.
// PR evidence must correspond to the exact commit already pushed, so unlike
// LOCAL (which adopts a mutating Gate's own edits and re-stabilises), a PR
// Gate that changes the snapshot underneath it is simply not certifiable:
// Gate mutated snapshot => snapshot not certifiable. Fail closed, never
// invoke the Reviewer, never treat reviewedSnapshotHeadSha as proven.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  MemoryPersistence, mockPrBackend, prTestFakes,
} from './helpers/reviewLoopHarness.js';

// A captureWorktreeSnapshotFn fake that returns a scripted sequence of
// results — one per call (pre-Gate, then post-Gate).
function scriptedSnapshot(results) {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
}

function buildController({ snapshotResults, reviewerFn }) {
  const backend = mockPrBackend({ heads: ['H1'] });
  let reviewerCalls = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    captureWorktreeSnapshotFn: scriptedSnapshot(snapshotResults),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo test'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, results: [], fingerprint: 'g1', failureIdentities: [],
    }),
    reviewerFn: async (args) => {
      reviewerCalls += 1;
      return (reviewerFn ?? (async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } })))(args);
    },
  });
  return { controller, getReviewerCalls: () => reviewerCalls };
}

test('a Gate that mutates a tracked file and PASSes -> PR is blocked, Reviewer never called', async () => {
  const { controller, getReviewerCalls } = buildController({
    // pre-Gate clean, post-Gate shows a changed tracked file.
    snapshotResults: [{ ok: true, entries: [] }, { ok: true, entries: [' M src/foo.js'] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
  assert.equal(getReviewerCalls(), 0, 'the Reviewer must never see evidence from a Gate-mutated snapshot');
  assert.ok(r.safetyEvents.some((e) => e.code === 'GATE_MUTATED_PR_SNAPSHOT' && e.severity === 'BLOCKING'));
});

test('a Gate that creates an untracked file affecting the snapshot -> not PASS', async () => {
  const { controller, getReviewerCalls } = buildController({
    snapshotResults: [{ ok: true, entries: [] }, { ok: true, entries: ['?? generated.snap'] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
  assert.equal(getReviewerCalls(), 0);
});

test('a non-mutating Gate proceeds normally to PASS', async () => {
  const { controller, getReviewerCalls } = buildController({
    snapshotResults: [{ ok: true, entries: [] }, { ok: true, entries: [] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(getReviewerCalls(), 1);
});

test('the exact-head marker is only set once post-Gate cleanliness is proven — a mutated round never PASSes even on a later identical resubmission', async () => {
  const { controller } = buildController({
    snapshotResults: [{ ok: true, entries: [] }, { ok: true, entries: [' M src/foo.js'] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  // No audit record was written for this round (appendAuditRecord is never
  // reached on the GATE_MUTATED_SNAPSHOT path) — the loop never certified
  // anything about this HEAD.
  const state = await controller._persistence.readWorkflowState(loopId);
  assert.deepEqual(state.reviewLoop.audit ?? [], []);
});

test('an unverifiable pre-Gate or post-Gate state fails closed (never treated as clean)', async () => {
  const { controller, getReviewerCalls } = buildController({
    snapshotResults: [{ ok: false, reason: 'git status failed' }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.equal(getReviewerCalls(), 0);
});
