import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { nullWindowSession } from '../src/orchestrator/agyProviderSessions.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';
import { registerUserInputEvidence, registerTaskCardEvidence } from '../src/orchestrator/newInformation.js';

const BOTH_AGY = { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy' };

test('defaults: Supervisor = Gemini 3.7 Flash High, Reviewer = GPT-OSS 120B Medium', () => {
  const s = selectProviders({ env: { ...BOTH_AGY }, callAgy: makeFakeCallAgy({}) });
  assert.equal(s.supervisorModel, 'gemini-3.7-flash-high');
  assert.equal(s.reviewerModel, 'gpt-oss-120b-medium');
  assert.equal(typeof s.supervisorSession.decide, 'function');
  assert.equal(typeof s.createReviewerSession, 'function');
  assert.equal(s.windowSession, nullWindowSession);
});

test('AGY_MODEL is a shared backward-compatible fallback for BOTH roles', () => {
  const s = selectProviders({
    env: { ...BOTH_AGY, AGY_MODEL: 'gemini-3.1-pro-high' },
    callAgy: makeFakeCallAgy({}),
  });
  assert.equal(s.supervisorModel, 'gemini-3.1-pro-high');
  assert.equal(s.reviewerModel, 'gemini-3.1-pro-high');
});

test('per-role overrides are independent and beat AGY_MODEL', () => {
  const s = selectProviders({
    env: {
      ...BOTH_AGY,
      AGY_MODEL: 'gemini-3.1-pro-high',
      AGY_SUPERVISOR_MODEL: 'gemini-3.6-flash-medium',
      AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium',
    },
    callAgy: makeFakeCallAgy({}),
  });
  assert.equal(s.supervisorModel, 'gemini-3.6-flash-medium');
  assert.equal(s.reviewerModel, 'gpt-oss-120b-medium');
});

test('only AGY_SUPERVISOR_MODEL set -> Reviewer still falls back to its default', () => {
  const s = selectProviders({
    env: { ...BOTH_AGY, AGY_SUPERVISOR_MODEL: 'gemini-3.5-flash-low' },
    callAgy: makeFakeCallAgy({}),
  });
  assert.equal(s.supervisorModel, 'gemini-3.5-flash-low');
  assert.equal(s.reviewerModel, 'gpt-oss-120b-medium');
});

test('only AGY_REVIEWER_MODEL set -> Supervisor still falls back to its default', () => {
  const s = selectProviders({
    env: { ...BOTH_AGY, AGY_REVIEWER_MODEL: 'gemini-3.6-flash-high' },
    callAgy: makeFakeCallAgy({}),
  });
  assert.equal(s.supervisorModel, 'gemini-3.7-flash-high');
  assert.equal(s.reviewerModel, 'gemini-3.6-flash-high');
});

test('Codex is an explicit Supervisor provider and does not affect the agy Reviewer', () => {
  const s = selectProviders({
    env: { SUPERVISOR_PROVIDER: 'codex', REVIEWER_PROVIDER: 'agy', SUPERGPT_CODEX_SUPERVISOR_MODEL: 'codex-test' },
    callAgy: makeFakeCallAgy({}),
    codexCall: async () => ({ text: JSON.stringify({ action: 'WORKFLOW_DONE', summary: 'done' }), usage: null, durationMs: 1 }),
  });
  assert.equal(s.supervisorModel, 'codex-test');
  assert.equal(s.reviewerModel, 'gpt-oss-120b-medium');
});

test('Supervisor and Reviewer provider calls receive their OWN resolved model id', async () => {
  const supCall = makeFakeCallAgy([{ action: 'NEXT_TASK', task_card: validTaskCardObject() }]);
  const revCall = makeFakeCallAgy([{ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }]);

  // Build providers directly through selectProviders' resolution, but with
  // a distinct fake per role so we can inspect the exact model each got.
  const env = {
    ...BOTH_AGY,
    AGY_SUPERVISOR_MODEL: 'gemini-3.7-flash-high',
    AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium',
  };
  const sup = selectProviders({ env, workflowId: 'wf-model-id-sup', callAgy: supCall });
  const supEvidence = await registerUserInputEvidence(sup.informationLedger, {
    workflowId: 'wf-model-id-sup', interactionId: 'initial-input', text: 'p',
  });
  await sup.supervisorSession.decide({
    workflowGoal: 'p', repositoryContext: {}, history: [], evidenceIds: [supEvidence.evidenceId],
  });
  assert.equal(supCall.calls[0].model, 'gemini-3.7-flash-high');

  const rev = selectProviders({ env, workflowId: 'wf-model-id-rev', callAgy: revCall });
  const revEvidence = await registerTaskCardEvidence(rev.informationLedger, {
    workflowId: 'wf-model-id-rev', taskId: 'auto-a', taskCard: validTaskCardObject(),
  });
  const rs = rev.createReviewerSession();
  await rs.create();
  await rs.review('auto-a', validTaskCardObject(), { status: 'DONE' }, { pass: true, results: [] }, { evidenceIds: [revEvidence.evidenceId] });
  assert.equal(revCall.calls[0].model, 'gpt-oss-120b-medium');
});

test('legacy fixed-provider environment values do not bypass role routing', () => {
  const selected = selectProviders({ env: { SUPERVISOR_PROVIDER: 'chrome', REVIEWER_PROVIDER: 'agy' } });
  assert.ok(selected.runtime);
});

test('role routing has safe defaults when legacy provider variables are absent', () => {
  const selected = selectProviders({ env: {} });
  assert.ok(selected.runtime);
});

test('Planner physical invocation records native usage exactly once with immutable call identity', async () => {
  const { UsageTracker } = await import('../src/orchestrator/usageTracker.js');
  const usageTracker = new UsageTracker();
  const workflowId = 'wf-planner-usage-identity';
  const selected = selectProviders({
    env: { SUPERGPT_CODEX_MODEL: 'codex-planner-test' },
    workflowId,
    usageTracker,
    codexCall: async () => ({
      text: JSON.stringify({ status: 'READY' }),
      usage: { input_tokens: 101, output_tokens: 17, cache_read_tokens: 9 },
      durationMs: 7,
    }),
  });
  const evidence = await registerUserInputEvidence(selected.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: 'plan the work',
  });

  await selected.runtime.invoke('planner', {
    resolve: async (call) => call({ prompt: 'plan the work' }),
  }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] });

  assert.equal(usageTracker.records.length, 1);
  const [record] = usageTracker.records;
  assert.equal(record.role, 'planner');
  assert.match(record.callId, /^call-codex-plan-/);
  assert.equal(record.requestedFamily, 'codex:default');
  assert.equal(record.resolvedModel, 'codex-planner-test');
  assert.equal(record.inputTokens, 101);
  assert.equal(record.outputTokens, 17);
  assert.equal(record.cachedTokens, 9);
  assert.deepEqual(record.providerMetadata, { provider: 'codex', conversationId: null, exitCode: null });
  assert.equal(usageTracker.summary().planner.calls, 1);
});

test('nullWindowSession opens nothing and satisfies the loop tab invariant', async () => {
  assert.deepEqual(await nullWindowSession.create(), { windowId: null, initialTabId: null });
  const activation = await nullWindowSession.activateTab(null);
  assert.equal(activation.active, true);
  assert.equal(activation.windowFocused, false);
  assert.equal(typeof nullWindowSession.listTabs, 'undefined');
});
