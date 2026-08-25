import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createClaudeSessionManager } from '../src/orchestrator/adapters/claudeSessionManager.js';

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'demo-task',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'phase1-handshake',
      commit_sha: 'abc123',
    },
    goal: 'demo',
    context: 'original context',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function demoReport(overrides = {}) {
  return {
    task_id: 'demo-task',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: null,
      branch: 'phase1-handshake',
      commit_sha: 'def456',
    },
    status: 'DONE',
    changed_files: [],
    tests_run: [],
    test_results: [],
    issues: 'none',
    next_recommendation: 'proceed',
    ...overrides,
  };
}

// Fake "git" spawn: rev-parse/status always succeed with canned output, so
// tests don't depend on the real repo's state.
function makeFakeGitSpawn({ commit = 'deadbeef', status = ' M src/foo.js' } = {}) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      const out = args[0] === 'rev-parse' ? commit : status;
      child.stdout.emit('data', Buffer.from(out));
      child.emit('close', 0);
    });
    return child;
  };
}

function makeFakePersistence(state) {
  return {
    readState: async (workflowId, taskId) => {
      assert.equal(workflowId, 'wf-1');
      assert.equal(taskId, 'demo-task');
      return state;
    },
  };
}

test('claude session manager: first call is session #1, runs the task card unmodified', async () => {
  const calls = [];
  const createExecutor = () => ({
    async execute(taskCard) {
      calls.push(taskCard);
      return demoReport();
    },
  });
  const manager = createClaudeSessionManager({
    workflowId: 'wf-1',
    taskId: 'demo-task',
    persistence: makeFakePersistence({ attempt_count: 0, last_error: null }),
    createExecutor,
    spawn: makeFakeGitSpawn(),
  });

  const taskCard = demoTaskCard();
  const report = await manager.execute(taskCard);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, 'original context');
  assert.deepEqual(report, demoReport());
});

test('claude session manager: rework call is a new session, fed feedback + repo state, original task card unchanged', async () => {
  const executors = [];
  const createExecutor = () => {
    const calls = [];
    executors.push(calls);
    return {
      async execute(taskCard) {
        calls.push(taskCard);
        return demoReport();
      },
    };
  };
  const manager = createClaudeSessionManager({
    workflowId: 'wf-1',
    taskId: 'demo-task',
    persistence: makeFakePersistence({ attempt_count: 1, last_error: '["fix the null check"]' }),
    createExecutor,
    spawn: makeFakeGitSpawn({ commit: 'cafef00d', status: ' M src/bar.js' }),
  });

  const taskCard = demoTaskCard();
  await manager.execute(taskCard); // session #1
  await manager.execute(taskCard); // session #2 (rework)

  // a distinct executor instance was created for each session
  assert.equal(executors.length, 2);
  assert.equal(executors[0].length, 1);
  assert.equal(executors[1].length, 1);

  const reworkCard = executors[1][0];
  assert.match(reworkCard.context, /Claude session #2/);
  assert.match(reworkCard.context, /fix the null check/);
  assert.match(reworkCard.context, /cafef00d/);
  assert.match(reworkCard.context, /src\/bar\.js/);
  assert.match(reworkCard.context, /original context/);

  // the caller's original task card object is never mutated
  assert.equal(taskCard.context, 'original context');
});

test('claude session manager: third call is session #3 and still reflects the latest persisted feedback', async () => {
  const executors = [];
  const createExecutor = () => {
    const calls = [];
    executors.push(calls);
    return {
      async execute(taskCard) {
        calls.push(taskCard);
        return demoReport();
      },
    };
  };
  const manager = createClaudeSessionManager({
    workflowId: 'wf-1',
    taskId: 'demo-task',
    persistence: makeFakePersistence({ attempt_count: 2, last_error: 'verification failed' }),
    createExecutor,
    spawn: makeFakeGitSpawn(),
  });

  const taskCard = demoTaskCard();
  await manager.execute(taskCard);
  await manager.execute(taskCard);
  await manager.execute(taskCard);

  assert.equal(executors.length, 3);
  assert.match(executors[2][0].context, /Claude session #3/);
  assert.match(executors[2][0].context, /verification failed/);
});
