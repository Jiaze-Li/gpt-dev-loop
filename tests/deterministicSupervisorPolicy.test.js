import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideDeterministically,
  materializePlannedTask,
  validPlannedTasks,
} from '../src/orchestrator/deterministicSupervisorPolicy.js';

const tasks = [
  {
    task_id: 'one',
    goal: 'Implement one',
    scope: 'src/one.js only',
    allowed_files: ['src/one.js'],
    verification_commands: ['node --test test/one.test.js'],
  },
  {
    task_id: 'two',
    goal: 'Implement two',
    scope: 'src/two.js only',
    allowed_files: ['src/two.js'],
    verification_commands: ['node --test test/two.test.js'],
  },
];

const repositoryContext = {
  repository_name: 'demo', repository_url: null, branch: 'main', commit_sha: 'abc',
};

function ctx(overrides = {}) {
  return {
    workflowGoal: 'Do both tasks.',
    repositoryContext,
    history: [],
    latestReviewResult: null,
    ...overrides,
  };
}

test('planned task validation is fail-closed', () => {
  assert.equal(validPlannedTasks(tasks), true);
  assert.equal(validPlannedTasks([]), false);
  assert.equal(validPlannedTasks([{ ...tasks[0], task_id: '' }]), false);
  assert.equal(validPlannedTasks([tasks[0], { ...tasks[1], task_id: 'one' }]), false);
});

test('initial decision selects first Planner task without Supervisor', () => {
  const result = decideDeterministically({ context: ctx(), plannedTasks: tasks });
  assert.equal(result.handled, true);
  assert.equal(result.decision.action, 'NEXT_TASK');
  assert.equal(result.decision.task_card.task_id, 'one');
  assert.deepEqual(result.decision.task_card.repository_context, repositoryContext);
  assert.match(result.decision.task_card.acceptance_criteria[0], /Implement one/);
});

test('Reviewer PASS advances directly to next task then DONE', () => {
  const memory = new Map();
  const next = decideDeterministically({
    context: ctx({
      history: [{ task_id: 'one', decision: 'PASS', attempts: 1 }],
      latestReviewResult: { task_id: 'one', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'ship both',
    reworkMemory: memory,
  });
  assert.equal(next.decision.action, 'NEXT_TASK');
  assert.equal(next.decision.task_card.task_id, 'two');

  const done = decideDeterministically({
    context: ctx({
      history: [
        { task_id: 'one', decision: 'PASS', attempts: 1 },
        { task_id: 'two', decision: 'PASS', attempts: 1 },
      ],
      latestReviewResult: { task_id: 'two', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'ship both',
    reworkMemory: memory,
  });
  assert.deepEqual(done.decision, { action: 'WORKFLOW_DONE', summary: 'ship both' });
});

test('Gate REWORK always returns directly to Executor', () => {
  const memory = new Map();
  for (let i = 0; i < 3; i += 1) {
    const result = decideDeterministically({
      context: ctx({
        latestReviewResult: {
          task_id: 'one', decision: 'REWORK', source: 'GATE', required_changes: ['Fix npm test'],
        },
      }),
      plannedTasks: tasks,
      reworkMemory: memory,
    });
    assert.equal(result.handled, true);
    assert.equal(result.decision.action, 'CONTINUE_REWORK');
  }
});

test('first Reviewer REWORK is direct; identical non-convergence escalates', () => {
  const memory = new Map();
  const review = {
    task_id: 'one', decision: 'REWORK', required_changes: ['Fix the race condition'],
  };
  const first = decideDeterministically({ context: ctx({ latestReviewResult: review }), plannedTasks: tasks, reworkMemory: memory });
  assert.equal(first.handled, true);
  assert.equal(first.decision.action, 'CONTINUE_REWORK');

  const second = decideDeterministically({ context: ctx({ latestReviewResult: review }), plannedTasks: tasks, reworkMemory: memory });
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'reviewer_rework_nonconvergence');
});

test('Reviewer HUMAN_REQUIRED and plan/history mismatch escalate', () => {
  const human = decideDeterministically({
    context: ctx({ latestReviewResult: { task_id: 'one', decision: 'HUMAN_REQUIRED' } }),
    plannedTasks: tasks,
  });
  assert.equal(human.handled, false);
  assert.equal(human.reason, 'reviewer_human_required');

  const mismatch = decideDeterministically({
    context: ctx({ history: [{ task_id: 'old-task', decision: 'PASS' }] }),
    plannedTasks: tasks,
  });
  assert.equal(mismatch.handled, false);
  assert.equal(mismatch.reason, 'plan_history_mismatch');
});

test('materialized task preserves explicit acceptance criteria when Planner provides them', () => {
  const card = materializePlannedTask({
    ...tasks[0], acceptance_criteria: ['returns 200', 'rejects invalid input'], forbidden_files: ['src/secret.js'],
  }, { repositoryContext, workflowGoal: 'goal' });
  assert.deepEqual(card.acceptance_criteria, ['returns 200', 'rejects invalid input']);
  assert.deepEqual(card.forbidden_files, ['src/secret.js']);
});
