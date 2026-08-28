// End-to-end: the agy Gemini Supervisor + Reviewer driving the UNMODIFIED
// automatedLoop state machine, with a fake callAgy and fake Claude/gate.
// No Chrome window/tab is ever created (nullWindowSession).

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

function fakeClaudeFactory(onExecute, onFactory) {
  return (args) => {
    onFactory?.(args);
    return {
    async execute(taskCard) {
      onExecute?.(args.taskId);
      return {
        task_id: taskCard.task_id,
        repository_context: taskCard.repository_context,
        status: 'DONE',
        changed_files: ['work/auto-a.txt'],
        tests_run: [],
        test_results: [],
        issues: 'none',
        next_recommendation: 'review',
      };
    },
    };
  };
}

const fakeGate = {
  async run() {
    return { status: 'CHANGED', head: 'h', base: 'b', diff: '+x', pass: true, results: [] };
  },
};

const fakePersistence = { async writeState() {}, async readState() { return {}; } };

const ENV = { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy' };

function run(callAgy, extra = {}) {
  const sel = selectProviders({ env: extra.env ?? ENV, callAgy });
  return runAutomatedWorkflow({
    workflowId: 'wf-test',
    supervisorSession: sel.supervisorSession,
    createReviewerSession: sel.createReviewerSession,
    createClaudeSessionManager: fakeClaudeFactory(extra.onExecute, extra.onFactory),
    gateRunner: fakeGate,
    windowSession: sel.windowSession,
    persistence: fakePersistence,
    workflowGoal: 'PLAN: make work/auto-a.txt then finish.',
    repositoryContext: { repository_name: 'gpt-dev-loop', repository_url: null, branch: 'x', commit_sha: 'y' },
    maxAttemptsPerTask: 3,
    log: () => {},
    ...extra.loopOverrides,
  });
}

test('happy path: NEXT_TASK -> PASS -> WORKFLOW_DONE', async () => {
  const callAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact match' },
    { action: 'WORKFLOW_DONE', summary: 'auto-a created' },
  ]);
  const result = await run(callAgy);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(result.summary, 'auto-a created');
  assert.deepEqual(result.history, [{ task_id: 'auto-a', decision: 'PASS', attempts: 1 }]);
});

test('rework path: REWORK -> CONTINUE_REWORK -> fresh Claude -> PASS -> WORKFLOW_DONE', async () => {
  const executes = [];
  const callAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'REWORK', findings: ['trailing space'], required_changes: ['strip it'], rationale: 'inexact' },
    { action: 'CONTINUE_REWORK' },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'now exact' },
    { action: 'WORKFLOW_DONE', summary: 'done after one rework' },
  ]);
  const result = await run(callAgy, { onExecute: (id) => executes.push(id) });
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(executes.length, 2, 'a fresh Claude execute per attempt');
  assert.deepEqual(result.history, [{ task_id: 'auto-a', decision: 'PASS', attempts: 2 }]);
});

test('fail closed: malformed Reviewer output aborts the workflow', async () => {
  const callAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    'not-json-at-all',
  ]);
  await assert.rejects(() => run(callAgy), (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
});

test('fail closed: invalid Supervisor Task Card aborts the workflow', async () => {
  const bad = validTaskCardObject();
  delete bad.acceptance_criteria;
  const callAgy = makeFakeCallAgy([{ action: 'NEXT_TASK', task_card: bad }]);
  await assert.rejects(() => run(callAgy), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('Supervisor and Reviewer run on different models in one workflow; neither leaks into Claude', async () => {
  const env = {
    SUPERVISOR_PROVIDER: 'agy',
    REVIEWER_PROVIDER: 'agy',
    AGY_SUPERVISOR_MODEL: 'gemini-3.7-flash-high',
    AGY_REVIEWER_MODEL: 'gpt-oss-120b-medium',
  };
  const callAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact match' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const factoryArgs = [];
  const result = await run(callAgy, { env, onFactory: (a) => factoryArgs.push(a) });
  assert.equal(result.status, 'WORKFLOW_DONE');

  const supModels = callAgy.calls.filter((c) => c.prompt.includes('You are the Supervisor')).map((c) => c.model);
  const revModels = callAgy.calls.filter((c) => c.prompt.includes('You are the Reviewer')).map((c) => c.model);
  assert.deepEqual([...new Set(supModels)], ['gemini-3.7-flash-high']);
  assert.deepEqual([...new Set(revModels)], ['gpt-oss-120b-medium']);

  // The Claude executor factory is handed no agy model at all.
  assert.ok(factoryArgs.length >= 1);
  for (const a of factoryArgs) {
    assert.equal(JSON.stringify(a).includes('gemini'), false);
    assert.equal(JSON.stringify(a).includes('gpt-oss'), false);
    assert.equal('model' in a, false);
  }
});

test('AGY_MODEL alone still drives both roles (backward compatible)', async () => {
  const env = { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy', AGY_MODEL: 'gemini-3.6-flash-high' };
  const callAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'match' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const result = await run(callAgy, { env });
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual([...new Set(callAgy.calls.map((c) => c.model))], ['gemini-3.6-flash-high']);
});

test('HUMAN_REQUIRED from the Supervisor stops cleanly', async () => {
  const callAgy = makeFakeCallAgy([{ action: 'HUMAN_REQUIRED', reason: 'ambiguous plan', question: 'clarify?' }]);
  const result = await run(callAgy);
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.reason, 'ambiguous plan');
});
