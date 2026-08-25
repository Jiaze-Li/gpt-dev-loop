import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseArgs, runWorkflow } from '../src/orchestratorCli.js';
import { UsageError } from '../src/bridge/errors.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { STATES } from '../src/orchestrator/stateMachine.js';
import { createMockExecutorAdapter } from '../src/orchestrator/mocks/mockExecutorAdapter.js';
import { createMockGateRunner } from '../src/orchestrator/mocks/mockGateRunner.js';
import { createMockReviewerAdapter } from '../src/orchestrator/mocks/mockReviewerAdapter.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-dev-loop-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function demoTaskCard() {
  return {
    task_id: 'demo-task',
    repository_context: { repository_name: 'demo', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
  };
}

test('parseArgs requires the "run" command and a task card path', () => {
  const result = parseArgs(['run', 'task.md']);
  assert.equal(result.command, 'run');
  assert.equal(result.taskCardPath, 'task.md');

  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['review', 'task.md']), UsageError);
  assert.throws(() => parseArgs(['run']), UsageError);
});

test('runWorkflow drives a Task Card through the real Workflow Manager with the mock adapters and reports every state', async () => {
  await withTempDir(async (dir) => {
    const loggedStates = [];

    const finalState = await runWorkflow('unused-task-card-path.md', {
      baseDir: dir,
      createPersistence: (base) => new Persistence(base),
      readTaskCardFn: async () => demoTaskCard(),
      createExecutorAdapter: () => createMockExecutorAdapter({ status: 'DONE' }),
      createReviewerAdapter: () => createMockReviewerAdapter({ decision: 'PASS' }),
      createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
      log: (line) => loggedStates.push(line),
    });

    assert.equal(finalState.current_state, STATES.COMPLETE);
    assert.match(finalState.workflow_id, /^wf-/);
    assert.deepEqual(loggedStates, [
      STATES.PENDING,
      STATES.EXECUTING,
      STATES.VERIFYING,
      STATES.REVIEWING,
      STATES.COMPLETE,
    ]);

    const persisted = await new Persistence(dir).readState(finalState.workflow_id, 'demo-task');
    assert.equal(persisted.current_state, STATES.COMPLETE);
  });
});

test('runWorkflow reports HUMAN_REQUIRED without duplicating a state that repeats across transitions', async () => {
  await withTempDir(async (dir) => {
    const loggedStates = [];

    const finalState = await runWorkflow('unused-task-card-path.md', {
      baseDir: dir,
      createPersistence: (base) => new Persistence(base),
      readTaskCardFn: async () => demoTaskCard(),
      createExecutorAdapter: () => createMockExecutorAdapter({ status: 'HUMAN_REQUIRED' }),
      createReviewerAdapter: () => createMockReviewerAdapter({ decision: 'PASS' }),
      createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
      log: (line) => loggedStates.push(line),
    });

    assert.equal(finalState.current_state, STATES.HUMAN_REQUIRED);
    assert.deepEqual(loggedStates, [STATES.PENDING, STATES.EXECUTING, STATES.HUMAN_REQUIRED]);
  });
});
