// TokenAnomalyMonitor — zero-model-token token anomaly, regression, and duplicate monitor.
//
// Rules:
//   - Consumes ZERO model tokens (100% deterministic analysis).
//   - Deterministically detects duplicate accounting using immutable provider callId.
//   - Fallback heuristic for records without callId.
//   - Detects unexpected model-call counts per attempt / task.
//   - Detects abnormal prompt inflation between turns.
//   - Dynamically probes runtime environment metadata and versions token baselines.
//   - Prevents hardcoded placeholder versions (e.g. '2.1.0') in live baselines.
//   - Flags environment mismatches (BASELINE_ENVIRONMENT_CHANGED).
//   - Warns prominently but NEVER fails legitimate large workflows solely because absolute token usage is high.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeEnvironmentMetadata, isPlaceholderVersion } from './environmentProbe.js';

export const ANOMALY_TYPES = Object.freeze({
  DUPLICATE_ACCOUNTING: 'DUPLICATE_ACCOUNTING',
  UNEXPECTED_CALL_COUNT: 'UNEXPECTED_CALL_COUNT',
  PROMPT_INFLATION: 'PROMPT_INFLATION',
  BASELINE_REGRESSION: 'BASELINE_REGRESSION',
  BASELINE_ENVIRONMENT_CHANGED: 'BASELINE_ENVIRONMENT_CHANGED',
});

export const ANOMALY_SEVERITY = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
});

export const CURRENT_BASELINE_VERSION = '1.0.0';

// Documentation / Schema specification example only (NOT to be used as production metadata)
export const SCHEMA_SPECIFICATION_EXAMPLE = Object.freeze({
  version: '1.0.0',
  scenario: 'example-scenario',
  recordedAt: '2026-01-01T00:00:00.000Z',
  environment: {
    supergptVersion: '0.1.0',
    gitRevision: 'example-sha',
    agyVersion: 'example-agy-version',
    supervisorModel: 'gemini-3.7-flash-high',
    reviewerModel: 'gpt-oss-120b-medium',
    claudeCliVersion: 'example-claude-version',
    claudeExecutorModel: 'claude-sonnet-5',
  },
  expected: {
    calls: { supervisor: 2, reviewer: 1, executor: 1, total: 4 },
    tokens: {
      supervisor: { inputTokens: 40000, outputTokens: 4000 },
      reviewer: { inputTokens: 18000, outputTokens: 500 },
      executor: { inputTokens: 100, outputTokens: 3000 },
      total: { inputTokens: 58000, outputTokens: 7500 },
    },
  },
});

const DEFAULT_RECORDED_BASELINES = Object.freeze({
  'single-attempt': {
    version: '1.0.0',
    scenario: 'single-attempt',
    recordedAt: '2026-08-28T04:40:00.000Z',
    environment: {
      supergptVersion: '0.1.0',
      gitRevision: 'e68e357',
      agyVersion: '1.1.22',
      supervisorModel: 'gemini-3.7-flash-high',
      reviewerModel: 'gpt-oss-120b-medium',
      claudeCliVersion: '2.1.250 (Claude Code)',
      claudeExecutorModel: 'claude-sonnet-5',
    },
    expected: {
      calls: {
        supervisor: 2,
        reviewer: 1,
        executor: 1,
        total: 4,
      },
      tokens: {
        supervisor: { inputTokens: 42000, outputTokens: 4500 },
        reviewer: { inputTokens: 19000, outputTokens: 500 },
        executor: { inputTokens: 100, outputTokens: 3500 },
        total: { inputTokens: 55000, outputTokens: 8000 },
      },
    },
    total: { calls: 4, inputTokens: 55000, outputTokens: 8000 },
    supervisor: { calls: 2, inputTokens: 42000, outputTokens: 4500 },
    reviewer: { calls: 1, inputTokens: 19000, outputTokens: 500 },
    executor: { calls: 1, inputTokens: 100, outputTokens: 3500 },
  },
  'rework-attempt': {
    version: '1.0.0',
    scenario: 'rework-attempt',
    recordedAt: '2026-08-28T04:40:00.000Z',
    environment: {
      supergptVersion: '0.1.0',
      gitRevision: 'e68e357',
      agyVersion: '1.1.22',
      supervisorModel: 'gemini-3.7-flash-high',
      reviewerModel: 'gpt-oss-120b-medium',
      claudeCliVersion: '2.1.250 (Claude Code)',
      claudeExecutorModel: 'claude-sonnet-5',
    },
    expected: {
      calls: {
        supervisor: 3,
        reviewer: 2,
        executor: 2,
        total: 7,
      },
      tokens: {
        supervisor: { inputTokens: 81000, outputTokens: 6600 },
        reviewer: { inputTokens: 38000, outputTokens: 800 },
        executor: { inputTokens: 100, outputTokens: 7000 },
        total: { inputTokens: 120000, outputTokens: 15000 },
      },
    },
    total: { calls: 7, inputTokens: 120000, outputTokens: 15000 },
    supervisor: { calls: 3, inputTokens: 81000, outputTokens: 6600 },
    reviewer: { calls: 2, inputTokens: 38000, outputTokens: 800 },
    executor: { calls: 2, inputTokens: 100, outputTokens: 7000 },
  },
});

/**
 * Load persisted recorded baselines from disk or fallback to verified defaults.
 */
export function loadRecordedBaselines(customPath = null) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const filePath = customPath || path.resolve(here, 'baselines/recordedBaselines.json');
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.baselines && typeof raw.baselines === 'object') {
        const res = {};
        for (const [key, b] of Object.entries(raw.baselines)) {
          res[key] = {
            ...b,
            total: b.total || b.expected?.tokens?.total,
            supervisor: b.supervisor || { calls: b.expected?.calls?.supervisor, ...b.expected?.tokens?.supervisor },
            reviewer: b.reviewer || { calls: b.expected?.calls?.reviewer, ...b.expected?.tokens?.reviewer },
            executor: b.executor || { calls: b.expected?.calls?.executor, ...b.expected?.tokens?.executor },
          };
        }
        return Object.freeze(res);
      }
    }
  } catch {}
  return DEFAULT_RECORDED_BASELINES;
}

export function saveRecordedBaseline(scenario, baselineData, customPath = null) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = customPath || path.resolve(here, 'baselines/recordedBaselines.json');
  let current = { schemaVersion: '1.0.0', updatedAt: new Date().toISOString(), baselines: {} };
  if (fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {}
  }
  current.updatedAt = new Date().toISOString();
  current.baselines[scenario] = baselineData;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf8');
}

/**
 * Update baseline following an explicitly validated real live benchmark run.
 * Deterministic simulations are strictly disallowed from updating production baselines.
 */
export function updateBaseline({
  scenario = 'rework-attempt',
  summary,
  environment = null,
  isLive = false,
  version = CURRENT_BASELINE_VERSION,
  filePath = null,
} = {}) {
  if (!isLive) {
    throw new Error(
      'Cannot update production live baseline: updates must originate from a verified real benchmark:live run using native provider usage, not deterministic simulation.'
    );
  }

  const env = environment || probeEnvironmentMetadata();
  if (isPlaceholderVersion(env.claudeCliVersion)) {
    throw new Error(`Cannot update baseline: claudeCliVersion "${env.claudeCliVersion}" is an invalid placeholder/marker`);
  }
  if (isPlaceholderVersion(env.agyVersion)) {
    throw new Error(`Cannot update baseline: agyVersion "${env.agyVersion}" is an invalid placeholder/marker`);
  }

  const baselineData = {
    version,
    scenario,
    recordedAt: new Date().toISOString(),
    environment: {
      supergptVersion: env.supergptVersion,
      gitRevision: env.gitRevision,
      agyVersion: env.agyVersion,
      supervisorModel: env.supervisorModel,
      reviewerModel: env.reviewerModel,
      claudeCliVersion: env.claudeCliVersion,
      claudeExecutorModel: env.claudeExecutorModel,
    },
    expected: {
      calls: {
        supervisor: summary?.supervisor?.calls ?? 0,
        reviewer: summary?.reviewer?.calls ?? 0,
        executor: summary?.executor?.calls ?? 0,
        total: summary?.total?.calls ?? 0,
      },
      tokens: {
        supervisor: { inputTokens: summary?.supervisor?.inputTokens ?? 0, outputTokens: summary?.supervisor?.outputTokens ?? 0 },
        reviewer: { inputTokens: summary?.reviewer?.inputTokens ?? 0, outputTokens: summary?.reviewer?.outputTokens ?? 0 },
        executor: { inputTokens: summary?.executor?.inputTokens ?? 0, outputTokens: summary?.executor?.outputTokens ?? 0 },
        total: { inputTokens: summary?.total?.inputTokens ?? 0, outputTokens: summary?.total?.outputTokens ?? 0 },
      },
    },
    total: { calls: summary?.total?.calls ?? 0, inputTokens: summary?.total?.inputTokens ?? 0, outputTokens: summary?.total?.outputTokens ?? 0 },
    supervisor: { calls: summary?.supervisor?.calls ?? 0, inputTokens: summary?.supervisor?.inputTokens ?? 0, outputTokens: summary?.supervisor?.outputTokens ?? 0 },
    reviewer: { calls: summary?.reviewer?.calls ?? 0, inputTokens: summary?.reviewer?.inputTokens ?? 0, outputTokens: summary?.reviewer?.outputTokens ?? 0 },
    executor: { calls: summary?.executor?.calls ?? 0, inputTokens: summary?.executor?.inputTokens ?? 0, outputTokens: summary?.executor?.outputTokens ?? 0 },
  };

  saveRecordedBaseline(scenario, baselineData, filePath);
  return baselineData;
}

export const VERSIONED_BASELINES = loadRecordedBaselines();

export const TINY_WORKFLOW_BASELINE = Object.freeze({
  SINGLE_ATTEMPT: VERSIONED_BASELINES['single-attempt'] || DEFAULT_RECORDED_BASELINES['single-attempt'],
  REWORK_ATTEMPT: VERSIONED_BASELINES['rework-attempt'] || DEFAULT_RECORDED_BASELINES['rework-attempt'],
});

export function checkBaselineEnvironmentCompatibility(baseline, currentEnv = {}) {
  if (!baseline || !baseline.environment) return { compatible: true, diffs: [] };
  const diffs = [];
  const bEnv = baseline.environment;

  if (isPlaceholderVersion(bEnv.claudeCliVersion)) {
    diffs.push(`Baseline carries placeholder claudeCliVersion: "${bEnv.claudeCliVersion}"`);
  }
  if (isPlaceholderVersion(currentEnv.claudeCliVersion)) {
    diffs.push(`Current environment claudeCliVersion is placeholder/unavailable: "${currentEnv.claudeCliVersion}"`);
  } else if (currentEnv.claudeCliVersion && currentEnv.claudeCliVersion !== bEnv.claudeCliVersion) {
    diffs.push(`Claude CLI version changed: baseline=${bEnv.claudeCliVersion}, current=${currentEnv.claudeCliVersion}`);
  }

  if (currentEnv.supervisorModel && currentEnv.supervisorModel !== bEnv.supervisorModel) {
    diffs.push(`Supervisor model changed: baseline=${bEnv.supervisorModel}, current=${currentEnv.supervisorModel}`);
  }
  if (currentEnv.reviewerModel && currentEnv.reviewerModel !== bEnv.reviewerModel) {
    diffs.push(`Reviewer model changed: baseline=${bEnv.reviewerModel}, current=${currentEnv.reviewerModel}`);
  }
  if (currentEnv.claudeExecutorModel && currentEnv.claudeExecutorModel !== bEnv.claudeExecutorModel) {
    diffs.push(`Claude executor model changed: baseline=${bEnv.claudeExecutorModel}, current=${currentEnv.claudeExecutorModel}`);
  }
  if (currentEnv.agyVersion && currentEnv.agyVersion !== bEnv.agyVersion) {
    diffs.push(`agy CLI version changed: baseline=${bEnv.agyVersion}, current=${currentEnv.agyVersion}`);
  }

  return {
    compatible: diffs.length === 0,
    diffs,
  };
}

export class TokenAnomalyMonitor {
  constructor({
    duplicateTimeWindowMs = 1500,
    promptGrowthRatioThreshold = 2.5,
    promptGrowthMinTokens = 20000,
    baselineRegressionCallsMultiplier = 1.5,
    baselineRegressionTokensMultiplier = 2.2,
  } = {}) {
    this.duplicateTimeWindowMs = duplicateTimeWindowMs;
    this.promptGrowthRatioThreshold = promptGrowthRatioThreshold;
    this.promptGrowthMinTokens = promptGrowthMinTokens;
    this.baselineRegressionCallsMultiplier = baselineRegressionCallsMultiplier;
    this.baselineRegressionTokensMultiplier = baselineRegressionTokensMultiplier;
  }

  /**
   * Run full anomaly analysis over usage tracker data and workflow context.
   * Consumes ZERO model tokens.
   *
   * @param {object} opts
   * @param {object} opts.tracker           UsageTracker instance or summary object
   * @param {object} [opts.workflowContext] { tasksCount, attemptCount, reworkCount, currentEnv }
   * @param {object} [opts.baseline]        Baseline summary to compare against
   * @returns {object} { anomalies, hasAnomalies, warningCount, criticalCount, formattedBanner }
   */
  analyze({ tracker, workflowContext = {}, baseline = null } = {}) {
    const anomalies = [];
    if (!tracker) {
      return {
        anomalies: [],
        hasAnomalies: false,
        warningCount: 0,
        criticalCount: 0,
        formattedBanner: null,
      };
    }

    const records = tracker.records || [];
    const summary = typeof tracker.summary === 'function' ? tracker.summary() : tracker;

    // 1. Detect duplicate accounting in records (callId primary + timestamp fallback)
    this.detectDuplicateRecords(records, anomalies);

    // 2. Detect unexpected call counts based on workflow state machine bounds
    this.detectUnexpectedCallCounts(summary, workflowContext, anomalies);

    // 3. Detect abnormal turn-over-turn prompt inflation
    this.detectPromptInflation(records, anomalies);

    // 4. Detect regressions relative to baseline (and environment changes)
    if (baseline) {
      this.detectBaselineRegression(summary, baseline, workflowContext.currentEnv ?? {}, anomalies);
    }

    const warningCount = anomalies.filter((a) => a.severity === ANOMALY_SEVERITY.WARNING).length;
    const criticalCount = anomalies.filter((a) => a.severity === ANOMALY_SEVERITY.CRITICAL).length;
    const hasAnomalies = anomalies.length > 0;
    const formattedBanner = hasAnomalies ? this.formatAnomalyBanner(anomalies) : null;

    return {
      anomalies,
      hasAnomalies,
      warningCount,
      criticalCount,
      formattedBanner,
    };
  }

  /**
   * Detect duplicate usage entries.
   *
   * Primary: immutable callId matching across records.
   * Fallback: timestamp & token matching ONLY for legacy records without callId.
   */
  detectDuplicateRecords(records, anomalies) {
    if (!Array.isArray(records) || records.length < 2) return;

    // 1. Primary deterministic detector: unique callId tracking
    const seenCallIds = new Map();
    const recordsWithoutCallId = [];

    for (const r of records) {
      if (r.callId) {
        if (seenCallIds.has(r.callId)) {
          anomalies.push({
            type: ANOMALY_TYPES.DUPLICATE_ACCOUNTING,
            severity: ANOMALY_SEVERITY.CRITICAL,
            role: r.role,
            callId: r.callId,
            message: `Deterministic duplicate accounting: physical provider invocation "${r.callId}" (${r.role}) was recorded multiple times`,
            details: { callId: r.callId, firstRecord: seenCallIds.get(r.callId), duplicateRecord: r },
          });
        } else {
          seenCallIds.set(r.callId, r);
        }
      } else {
        recordsWithoutCallId.push(r);
      }
    }

    // 2. Fallback heuristic detector for legacy/injected records lacking callId
    if (recordsWithoutCallId.length >= 2) {
      for (let i = 0; i < recordsWithoutCallId.length; i++) {
        for (let j = i + 1; j < recordsWithoutCallId.length; j++) {
          const a = recordsWithoutCallId[i];
          const b = recordsWithoutCallId[j];

          if (a.role !== b.role) continue;
          if (a.taskId && b.taskId && a.taskId !== b.taskId) continue;
          if (a.attempt !== null && b.attempt !== null && a.attempt !== b.attempt) continue;

          const timeA = new Date(a.timestamp).getTime();
          const timeB = new Date(b.timestamp).getTime();
          const diffMs = Math.abs(timeB - timeA);

          if (
            diffMs <= this.duplicateTimeWindowMs &&
            a.inputTokens === b.inputTokens &&
            a.outputTokens === b.outputTokens &&
            a.inputTokens > 0
          ) {
            anomalies.push({
              type: ANOMALY_TYPES.DUPLICATE_ACCOUNTING,
              severity: ANOMALY_SEVERITY.CRITICAL,
              role: a.role,
              message: `Duplicate accounting detected (heuristic fallback): ${a.role} recorded identical usage (${a.inputTokens} in / ${a.outputTokens} out) twice within ${diffMs}ms (attempt: ${a.attempt ?? 'turn'})`,
              details: { recordA: a, recordB: b, diffMs },
            });
          }
        }
      }
    }
  }

  /**
   * Detect call count violations against theoretical workflow state transitions.
   */
  detectUnexpectedCallCounts(summary, { tasksCount = null, attemptCount = null, attemptsByTask = null, reworkCount = null, plannerCalls = 0, providerFailovers = 0, supervisorRotations = 0 } = {}, anomalies) {
    if (!summary) return;

    const sup = summary.supervisor || { calls: 0 };
    const rev = summary.reviewer || { calls: 0 };
    const exe = summary.executor || { calls: 0 };

    // A workflow has many task-local attempt counters.  Never compare the
    // workflow-wide physical calls to the final task's attempt number.
    const derivedAttempts = attemptsByTask && typeof attemptsByTask === 'object'
      ? Object.values(attemptsByTask).reduce((sum, value) => sum + (Number(value) || 0), 0)
      : attemptCount;
    if (derivedAttempts !== null && derivedAttempts > 0) {
      if (rev.calls > derivedAttempts) {
        anomalies.push({
          type: ANOMALY_TYPES.UNEXPECTED_CALL_COUNT,
          severity: ANOMALY_SEVERITY.CRITICAL,
          role: 'reviewer',
          message: `Unexpected Reviewer call count: ${rev.calls} calls for ${derivedAttempts} workflow attempt(s) (expected at most ${derivedAttempts})`,
          details: { calls: rev.calls, maxExpected: derivedAttempts, attemptsByTask },
        });
      }

      if (exe.calls > derivedAttempts) {
        anomalies.push({
          type: ANOMALY_TYPES.UNEXPECTED_CALL_COUNT,
          severity: ANOMALY_SEVERITY.CRITICAL,
          role: 'executor',
          message: `Unexpected Executor call count: ${exe.calls} calls for ${derivedAttempts} workflow attempt(s) (expected at most ${derivedAttempts})`,
          details: { calls: exe.calls, maxExpected: derivedAttempts, attemptsByTask },
        });
      }
    }

    if (tasksCount !== null && tasksCount > 0) {
      const reworks = reworkCount ?? (derivedAttempts ? Math.max(0, derivedAttempts - tasksCount) : 0);
      // one decision per task/attempt transition, with explicitly recorded
      // physical failover and session-rotation calls allowed separately.
      const maxExpectedSupervisor = tasksCount + reworks + 1 + (Number(plannerCalls) || 0) * 0 + (Number(providerFailovers) || 0) + (Number(supervisorRotations) || 0);

      if (sup.calls > maxExpectedSupervisor) {
        anomalies.push({
          type: ANOMALY_TYPES.UNEXPECTED_CALL_COUNT,
          severity: ANOMALY_SEVERITY.WARNING,
          role: 'supervisor',
          message: `Unexpected Supervisor call count: ${sup.calls} calls for ${tasksCount} task(s) and ${reworks} rework(s) (expected at most ${maxExpectedSupervisor})`,
          details: { calls: sup.calls, maxExpected: maxExpectedSupervisor },
        });
      }
    }
  }

  /**
   * Detect sudden exponential prompt inflation within a role's turns.
   */
  detectPromptInflation(records, anomalies) {
    if (!Array.isArray(records) || records.length < 2) return;

    const byRole = {};
    for (const rec of records) {
      if (!byRole[rec.role]) byRole[rec.role] = [];
      byRole[rec.role].push(rec);
    }

    for (const [role, roleRecords] of Object.entries(byRole)) {
      for (let i = 0; i < roleRecords.length - 1; i++) {
        const curr = roleRecords[i];
        const next = roleRecords[i + 1];

        if (curr.inputTokens && next.inputTokens && curr.inputTokens > 0) {
          const ratio = next.inputTokens / curr.inputTokens;
          const delta = next.inputTokens - curr.inputTokens;

          if (ratio >= this.promptGrowthRatioThreshold && delta >= this.promptGrowthMinTokens) {
            anomalies.push({
              type: ANOMALY_TYPES.PROMPT_INFLATION,
              severity: ANOMALY_SEVERITY.WARNING,
              role,
              message: `Abnormal prompt inflation in ${role}: turn ${i + 2} input tokens grew by ${(ratio * 100).toFixed(0)}% (+${delta.toLocaleString()} tokens, from ${curr.inputTokens.toLocaleString()} to ${next.inputTokens.toLocaleString()})`,
              details: {
                fromTokens: curr.inputTokens,
                toTokens: next.inputTokens,
                ratio,
                delta,
              },
            });
          }
        }
      }
    }
  }

  /**
   * Detect regressions against a recorded baseline and environment changes.
   */
  detectBaselineRegression(current, baseline, currentEnv, anomalies) {
    if (!current || !baseline) return;

    // Check environment compatibility
    const envCheck = checkBaselineEnvironmentCompatibility(baseline, currentEnv);
    if (!envCheck.compatible) {
      anomalies.push({
        type: ANOMALY_TYPES.BASELINE_ENVIRONMENT_CHANGED,
        severity: ANOMALY_SEVERITY.WARNING,
        role: 'workflow',
        message: `Baseline environment changed (${baseline.scenario || 'baseline'} v${baseline.version || '1.0'}): ${envCheck.diffs.join('; ')}`,
        details: { baselineEnv: baseline.environment, currentEnv, diffs: envCheck.diffs },
      });
    }

    const curTot = current.total || current.workflow || {};
    const baseTot = (baseline.expected ? baseline.expected.tokens.total : null) || baseline.total || baseline.workflow || {};
    const baseCalls = (baseline.expected ? baseline.expected.calls.total : null) || baseline.total?.calls || 0;

    // Total calls check
    if (baseCalls > 0 && curTot.calls > 0) {
      const callRatio = curTot.calls / baseCalls;
      if (callRatio >= this.baselineRegressionCallsMultiplier) {
        anomalies.push({
          type: ANOMALY_TYPES.BASELINE_REGRESSION,
          severity: ANOMALY_SEVERITY.WARNING,
          role: 'workflow',
          message: `Call count regression: ${curTot.calls} total calls is ${(callRatio * 100).toFixed(0)}% of baseline (${baseCalls} calls)`,
          details: { current: curTot.calls, baseline: baseCalls, ratio: callRatio },
        });
      }
    }

    // Total input tokens check
    if (baseTot.inputTokens > 0 && curTot.inputTokens > 0) {
      const tokenRatio = curTot.inputTokens / baseTot.inputTokens;
      if (tokenRatio >= this.baselineRegressionTokensMultiplier) {
        anomalies.push({
          type: ANOMALY_TYPES.BASELINE_REGRESSION,
          severity: ANOMALY_SEVERITY.WARNING,
          role: 'workflow',
          message: `Input token regression: ${curTot.inputTokens.toLocaleString()} input tokens is ${(tokenRatio * 100).toFixed(0)}% of baseline (${baseTot.inputTokens.toLocaleString()})`,
          details: { current: curTot.inputTokens, baseline: baseTot.inputTokens, ratio: tokenRatio },
        });
      }
    }
  }

  /**
   * Format prominent warning banner for human/agent visibility.
   */
  formatAnomalyBanner(anomalies) {
    if (!Array.isArray(anomalies) || anomalies.length === 0) return null;

    const lines = [
      '============================================================',
      '⚠️  SUPERGPT TOKEN ANOMALY / REGRESSION DETECTED ⚠️',
      '------------------------------------------------------------',
    ];

    for (const a of anomalies) {
      const tag = a.severity === ANOMALY_SEVERITY.CRITICAL ? 'CRITICAL' : 'WARN';
      lines.push(`  [${tag}] [${a.type}] ${a.message}`);
    }

    lines.push('------------------------------------------------------------');
    lines.push('Telemetry notice: tokens may be spent on redundant context,');
    lines.push('duplicated accounting, or uncompacted conversations.');
    lines.push('============================================================');

    return lines.join('\n');
  }
}

export { probeEnvironmentMetadata, isPlaceholderVersion };
