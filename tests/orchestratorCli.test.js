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
import { workflowProfileDir, loadConfig } from '../src/config.js';

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

test('runWorkflow logs worker window connect/disconnect as events.jsonl lines, not state machine transitions', async () => {
  await withTempDir(async (dir) => {
    const originalMode = process.env.GPT_BROWSER_MODE;
    process.env.GPT_BROWSER_MODE = 'extension';
    let subscribed = false;
    let unsubscribed = false;
    let capturedListener = null;

    const fakeExtensionServer = {
      onLifecycle(listener) {
        subscribed = true;
        capturedListener = listener;
        return () => {
          unsubscribed = true;
          capturedListener = null;
        };
      },
    };

    try {
      const finalState = await runWorkflow('unused-task-card-path.md', {
        baseDir: dir,
        createPersistence: (base) => new Persistence(base),
        readTaskCardFn: async () => demoTaskCard(),
        // By the time EXECUTING runs, the lifecycle subscription (set up
        // right before manager.runTask()) is already attached — this fires
        // one "connected" event from inside the workflow, same as a real
        // extension hello arriving mid-run.
        createExecutorAdapter: () => ({
          async execute(taskCard) {
            assert.ok(subscribed, 'lifecycle listener should be attached before EXECUTING runs');
            capturedListener({ type: 'connected', extensionVersion: '0.1.0', capabilities: ['chatgpt-dom-v1'] });
            return createMockExecutorAdapter({ status: 'DONE' }).execute(taskCard);
          },
        }),
        createReviewerAdapter: () => createMockReviewerAdapter({ decision: 'PASS' }),
        createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
        log: () => {},
        cleanupChromeProfile: async () => {},
        getExtensionServerFn: () => fakeExtensionServer,
      });

      assert.equal(finalState.current_state, STATES.COMPLETE);
      assert.ok(unsubscribed, 'lifecycle listener should be detached once the workflow finishes');

      const events = await new Persistence(dir).readEvents(finalState.workflow_id, 'demo-task');
      const lifecycleEvents = events.filter((event) => event.actor === 'extension');
      assert.equal(lifecycleEvents.length, 1);
      assert.equal(lifecycleEvents[0].trigger, 'worker_window_connected');
      // Logged alongside the real state transitions, but as a no-op entry
      // (previous_state === new_state) — it must never look like the state
      // machine itself transitioned.
      assert.equal(lifecycleEvents[0].previous_state, lifecycleEvents[0].new_state);
      assert.equal(lifecycleEvents[0].previous_state, STATES.EXECUTING);

      // The state machine's own transition sequence is untouched by any of
      // this — same states, same order as the plain COMPLETE test above.
      const stateEvents = events.filter((event) => event.actor !== 'extension');
      assert.deepEqual(
        stateEvents.map((event) => event.new_state),
        [STATES.PENDING, STATES.EXECUTING, STATES.VERIFYING, STATES.REVIEWING, STATES.COMPLETE]
      );
    } finally {
      if (originalMode === undefined) delete process.env.GPT_BROWSER_MODE;
      else process.env.GPT_BROWSER_MODE = originalMode;
    }
  });
});

test('runWorkflow gives the reviewer adapter a workflow-scoped Chrome profile, and two workflows never collide', async () => {
  await withTempDir(async (dir) => {
    const capturedWorkflowIds = [];
    const capturedReviewerWorkflowIds = [];

    async function runOnce() {
      return runWorkflow('unused-task-card-path.md', {
        baseDir: dir,
        createPersistence: (base) => new Persistence(base),
        readTaskCardFn: async () => demoTaskCard(),
        createExecutorAdapter: () => createMockExecutorAdapter({ status: 'DONE' }),
        createReviewerAdapter: ({ workflowId }) => {
          capturedReviewerWorkflowIds.push(workflowId);
          return createMockReviewerAdapter({ decision: 'PASS' });
        },
        createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
        log: () => {},
        cleanupChromeProfile: async () => {},
      });
    }

    const first = await runOnce();
    const second = await runOnce();
    capturedWorkflowIds.push(first.workflow_id, second.workflow_id);

    assert.notEqual(first.workflow_id, second.workflow_id);
    // The reviewer adapter factory was handed the same workflow_id the core
    // actually ran with, not a mismatched or missing one.
    assert.deepEqual(capturedReviewerWorkflowIds, [first.workflow_id, second.workflow_id]);

    const firstProfile = workflowProfileDir(first.workflow_id, loadConfig().profileDir);
    const secondProfile = workflowProfileDir(second.workflow_id, loadConfig().profileDir);
    assert.notEqual(firstProfile, secondProfile);
    assert.notEqual(firstProfile, loadConfig().profileDir);
  });
});

test('runWorkflow cleans up the Chrome profile on COMPLETE but keeps it for manual recovery on HUMAN_REQUIRED', async () => {
  await withTempDir(async (dir) => {
    const cleanedUp = [];

    const completed = await runWorkflow('unused-task-card-path.md', {
      baseDir: dir,
      createPersistence: (base) => new Persistence(base),
      readTaskCardFn: async () => demoTaskCard(),
      createExecutorAdapter: () => createMockExecutorAdapter({ status: 'DONE' }),
      createReviewerAdapter: () => createMockReviewerAdapter({ decision: 'PASS' }),
      createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
      log: () => {},
      cleanupChromeProfile: async (workflowId) => cleanedUp.push(workflowId),
    });
    assert.deepEqual(cleanedUp, [completed.workflow_id]);

    const humanRequired = await runWorkflow('unused-task-card-path.md', {
      baseDir: dir,
      createPersistence: (base) => new Persistence(base),
      readTaskCardFn: async () => demoTaskCard(),
      createExecutorAdapter: () => createMockExecutorAdapter({ status: 'HUMAN_REQUIRED' }),
      createReviewerAdapter: () => createMockReviewerAdapter({ decision: 'PASS' }),
      createGateRunnerAdapter: () => createMockGateRunner({ pass: true }),
      log: () => {},
      cleanupChromeProfile: async (workflowId) => cleanedUp.push(workflowId),
    });
    assert.equal(humanRequired.current_state, STATES.HUMAN_REQUIRED);
    // Still just the one cleanup call from the COMPLETE run above.
    assert.deepEqual(cleanedUp, [completed.workflow_id]);
  });
});
