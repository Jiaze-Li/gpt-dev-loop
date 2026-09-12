// Phase 1 — every public REVIEWLOOP_MAX_* env knob is really wired, not
// resolved-and-ignored:
//   * REVIEWLOOP_MAX_REVIEW_ROUNDS feeds the frozen objective that
//     decideConvergence() enforces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function localController(env) {
  let d = 0;
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    env,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      d += 1;
      return {
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true,
        noWorkerChangeYet: false, changedFiles: ['a.js'],
        fingerprint: `fp${d}`, diff: `diff ${d}`,
      };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: `g${d}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => ({ value: { findings: [{ severity: 'P1', file: 'a.js', title: 'bug' }] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

test('REVIEWLOOP_MAX_REVIEW_ROUNDS=1 -> objective carries it and a first blocking round escalates to HUMAN_REQUIRED', async () => {
  const controller = localController({ REVIEWLOOP_MAX_REVIEW_ROUNDS: '1' });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const state = await controller._persistence.readWorkflowState(loopId);
  assert.equal(state.reviewLoop.objective.maxReviewRounds, 1);
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
});

test('an explicit begin maxReviewRounds argument still wins over the env knob', async () => {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    env: { REVIEWLOOP_MAX_REVIEW_ROUNDS: '1' },
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', maxReviewRounds: 5 });
  const state = await controller._persistence.readWorkflowState(loopId);
  assert.equal(state.reviewLoop.objective.maxReviewRounds, 5);
});
