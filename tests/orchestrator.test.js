import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { STATES, nextState } from '../src/orchestrator/stateMachine.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { WorkflowManager } from '../src/orchestrator/workflowManager.js';
import { createMockExecutorAdapter } from '../src/orchestrator/mocks/mockExecutorAdapter.js';
import { createMockGateRunner } from '../src/orchestrator/mocks/mockGateRunner.js';
import { createMockReviewerAdapter } from '../src/orchestrator/mocks/mockReviewerAdapter.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-dev-loop-orchestrator-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'demo-task',
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

test('stateMachine: rejects illegal transitions', () => {
  assert.throws(() => nextState(STATES.PENDING, 'review_pass'));
  assert.equal(nextState(STATES.PENDING, 'task_card_generated'), STATES.EXECUTING);
});

test('stateMachine: retry_limit_exceeded reaches ABORTED from any non-terminal state', () => {
  assert.equal(nextState(STATES.REWORK, 'retry_limit_exceeded'), STATES.ABORTED);
  assert.throws(() => nextState(STATES.COMPLETE, 'retry_limit_exceeded'));
});

test('demo workflow reaches COMPLETE with a workflow_id and correct owners', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'DONE' }),
      gateRunner: createMockGateRunner({ pass: true }),
      reviewerAdapter: createMockReviewerAdapter({ decision: 'PASS' }),
      persistence,
    });

    const taskCard = demoTaskCard();
    const finalState = await manager.runTask(taskCard);

    assert.equal(finalState.current_state, STATES.COMPLETE);
    assert.match(finalState.workflow_id, /^wf-/);
    assert.equal(finalState.current_executor, 'shell');
    assert.equal(finalState.attempt_count, 0);

    const persisted = await persistence.readState(finalState.workflow_id, taskCard.task_id);
    assert.equal(persisted.current_state, STATES.COMPLETE);
    assert.ok(persisted.artifacts.length > 0);

    const events = await persistence.readEvents(finalState.workflow_id, taskCard.task_id);
    const path_ = events.map((e) => e.new_state);
    assert.deepEqual(path_, [
      STATES.PENDING,
      STATES.EXECUTING,
      STATES.VERIFYING,
      STATES.REVIEWING,
      STATES.COMPLETE,
    ]);
  });
});

test('gate failure routes through REWORK back to EXECUTING and increments attempt_count', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    let gateCalls = 0;
    const gateRunner = {
      async run(commands) {
        gateCalls += 1;
        const pass = gateCalls > 1;
        return {
          pass,
          results: commands.map((command) => ({ command, pass, output: pass ? 'ok' : 'fail' })),
        };
      },
    };

    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'DONE' }),
      gateRunner,
      reviewerAdapter: createMockReviewerAdapter({ decision: 'PASS' }),
      persistence,
      maxAttempts: 3,
    });

    const finalState = await manager.runTask(demoTaskCard());

    assert.equal(finalState.current_state, STATES.COMPLETE);
    assert.equal(finalState.attempt_count, 1);
    assert.equal(gateCalls, 2);
  });
});

test('reviewer REWORK decision loops back through EXECUTING', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    let reviewCalls = 0;
    const reviewerAdapter = {
      async review(taskCard) {
        reviewCalls += 1;
        const decision = reviewCalls > 1 ? 'PASS' : 'REWORK';
        return {
          task_id: taskCard.task_id,
          decision,
          findings: decision === 'REWORK' ? ['needs work'] : [],
          required_changes: decision === 'REWORK' ? ['fix it'] : 'none',
          rationale: 'test',
        };
      },
    };

    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'DONE' }),
      gateRunner: createMockGateRunner({ pass: true }),
      reviewerAdapter,
      persistence,
      maxAttempts: 3,
    });

    const finalState = await manager.runTask(demoTaskCard());

    assert.equal(finalState.current_state, STATES.COMPLETE);
    assert.equal(finalState.attempt_count, 1);
    assert.equal(reviewCalls, 2);
  });
});

test('executor HUMAN_REQUIRED report stops the loop at HUMAN_REQUIRED', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'HUMAN_REQUIRED' }),
      gateRunner: createMockGateRunner({ pass: true }),
      reviewerAdapter: createMockReviewerAdapter({ decision: 'PASS' }),
      persistence,
    });

    const finalState = await manager.runTask(demoTaskCard());

    assert.equal(finalState.current_state, STATES.HUMAN_REQUIRED);
    assert.equal(finalState.current_executor, 'human');
    assert.ok(finalState.last_error);
  });
});

test('repeated reviewer REWORK verdicts exceed the retry limit and reach ABORTED', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    const reviewerAdapter = {
      async review(taskCard) {
        return {
          task_id: taskCard.task_id,
          decision: 'REWORK',
          findings: ['still not right'],
          required_changes: ['fix it'],
          rationale: 'test',
        };
      },
    };

    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'DONE' }),
      gateRunner: createMockGateRunner({ pass: true }),
      reviewerAdapter,
      persistence,
      maxAttempts: 2,
    });

    const finalState = await manager.runTask(demoTaskCard());

    assert.equal(finalState.current_state, STATES.ABORTED);
    assert.equal(finalState.attempt_count, 2);
    assert.match(finalState.last_error, /retry limit exceeded/);
  });
});

test('repeated gate failures exceed the retry limit and reach ABORTED', async () => {
  await withTempDir(async (dir) => {
    const persistence = new Persistence(dir);
    const manager = new WorkflowManager({
      executorAdapter: createMockExecutorAdapter({ status: 'DONE' }),
      gateRunner: createMockGateRunner({ pass: false }),
      reviewerAdapter: createMockReviewerAdapter({ decision: 'PASS' }),
      persistence,
      maxAttempts: 2,
    });

    const finalState = await manager.runTask(demoTaskCard());

    assert.equal(finalState.current_state, STATES.ABORTED);
    assert.equal(finalState.attempt_count, 2);
    assert.match(finalState.last_error, /retry limit exceeded/);
  });
});
