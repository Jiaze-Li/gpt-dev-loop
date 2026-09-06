import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAgySupervisorModel,
  resolveAgyReviewerModel,
  resolveAgySupervisorFamily,
  resolveAgyReviewerFamily,
  resolveAgyModel,
  agyModelLabel,
} from '../src/agy/agyConfig.js';

test('no concrete version pin by default — provider-default resolution', () => {
  assert.equal(resolveAgySupervisorModel({}), null);
  assert.equal(resolveAgyReviewerModel({}), null);
  assert.equal(resolveAgySupervisorFamily({}).resolvedFrom, 'provider_default');
  assert.equal(resolveAgyReviewerFamily({}).resolvedFrom, 'provider_default');
  assert.equal(resolveAgySupervisorFamily({}).concreteVersionPinned, false);
});

test('explicit env override pins a concrete model (Supervisor precedence)', () => {
  assert.equal(resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgySupervisorModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_SUPERVISOR_MODEL: 'gemini-3.6-flash-low' }),
    'gemini-3.6-flash-low',
  );
  assert.equal(
    resolveAgySupervisorModel({ REVIEWLOOP_SUPERVISOR_MODEL: 'gemini-9.9-flash-high', AGY_SUPERVISOR_MODEL: 'x' }),
    'gemini-9.9-flash-high',
  );
  assert.equal(resolveAgySupervisorModel({ AGY_SUPERVISOR_MODEL: '   ' }), null);
  assert.equal(resolveAgySupervisorFamily({ AGY_MODEL: 'gemini-3.1-pro-high' }).pinnedByEnv, true);
});

test('explicit env override pins a concrete model (Reviewer precedence)', () => {
  assert.equal(resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high' }), 'gemini-3.1-pro-high');
  assert.equal(
    resolveAgyReviewerModel({ AGY_MODEL: 'gemini-3.1-pro-high', AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium' }),
    'gpt-oss-120b-medium',
  );
});

test('runtime catalog resolves the newest family entry without any config edit', () => {
  const agyCatalog = [
    'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.7-flash-high',
    'gpt-oss-120b-medium', 'gpt-oss-200b-medium',
  ];
  assert.equal(resolveAgySupervisorModel({}, { agyCatalog }), 'gemini-3.8-flash-high');
  assert.equal(resolveAgyReviewerModel({}, { agyCatalog }), 'gpt-oss-200b-medium');
  assert.equal(resolveAgySupervisorFamily({}, { agyCatalog }).resolvedFrom, 'runtime_catalog');

  // a newer catalog -> a different concrete model, still zero config edits
  const newer = [...agyCatalog, 'gemini-4.1-flash-high'];
  assert.equal(resolveAgySupervisorModel({}, { agyCatalog: newer }), 'gemini-4.1-flash-high');
});

test('per-role vars are independent of each other', () => {
  const env = { AGY_SUPERVISOR_MODEL: 'gemini-3.5-flash-high', AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium' };
  assert.equal(resolveAgySupervisorModel(env), 'gemini-3.5-flash-high');
  assert.equal(resolveAgyReviewerModel(env), 'gpt-oss-120b-medium');
});

test('resolveAgyModel is an AGY_MODEL-only shared fallback (null otherwise)', () => {
  assert.equal(resolveAgyModel({}), null);
  assert.equal(resolveAgyModel({ AGY_MODEL: 'gemini-3.6-flash-medium' }), 'gemini-3.6-flash-medium');
});

test('agyModelLabel prettifies an id', () => {
  assert.equal(agyModelLabel('gemini-3.7-flash-high'), 'Gemini 3.7 Flash High');
  assert.equal(agyModelLabel(''), '(unknown model)');
});
