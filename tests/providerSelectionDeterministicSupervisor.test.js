import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { makeFakeCallAgy } from './fixtures/fakeAgy.mjs';

const planned = {
  status: 'READY',
  source: 'nl',
  summary: 'ship two bounded tasks',
  plan: 'Do task one, then task two.',
  tasks: [
    { task_id: 'one', goal: 'Implement one', scope: 'one', allowed_files: ['src/one.js'], verification_commands: ['node --test one'] },
    { task_id: 'two', goal: 'Implement two', scope: 'two', allowed_files: ['src/two.js'], verification_commands: ['node --test two'] },
  ],
};

const repositoryContext = { repository_name: 'demo', repository_url: null, branch: 'main', commit_sha: 'abc' };

function decisionContext(overrides = {}) {
  return {
    workflowGoal: planned.plan,
    repositoryContext,
    history: [],
    latestReviewResult: null,
    ...overrides,
  };
}

test('Planner task queue makes Supervisor happy path zero-token', async () => {
  const providerCalls = [];
  const events = [];
  const selection = selectProviders({
    env: {},
    workflowId: 'wf-deterministic-supervisor',
    callAgy: async () => { providerCalls.push('agy'); throw new Error('should not be called'); },
    codexCall: async () => { providerCalls.push('codex'); throw new Error('should not be called'); },
    claudeCall: async () => { providerCalls.push('claude'); throw new Error('should not be called'); },
    onEvent: (event) => events.push(event),
  });

  // The planner adapter receives the already-parsed Planner resolution from
  // resolveWorkflowPlan; capture it without invoking the transport in this test.
  const plannerResult = await selection.runtime.invoke('planner', {
    resolve: async () => planned,
  }, { operationId: 'wf-deterministic-supervisor' });
  assert.equal(plannerResult.value, planned);

  const first = await selection.supervisorSession.decide(decisionContext());
  assert.equal(first.action, 'NEXT_TASK');
  assert.equal(first.task_card.task_id, 'one');

  const second = await selection.supervisorSession.decide(decisionContext({
    history: [{ task_id: 'one', decision: 'PASS', attempts: 1 }],
    latestReviewResult: { task_id: 'one', decision: 'PASS' },
  }));
  assert.equal(second.action, 'NEXT_TASK');
  assert.equal(second.task_card.task_id, 'two');

  const done = await selection.supervisorSession.decide(decisionContext({
    history: [
      { task_id: 'one', decision: 'PASS', attempts: 1 },
      { task_id: 'two', decision: 'PASS', attempts: 1 },
    ],
    latestReviewResult: { task_id: 'two', decision: 'PASS' },
  }));
  assert.deepEqual(done, { action: 'WORKFLOW_DONE', summary: planned.summary });

  assert.deepEqual(providerCalls, []);
  assert.equal(events.filter((e) => e.type === 'SUPERVISOR_DECISION_DETERMINISTIC').length, 3);
});

test('ordinary rework is local once; repeated identical rework escalates', async () => {
  const events = [];
  const callAgy = makeFakeCallAgy({ action: 'CONTINUE_REWORK' });
  const selection = selectProviders({
    env: {},
    workflowId: 'wf-deterministic-rework',
    // Keep this integration test scoped to deterministic escalation. Planner
    // capture is local and the escalated Supervisor has exactly one provider.
    rolePolicy: {
      planner: [{ family: 'codex:default', effort: 'medium' }],
      supervisor: [{ family: 'agy:gemini', effort: 'medium' }],
      reviewer: [],
      executor: [],
    },
    codexCall: async () => { throw new Error('planner transport should not be called'); },
    callAgy,
    onEvent: (event) => events.push(event),
  });
  await selection.runtime.invoke('planner', { resolve: async () => planned }, { operationId: 'wf-deterministic-rework' });

  const review = { task_id: 'one', decision: 'REWORK', findings: ['race'], required_changes: ['Fix the race'], rationale: 'still races' };
  const first = await selection.supervisorSession.decide(decisionContext({ latestReviewResult: review }));
  assert.equal(first.action, 'CONTINUE_REWORK');
  assert.equal(callAgy.calls.length, 0);

  const second = await selection.supervisorSession.decide(decisionContext({ latestReviewResult: review }));
  assert.equal(second.action, 'CONTINUE_REWORK');
  assert.equal(callAgy.calls.length, 1);
  assert.ok(events.some((e) => e.type === 'SUPERVISOR_ESCALATED' && e.reason === 'reviewer_rework_nonconvergence'));
});
