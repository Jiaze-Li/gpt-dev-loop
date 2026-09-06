// Phase 2 #6 — a chunked review checkpoints each completed chunk durably. A
// crash after chunk N resumes at N+1 without re-calling the model for the
// already-reviewed chunks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function bigDiff() {
  const file = (n) => [
    `diff --git a/file${n}.js b/file${n}.js`,
    `--- a/file${n}.js`,
    `+++ b/file${n}.js`,
    '@@ -1,1 +1,20 @@',
    ...Array.from({ length: 18 }, (_, i) => `+  const v${n}_${i} = ${i} + ${n}; // padding to force this file over the chunk size limit`),
  ].join('\n');
  return [file(0), file(1), file(2)].join('\n');
}

test('crash after chunk N -> resume reviews only chunk N+1..', async () => {
  const persistence = new MemoryPersistence();
  const callsByChunk = {};
  let failChunk2 = true;

  function build() {
    return createReviewLoopController({
      persistence,
      env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '700', REVIEWLOOP_MAX_REVIEW_CHUNKS: '12' },
      captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({
        baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
        changedFiles: ['file0.js', 'file1.js', 'file2.js'], fingerprint: 'DELTA_FP', diff: bigDiff(),
      }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
      discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
      reviewerFn: async ({ chunk }) => {
        callsByChunk[chunk.index] = (callsByChunk[chunk.index] ?? 0) + 1;
        if (chunk.index === 2 && failChunk2) {
          throw Object.assign(new Error('provider blip'), { code: 'PROVIDER_UNAVAILABLE' });
        }
        return { value: { findings: [] }, usage: { input_tokens: 2, output_tokens: 1 } };
      },
    });
  }

  const ctlA = build();
  const { loopId } = await ctlA.begin({ goal: 'g', cwd: '/r' });
  const r1 = await ctlA.review({ loopId });
  assert.equal(r1.status, 'HUMAN_REQUIRED', 'chunk 2 could not be reviewed -> fail closed this round');
  assert.equal(callsByChunk[0], 1);
  assert.equal(callsByChunk[1], 1);
  assert.ok(callsByChunk[2] >= 1);

  // The checkpoint holds chunks 0 and 1.
  const persisted = await persistence.readWorkflowState(loopId);
  assert.equal(persisted.reviewLoop.chunkReviewCheckpoint.chunks['0'].status, 'CLEAN');
  assert.equal(persisted.reviewLoop.chunkReviewCheckpoint.chunks['1'].status, 'CLEAN');

  // "restart": fresh controller over the same store; chunk 2 now succeeds.
  failChunk2 = false;
  const beforeResume = { ...callsByChunk };
  const ctlB = build();
  const r2 = await ctlB.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.equal(callsByChunk[0], beforeResume[0], 'chunk 0 was NOT re-sent to the model on resume');
  assert.equal(callsByChunk[1], beforeResume[1], 'chunk 1 was NOT re-sent to the model on resume');
  assert.equal(callsByChunk[2], beforeResume[2] + 1, 'only chunk 2 was reviewed on resume');
});

test('a changed diff invalidates a stale chunk checkpoint', async () => {
  const persistence = new MemoryPersistence();
  let diffFp = 'FP_A';
  const calls = [];
  const build = () => createReviewLoopController({
    persistence,
    env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '700' },
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['file0.js', 'file1.js', 'file2.js'], fingerprint: diffFp, diff: bigDiff(),
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE_FP', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async ({ chunk, round }) => {
      calls.push(`${round}:${chunk.index}`);
      // round 1 reports a blocking finding on chunk 0 -> REWORK (not terminal);
      // round 2 (changed diff) is clean.
      const findings = (round === 1 && chunk.index === 0) ? [{ severity: 'P1', file: 'file0.js', title: 'bug' }] : [];
      return { value: { findings }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const ctl = build();
  const { loopId } = await ctl.begin({ goal: 'g', cwd: '/r' });
  const r1 = await ctl.review({ loopId });      // round 1: REWORK, checkpoint cleared
  assert.equal(r1.status, 'REWORK');
  diffFp = 'FP_B';                              // worker changed the code
  const r2 = await ctl.review({ loopId });
  assert.equal(r2.status, 'PASS');
  // round 2 reviewed its own chunks (fresh state), not skipped by a stale checkpoint
  assert.ok(calls.some((c) => c.startsWith('2:')), `calls: ${calls.join(',')}`);
});
