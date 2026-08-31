// UsageTracker — track, record, and aggregate real token usage metadata
// across Supervisor, Executor, Reviewer, and Planner.
//
// Rules (PHASE A1):
//   - Record usage ONLY when the provider actually exposes it.
//   - Never estimate token counts when the provider does not expose them.
//   - No extra model call may be made merely to obtain usage information.
//   - Do not log prompts or private model responses.
//   - Expose local structured usage summaries: workflow, supervisor,
//     executor, reviewer, planner, total.

import { TokenAnomalyMonitor, TINY_WORKFLOW_BASELINE } from './tokenAnomalyMonitor.js';

export const USAGE_ROLES = Object.freeze({
  SUPERVISOR: 'supervisor',
  EXECUTOR: 'executor',
  INTERNAL_REVIEWER: 'internalReviewer',
  REVIEWER: 'internalReviewer',
  PLANNER: 'planner',
});

function normalizeNumber(val) {
  return Number.isFinite(val) ? val : null;
}

function emptyRoleBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byModel: {},
  };
}

const INPUT_CATEGORIES = ['taskCard', 'repoContext', 'history', 'evidence', 'other'];

function aggregateExecutorInputBreakdown(records) {
  const executorRecords = records.filter((record) => record?.role === 'executor');
  const categories = Object.fromEntries(INPUT_CATEGORIES.map((name) => [name, {
    bytes: 0, characters: 0, tokens: 0,
  }]));
  let callsWithBreakdown = 0;
  let providerInputTokens = 0;
  let cachedTokens = 0;

  const perCall = executorRecords.map((record) => {
    const breakdown = record.inputBreakdown && typeof record.inputBreakdown === 'object'
      ? record.inputBreakdown : null;
    if (breakdown) {
      callsWithBreakdown += 1;
      for (const name of INPUT_CATEGORIES) {
        const item = breakdown.categories?.[name] ?? {};
        categories[name].bytes += Math.max(0, Number(item.bytes) || 0);
        categories[name].characters += Math.max(0, Number(item.characters ?? item.chars) || 0);
        categories[name].tokens += Math.max(0, Number(item.tokens) || 0);
      }
    }
    providerInputTokens += Math.max(0, Number(record.inputTokens) || 0);
    cachedTokens += Math.max(0, Number(record.cachedTokens) || 0);
    return {
      callId: record.callId ?? null,
      taskId: record.taskId ?? null,
      attempt: record.attempt ?? null,
      inputTokens: record.inputTokens ?? null,
      cachedTokens: record.cachedTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      breakdown,
      legacy: !breakdown,
    };
  });

  return {
    perCall,
    aggregate: {
      calls: executorRecords.length,
      callsWithBreakdown,
      legacyCalls: executorRecords.length - callsWithBreakdown,
      providerInputTokens,
      cachedTokens,
      categories,
      componentTokens: INPUT_CATEGORIES.reduce((sum, name) => sum + categories[name].tokens, 0),
      semantics: 'Categories compose provider input tokens; cached tokens are a provider subset and are not added to composition.',
    },
  };
}

function reconcileInputBreakdown(value, providerInputTokens) {
  if (!value || typeof value !== 'object') return null;
  const source = value.categories ?? {};
  const totalBytes = INPUT_CATEGORIES.reduce((sum, name) => sum + Math.max(0, Number(source[name]?.bytes) || 0), 0);
  const categories = {};
  let attributed = 0;
  for (const [index, name] of INPUT_CATEGORIES.entries()) {
    const item = source[name] ?? {};
    const tokens = Number.isFinite(providerInputTokens) && totalBytes > 0
      ? (index === INPUT_CATEGORIES.length - 1
        ? providerInputTokens - attributed
        : Math.floor(providerInputTokens * (Math.max(0, Number(item.bytes) || 0) / totalBytes)))
      : (Number.isFinite(item.estimatedTokens) ? item.estimatedTokens : null);
    if (tokens !== null) attributed += tokens;
    categories[name] = {
      ...item,
      tokens,
      tokenAccounting: Number.isFinite(providerInputTokens) ? 'provider-total-proportional-by-utf8-bytes' : 'deterministic-estimate',
    };
  }
  return {
    ...value,
    categories,
    providerInputTokens: Number.isFinite(providerInputTokens) ? providerInputTokens : null,
    componentTokens: INPUT_CATEGORIES.reduce((sum, name) => sum + (categories[name].tokens ?? 0), 0),
    unattributedTokens: Number.isFinite(providerInputTokens) ? providerInputTokens - attributed : null,
  };
}

export class UsageTracker {
  constructor({ anomalyMonitor = new TokenAnomalyMonitor() } = {}) {
    this.records = [];
    this.anomalyMonitor = anomalyMonitor;
    this.byRole = {
      supervisor: emptyRoleBucket(),
      executor: emptyRoleBucket(),
      internalReviewer: emptyRoleBucket(),
      planner: emptyRoleBucket(),
    };
    this.byTask = {};
  }

  /**
   * Record a provider call's usage metadata.
   */
  record({
    workflowId = null,
    role,
    callId = null,
    taskId = null,
    attempt = null,
    repairRound = null,
    provider = null,
    model = null,
    requestedFamily = null,
    resolvedModel = null,
    providerMetadata = null,
    usage = null,
    costUsd = null,
    durationMs = null,
    startedAt = null,
    completedAt = null,
    inputBreakdown = null,
  } = {}) {
    if (!role) throw new Error('UsageTracker.record() requires a role');

    let normalizedRole = String(role);
    const lower = normalizedRole.toLowerCase();
    if (lower === 'reviewer' || lower === 'internal_reviewer' || lower === 'internalreviewer') {
      normalizedRole = 'internalReviewer';
    } else if (lower === 'supervisor') {
      normalizedRole = 'supervisor';
    } else if (lower === 'executor') {
      normalizedRole = 'executor';
    } else if (lower === 'planner') {
      normalizedRole = 'planner';
    }

    const effectiveCallId = callId ?? usage?.callId ?? null;
    let inputTokens = null;
    let outputTokens = null;
    let cachedTokens = null;
    let totalTokens = null;

    if (usage && typeof usage === 'object') {
      const inTok = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
      const outTok = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
      const cacheRead = usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
      const cached = cacheRead + cacheCreate;
      const totTok = usage.total_tokens ?? usage.totalTokens;

      if (Number.isFinite(inTok)) inputTokens = inTok;
      if (Number.isFinite(outTok)) outputTokens = outTok;
      if (cached > 0) cachedTokens = cached;
      if (Number.isFinite(totTok)) {
        totalTokens = totTok;
      } else if (inputTokens !== null || outputTokens !== null) {
        totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
      }
    }

    const effectiveProvider = provider ?? (model?.startsWith('claude') ? 'claude' : (model?.startsWith('codex') ? 'codex' : null));
    const effectiveModel = resolvedModel ?? model ?? 'default';
    const modelKey = effectiveProvider
      ? (effectiveModel && !effectiveModel.startsWith(effectiveProvider) ? `${effectiveProvider}:${effectiveModel}` : effectiveModel)
      : effectiveModel;

    const rec = {
      timestamp: new Date().toISOString(),
      startedAt: startedAt ?? new Date().toISOString(),
      completedAt: completedAt ?? new Date().toISOString(),
      workflowId,
      role: normalizedRole,
      callId: effectiveCallId,
      taskId,
      attempt,
      repairRound,
      provider: effectiveProvider,
      model: effectiveModel,
      modelKey,
      requestedFamily,
      resolvedModel: effectiveModel,
      providerMetadata: providerMetadata && typeof providerMetadata === 'object' ? { ...providerMetadata } : null,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      costUsd: normalizeNumber(costUsd),
      durationMs: normalizeNumber(durationMs),
      inputBreakdown: normalizedRole === 'executor' ? reconcileInputBreakdown(inputBreakdown, inputTokens) : null,
    };

    this.records.push(rec);

    if (!this.byRole[normalizedRole]) {
      this.byRole[normalizedRole] = emptyRoleBucket();
    }
    const bucket = this.byRole[normalizedRole];
    bucket.calls += 1;
    if (inputTokens !== null) bucket.inputTokens += inputTokens;
    if (outputTokens !== null) bucket.outputTokens += outputTokens;
    if (cachedTokens !== null) bucket.cachedTokens += cachedTokens;
    if (totalTokens !== null) bucket.totalTokens += totalTokens;
    if (rec.costUsd !== null) bucket.costUsd += rec.costUsd;

    if (!bucket.byModel[modelKey]) {
      bucket.byModel[modelKey] = {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      };
    }
    const mBucket = bucket.byModel[modelKey];
    mBucket.calls += 1;
    if (inputTokens !== null) mBucket.inputTokens += inputTokens;
    if (outputTokens !== null) mBucket.outputTokens += outputTokens;
    if (cachedTokens !== null) mBucket.cachedTokens += cachedTokens;
    if (totalTokens !== null) mBucket.totalTokens += totalTokens;
    if (rec.costUsd !== null) mBucket.costUsd += rec.costUsd;

    if (taskId) {
      if (!this.byTask[taskId]) this.byTask[taskId] = {};
      const attKey = attempt !== null ? String(attempt) : '1';
      if (!this.byTask[taskId][attKey]) this.byTask[taskId][attKey] = [];
      this.byTask[taskId][attKey].push(rec);
    }

    return rec;
  }

  /**
   * Run zero-model-token anomaly and regression check.
   */
  checkAnomalies({ workflowContext = {}, baseline = null } = {}) {
    return this.anomalyMonitor.analyze({
      tracker: this,
      workflowContext,
      baseline,
    });
  }

  /**
   * Return a structured summary of token usage across all roles.
   */
  summary({ workflowContext = {}, baseline = null, checkAnomalies = false, prCloseout = null } = {}) {
    const measuredTotal = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };

    const rolesSummary = {};
    for (const [role, data] of Object.entries(this.byRole)) {
      rolesSummary[role] = { ...data, byModel: { ...data.byModel } };
      measuredTotal.calls += data.calls;
      measuredTotal.inputTokens += data.inputTokens;
      measuredTotal.outputTokens += data.outputTokens;
      measuredTotal.cachedTokens += data.cachedTokens;
      measuredTotal.totalTokens += data.totalTokens;
      measuredTotal.costUsd += data.costUsd;
    }

    const reviewerName = prCloseout?.configuredReviewer || prCloseout?.activeReviewer || null;
    const externalPrReviewer = {
      reviewer: reviewerName,
      usageAvailable: false,
      note: reviewerName ? 'Token usage: unavailable / external' : 'Not configured',
      reviewed: Boolean(prCloseout?.reviewedPrHead),
    };

    const executorBreakdown = aggregateExecutorInputBreakdown(this.records);
    const res = {
      workflow: { ...measuredTotal },
      supervisor: rolesSummary.supervisor || emptyRoleBucket(),
      executor: rolesSummary.executor || emptyRoleBucket(),
      internalReviewer: rolesSummary.internalReviewer || emptyRoleBucket(),
      reviewer: rolesSummary.internalReviewer || emptyRoleBucket(), // backwards-compatible alias
      planner: rolesSummary.planner || emptyRoleBucket(),
      measuredTotal,
      total: measuredTotal, // backwards-compatible alias
      externalPrReviewer,
      hasUsageData: measuredTotal.totalTokens > 0 || measuredTotal.calls > 0,
      records: this.records,
      // Keep the historical array shape while exposing stable, presentation-ready
      // per-call metadata and aggregate totals alongside it.
      executorInputBreakdown: executorBreakdown.perCall.map((call) => call.breakdown),
      executorInputBreakdownCalls: executorBreakdown.perCall,
      executorInputBreakdownAggregate: executorBreakdown.aggregate,
    };

    if (checkAnomalies) {
      const report = this.checkAnomalies({ workflowContext, baseline });
      res.anomalies = report.anomalies;
      res.hasAnomalies = report.hasAnomalies;
      res.anomalyBanner = report.formattedBanner;
    }

    return res;
  }

  /**
   * Format a compact, safe multi-line text summary.
   */
  formatSummary() {
    const sum = this.summary();
    const lines = ['Token usage summary:'];
    const fmt = (n) => (n > 0 ? n.toLocaleString('en-US') : '0');
    const roles = [
      ['Supervisor', sum.supervisor],
      ['Executor', sum.executor],
      ['Reviewer', sum.reviewer],
      ['Planner', sum.planner],
    ];

    for (const [label, data] of roles) {
      if (data.calls > 0) {
        let line = `  ${label.padEnd(11)} ${String(data.calls).padStart(2)} call${data.calls === 1 ? ' ' : 's'}   ${fmt(data.inputTokens).padStart(7)} in   ${fmt(data.outputTokens).padStart(6)} out`;
        if (data.cachedTokens > 0) line += `   ${fmt(data.cachedTokens).padStart(7)} cached`;
        if (data.costUsd > 0) line += `   $${data.costUsd.toFixed(4)}`;
        lines.push(line);
      }
    }

    const t = sum.total;
    let totLine = `  Total       ${String(t.calls).padStart(2)} call${t.calls === 1 ? ' ' : 's'}   ${fmt(t.inputTokens).padStart(7)} in   ${fmt(t.outputTokens).padStart(6)} out`;
    if (t.cachedTokens > 0) totLine += `   ${fmt(t.cachedTokens).padStart(7)} cached`;
    if (t.costUsd > 0) totLine += `   $${t.costUsd.toFixed(4)}`;
    lines.push(totLine);

    const breakdown = sum.executorInputBreakdownAggregate;
    if (breakdown.calls > 0) {
      lines.push('Executor Input Breakdown:');
      if (breakdown.callsWithBreakdown === 0) {
        lines.push(`  Unavailable for ${breakdown.legacyCalls} legacy call${breakdown.legacyCalls === 1 ? '' : 's'}`);
      } else {
        for (const name of INPUT_CATEGORIES) {
          lines.push(`  ${name.padEnd(11)} ${fmt(breakdown.categories[name].tokens).padStart(7)} input tokens`);
        }
        lines.push(`  Provider     ${fmt(breakdown.providerInputTokens).padStart(7)} input   ${fmt(breakdown.cachedTokens).padStart(7)} cached (subset)`);
      }
    }

    return lines.join('\n');
  }

  toJSON() {
    return {
      records: this.records,
      byRole: this.byRole,
      byTask: this.byTask,
    };
  }

  static fromJSON(data) {
    const tracker = new UsageTracker();
    if (!data || typeof data !== 'object') return tracker;
    if (Array.isArray(data.records)) tracker.records = [...data.records];
    if (data.byRole && typeof data.byRole === 'object') {
      for (const [r, bucket] of Object.entries(data.byRole)) {
        if (tracker.byRole[r]) tracker.byRole[r] = { ...bucket };
      }
    }
    if (data.byTask && typeof data.byTask === 'object') {
      tracker.byTask = JSON.parse(JSON.stringify(data.byTask));
    }
    return tracker;
  }
}

export { TokenAnomalyMonitor, TINY_WORKFLOW_BASELINE };
