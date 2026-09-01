import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageTracker, invocationIdentity } from '../src/orchestrator/usageTracker.js';
import { TokenAnomalyMonitor, ANOMALY_TYPES } from '../src/orchestrator/tokenAnomalyMonitor.js';
import { decideDeterministically } from '../src/orchestrator/deterministicSupervisorPolicy.js';

const SUP_CALL = {
  workflowId: 'wf-1',
  role: 'supervisor',
  callId: 'call-agy-sup-abc',
  provider: 'agy',
  model: 'gemini-3.7-flash-high',
  usage: { input_tokens: 12000, output_tokens: 900, callId: 'call-agy-sup-abc' },
};

test('callId is authoritative: the same physical invocation is aggregated exactly once', () => {
  const tracker = new UsageTracker();
  tracker.record(SUP_CALL);
  // Same event delivered again (retry / duplicate emit / resume replay).
  tracker.record(SUP_CALL);
  tracker.record({ ...SUP_CALL, usage: { input_tokens: 12000, output_tokens: 900 } });

  const sum = tracker.summary();
  assert.equal(sum.supervisor.calls, 1);
  assert.equal(sum.supervisor.inputTokens, 12000);
  assert.equal(sum.supervisor.outputTokens, 900);
  assert.equal(sum.total.calls, 1);

  // The replays are still visible for audit, flagged, not accounted.
  const dups = tracker.records.filter((r) => r.duplicate);
  assert.equal(dups.length, 2);
  assert.equal(tracker.records.filter((r) => r.countsTowardAggregates !== false).length, 1);
});

test('without a callId a stable invocation identity deduplicates replays but keeps distinct calls', () => {
  const tracker = new UsageTracker();
  const legacy = {
    workflowId: 'wf-1',
    role: 'reviewer',
    taskId: 'task-1',
    attempt: 1,
    model: 'gpt-oss-120b-medium',
    startedAt: '2026-09-01T00:00:00.000Z',
    usage: { input_tokens: 8000, output_tokens: 300 },
  };
  tracker.record(legacy);
  tracker.record({ ...legacy }); // exact replay -> same identity
  // A genuinely different invocation (later attempt, different tokens).
  tracker.record({ ...legacy, attempt: 2, startedAt: '2026-09-01T00:05:00.000Z', usage: { input_tokens: 9000, output_tokens: 350 } });

  const sum = tracker.summary();
  assert.equal(sum.reviewer.calls, 2);
  assert.equal(sum.reviewer.inputTokens, 17000);
  assert.equal(invocationIdentity({ ...legacy }).startsWith('slot|'), true);
  // A generic record with no task/attempt slot is never deduplicated.
  assert.equal(invocationIdentity({ role: 'supervisor', usage: {} }), null);
});

test('deterministic Supervisor decision is recorded as zero calls and zero tokens', () => {
  const tracker = new UsageTracker();
  tracker.record(SUP_CALL); // one real model call

  // Shape produced by automatedLoop when decideDeterministically handled the
  // transition: no callId, no model, no provider, no usage.
  const tasks = [
    { task_id: 'one', goal: 'do one', allowed_files: ['a.js'], verification_commands: ['node --test a'] },
  ];
  const deterministic = decideDeterministically({
    context: { workflowGoal: 'g', repositoryContext: {}, history: [], latestReviewResult: null },
    plannedTasks: tasks,
  });
  assert.equal(deterministic.handled, true);

  const decision = deterministic.decision;
  const rec = tracker.record({
    workflowId: 'wf-1',
    role: 'supervisor',
    callId: decision?.callId ?? decision?.usage?.callId,
    provider: decision?.provider,
    model: decision?.model,
    usage: decision?.usage ?? null,
    durationMs: decision?.durationMs,
  });

  assert.equal(rec.deterministic, true);
  assert.equal(rec.countsTowardAggregates, false);
  const sum = tracker.summary();
  assert.equal(sum.supervisor.calls, 1, 'only the real provider call is accounted');
  assert.equal(sum.supervisor.inputTokens, 12000);
  assert.equal(sum.supervisor.totalTokens, 12900);
  assert.equal(tracker.deterministicDecisions, 1);
});

test('a real Supervisor call whose provider does not expose usage is still counted', () => {
  const tracker = new UsageTracker();
  tracker.record({ role: 'supervisor', callId: 'call-sup-real-nousage', model: 'gemini-3.7-flash-high', usage: null });
  tracker.record({ role: 'supervisor', model: 'unknown-extension', usage: null });
  assert.equal(tracker.summary().supervisor.calls, 2);
});

test('checkpoint resume: reload of the usage log does not double-count', () => {
  const tracker = new UsageTracker();
  tracker.record(SUP_CALL);
  tracker.record({ role: 'executor', callId: 'call-exe-1', taskId: 't1', attempt: 1, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 4000 } });
  tracker.record({ role: 'supervisor', role2: undefined, model: undefined, usage: null }); // deterministic

  const reloaded = UsageTracker.fromJSON(tracker.toJSON());
  assert.deepEqual(
    { calls: reloaded.summary().total.calls, sup: reloaded.summary().supervisor.calls, exe: reloaded.summary().executor.calls },
    { calls: 2, sup: 1, exe: 1 },
  );

  // Re-applying the same event after resume is still idempotent.
  reloaded.record(SUP_CALL);
  assert.equal(reloaded.summary().supervisor.calls, 1);

  // A second reload of the already-reloaded state is also stable.
  const reloadedTwice = UsageTracker.fromJSON(reloaded.toJSON());
  assert.equal(reloadedTwice.summary().total.calls, 2);
  assert.equal(reloadedTwice.summary().supervisor.inputTokens, 12000);
});

test('cross-workflow merge folds overlapping invocations exactly once', () => {
  const a = new UsageTracker();
  a.record(SUP_CALL);
  a.record({ role: 'reviewer', callId: 'call-rev-a', taskId: 't1', attempt: 1, model: 'gpt-oss-120b-medium', usage: { input_tokens: 5000, output_tokens: 200 } });

  const b = new UsageTracker();
  b.record(SUP_CALL); // same physical supervisor call seen from another reader
  b.record({ role: 'executor', callId: 'call-exe-b', taskId: 't1', attempt: 1, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 3000 } });

  a.merge(b);
  const sum = a.summary();
  assert.equal(sum.supervisor.calls, 1);
  assert.equal(sum.reviewer.calls, 1);
  assert.equal(sum.executor.calls, 1);
  assert.equal(sum.total.calls, 3);

  // Merging again changes nothing.
  a.merge(b);
  assert.equal(a.summary().total.calls, 3);
});

test('TokenAnomalyMonitor operates on the deduplicated set: no double count, single alert on replay', () => {
  const tracker = new UsageTracker();
  // One real attempt per task; the executor call for task-2 is replayed.
  tracker.record({ role: 'executor', callId: 'call-exe-t1', taskId: 't1', attempt: 1, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 3000 } });
  const exeT2 = { role: 'executor', callId: 'call-exe-t2', taskId: 't2', attempt: 1, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 3000 } };
  tracker.record(exeT2);
  tracker.record(exeT2);
  tracker.record(exeT2);

  const res = new TokenAnomalyMonitor().analyze({
    tracker,
    workflowContext: { tasksCount: 2, attemptsByTask: { t1: 1, t2: 1 } },
  });

  // Deduplicated executor calls = 2, exactly matching the 2 attempts: no
  // UNEXPECTED_CALL_COUNT even though the raw log holds 4 executor records.
  assert.equal(res.anomalies.some((a) => a.type === ANOMALY_TYPES.UNEXPECTED_CALL_COUNT), false);
  assert.equal(tracker.summary().executor.calls, 2);

  // The accidental double-record bug is still surfaced (deterministically) as a
  // duplicate-accounting anomaly so it can be fixed upstream.
  const dupAlerts = res.anomalies.filter((a) => a.type === ANOMALY_TYPES.DUPLICATE_ACCOUNTING);
  assert.ok(dupAlerts.length >= 1);
  assert.ok(dupAlerts.every((a) => a.callId === 'call-exe-t2'));
});

test('replayed usage never inflates a clean workflow into a baseline regression', () => {
  const tracker = new UsageTracker();
  for (let t = 1; t <= 3; t += 1) {
    const sup = { role: 'supervisor', callId: `call-sup-${t}`, taskId: `task-${t}`, model: 'gemini-3.7-flash-high', usage: { input_tokens: 14000, output_tokens: 1000 } };
    tracker.record(sup);
    tracker.record(sup); // replay
  }
  const res = new TokenAnomalyMonitor().analyze({
    tracker,
    workflowContext: { tasksCount: 3 },
    baseline: { scenario: 's', version: '1.0.0', total: { calls: 6, inputTokens: 60000, outputTokens: 6000 }, expected: { calls: { total: 6 }, tokens: { total: { inputTokens: 60000, outputTokens: 6000 } } } },
  });
  assert.equal(res.anomalies.some((a) => a.type === ANOMALY_TYPES.BASELINE_REGRESSION), false);
  assert.equal(tracker.summary().supervisor.inputTokens, 42000);
});
