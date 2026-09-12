// Phase 1 — one long-lived controller (one MCP process, many loopIds):
//   * a safety event raised while reviewing loop A must not appear in loop B's
//     result (per-invocation / per-loop isolation);
//   * telemetry on NO_PROGRESS / WAITING / PUSH_REQUIRED must still report the
//     durable cumulative spend from earlier rounds, never reset to zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  MemoryPersistence, makeHarness, finding, mockPrBackend, prTestFakes,
} from './helpers/reviewLoopHarness.js';

test('a safety event from loop A does not leak into loop B on the same controller', async () => {
  const persistence = new MemoryPersistence();
  let d = 0;
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      d += 1;
      return { baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: `fp${d}`, diff: `d${d}` };
    },
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: `g${d}`, failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });

  const a = await controller.begin({ goal: 'a', cwd: '/a' });
  // Seed loop A with a crash-abandoned DISPATCHING reservation -> reconcile on
  // resume raises a BLOCKING safety event and blocks the review.
  await persistence.updateWorkflowState(a.loopId, {
    modelSpendReservations: {
      r1: { reservationId: 'r1', workflowId: a.loopId, role: 'reviewer', status: 'DISPATCHING', taskId: 't', physicalAttempt: 1, createdAt: 't0', dispatchStartedAt: 't0' },
    },
  });
  const rA = await controller.review({ loopId: a.loopId });
  assert.equal(rA.status, 'HUMAN_REQUIRED');
  assert.ok(rA.safetyEvents.some((e) => e.code === 'MODEL_SPEND_USAGE_UNRESOLVED'), 'loop A surfaces its own safety event');

  const b = await controller.begin({ goal: 'b', cwd: '/b' });
  const rB = await controller.review({ loopId: b.loopId });
  assert.equal(rB.status, 'PASS');
  assert.deepEqual(rB.safetyEvents, [], 'loop B result carries none of loop A\'s safety events');
});

test('NO_PROGRESS after a spending round still reports cumulative durable spend', async () => {
  const { controller } = makeHarness({
    deltas: [{ fingerprint: 'SAME', diff: 'x', changedFiles: ['a.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'G' }],
    reviews: [{ findings: [finding('P3')] }],
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'PASS');
  assert.equal(r1.telemetry.reviewerCalls, 1);

  // Identical delta + gate on the next call -> NO_PROGRESS, zero new calls, but
  // the telemetry must still show the earlier round's durable spend.
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS'); // already terminal -> terminalResult
  assert.equal(r2.telemetry.reviewerCalls, 1, 'cumulative spend is not reset to zero on a terminal / no-progress re-call');
  assert.equal(r2.telemetry.workerUsage, 'external / not observable by ReviewLoop');
});

test('PR PUSH_REQUIRED after a spending round still reports cumulative durable spend', async () => {
  const backend = mockPrBackend({ heads: ['H1'] });
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo t'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, results: [], fingerprint: `g${Math.random()}`, failureIdentities: [] }),
    reviewerFn: async () => ({ value: { findings: [{ severity: 'P1', file: 'a', title: 'b' }] }, usage: { input_tokens: 5, output_tokens: 5 }, model: 'm' }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.equal(r1.telemetry.reviewerCalls, 1);

  // No push -> PUSH_REQUIRED, no fresh Reviewer call, but the earlier spend stays.
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PUSH_REQUIRED');
  assert.equal(r2.telemetry.reviewerCalls, 1, 'cumulative spend is not reset to zero on an early-return re-call');
  assert.equal(r2.telemetry.workerUsage, 'external / not observable by ReviewLoop');
});
