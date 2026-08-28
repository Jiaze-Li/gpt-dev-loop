// End-to-end: the agy Gemini Supervisor + Reviewer driving the UNMODIFIED
// automatedLoop state machine, with a fake callAgy and fake Claude/gate.
// No Chrome window/tab is ever created (nullWindowSession).

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { AgyConversationResumeError } from '../src/agy/agyClient.js';
import { evaluateResume, extractNumTurns } from '../scripts/test-agy-conversations-live.js';
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

// In-memory Persistence-shaped fake with the real workflow-state semantics.
function makeFakePersistence() {
  const workflowStates = new Map();
  const taskStates = new Map();
  const writes = [];
  return {
    writes,
    async writeState(state) {
      taskStates.set(`${state.workflow_id}/${state.task_id}`, state);
    },
    async readState(workflowId, taskId) {
      return taskStates.get(`${workflowId}/${taskId}`) ?? {};
    },
    async writeWorkflowState(workflowId, state) {
      writes.push({ workflowId, state: JSON.parse(JSON.stringify(state)) });
      workflowStates.set(workflowId, JSON.parse(JSON.stringify(state)));
    },
    async readWorkflowState(workflowId) {
      return workflowStates.has(workflowId) ? JSON.parse(JSON.stringify(workflowStates.get(workflowId))) : null;
    },
  };
}

// callAgy fake that models agy's conversation lifecycle: a call with no
// conversationId is assigned a fresh id (tagged by role); a call carrying a
// conversationId echoes exactly it back. Records role + conversationId for
// every call.
function makeConversationalCallAgy(answers) {
  const queue = [...answers];
  const calls = [];
  let sup = 0;
  let rev = 0;
  async function callAgy({ prompt, model, conversationId } = {}) {
    const role = /You are the Supervisor/.test(prompt)
      ? 'supervisor'
      : /You are the Reviewer/.test(prompt)
        ? 'reviewer'
        : 'other';
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) {
      calls.push({ role, conversationId: conversationId ?? null, model });
      throw answer;
    }
    let cid = conversationId ?? null;
    if (cid === null) cid = role === 'supervisor' ? `sup-conv-${++sup}` : `rev-conv-${++rev}`;
    calls.push({ role, conversationId: conversationId ?? null, assigned: cid, model });
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return { model, exitCode: 0, text, json: { result: text }, stdout: text, durationMs: 1, conversationId: cid };
  }
  callAgy.calls = calls;
  return callAgy;
}

const ENV = { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy' };

function run(callAgy, extra = {}) {
  const persistence = extra.persistence ?? { async writeState() {}, async readState() { return {}; } };
  const sel = selectProviders({
    env: extra.env ?? ENV,
    callAgy,
    persistence,
    workflowId: extra.workflowId ?? 'wf-test',
  });
  extra.onSelect?.(sel);
  return runAutomatedWorkflow({
    workflowId: extra.workflowId ?? 'wf-test',
    supervisorSession: sel.supervisorSession,
    createReviewerSession: sel.createReviewerSession,
    createClaudeSessionManager: fakeClaudeFactory(extra.onExecute, extra.onFactory),
    gateRunner: fakeGate,
    windowSession: sel.windowSession,
    persistence,
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

// --- persistent role conversations --------------------------------------

test('Supervisor keeps ONE conversation: captured on the first decide, resumed on every later one', async () => {
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const result = await run(callAgy);
  assert.equal(result.status, 'WORKFLOW_DONE');

  const sup = callAgy.calls.filter((c) => c.role === 'supervisor');
  assert.ok(sup.length >= 2, 'supervisor decided more than once');
  assert.equal(sup[0].conversationId, null, 'first decide creates the conversation');
  assert.equal(sup[0].assigned, 'sup-conv-1');
  for (const c of sup.slice(1)) assert.equal(c.conversationId, 'sup-conv-1', 'later decides resume it');
});

test('Reviewer reuses one conversation across REWORK rounds of the same task', async () => {
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'REWORK', findings: ['x'], required_changes: ['strip it'], rationale: 'inexact' },
    { action: 'CONTINUE_REWORK' },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'now exact' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const result = await run(callAgy);
  assert.equal(result.status, 'WORKFLOW_DONE');

  const rev = callAgy.calls.filter((c) => c.role === 'reviewer');
  assert.equal(rev.length, 2);
  assert.equal(rev[0].conversationId, null);
  assert.equal(rev[0].assigned, 'rev-conv-1');
  assert.equal(rev[1].conversationId, 'rev-conv-1', 'the rework review resumes the same conversation');
});

test('Reviewer gets a FRESH conversation for a different task', async () => {
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject({ task_id: 'auto-a', allowed_files: ['work/auto-a.txt'] }) },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact' },
    { action: 'NEXT_TASK', task_card: validTaskCardObject({ task_id: 'auto-b', allowed_files: ['work/auto-b.txt'] }) },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact' },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const result = await run(callAgy);
  assert.equal(result.status, 'WORKFLOW_DONE');

  const rev = callAgy.calls.filter((c) => c.role === 'reviewer');
  assert.equal(rev.length, 2);
  assert.equal(rev[0].assigned, 'rev-conv-1');
  assert.equal(rev[1].conversationId, null, 'a new task does not resume the previous task conversation');
  assert.equal(rev[1].assigned, 'rev-conv-2');
});

test('session ownership is persisted to workflow state via writeWorkflowState', async () => {
  const persistence = makeFakePersistence();
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const result = await run(callAgy, { persistence });
  assert.equal(result.status, 'WORKFLOW_DONE');

  assert.ok(persistence.writes.length >= 1, 'workflow state was written');
  const final = await persistence.readWorkflowState('wf-test');
  assert.equal(final.supervisor.conversation_id, 'sup-conv-1');
  assert.equal(final.reviewer.conversations['auto-a'], 'rev-conv-1');
});

test('workflow state on disk is read back on resume so the SAME conversations continue', async () => {
  const persistence = makeFakePersistence();
  await persistence.writeWorkflowState('wf-test', {
    workflow_id: 'wf-test',
    supervisor: { conversation_id: 'pre-existing-sup' },
    reviewer: { conversations: { 'auto-a': 'pre-existing-rev' } },
  });
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: ['ok'], required_changes: [], rationale: 'exact' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const result = await run(callAgy, { persistence });
  assert.equal(result.status, 'WORKFLOW_DONE');

  const sup = callAgy.calls.filter((c) => c.role === 'supervisor');
  const rev = callAgy.calls.filter((c) => c.role === 'reviewer');
  assert.equal(sup[0].conversationId, 'pre-existing-sup', 'resumed the persisted Supervisor conversation');
  assert.equal(rev[0].conversationId, 'pre-existing-rev', 'resumed the persisted Reviewer conversation');
});

test('fail closed: a Reviewer conversation that cannot be resumed aborts the workflow', async () => {
  const persistence = makeFakePersistence();
  await persistence.writeWorkflowState('wf-test', {
    workflow_id: 'wf-test',
    supervisor: { conversation_id: null },
    reviewer: { conversations: { 'auto-a': 'gone-rev-conv' } },
  });
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    new AgyConversationResumeError('agy could not resume conversation gone-rev-conv'),
  ]);
  await assert.rejects(
    () => run(callAgy, { persistence }),
    (err) => err.code === 'AGY_CONVERSATION_RESUME_FAILED',
  );
});

test('live-smoke verdict: exact conversation id + advancing num_turns is the only pass', () => {
  assert.equal(extractNumTurns({ num_turns: 3 }), 3);
  assert.equal(extractNumTurns({ conversation: { turn_count: 5 } }), 5);
  assert.equal(extractNumTurns({ nope: 1 }), null);

  assert.deepEqual(
    evaluateResume({ turn1Id: 'c1', turn2Id: 'c1', turn1Turns: 1, turn2Turns: 2 }),
    { ok: true, problems: [] },
  );
  assert.equal(evaluateResume({ turn1Id: 'c1', turn2Id: 'c2', turn1Turns: 1, turn2Turns: 2 }).ok, false);
  assert.equal(evaluateResume({ turn1Id: 'c1', turn2Id: 'c1', turn1Turns: 2, turn2Turns: 2 }).ok, false);
  assert.equal(evaluateResume({ turn1Id: null, turn2Id: 'c1', turn1Turns: null, turn2Turns: null }).ok, false);
  // Unknown turn counts must not by themselves fail the resume.
  assert.equal(evaluateResume({ turn1Id: 'c1', turn2Id: 'c1', turn1Turns: null, turn2Turns: null }).ok, true);
});
