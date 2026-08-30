import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenAwareSessionPolicy, createSupervisorCheckpoint } from '../src/orchestrator/tokenAwareSessionPolicy.js';

test('economical sessions are reused and missing telemetry is harmless', () => {
  const p = new TokenAwareSessionPolicy({ maxPhysicalCalls: 4 }); let s = p.initial();
  s = p.observe(s, {}); assert.equal(p.rotationReason(s), null);
  s = p.observe(s, { inputTokens: 100, latencyMs: 10 }); assert.equal(p.rotationReason(s), null);
});
test('sustained native input growth causes a local rotation decision', () => {
  const p = new TokenAwareSessionPolicy({ maxConsecutiveGrowth: 2, maxInputGrowthRatio: 1.5 }); let s = p.initial();
  for (const inputTokens of [100, 200, 400]) s = p.observe(s, { inputTokens });
  assert.equal(p.rotationReason(s), 'uncached_input_growth'); assert.equal(p.rotate(s).generation, 2);
});
test('checkpoint is compact structured state and creates no provider call', () => {
  const checkpoint = createSupervisorCheckpoint({ workflowGoal: 'x', history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }], latestReviewResult: { task_id: 'b', decision: 'REWORK', required_changes: ['fix'] } });
  assert.equal(checkpoint.schema, 'supergpt.supervisor-checkpoint/v1'); assert.deepEqual(checkpoint.completedTasks, [{ task_id: 'a', decision: 'PASS', attempts: 1 }]); assert.deepEqual(checkpoint.latestRequiredChanges, ['fix']);
});
