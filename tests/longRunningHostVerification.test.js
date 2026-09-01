import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFICATION_KIND,
  NORMAL_GATE_BUDGET_MS,
  LONG_RUNNING_HOST_VERIFICATION_MIN_BUDGET_MS,
  LONG_RUNNING_HOST_VERIFICATION_MAX_BUDGET_MS,
  DEFAULT_LONG_RUNNING_HOST_VERIFICATION_BUDGET_MS,
  DEFAULT_LIVENESS_STALL_THRESHOLD_MS,
  resolveHostVerificationBudgetMs,
  evaluateHostVerificationLiveness,
} from '../src/orchestrator/hostVerification.js';

const MIN = 60 * 1000;

test('NORMAL_GATE keeps a short (~120s) budget', () => {
  assert.equal(resolveHostVerificationBudgetMs(VERIFICATION_KIND.NORMAL_GATE), NORMAL_GATE_BUDGET_MS);
  assert.equal(resolveHostVerificationBudgetMs(VERIFICATION_KIND.HOST_VERIFICATION), NORMAL_GATE_BUDGET_MS);
});

test('long-running budget defaults into, and clamps to, the 15-30 minute window', () => {
  assert.equal(
    resolveHostVerificationBudgetMs(VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION),
    DEFAULT_LONG_RUNNING_HOST_VERIFICATION_BUDGET_MS,
  );
  assert.equal(
    resolveHostVerificationBudgetMs(VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION, 2 * MIN),
    LONG_RUNNING_HOST_VERIFICATION_MIN_BUDGET_MS,
  );
  assert.equal(
    resolveHostVerificationBudgetMs(VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION, 90 * MIN),
    LONG_RUNNING_HOST_VERIFICATION_MAX_BUDGET_MS,
  );
  assert.equal(
    resolveHostVerificationBudgetMs(VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION, 22 * MIN),
    22 * MIN,
  );
});

test('a live verification well within budget and recently progressing continues', () => {
  const now = 1_000_000_000_000;
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: now - 8 * MIN,
    budgetMs: 20 * MIN,
    processAlive: true,
    heartbeatAt: now - 10 * 1000,
    lastProgressAt: now - 30 * 1000,
    stage: 'RUNNING',
    previousStage: 'RUNNING',
  });
  assert.equal(res.decision, 'CONTINUE');
  assert.equal(res.reason, 'WITHIN_BUDGET');
});

test('a dead process is stuck even with budget remaining', () => {
  const now = 2_000_000_000_000;
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: now - 3 * MIN,
    budgetMs: 20 * MIN,
    processAlive: false,
    heartbeatAt: now - 5 * 1000,
  });
  assert.equal(res.decision, 'STUCK');
  assert.equal(res.reason, 'PROCESS_DEAD');
});

test('an exhausted total budget is stuck even while the process is alive', () => {
  const now = 3_000_000_000_000;
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: now - 21 * MIN,
    budgetMs: 20 * MIN,
    processAlive: true,
    heartbeatAt: now - 1000,
  });
  assert.equal(res.decision, 'STUCK');
  assert.equal(res.reason, 'BUDGET_EXHAUSTED');
});

test('no heartbeat or progress past the stall threshold is stuck', () => {
  const now = 4_000_000_000_000;
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: now - 10 * MIN,
    budgetMs: 25 * MIN,
    processAlive: true,
    heartbeatAt: now - (DEFAULT_LIVENESS_STALL_THRESHOLD_MS + MIN),
    lastProgressAt: now - (DEFAULT_LIVENESS_STALL_THRESHOLD_MS + 2 * MIN),
    stage: 'RUNNING',
    previousStage: 'RUNNING',
  });
  assert.equal(res.decision, 'STUCK');
  assert.equal(res.reason, 'NO_PROGRESS');
});

test('a stage advance counts as progress and defeats a stale heartbeat', () => {
  const now = 5_000_000_000_000;
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: now - 10 * MIN,
    budgetMs: 25 * MIN,
    processAlive: true,
    heartbeatAt: now - (DEFAULT_LIVENESS_STALL_THRESHOLD_MS + 3 * MIN),
    lastProgressAt: now - (DEFAULT_LIVENESS_STALL_THRESHOLD_MS + 3 * MIN),
    stage: 'FINALIZING',
    previousStage: 'RUNNING',
  });
  assert.equal(res.decision, 'CONTINUE');
  assert.equal(res.reason, 'STAGE_ADVANCED');
});

test('ISO-8601 timestamps are accepted for startedAt and heartbeatAt', () => {
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const res = evaluateHostVerificationLiveness({
    now,
    startedAt: '2026-09-01T11:50:00.000Z',
    budgetMs: 25 * MIN,
    processAlive: true,
    heartbeatAt: '2026-09-01T11:59:30.000Z',
  });
  assert.equal(res.decision, 'CONTINUE');
});
