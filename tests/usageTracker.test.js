import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageTracker, USAGE_ROLES } from '../src/orchestrator/usageTracker.js';

test('usageTracker: records usage for each role without estimation', () => {
  const tracker = new UsageTracker();

  // Supervisor call with agy usage
  tracker.record({
    role: USAGE_ROLES.SUPERVISOR,
    model: 'gemini-3.7-flash-high',
    usage: {
      input_tokens: 1500,
      output_tokens: 200,
      cache_read_tokens: 300,
      total_tokens: 1700,
    },
    durationMs: 1200,
  });

  // Executor call with Claude usage
  tracker.record({
    role: USAGE_ROLES.EXECUTOR,
    taskId: 'task-1',
    attempt: 1,
    model: 'sonnet',
    usage: {
      input_tokens: 3000,
      output_tokens: 500,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
    },
    costUsd: 0.045,
    durationMs: 4500,
  });

  // Reviewer call with agy usage
  tracker.record({
    role: USAGE_ROLES.REVIEWER,
    taskId: 'task-1',
    attempt: 1,
    model: 'gpt-oss-120b-medium',
    usage: {
      input_tokens: 2000,
      output_tokens: 150,
      cache_read_tokens: 0,
      total_tokens: 2150,
    },
    durationMs: 800,
  });

  // Call with no usage (e.g. extension/unsupported provider) — must NOT estimate
  tracker.record({
    role: USAGE_ROLES.SUPERVISOR,
    model: 'unknown',
    usage: null,
  });

  const sum = tracker.summary();

  assert.equal(sum.supervisor.calls, 2);
  assert.equal(sum.supervisor.inputTokens, 1500);
  assert.equal(sum.supervisor.outputTokens, 200);
  assert.equal(sum.supervisor.cachedTokens, 300);

  assert.equal(sum.executor.calls, 1);
  assert.equal(sum.executor.inputTokens, 3000);
  assert.equal(sum.executor.outputTokens, 500);
  assert.equal(sum.executor.cachedTokens, 1500);
  assert.equal(sum.executor.costUsd, 0.045);

  assert.equal(sum.reviewer.calls, 1);
  assert.equal(sum.reviewer.inputTokens, 2000);
  assert.equal(sum.reviewer.outputTokens, 150);

  assert.equal(sum.total.calls, 4);
  assert.equal(sum.total.inputTokens, 6500);
  assert.equal(sum.total.outputTokens, 850);
  assert.equal(sum.total.cachedTokens, 1800);
  assert.equal(sum.total.costUsd, 0.045);

  // Per-task breakdown check
  assert.ok(tracker.byTask['task-1']['1']);
  assert.equal(tracker.byTask['task-1']['1'].length, 2);

  // Formatting output check
  const formatted = tracker.formatSummary();
  assert.match(formatted, /Supervisor/);
  assert.match(formatted, /Executor/);
  assert.match(formatted, /Reviewer/);
  assert.match(formatted, /Total/);
});

test('usageTracker: serializes to/from JSON', () => {
  const tracker = new UsageTracker();
  tracker.record({
    role: USAGE_ROLES.PLANNER,
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 500, output_tokens: 100 },
  });

  const json = tracker.toJSON();
  const restored = UsageTracker.fromJSON(json);

  assert.equal(restored.summary().planner.inputTokens, 500);
  assert.equal(restored.summary().planner.calls, 1);
});

test('usageTracker: tracks callId and propagates to records', () => {
  const tracker = new UsageTracker();
  const rec = tracker.record({
    role: USAGE_ROLES.SUPERVISOR,
    callId: 'call-sup-test-123',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 1000, output_tokens: 200, callId: 'call-sup-test-123' },
  });

  assert.equal(rec.callId, 'call-sup-test-123');
  assert.equal(tracker.records[0].callId, 'call-sup-test-123');
});

test('usageTracker: reconciles Executor input composition without double-counting cached tokens', () => {
  const tracker = new UsageTracker();
  const rec = tracker.record({
    role: 'executor',
    usage: { input_tokens: 101, output_tokens: 3, cache_read_tokens: 50 },
    inputBreakdown: { categories: {
      taskCard: { bytes: 40, estimatedTokens: 10 }, repoContext: { bytes: 20, estimatedTokens: 5 },
      history: { bytes: 20, estimatedTokens: 5 }, evidence: { bytes: 10, estimatedTokens: 3 }, other: { bytes: 10, estimatedTokens: 3 },
    } },
  });
  assert.equal(rec.inputBreakdown.componentTokens, 101);
  assert.equal(rec.inputBreakdown.unattributedTokens, 0);
  assert.equal(rec.cachedTokens, 50);
  assert.equal(tracker.summary().executorInputBreakdown.length, 1);
  const aggregate = tracker.summary().executorInputBreakdownAggregate;
  assert.equal(aggregate.providerInputTokens, 101);
  assert.equal(aggregate.cachedTokens, 50);
  assert.equal(aggregate.componentTokens, 101);
  assert.match(aggregate.semantics, /not added/);
});

test('usageTracker: exposes cache read, cache creation and non-billable usage volume separately', () => {
  const tracker = new UsageTracker();
  const rec = tracker.record({
    role: 'executor',
    taskId: 'small-task',
    attempt: 1,
    physicalCallReason: 'PRIMARY',
    usage: { input_tokens: 100, output_tokens: 25, cache_read_tokens: 3_500_000, cache_creation_tokens: 10 },
  });
  const executor = tracker.summary().executor;
  assert.equal(rec.physicalCallReason, 'PRIMARY');
  assert.equal(executor.cacheReadTokens, 3_500_000);
  assert.equal(executor.cacheCreationTokens, 10);
  assert.equal(executor.usageVolume, 3_500_135);
  assert.equal(executor.totalTokens, 125, 'legacy total remains input + output, not a billing claim');
  assert.equal(rec.membershipUsageAvailable, false);
});

test('usageTracker: legacy Executor records remain present with unavailable breakdown', () => {
  const tracker = UsageTracker.fromJSON({ records: [{ role: 'executor', inputTokens: 77, cachedTokens: 12, outputTokens: 4 }] });
  const summary = tracker.summary();
  assert.equal(summary.executorInputBreakdownCalls[0].legacy, true);
  assert.equal(summary.executorInputBreakdownAggregate.legacyCalls, 1);
  assert.match(tracker.formatSummary(), /Unavailable for 1 legacy call/);
});

test('usageTracker: tracks provider failover model breakdown and external PR reviewer', () => {
  const tracker = new UsageTracker();

  // 1. Planner
  tracker.record({
    workflowId: 'wf-test-accounting-1',
    role: 'planner',
    provider: 'claude',
    model: 'opus',
    usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
  });

  // 2. Executor failover sequence: sonnet -> codex -> opus
  tracker.record({
    workflowId: 'wf-test-accounting-1',
    role: 'executor',
    taskId: 'task-1',
    attempt: 1,
    provider: 'claude',
    model: 'sonnet',
    usage: { input_tokens: 3000, output_tokens: 200, total_tokens: 3200 },
  });
  tracker.record({
    workflowId: 'wf-test-accounting-1',
    role: 'executor',
    taskId: 'task-1',
    attempt: 1,
    provider: 'codex',
    model: 'default',
    usage: { input_tokens: 2500, output_tokens: 150, total_tokens: 2650 },
  });
  tracker.record({
    workflowId: 'wf-test-accounting-1',
    role: 'executor',
    taskId: 'task-1',
    attempt: 1,
    provider: 'claude',
    model: 'opus',
    usage: { input_tokens: 4000, output_tokens: 600, total_tokens: 4600 },
  });

  // 3. Summary with PR closeout
  const sum = tracker.summary({
    prCloseout: { configuredReviewer: 'codex', reviewedPrHead: 'abc1234' },
  });

  assert.equal(sum.planner.totalTokens, 1500);
  assert.equal(sum.executor.calls, 3);
  assert.equal(sum.executor.totalTokens, 10450);
  assert.equal(sum.executor.byModel['claude:sonnet'].totalTokens, 3200);
  assert.equal(sum.executor.byModel['codex:default'].totalTokens, 2650);
  assert.equal(sum.executor.byModel['claude:opus'].totalTokens, 4600);

  // Supervisor was not called -> 0
  assert.equal(sum.supervisor.calls, 0);
  assert.equal(sum.supervisor.totalTokens, 0);

  // Internal Reviewer was not called -> 0
  assert.equal(sum.internalReviewer.calls, 0);
  assert.equal(sum.internalReviewer.totalTokens, 0);

  // Measured Total is exact sum: 1500 + 10450 = 11950
  assert.equal(sum.measuredTotal.totalTokens, 11950);
  assert.equal(sum.total.totalTokens, 11950);

  // External PR Reviewer
  assert.equal(sum.externalPrReviewer.reviewer, 'codex');
  assert.equal(sum.externalPrReviewer.usageAvailable, false);
  assert.equal(sum.externalPrReviewer.reviewed, true);
  assert.match(sum.externalPrReviewer.note, /unavailable \/ external/);
});
