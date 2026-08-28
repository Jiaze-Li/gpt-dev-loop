import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { nullWindowSession } from '../src/orchestrator/agyProviderSessions.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

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
  const sup = selectProviders({ env, callAgy: supCall });
  await sup.supervisorSession.decide({ workflowGoal: 'p', repositoryContext: {}, history: [] });
  assert.equal(supCall.calls[0].model, 'gemini-3.7-flash-high');

  const rev = selectProviders({ env, callAgy: revCall });
  const rs = rev.createReviewerSession();
  await rs.create();
  await rs.review('auto-a', validTaskCardObject(), { status: 'DONE' }, { pass: true, results: [] });
  assert.equal(revCall.calls[0].model, 'gpt-oss-120b-medium');
});

test('fail closed: supervisor provider not agy', () => {
  assert.throws(
    () => selectProviders({ env: { SUPERVISOR_PROVIDER: 'chrome', REVIEWER_PROVIDER: 'agy' } }),
    /requires SUPERVISOR_PROVIDER=agy and REVIEWER_PROVIDER=agy/,
  );
});

test('fail closed: reviewer provider unset', () => {
  assert.throws(
    () => selectProviders({ env: { SUPERVISOR_PROVIDER: 'agy' } }),
    /requires SUPERVISOR_PROVIDER=agy and REVIEWER_PROVIDER=agy/,
  );
});

test('nullWindowSession opens nothing and satisfies the loop tab invariant', async () => {
  assert.deepEqual(await nullWindowSession.create(), { windowId: null, initialTabId: null });
  const activation = await nullWindowSession.activateTab(null);
  assert.equal(activation.active, true);
  assert.equal(activation.windowFocused, false);
  assert.equal(typeof nullWindowSession.listTabs, 'undefined');
});
