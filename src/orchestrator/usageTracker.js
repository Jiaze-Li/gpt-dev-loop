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
  REVIEWER: 'reviewer',
  PLANNER: 'planner',
});

function normalizeNumber(val) {
  return Number.isFinite(val) ? val : null;
}

export class UsageTracker {
  constructor({ anomalyMonitor = new TokenAnomalyMonitor() } = {}) {
    this.records = [];
    this.anomalyMonitor = anomalyMonitor;
    this.byRole = {
      [USAGE_ROLES.SUPERVISOR]: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 },
      [USAGE_ROLES.EXECUTOR]: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 },
      [USAGE_ROLES.REVIEWER]: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 },
      [USAGE_ROLES.PLANNER]: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0 },
    };
    this.byTask = {};
  }

  /**
   * Record a provider call's usage metadata.
   *
   * @param {object} entry
   * @param {string} entry.role         supervisor | executor | reviewer | planner
   * @param {string} [entry.taskId]     task id if within a task
   * @param {number} [entry.attempt]    attempt number if within a task
   * @param {string} [entry.model]      model id used
   * @param {object} [entry.usage]      raw usage object from provider (optional)
   * @param {number} [entry.costUsd]    cost in USD if reported
   * @param {number} [entry.durationMs] duration in milliseconds
   */
  record({
    role,
    callId = null,
    taskId = null,
    attempt = null,
    model = null,
    requestedFamily = null,
    resolvedModel = null,
    providerMetadata = null,
    usage = null,
    costUsd = null,
    durationMs = null,
  } = {}) {
    if (!role) throw new Error('UsageTracker.record() requires a role');

    const effectiveCallId = callId ?? usage?.callId ?? null;
    let inputTokens = null;
    let outputTokens = null;
    let cachedTokens = null;
    let totalTokens = null;

    if (usage && typeof usage === 'object') {
      // agy exposes: input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens
      // Claude exposes: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
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

    const rec = {
      timestamp: new Date().toISOString(),
      role,
      callId: effectiveCallId,
      taskId,
      attempt,
      model,
      requestedFamily,
      resolvedModel: resolvedModel ?? model,
      providerMetadata: providerMetadata && typeof providerMetadata === 'object' ? { ...providerMetadata } : null,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      costUsd: normalizeNumber(costUsd),
      durationMs: normalizeNumber(durationMs),
    };

    this.records.push(rec);

    if (this.byRole[role]) {
      const bucket = this.byRole[role];
      bucket.calls += 1;
      if (inputTokens !== null) bucket.inputTokens += inputTokens;
      if (outputTokens !== null) bucket.outputTokens += outputTokens;
      if (cachedTokens !== null) bucket.cachedTokens += cachedTokens;
      if (totalTokens !== null) bucket.totalTokens += totalTokens;
      if (rec.costUsd !== null) bucket.costUsd += rec.costUsd;
    }

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
  summary({ workflowContext = {}, baseline = null, checkAnomalies = false } = {}) {
    const total = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };

    const rolesSummary = {};
    for (const [role, data] of Object.entries(this.byRole)) {
      rolesSummary[role] = { ...data };
      total.calls += data.calls;
      total.inputTokens += data.inputTokens;
      total.outputTokens += data.outputTokens;
      total.cachedTokens += data.cachedTokens;
      total.totalTokens += data.totalTokens;
      total.costUsd += data.costUsd;
    }

    const res = {
      workflow: { ...total },
      supervisor: rolesSummary[USAGE_ROLES.SUPERVISOR],
      executor: rolesSummary[USAGE_ROLES.EXECUTOR],
      reviewer: rolesSummary[USAGE_ROLES.REVIEWER],
      planner: rolesSummary[USAGE_ROLES.PLANNER],
      total,
      hasUsageData: total.totalTokens > 0 || total.calls > 0,
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
