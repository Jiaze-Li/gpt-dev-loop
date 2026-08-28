import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyExecutorModel,
  createClaudeSessionManager,
  CLAUDE_MODELS,
} from '../src/orchestrator/adapters/claudeSessionManager.js';

test('classifyExecutorModel: defaults to Sonnet for routine tasks', () => {
  const routineTasks = [
    { task_id: 'task-1', goal: 'add unit test for helper', scope: 'tests/helper.test.js' },
    { task_id: 'task-2', goal: 'update config.json port', scope: 'config.json' },
    { task_id: 'task-3', goal: 'small local refactor of parseDate', scope: 'src/utils/date.js' },
    { task_id: 'task-4', goal: 'implement simple greeting endpoint', scope: 'src/api.js' },
  ];

  for (const tc of routineTasks) {
    const result = classifyExecutorModel(tc, { sessionNumber: 1 });
    assert.equal(result.model, CLAUDE_MODELS.DEFAULT);
    assert.equal(result.escalated, false);
    assert.equal(result.escalationReason, null);
  }
});

test('classifyExecutorModel: escalates to Opus for high complexity / architectural tasks', () => {
  // Explicit complexity
  const highComplexity = { task_id: 't-1', goal: 'routine goal', complexity: 'high' };
  const res1 = classifyExecutorModel(highComplexity, { sessionNumber: 1 });
  assert.equal(res1.model, CLAUDE_MODELS.ESCALATED);
  assert.equal(res1.escalated, true);
  assert.match(res1.escalationReason, /high complexity/i);

  // Architectural flag
  const archTask = { task_id: 't-2', goal: 'refactor', architectural: true };
  const res2 = classifyExecutorModel(archTask, { sessionNumber: 1 });
  assert.equal(res2.model, CLAUDE_MODELS.ESCALATED);
  assert.equal(res2.escalated, true);

  // Goal with architectural / cross-cutting keywords
  const keywordTask = { task_id: 't-3', goal: 'perform architectural refactor of auth pipeline' };
  const res3 = classifyExecutorModel(keywordTask, { sessionNumber: 1 });
  assert.equal(res3.model, CLAUDE_MODELS.ESCALATED);
  assert.equal(res3.escalated, true);
  assert.match(res3.escalationReason, /architectural complexity/i);
});

test('classifyExecutorModel: escalates to Opus on repeated rework (attempt >= 3)', () => {
  const routine = { task_id: 't-1', goal: 'routine bugfix' };

  // Attempt 1: Sonnet
  assert.equal(classifyExecutorModel(routine, { sessionNumber: 1 }).model, 'sonnet');
  // Attempt 2: Sonnet (unless feedback indicates complex debugging)
  assert.equal(classifyExecutorModel(routine, { sessionNumber: 2 }).model, 'sonnet');
  // Attempt 3: Escalated to Opus
  const res3 = classifyExecutorModel(routine, { sessionNumber: 3 });
  assert.equal(res3.model, 'opus');
  assert.equal(res3.escalated, true);
  assert.match(res3.escalationReason, /repeated rework/i);
});

test('classifyExecutorModel: escalates to Opus on difficult debugging feedback', () => {
  const routine = { task_id: 't-1', goal: 'fix test flakiness' };
  const feedback = 'Reviewer found deep debugging required due to cross-cutting race condition in state machine';

  const res = classifyExecutorModel(routine, { sessionNumber: 2, feedback });
  assert.equal(res.model, 'opus');
  assert.equal(res.escalated, true);
  assert.match(res.escalationReason, /debugging/i);
});

test('createClaudeSessionManager: passes routed model to executor and fires routing callback', async () => {
  const routingEvents = [];
  const executorCalls = [];

  const createExecutor = ({ cwd, model }) => {
    executorCalls.push({ cwd, model });
    return {
      async execute(taskCard) {
        return {
          task_id: taskCard.task_id,
          repository_context: taskCard.repository_context,
          status: 'DONE',
          changed_files: [],
          tests_run: [],
          test_results: [],
          issues: 'none',
          next_recommendation: 'proceed',
        };
      },
    };
  };

  const manager = createClaudeSessionManager({
    workflowId: 'wf-test',
    taskId: 'arch-task',
    createExecutor,
    onRoutingDecision: (event) => routingEvents.push(event),
  });

  const report = await manager.execute({
    task_id: 'arch-task',
    goal: 'architectural redesign of storage layer',
    repository_context: { repository_name: 'test', branch: 'main', commit_sha: '123' },
    scope: 'all',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['done'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
  });

  assert.equal(executorCalls.length, 1);
  assert.equal(executorCalls[0].model, 'opus');
  assert.equal(routingEvents.length, 1);
  assert.equal(routingEvents[0].model, 'opus');
  assert.equal(routingEvents[0].escalated, true);
  assert.equal(report.model, 'opus');
  assert.equal(report.modelEscalated, true);
});
