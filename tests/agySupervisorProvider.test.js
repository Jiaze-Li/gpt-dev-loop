import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgySupervisorProvider, buildAgySupervisorPrompt } from '../src/orchestrator/adapters/agySupervisorProvider.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { AgyTimeoutError, AgyExitError, AgyExecutableNotFoundError } from '../src/agy/agyClient.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

const CONTEXT = {
  workflowGoal: 'PLAN: create work/auto-a.txt then finish.',
  repositoryContext: { repository_name: 'gpt-dev-loop', repository_url: null, branch: 'phase1-handshake', commit_sha: 'abc' },
  history: [],
  latestReviewResult: null,
};

test('NEXT_TASK: valid task_card object -> parsed Task Card', async () => {
  const callAgy = makeFakeCallAgy({ action: 'NEXT_TASK', task_card: validTaskCardObject() });
  const provider = createAgySupervisorProvider({ callAgy, model: 'gemini-3.7-flash-high' });
  const decision = await provider.decide(CONTEXT);

  assert.equal(decision.action, 'NEXT_TASK');
  assert.equal(decision.task_card.task_id, 'auto-a');
  assert.deepEqual(decision.task_card.allowed_files, ['work/auto-a.txt']);
  assert.deepEqual(decision.task_card.acceptance_criteria, ['work/auto-a.txt contains exactly auto-a-ok']);
  assert.equal(decision.task_card.completion_signal, 'DONE');
  assert.equal(callAgy.calls[0].model, 'gemini-3.7-flash-high');
});

test('NEXT_TASK: code-fenced JSON is tolerated', async () => {
  const fenced = '```json\n' + JSON.stringify({ action: 'NEXT_TASK', task_card: validTaskCardObject() }) + '\n```';
  const callAgy = makeFakeCallAgy(fenced);
  const provider = createAgySupervisorProvider({ callAgy });
  const decision = await provider.decide(CONTEXT);
  assert.equal(decision.action, 'NEXT_TASK');
});

test('WORKFLOW_DONE / CONTINUE_REWORK / HUMAN_REQUIRED', async () => {
  const done = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'WORKFLOW_DONE', summary: 'all tasks passed' }) });
  assert.deepEqual(await done.decide(CONTEXT), { action: 'WORKFLOW_DONE', summary: 'all tasks passed' });

  const reworkCtx = { ...CONTEXT, latestReviewResult: { decision: 'REWORK', required_changes: ['x'] } };
  const rework = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'CONTINUE_REWORK' }) });
  assert.deepEqual(await rework.decide(reworkCtx), { action: 'CONTINUE_REWORK' });

  const human = createAgySupervisorProvider({
    callAgy: makeFakeCallAgy({ action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'which format?' }),
  });
  assert.deepEqual(await human.decide(CONTEXT), { action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'which format?' });
});

test('fail closed: malformed JSON -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy('not json {') });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
    return true;
  });
});

test('fail closed: unknown action -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'DO_STUFF' }) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: NEXT_TASK with missing task_card field -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const bad = validTaskCardObject();
  delete bad.verification_commands;
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'NEXT_TASK', task_card: bad }) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: NEXT_TASK with invalid completion_signal -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({
    callAgy: makeFakeCallAgy({ action: 'NEXT_TASK', task_card: validTaskCardObject({ completion_signal: 'MAYBE' }) }),
  });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: agy timeout -> SUPERVISOR_TIMEOUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyTimeoutError(1000)) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT);
});

test('fail closed: agy nonzero exit / missing binary -> SUPERVISOR_UNAVAILABLE', async () => {
  const exit = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyExitError(2, 'boom')) });
  await assert.rejects(() => exit.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE);

  const missing = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyExecutableNotFoundError('agy')) });
  await assert.rejects(() => missing.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
});

test('prompt carries the plan text and constrains actions during rework', () => {
  const p1 = buildAgySupervisorPrompt(CONTEXT);
  assert.match(p1, /PLAN: create work\/auto-a\.txt/);
  assert.match(p1, /NEXT_TASK, WORKFLOW_DONE, or HUMAN_REQUIRED only/);

  const p2 = buildAgySupervisorPrompt({ ...CONTEXT, latestReviewResult: { decision: 'REWORK', required_changes: ['fix'] } });
  assert.match(p2, /CONTINUE_REWORK or HUMAN_REQUIRED only/);
});
