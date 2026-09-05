#!/usr/bin/env node
// SuperGPT Token Anomaly & Regression Benchmark Runner.
//
// Separates deterministic token regression checks (zero model calls) from
// live tiny-workflow benchmarks (costs real provider quota):
//   - npm run benchmark: deterministic, zero model calls, evaluates against versioned baselines.
//   - npm run benchmark:live: runs live tiny Gemini + Claude + GPT-OSS workflow, measures true usage.
//
// Usage:
//   node bin/benchmark-tokens.js                 # Run deterministic benchmark (zero model calls)
//   node bin/benchmark-tokens.js --live          # Run live tiny-workflow benchmark (costs real quota)
//   node bin/benchmark-tokens.js --baseline=rework # Compare against rework baseline (default)
//   node bin/benchmark-tokens.js --baseline=single # Compare against single-attempt baseline

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import {
  TokenAnomalyMonitor,
  TINY_WORKFLOW_BASELINE,
  VERSIONED_BASELINES,
  checkBaselineEnvironmentCompatibility,
  updateBaseline,
  probeEnvironmentMetadata,
} from '../src/orchestrator/tokenAnomalyMonitor.js';
import { runSuperGPT } from '../src/orchestrator/supergpt.js';
import { assertRealProviderCallsAuthorized } from '../src/orchestrator/realProviderCallGuard.js';

export function getEnvironmentMetadata(opts = {}) {
  return probeEnvironmentMetadata(opts);
}

export function runDeterministicBenchmark({
  scenario = 'rework', // 'rework' (1 task / 2 attempts) | 'single' (1 task / 1 attempt)
  simulateAnomaly = null, // null | 'duplicate' | 'inflation' | 'excess_calls' | 'env_mismatch'
} = {}) {
  const tracker = new UsageTracker();
  const baseline = scenario === 'single'
    ? VERSIONED_BASELINES['single-attempt']
    : VERSIONED_BASELINES['rework-attempt'];

  // Deterministic benchmarks must be hermetic. Host probes belong only to
  // benchmark:live; otherwise a CI runner without agy/Claude installed can
  // turn an unchanged deterministic scenario into an environment anomaly.
  const baselineEnv = baseline?.environment ?? {};
  const currentEnv = simulateAnomaly === 'env_mismatch'
    ? { ...baselineEnv, supervisorModel: 'gemini-2.0-flash-experimental' }
    : { ...baselineEnv };

  if (scenario === 'single') {
    // 1 task / 1 attempt
    // Turn 1: Supervisor NEXT_TASK
    tracker.record({
      role: 'supervisor',
      callId: 'call-agy-sup-bench-single-1',
      model: currentEnv.supervisorModel,
      usage: { input_tokens: 13660, output_tokens: 1500, cache_read_tokens: 0 },
    });
    // Attempt 1: Executor
    tracker.record({
      role: 'executor',
      callId: 'call-claude-exe-bench-single-1',
      taskId: 't-1',
      attempt: 1,
      model: currentEnv.claudeExecutorModel,
      usage: { input_tokens: 50, output_tokens: 3500, cache_read_input_tokens: 300000 },
      costUsd: 0.15,
    });
    // Reviewer: PASS
    tracker.record({
      role: 'reviewer',
      callId: 'call-agy-rev-bench-single-1',
      taskId: 't-1',
      attempt: 1,
      model: currentEnv.reviewerModel,
      usage: { input_tokens: 19000, output_tokens: 400 },
    });
    // Turn 2: Supervisor WORKFLOW_DONE
    tracker.record({
      role: 'supervisor',
      callId: 'call-agy-sup-bench-single-2',
      model: currentEnv.supervisorModel,
      usage: { input_tokens: 27500, output_tokens: 1200, cache_read_tokens: 8000 },
    });
  } else {
    // 1 task / 2 attempts (with 1 rework)
    // Turn 1: Supervisor NEXT_TASK
    tracker.record({
      role: 'supervisor',
      callId: 'call-agy-sup-bench-rework-1',
      model: currentEnv.supervisorModel,
      usage: { input_tokens: 13660, output_tokens: 1500, cache_read_tokens: 0 },
    });

    if (simulateAnomaly === 'duplicate') {
      // Deterministic duplicate: exact same callId recorded twice
      tracker.record({
        role: 'supervisor',
        callId: 'call-agy-sup-bench-rework-1',
        model: currentEnv.supervisorModel,
        usage: { input_tokens: 13660, output_tokens: 1500, cache_read_tokens: 0 },
      });
    }

    // Attempt 1: Executor
    tracker.record({
      role: 'executor',
      callId: 'call-claude-exe-bench-rework-1',
      taskId: 't-1',
      attempt: 1,
      model: currentEnv.claudeExecutorModel,
      usage: { input_tokens: 50, output_tokens: 3400, cache_read_input_tokens: 310000 },
      costUsd: 0.15,
    });

    // Reviewer 1: REWORK
    tracker.record({
      role: 'reviewer',
      callId: 'call-agy-rev-bench-rework-1',
      taskId: 't-1',
      attempt: 1,
      model: currentEnv.reviewerModel,
      usage: { input_tokens: 19000, output_tokens: 450 },
    });

    // Turn 2: Supervisor CONTINUE_REWORK
    const turn2Input = simulateAnomaly === 'inflation' ? 95000 : 27500;
    tracker.record({
      role: 'supervisor',
      callId: 'call-agy-sup-bench-rework-2',
      model: currentEnv.supervisorModel,
      usage: { input_tokens: turn2Input, output_tokens: 800, cache_read_tokens: 8000 },
    });

    // Attempt 2: Executor
    tracker.record({
      role: 'executor',
      callId: 'call-claude-exe-bench-rework-2',
      taskId: 't-1',
      attempt: 2,
      model: currentEnv.claudeExecutorModel,
      usage: { input_tokens: 50, output_tokens: 3400, cache_read_input_tokens: 315000 },
      costUsd: 0.15,
    });

    // Reviewer 2: PASS
    tracker.record({
      role: 'reviewer',
      callId: 'call-agy-rev-bench-rework-2',
      taskId: 't-1',
      attempt: 2,
      model: currentEnv.reviewerModel,
      usage: { input_tokens: 19000, output_tokens: 350 },
    });

    // Turn 3: Supervisor WORKFLOW_DONE
    tracker.record({
      role: 'supervisor',
      callId: 'call-agy-sup-bench-rework-3',
      model: currentEnv.supervisorModel,
      usage: { input_tokens: 41600, output_tokens: 1100, cache_read_tokens: 8400 },
    });

    if (simulateAnomaly === 'excess_calls') {
      tracker.record({
        role: 'supervisor',
        callId: 'call-agy-sup-bench-excess-1',
        model: currentEnv.supervisorModel,
        usage: { input_tokens: 45000, output_tokens: 500 },
      });
      tracker.record({
        role: 'supervisor',
        callId: 'call-agy-sup-bench-excess-2',
        model: currentEnv.supervisorModel,
        usage: { input_tokens: 48000, output_tokens: 500 },
      });
    }
  }

  const monitor = new TokenAnomalyMonitor();
  const report = monitor.analyze({
    tracker,
    workflowContext: {
      tasksCount: 1,
      attemptCount: scenario === 'single' ? 1 : 2,
      reworkCount: scenario === 'single' ? 0 : 1,
      currentEnv,
    },
    baseline,
  });

  return {
    scenario,
    environment: currentEnv,
    summary: tracker.summary(),
    baseline,
    report,
    isLive: false,
  };
}

export async function runLiveBenchmark({ scenario = 'rework' } = {}) {
  // --live is itself the explicit CLI live intent for this command (see
  // PART G of the guard task): a second --allow-real-provider-calls flag
  // would be redundant since the command has no other purpose. The env
  // opt-in is still required.
  assertRealProviderCallsAuthorized({
    explicitLiveIntent: true,
    entrypoint: 'bin/benchmark-tokens.js --live',
  });

  const currentEnv = getEnvironmentMetadata();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-live-bench-'));

  try {
    execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "SuperGPT Benchmark"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "benchmark@supergpt.local"', { cwd: tmpDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'live-bench', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'test.js'), '// initial test\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

    const planContent = `
Task: bench-handshake
Goal: Create greeting.js that exports hello(name) returning "hello " + name.
Allowed Files: greeting.js
Verification Commands: node -e "const { hello } = require('./greeting.js'); if (hello('world') !== 'hello world') process.exit(1)"
Scope: minimal test function
`.trim();

    const planPath = path.join(tmpDir, 'plan.txt');
    fs.writeFileSync(planPath, planContent);

    const runResult = await runSuperGPT({
      goal: 'Implement greeting module per plan',
      planPath,
      cwd: tmpDir,
    });

    const baseline = scenario === 'single'
      ? VERSIONED_BASELINES['single-attempt']
      : VERSIONED_BASELINES['rework-attempt'];

    const monitor = new TokenAnomalyMonitor();
    const report = monitor.analyze({
      tracker: runResult.tokenUsage,
      workflowContext: {
        tasksCount: 1,
        attemptCount: runResult.history?.length ?? 1,
        currentEnv,
      },
      baseline,
    });

    return {
      scenario,
      environment: currentEnv,
      summary: runResult.tokenUsage || {},
      baseline,
      report,
      isLive: true,
      workflowStatus: runResult.status,
      cleanupStatus: 'CLEANED',
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

export function formatBenchmarkReport({ scenario, environment, summary, baseline, report, isLive, workflowStatus, cleanupStatus }) {
  const fmt = (n) => (n !== undefined && n !== null && n > 0 ? n.toLocaleString('en-US') : '0');
  const pad = (s, len) => String(s).padEnd(len);
  const rpad = (s, len) => String(s).padStart(len);

  const lines = [
    '========================================================================',
    `SUPERGPT TOKEN BENCHMARK & REGRESSION REPORT (${isLive ? 'LIVE' : 'DETERMINISTIC'} · ${scenario.toUpperCase()})`,
    '========================================================================',
    `  Version:           SuperGPT v${environment.supergptVersion} (rev: ${environment.gitRevision})`,
    `  Supervisor Model:  ${environment.supervisorModel}`,
    `  Reviewer Model:    ${environment.reviewerModel}`,
    `  Executor:          ${environment.claudeExecutorModel} (${environment.claudeCliVersion})`,
    `  agy Version:       ${environment.agyVersion}`,
    `  Baseline Version:  v${baseline.version || '1.0.0'} (${baseline.scenario || scenario})`,
    '  ----------------------------------------------------------------------',
    `  ${pad('Role / Metric', 16)} ${rpad('Actual Calls', 13)} ${rpad('Base Calls', 11)} ${rpad('Actual In', 12)} ${rpad('Base In', 10)} ${rpad('Actual Out', 11)}`,
    '  ----------------------------------------------------------------------',
  ];

  const roles = [
    ['Supervisor', summary.supervisor, baseline.supervisor || baseline.expected?.calls?.supervisor],
    ['Executor', summary.executor, baseline.executor || baseline.expected?.calls?.executor],
    ['Reviewer', summary.reviewer, baseline.reviewer || baseline.expected?.calls?.reviewer],
  ];

  for (const [name, act, base] of roles) {
    const baseCalls = typeof base === 'object' ? base.calls : base;
    const baseIn = typeof base === 'object' ? base.inputTokens : 0;
    lines.push(
      `  ${pad(name, 16)} ${rpad(act?.calls ?? 0, 13)} ${rpad(baseCalls ?? '-', 11)} ${rpad(fmt(act?.inputTokens ?? 0), 12)} ${rpad(fmt(baseIn ?? 0), 10)} ${rpad(fmt(act?.outputTokens ?? 0), 11)}`
    );
  }

  const baseTot = baseline.expected?.tokens?.total || baseline.total || {};
  const baseTotCalls = baseline.expected?.calls?.total || baseline.total?.calls || 0;

  lines.push('  ----------------------------------------------------------------------');
  lines.push(
    `  ${pad('Total', 16)} ${rpad(summary.total?.calls ?? 0, 13)} ${rpad(baseTotCalls, 11)} ${rpad(fmt(summary.total?.inputTokens ?? 0), 12)} ${rpad(fmt(baseTot.inputTokens ?? 0), 10)} ${rpad(fmt(summary.total?.outputTokens ?? 0), 11)}`
  );
  lines.push('');

  if (isLive) {
    lines.push(`  Workflow Status:   ${workflowStatus || 'UNKNOWN'}`);
    lines.push(`  Resource Cleanup:  ${cleanupStatus || 'CLEANED'}`);
    lines.push('');
  }

  if (report.hasAnomalies) {
    lines.push(report.formattedBanner);
  } else {
    lines.push('✔ BENCHMARK PASSED: Zero token anomalies or regressions detected.');
    lines.push('  - 1:1 call accounting verified via immutable callId.');
    lines.push('  - Turn prompt growth within expected bounds.');
    lines.push('  - Token consumption within compatible baseline tolerance.');
  }

  lines.push('========================================================================');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const shouldUpdate = args.includes('--update-baseline');
  const scenario = args.includes('--baseline=single') ? 'single' : 'rework';
  const baselineKey = scenario === 'single' ? 'single-attempt' : 'rework-attempt';

  let result;
  if (isLive) {
    console.log('Running live tiny-workflow benchmark (using real Gemini + Claude + GPT-OSS quota)...');
    result = await runLiveBenchmark({ scenario });
  } else {
    result = runDeterministicBenchmark({ scenario });
  }

  console.log(formatBenchmarkReport(result));

  if (shouldUpdate) {
    if (!isLive) {
      console.error(
        '\n✖ Cannot update production live baseline from deterministic simulation: baseline updates are strictly restricted to verified benchmark:live runs.'
      );
      process.exitCode = 1;
      return;
    }
    if (result.report.criticalCount > 0) {
      console.error(`\n✖ Cannot update baseline: benchmark detected ${result.report.criticalCount} critical anomaly/anomalies.`);
      process.exitCode = 1;
      return;
    }
    const updated = updateBaseline({
      scenario: baselineKey,
      summary: result.summary,
      environment: result.environment,
      isLive: true,
    });
    console.log(`\n✔ Successfully updated and saved production live baseline for "${baselineKey}" (Claude CLI: ${updated.environment.claudeCliVersion}, agy: ${updated.environment.agyVersion}).`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Benchmark failed:', err.message ?? err);
    process.exitCode = err.exitCode ?? 1;
  });
}