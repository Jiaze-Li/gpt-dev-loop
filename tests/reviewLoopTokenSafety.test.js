import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { MemoryPersistence, makeHarness, finding } from './helpers/reviewLoopHarness.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';

test('every real Reviewer call crosses ModelSpendAuthority and settles known usage', async () => {
  const spend = createReviewLoopSpend({ loopId: 'L1', persistence: new MemoryPersistence() });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 'L1', diffHash: 'h1' });
  const value = await spend.meteredCall({
    role: 'reviewer', operationId: 'L1:r1', evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 5, output_tokens: 2 } }),
  });
  assert.deepEqual(value, { findings: [] });
  assert.equal(spend.telemetry().reviewerCalls, 1);
  assert.equal(spend.telemetry().unknownUsageCalls, 0);
});

test('missing post-dispatch usage -> UNRESOLVED (never treated as zero)', async () => {
  const spend = createReviewLoopSpend({ loopId: 'L2', persistence: new MemoryPersistence() });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 'L2', diffHash: 'h1' });
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', operationId: 'L2:r1', evidenceIds: [ev.evidenceId],
      call: async () => ({ value: { findings: [] } }), // no usage
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
});

test('same evidence cannot authorize a second Reviewer call', async () => {
  const spend = createReviewLoopSpend({ loopId: 'L3', persistence: new MemoryPersistence() });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 'L3', diffHash: 'h1' });
  await spend.meteredCall({
    role: 'reviewer', operationId: 'L3:r1', evidenceIds: [ev.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', operationId: 'L3:r1', evidenceIds: [ev.evidenceId],
      call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
});

test('reviewer call ceiling denies further Reviewer spend', async () => {
  const spend = createReviewLoopSpend({
    loopId: 'L4', persistence: new MemoryPersistence(), env: { REVIEWLOOP_MAX_REVIEWER_CALLS: '1' },
  });
  const e1 = await spend.registerEvidence({ kind: 'diff', taskId: 'L4', diffHash: 'a' });
  await spend.meteredCall({
    role: 'reviewer', operationId: 'o1', evidenceIds: [e1.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const e2 = await spend.registerEvidence({ kind: 'diff', taskId: 'L4', diffHash: 'b' });
  await assert.rejects(() => spend.meteredCall({
    role: 'reviewer', operationId: 'o2', evidenceIds: [e2.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
  }), /reviewer call ceiling/);
});

test('telemetry never reports Worker usage as zero', async () => {
  const { controller } = makeHarness({ reviews: [{ findings: [finding('P3')] }] });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.telemetry.workerUsage, 'external / not observable by ReviewLoop');
  assert.notEqual(r.telemetry.workerUsage, 0);
});

test('DEFAULT_ROLE_POLICY has exactly reviewer + supervisor (mechanical)', async () => {
  const { DEFAULT_ROLE_POLICY } = await import('../src/orchestrator/roleRouting.js');
  assert.deepEqual(Object.keys(DEFAULT_ROLE_POLICY).sort(), ['reviewer', 'supervisor']);
});

test('New Information role eligibility carries no planner/executor keys', async () => {
  const { ROLE_EVENT_ELIGIBILITY } = await import('../src/orchestrator/newInformation.js');
  assert.deepEqual(Object.keys(ROLE_EVENT_ELIGIBILITY).sort(), ['reviewer', 'supervisor']);
});
