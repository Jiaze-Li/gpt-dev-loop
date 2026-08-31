import test from 'node:test';
import assert from 'node:assert/strict';
import { EXECUTOR_INPUT_BASELINE_TOTAL, assertExecutorTokenAcceptance, buildExecutorTokenReport, formatExecutorTokenReport } from '../scripts/run-final-e2e.js';

function breakdown(inputTokens) {
  return { categories: { taskCard: { tokens: 100 }, repoContext: { tokens: 40 }, history: { tokens: 20 }, evidence: { tokens: 10 }, other: { tokens: inputTokens - 170 } } };
}

test('live report captures every Executor call and compares real provider totals to baseline', () => {
  const calls = [1000, 1200].map((inputTokens, index) => ({ callId: `exec-${index + 1}`, taskId: `task-${index + 1}`, attempt: 1, inputTokens, cachedTokens: 100, outputTokens: 200, breakdown: breakdown(inputTokens) }));
  const report = buildExecutorTokenReport({ workflowId: 'wf-real', status: 'WORKFLOW_DONE', events: [{ type: 'review_finished', decision: 'PASS' }, { type: 'review_finished', decision: 'PASS' }], usage: { executorInputBreakdownCalls: calls } });
  assert.equal(assertExecutorTokenAcceptance(report), report);
  assert.equal(report.totals.inputTokens, 2200);
  assert.equal(report.comparison.absoluteReduction, EXECUTOR_INPUT_BASELINE_TOTAL - 2200);
  assert.match(formatExecutorTokenReport(report), /cached=100, output=200; taskCard=100/);
  assert.match(formatExecutorTokenReport(report), /Cached tokens are a subset/);
});

test('live acceptance rejects incomplete or non-terminal evidence', () => {
  const report = buildExecutorTokenReport({ workflowId: 'wf-incomplete', status: 'HUMAN_REQUIRED', events: [{ type: 'human_required' }], usage: { executorInputBreakdownCalls: [] } });
  assert.throws(() => assertExecutorTokenAcceptance(report), /Expected WORKFLOW_DONE/);
});
