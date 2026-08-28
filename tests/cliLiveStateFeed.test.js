import test from 'node:test';
import assert from 'node:assert/strict';

import { executeWorkflowWithLiveState } from '../bin/supergpt.js';
import { TerminalRenderer } from '../src/renderers/terminalRenderer.js';

test('CLI runtime feeds the TTY card from canonical persisted state before terminal completion without event workflowId', async () => {
  const received = [];
  let completed = false;
  let releaseRun;
  const terminal = new Promise((resolve) => { releaseRun = resolve; });
  let output = '';
  const renderer = new TerminalRenderer({
    stream: { write: (text) => { output += text; }, isTTY: true },
    isTTY: true,
    showSpinner: false,
  });
  renderer.start();
  const updateRenderer = renderer.updateState.bind(renderer);
  renderer.updateState = (state) => {
    assert.equal(completed, false, 'live state must arrive before terminal completion');
    received.push(state);
    updateRenderer(state);
  };
  const canonical = {
    workflowId: 'wf-cli-live',
    workflowStatus: 'RUNNING',
    task: { current: 1, total: 2, taskId: 'release-blocker', title: 'Release blocker' },
    attempt: 1,
    stage: 'EXECUTOR',
    executor: { status: 'running' },
    gate: { status: 'waiting' },
    reviewer: { status: 'waiting' },
    timing: { elapsed: '00:01', heartbeatAt: null, lastProgressAt: null, lastActivityAt: null },
    routing: {
      planner: { provider: 'codex' },
      supervisor: { provider: 'agy' },
      executor: { provider: 'claude' },
      reviewer: { provider: 'agy' },
    },
  };

  const resultPromise = executeWorkflowWithLiveState({
    workflowId: canonical.workflowId,
    intervalMs: 10,
    readProgress: ({ workflowId }) => {
      assert.equal(workflowId, canonical.workflowId);
      return canonical;
    },
    renderer,
    run: async ({ workflowId, onEvent }) => {
      assert.equal(workflowId, canonical.workflowId);
      onEvent?.({ type: 'task_started' }); // Deliberately no workflowId.
      await terminal;
      completed = true;
      return { status: 'WORKFLOW_DONE', workflowId };
    },
    runArgs: { onEvent: () => {} },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(received.length > 0);
  assert.deepEqual(received[0], canonical);
  for (const field of ['Task', 'Attempt', 'Stage', 'Planner', 'Supervisor', 'Executor', 'Gate', 'Reviewer']) {
    assert.match(output, new RegExp(field), `TTY card includes ${field}`);
  }

  releaseRun();
  const result = await resultPromise;
  assert.equal(result.status, 'WORKFLOW_DONE');
  const countAtTerminal = received.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(received.length, countAtTerminal, 'state observer stops with the runtime result');
  renderer.stop();
});
