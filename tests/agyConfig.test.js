import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGY_SUPERVISOR_DEFAULT_MODEL,
  AGY_REVIEWER_DEFAULT_MODEL,
  AGY_WORKFLOW_DEFAULT_MODEL,
  resolveAgySupervisorModel,
  resolveAgyReviewerModel,
  resolveAgyModel,
  agyModelLabel,
} from '../src/agy/agyConfig.js';

test('role defaults are the exact `agy models` IDs', () => {
  assert.equal(AGY_SUPERVISOR_DEFAULT_MODEL, 'gemini-3.7-flash-high');
  assert.equal(AGY_REVIEWER_DEFAULT_MODEL, 'gpt-oss-120b-medium');
  assert.equal(AGY_WORKFLOW_DEFAULT_MODEL, 'gemini-3.7-flash-high');
});

test('Supervisor precedence: AGY_SUPERVISOR_MODEL > AGY_MODEL > default', () => {
  assert.equal(resolveAgySupervisorModel({}), 'gemini-3.7-flash-high');
  assert.equal(resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_SUPERVISOR_MODEL: 'gemini-3.6-flash-low' }),
    'gemini-3.6-flash-low',
  );
  assert.equal(resolveAgySupervisorModel({ AGY_SUPERVISOR_MODEL: '   ' }), 'gemini-3.7-flash-high');
});

test('Reviewer precedence: AGY_REVIEWER_MODEL > AGY_MODEL > default', () => {
  assert.equal(resolveAgyReviewerModel({}), 'gpt-oss-120b-medium');
  assert.equal(resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium' }),
    'gpt-oss-120b-medium',
  );
});

test('per-role vars are independent of each other', () => {
  const env = { AGY_SUPERVISOR_MODEL: 'gemini-3.5-flash-high', AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium' };
  assert.equal(resolveAgySupervisorModel(env), 'gemini-3.5-flash-high');
  assert.equal(resolveAgyReviewerModel(env), 'gpt-oss-120b-medium');
});

test('resolveAgyModel remains a shared fallback helper', () => {
  assert.equal(resolveAgyModel({}), 'gemini-3.7-flash-high');
  assert.equal(resolveAgyModel({ AGY_MODEL: 'gemini-3.6-flash-medium' }), 'gemini-3.6-flash-medium');
});

test('agyModelLabel prettifies an id', () => {
  assert.equal(agyModelLabel('gemini-3.7-flash-high'), 'Gemini 3.7 Flash High');
  assert.equal(agyModelLabel(''), '(unknown model)');
});
