import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import {
  TokenAnomalyMonitor,
  TINY_WORKFLOW_BASELINE,
  ANOMALY_TYPES,
  ANOMALY_SEVERITY,
  SCHEMA_SPECIFICATION_EXAMPLE,
  loadRecordedBaselines,
  updateBaseline,
  probeEnvironmentMetadata,
  isPlaceholderVersion,
} from '../src/orchestrator/tokenAnomalyMonitor.js';
import { runDeterministicBenchmark } from '../bin/benchmark-tokens.js';

test('TokenAnomalyMonitor: detects deterministic duplicate accounting via callId', () => {
  const tracker = new UsageTracker();
  const callId = 'call-agy-sup-phys-12345';

  // Physical invocation recorded once
  tracker.record({
    role: 'supervisor',
    callId,
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 13660, output_tokens: 1500 },
  });

  // Accidental double record with the exact same callId
  tracker.record({
    role: 'supervisor',
    callId,
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 13660, output_tokens: 1500 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({ tracker });

  assert.equal(res.hasAnomalies, true);
  assert.equal(res.criticalCount, 1);
  const dup = res.anomalies.find((a) => a.type === ANOMALY_TYPES.DUPLICATE_ACCOUNTING);
  assert.ok(dup);
  assert.equal(dup.severity, ANOMALY_SEVERITY.CRITICAL);
  assert.match(dup.message, /Deterministic duplicate accounting/);
  assert.match(dup.message, /call-agy-sup-phys-12345/);
});

test('TokenAnomalyMonitor: separate legitimate calls with identical token counts are NOT duplicates', () => {
  const tracker = new UsageTracker();

  // Call 1: Attempt 1
  tracker.record({
    role: 'executor',
    callId: 'call-claude-exe-attempt-1',
    taskId: 't-1',
    attempt: 1,
    model: 'claude-sonnet-5',
    usage: { input_tokens: 50, output_tokens: 3400 },
  });

  // Call 2: Attempt 2 (happens to have identical token count and executed right after)
  tracker.record({
    role: 'executor',
    callId: 'call-claude-exe-attempt-2',
    taskId: 't-1',
    attempt: 2,
    model: 'claude-sonnet-5',
    usage: { input_tokens: 50, output_tokens: 3400 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({
    tracker,
    workflowContext: { tasksCount: 1, attemptCount: 2, reworkCount: 1 },
  });

  // Must NEVER be classified as duplicate!
  const dup = res.anomalies.find((a) => a.type === ANOMALY_TYPES.DUPLICATE_ACCOUNTING);
  assert.equal(dup, undefined);
  assert.equal(res.hasAnomalies, false);
});

test('TokenAnomalyMonitor: workflow-wide attempts prevent multi-task false positives', () => {
  const tracker = new UsageTracker();
  for (const [taskId, attempts] of [['one', 1], ['two', 3]]) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      for (const role of ['executor', 'reviewer']) tracker.record({ role, taskId, attempt, callId: `${role}-${taskId}-${attempt}`, usage: { input_tokens: 1, output_tokens: 1 } });
    }
  }
  const result = new TokenAnomalyMonitor().analyze({ tracker, workflowContext: { tasksCount: 2, attemptsByTask: { one: 1, two: 3 } } });
  assert.equal(result.anomalies.some((a) => a.type === ANOMALY_TYPES.UNEXPECTED_CALL_COUNT), false);
});

test('TokenAnomalyMonitor: detects baseline environment changes without silently ignoring them', () => {
  const tracker = new UsageTracker();

  tracker.record({
    role: 'supervisor',
    callId: 'call-sup-1',
    model: 'gemini-2.0-flash',
    usage: { input_tokens: 15000, output_tokens: 1000 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({
    tracker,
    workflowContext: {
      tasksCount: 1,
      attemptCount: 1,
      currentEnv: {
        supervisorModel: 'gemini-2.0-flash', // baseline expected gemini-3.7-flash-high
      },
    },
    baseline: TINY_WORKFLOW_BASELINE.SINGLE_ATTEMPT,
  });

  assert.equal(res.hasAnomalies, true);
  const envChanged = res.anomalies.find((a) => a.type === ANOMALY_TYPES.BASELINE_ENVIRONMENT_CHANGED);
  assert.ok(envChanged);
  assert.match(envChanged.message, /Baseline environment changed/);
  assert.match(envChanged.message, /Supervisor model changed/);
});

test('TokenAnomalyMonitor: fallback heuristic detects duplicates when callId is missing', () => {
  const tracker = new UsageTracker();

  // Legacy/external caller without callId
  tracker.record({
    role: 'supervisor',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 13660, output_tokens: 1500 },
  });

  tracker.record({
    role: 'supervisor',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 13660, output_tokens: 1500 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({ tracker });

  assert.equal(res.hasAnomalies, true);
  const dup = res.anomalies.find((a) => a.type === ANOMALY_TYPES.DUPLICATE_ACCOUNTING);
  assert.ok(dup);
  assert.match(dup.message, /heuristic fallback/);
});

test('TokenAnomalyMonitor: detects unexpected call counts based on state bounds', () => {
  const tracker = new UsageTracker();

  // Workflow has 1 task and 1 attempt, but 4 reviewer calls and 6 supervisor calls
  for (let i = 0; i < 6; i++) {
    tracker.record({
      role: 'supervisor',
      model: 'gemini-3.7-flash-high',
      usage: { input_tokens: 10000 + i * 2000, output_tokens: 500 },
    });
  }
  for (let i = 0; i < 4; i++) {
    tracker.record({
      role: 'reviewer',
      taskId: 't-1',
      attempt: 1,
      model: 'gpt-oss-120b-medium',
      usage: { input_tokens: 15000 + i * 1000, output_tokens: 400 },
    });
  }

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({
    tracker,
    workflowContext: { tasksCount: 1, attemptCount: 1, reworkCount: 0 },
  });

  assert.equal(res.hasAnomalies, true);
  const callCountAnomalies = res.anomalies.filter((a) => a.type === ANOMALY_TYPES.UNEXPECTED_CALL_COUNT);
  assert.ok(callCountAnomalies.length >= 2);
  assert.ok(callCountAnomalies.some((a) => a.role === 'reviewer'));
  assert.ok(callCountAnomalies.some((a) => a.role === 'supervisor'));
});

test('TokenAnomalyMonitor: detects abnormal prompt inflation between turns', () => {
  const tracker = new UsageTracker();

  // Turn 1: 13,000 tokens
  tracker.record({
    role: 'supervisor',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 13000, output_tokens: 1000 },
  });

  // Turn 2: sudden abnormal explosion to 85,000 tokens (6.5x jump, +72,000 tokens)
  tracker.record({
    role: 'supervisor',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 85000, output_tokens: 1000 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({ tracker });

  assert.equal(res.hasAnomalies, true);
  const inflation = res.anomalies.find((a) => a.type === ANOMALY_TYPES.PROMPT_INFLATION);
  assert.ok(inflation);
  assert.match(inflation.message, /Abnormal prompt inflation in supervisor/);
});

test('TokenAnomalyMonitor: detects baseline regressions', () => {
  const tracker = new UsageTracker();

  // Simulated run with 18 calls and 300,000 input tokens for a 1-task run
  for (let i = 0; i < 18; i++) {
    tracker.record({
      role: 'supervisor',
      model: 'gemini-3.7-flash-high',
      usage: { input_tokens: 20000, output_tokens: 500 },
    });
  }

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({
    tracker,
    baseline: TINY_WORKFLOW_BASELINE.SINGLE_ATTEMPT,
  });

  assert.equal(res.hasAnomalies, true);
  const regressions = res.anomalies.filter((a) => a.type === ANOMALY_TYPES.BASELINE_REGRESSION);
  assert.ok(regressions.length > 0);
  assert.ok(regressions.some((r) => r.message.includes('Call count regression')));
  assert.ok(regressions.some((r) => r.message.includes('Input token regression')));
});

test('TokenAnomalyMonitor: does NOT fail legitimate large workflows with high token usage', () => {
  const tracker = new UsageTracker();

  // Legitimate large 10-task workflow with 10 tasks and 600,000 total tokens
  for (let t = 1; t <= 10; t++) {
    tracker.record({
      role: 'supervisor',
      taskId: `task-${t}`,
      model: 'gemini-3.7-flash-high',
      usage: { input_tokens: 25000 + t * 500, output_tokens: 1200 },
    });
    tracker.record({
      role: 'executor',
      taskId: `task-${t}`,
      attempt: 1,
      model: 'claude-sonnet-5',
      usage: { input_tokens: 500, output_tokens: 4000 },
    });
    tracker.record({
      role: 'reviewer',
      taskId: `task-${t}`,
      attempt: 1,
      model: 'gpt-oss-120b-medium',
      usage: { input_tokens: 30000 + t * 400, output_tokens: 800 },
    });
  }
  // Final done call
  tracker.record({
    role: 'supervisor',
    model: 'gemini-3.7-flash-high',
    usage: { input_tokens: 30000, output_tokens: 800 },
  });

  const monitor = new TokenAnomalyMonitor();
  const res = monitor.analyze({
    tracker,
    workflowContext: { tasksCount: 10, attemptCount: 10, reworkCount: 0 },
  });

  // Legitimate workflow should have 0 anomalies and NOT fail
  assert.equal(res.hasAnomalies, false);
  assert.equal(res.anomalies.length, 0);
  assert.equal(res.formattedBanner, null);
});

test('benchmark-tokens: runs deterministic benchmark cleanly with 0 anomalies on baseline', () => {
  const reworkBench = runDeterministicBenchmark({ scenario: 'rework' });
  assert.equal(reworkBench.report.hasAnomalies, false);
  assert.equal(reworkBench.summary.total.calls, 7);

  const singleBench = runDeterministicBenchmark({ scenario: 'single' });
  assert.equal(singleBench.report.hasAnomalies, false);
  assert.equal(singleBench.summary.total.calls, 4);

  // Simulated anomaly benchmark
  const dupBench = runDeterministicBenchmark({ scenario: 'rework', simulateAnomaly: 'duplicate' });
  assert.equal(dupBench.report.hasAnomalies, true);
  assert.ok(dupBench.report.anomalies.some((a) => a.type === ANOMALY_TYPES.DUPLICATE_ACCOUNTING));

  const infBench = runDeterministicBenchmark({ scenario: 'rework', simulateAnomaly: 'inflation' });
  assert.equal(infBench.report.hasAnomalies, true);
  assert.ok(infBench.report.anomalies.some((a) => a.type === ANOMALY_TYPES.PROMPT_INFLATION));
});

test('environmentProbe: probeEnvironmentMetadata captures runtime versions and does not use hardcoded placeholders', () => {
  const fakeExec = (cmd) => {
    if (cmd.includes('claude --version')) return '2.1.250 (Claude Code)\n';
    if (cmd.includes('agy --version')) return '1.1.22\n';
    if (cmd.includes('git rev-parse')) return 'abc1234\n';
    return '';
  };

  const env = probeEnvironmentMetadata({ execSync: fakeExec });
  assert.equal(env.claudeCliVersion, '2.1.250 (Claude Code)');
  assert.equal(env.agyVersion, '1.1.22');
  assert.equal(env.gitRevision, 'abc1234');
  assert.equal(isPlaceholderVersion(env.claudeCliVersion), false);
  assert.equal(isPlaceholderVersion(env.agyVersion), false);
});

test('environmentProbe: isPlaceholderVersion correctly identifies dummy placeholders and preserves valid semver', () => {
  // Explicit dummy placeholders
  assert.equal(isPlaceholderVersion('x.y.z'), true);
  assert.equal(isPlaceholderVersion('unknown'), true);
  assert.equal(isPlaceholderVersion('placeholder'), true);
  assert.equal(isPlaceholderVersion('example'), true);
  assert.equal(isPlaceholderVersion('example-claude-version'), true);
  assert.equal(isPlaceholderVersion('not_available'), true);
  assert.equal(isPlaceholderVersion('not_installed'), true);
  assert.equal(isPlaceholderVersion(null), true);
  assert.equal(isPlaceholderVersion(''), true);

  // Syntactically valid semantic versions must NEVER be classified as placeholders
  assert.equal(isPlaceholderVersion('2.1.0'), false);
  assert.equal(isPlaceholderVersion('1.0.0'), false);
  assert.equal(isPlaceholderVersion('0.0.1'), false);
  assert.equal(isPlaceholderVersion('2.1.250 (Claude Code)'), false);
  assert.equal(isPlaceholderVersion('1.1.22'), false);
  assert.equal(isPlaceholderVersion('0.1.0-alpha.3'), false);
});

test('updateBaseline: strictly refuses baseline update from deterministic simulation (isLive=false)', () => {
  assert.throws(
    () =>
      updateBaseline({
        scenario: 'test-scenario',
        summary: { total: { calls: 4, inputTokens: 50000, outputTokens: 8000 } },
        environment: {
          claudeCliVersion: '2.1.250 (Claude Code)',
          agyVersion: '1.1.22',
        },
        isLive: false, // deterministic!
      }),
    /Cannot update production live baseline: updates must originate from a verified real benchmark:live run/
  );
});

test('updateBaseline: refuses baseline update if environment contains placeholder versions even if isLive=true', () => {
  assert.throws(
    () =>
      updateBaseline({
        scenario: 'test-scenario',
        summary: { total: { calls: 1 } },
        environment: {
          claudeCliVersion: 'example-claude-version', // placeholder!
          agyVersion: '1.1.22',
        },
        isLive: true,
      }),
    /Cannot update baseline: claudeCliVersion "example-claude-version" is an invalid placeholder\/marker/
  );
});

test('updateBaseline: successfully updates validated baseline when isLive=true and environment is probed and valid', (t) => {
  const tmpFile = path.join(os.tmpdir(), `test-baselines-${Date.now()}.json`);
  t.after(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  const updated = updateBaseline({
    scenario: 'single-attempt',
    summary: {
      supervisor: { calls: 2, inputTokens: 42000, outputTokens: 4500 },
      reviewer: { calls: 1, inputTokens: 19000, outputTokens: 500 },
      executor: { calls: 1, inputTokens: 100, outputTokens: 3500 },
      total: { calls: 4, inputTokens: 55000, outputTokens: 8000 },
    },
    environment: {
      supergptVersion: '0.1.0',
      gitRevision: 'e68e357',
      agyVersion: '1.1.22',
      supervisorModel: 'gemini-3.7-flash-high',
      reviewerModel: 'gpt-oss-120b-medium',
      claudeCliVersion: '2.1.250 (Claude Code)',
      claudeExecutorModel: 'claude-sonnet-5',
    },
    isLive: true,
    filePath: tmpFile,
  });

  assert.equal(updated.environment.claudeCliVersion, '2.1.250 (Claude Code)');
  assert.equal(updated.expected.calls.total, 4);

  // Read back from file
  const loaded = loadRecordedBaselines(tmpFile);
  assert.ok(loaded['single-attempt']);
  assert.equal(loaded['single-attempt'].environment.claudeCliVersion, '2.1.250 (Claude Code)');
});

test('baselineSchema: schema specification example is explicitly distinct from production baselines', () => {
  assert.ok(SCHEMA_SPECIFICATION_EXAMPLE);
  assert.equal(SCHEMA_SPECIFICATION_EXAMPLE.scenario, 'example-scenario');
  assert.equal(isPlaceholderVersion(SCHEMA_SPECIFICATION_EXAMPLE.environment.claudeCliVersion), true);

  // In contrast, production baselines must have verified versions
  const prod = loadRecordedBaselines();
  assert.equal(isPlaceholderVersion(prod['rework-attempt'].environment.claudeCliVersion), false);
  assert.equal(prod['rework-attempt'].environment.claudeCliVersion, '2.1.250 (Claude Code)');
});
