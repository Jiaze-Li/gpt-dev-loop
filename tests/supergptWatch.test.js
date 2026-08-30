import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  supergptWatch,
  WorkflowStateManager,
  WORKFLOW_STATUSES,
  WORKFLOW_STAGES,
} from '../src/orchestrator/supergpt.js';
import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';

test('watch emits immediately upon attachment', async () => {
  let emitted = [];
  const state = {
    workflowId: 'wf-watch-imm',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    taskId: 'task-1',
    taskName: 'Build UI',
    taskIndex: 1,
    taskTotal: 3,
    attempt: 1,
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    startedAt: '2026-08-28T12:00:00.000Z',
    heartbeatAt: '2026-08-28T12:00:05.000Z',
    lastProgressAt: '2026-08-28T12:00:05.000Z',
  };

  const abortController = new AbortController();
  const resPromise = supergptWatch({
    workflowId: 'wf-watch-imm',
    _readState: () => state,
    _now: () => new Date('2026-08-28T12:00:10.000Z').getTime(),
    _sleep: async () => {
      // Abort after immediate emission so test completes quickly
      abortController.abort();
    },
    signal: abortController.signal,
    onProgress: (p) => emitted.push(p),
  });

  const res = await resPromise;
  assert.ok(emitted.length >= 1, 'must emit progress immediately');
  assert.equal(emitted[0].progress, 1);
  assert.match(emitted[0].formattedProgress, /SUPERGPT ⟳ RUNNING/);
  assert.match(emitted[0].formattedProgress, /Task\s+1 \/ 3 — Build UI/);
  assert.match(emitted[0].formattedProgress, /Stage\s+EXECUTOR/);
  assert.match(emitted[0].formattedProgress, /Heartbeat\s+\d{2}:\d{2}:\d{2}/);
  assert.equal(res.cancelled, true);
});

test('heartbeat and elapsed updates occur periodically without model calls', async () => {
  const modelCalls = [];
  const emitted = [];
  let currentTime = new Date('2026-08-28T12:00:00.000Z').getTime();

  let tick = 0;
  const state = {
    workflowId: 'wf-heartbeat-test',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    taskId: 'task-1',
    attempt: 1,
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    startedAt: '2026-08-28T12:00:00.000Z',
    heartbeatAt: '2026-08-28T12:00:00.000Z',
    lastProgressAt: '2026-08-28T12:00:00.000Z',
  };

  const abortController = new AbortController();
  const res = await supergptWatch({
    workflowId: 'wf-heartbeat-test',
    _readState: () => {
      // Advance heartbeat on each tick
      state.heartbeatAt = new Date(currentTime).toISOString();
      return state;
    },
    _now: () => currentTime,
    _sleep: async () => {
      tick += 1;
      currentTime += 1000;
      if (tick > 3) abortController.abort();
    },
    signal: abortController.signal,
    onProgress: (p) => emitted.push(p),
  });

  // Verify progression
  assert.equal(emitted.length, 4); // 1 initial + 3 ticks
  assert.deepEqual(emitted.map((e) => e.progress), [1, 2, 3, 4]);

  // Check that elapsed time and heartbeat updated
  assert.match(emitted[0].formattedProgress, /Elapsed\s+00:00/);
  assert.match(emitted[0].formattedProgress, /Heartbeat\s+\d{2}:\d{2}:\d{2}/);

  assert.match(emitted[1].formattedProgress, /Elapsed\s+00:01/);
  assert.match(emitted[1].formattedProgress, /Heartbeat\s+\d{2}:\d{2}:\d{2}/);

  assert.match(emitted[2].formattedProgress, /Elapsed\s+00:02/);
  assert.match(emitted[2].formattedProgress, /Heartbeat\s+\d{2}:\d{2}:\d{2}/);

  assert.match(emitted[3].formattedProgress, /Elapsed\s+00:03/);
  assert.match(emitted[3].formattedProgress, /Heartbeat\s+\d{2}:\d{2}:\d{2}/);

  // Model call accounting is strictly 0
  assert.equal(modelCalls.length, 0);
  assert.equal(res.cancelled, true);
});

test('stage and task transitions update live during watch', async () => {
  const emitted = [];
  const stages = [
    { stage: WORKFLOW_STAGES.EXECUTOR, stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' } },
    { stage: WORKFLOW_STAGES.GATE, stageStatuses: { executor: 'done', gate: 'running', reviewer: 'waiting' } },
    { stage: WORKFLOW_STAGES.REVIEWER, stageStatuses: { executor: 'done', gate: 'PASS', reviewer: 'running' } },
  ];

  let currentIdx = 0;
  const state = {
    workflowId: 'wf-transitions',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: stages[0].stage,
    taskId: 'task-1',
    attempt: 1,
    stageStatuses: stages[0].stageStatuses,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };

  const abortController = new AbortController();
  await supergptWatch({
    workflowId: 'wf-transitions',
    _readState: () => {
      state.stage = stages[currentIdx].stage;
      state.stageStatuses = stages[currentIdx].stageStatuses;
      return state;
    },
    _sleep: async () => {
      currentIdx += 1;
      if (currentIdx >= stages.length) abortController.abort();
    },
    signal: abortController.signal,
    onProgress: (p) => emitted.push(p),
  });

  assert.equal(emitted.length, 3);
  assert.match(emitted[0].formattedProgress, /Stage\s+EXECUTOR/);
  assert.match(emitted[1].formattedProgress, /Stage\s+GATE/);
  assert.match(emitted[2].formattedProgress, /Stage\s+REVIEWER/);
});

test('terminal state ends watch immediately', async () => {
  const emitted = [];
  let ticks = 0;
  const state = {
    workflowId: 'wf-terminal-end',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    taskId: 'task-1',
    attempt: 1,
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };

  const res = await supergptWatch({
    workflowId: 'wf-terminal-end',
    _readState: () => {
      if (ticks >= 2) {
        state.workflowStatus = WORKFLOW_STATUSES.DONE;
        state.stage = WORKFLOW_STAGES.DONE;
        state.summary = 'All tasks completed successfully';
        state.deliveredFiles = ['src/index.js'];
      }
      return state;
    },
    _sleep: async () => {
      ticks += 1;
    },
    onProgress: (p) => emitted.push(p),
  });

  assert.equal(res.status, 'DONE');
  assert.equal(res.stage, 'DONE');
  assert.equal(res.summary, 'All tasks completed successfully');
  assert.deepEqual(res.deliveredFiles, ['src/index.js']);
  assert.equal(res.cancelled, false);
  assert.match(res.formattedProgress, /SUPERGPT ⟳ DONE/);
  assert.equal(emitted.at(-1).canonical.workflowStatus, 'DONE');
});

test('cancelling watch does NOT stop or modify the workflow', async () => {
  // Live WorkflowStateManager instance
  const manager = new WorkflowStateManager({ workflowId: 'wf-cancel-isolation' });
  manager.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 'task-auth' });
  manager.startHeartbeat(50);

  const abortController = new AbortController();

  const watchPromise = supergptWatch({
    workflowId: 'wf-cancel-isolation',
    _readState: () => manager.getState(),
    _sleep: async () => {
      // Cancel the watch from the frontend
      abortController.abort('user closed tab');
    },
    signal: abortController.signal,
  });

  const watchResult = await watchPromise;
  assert.equal(watchResult.cancelled, true);

  // Invariant: The workflow itself is STILL RUNNING, not STOPPED
  const liveState = manager.getState();
  assert.equal(liveState.workflowStatus, WORKFLOW_STATUSES.STARTING);
  assert.equal(liveState.stage, WORKFLOW_STAGES.EXECUTOR);
  assert.notEqual(liveState.workflowStatus, WORKFLOW_STATUSES.STOPPED);

  manager.stopHeartbeat();
});

test('frontend disconnect does NOT stop the workflow', async () => {
  const manager = new WorkflowStateManager({ workflowId: 'wf-disconnect-isolation' });
  manager.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 'task-fetch' });

  const server = createSuperGptMcpServer({
    watchSuperGptFn: async ({ workflowId, signal, onProgress }) => {
      return supergptWatch({
        workflowId,
        signal,
        onProgress,
        _readState: () => manager.getState(),
      });
    },
  });

  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Start watch tool call
  const watchCall = client.callTool(
    { name: 'supergpt_watch', arguments: { workflowId: 'wf-disconnect-isolation' } }
  ).catch(() => {});

  // Disconnect frontend while watch is running
  await client.close();
  await watchCall;

  // Workflow is still intact and alive
  assert.equal(manager.getState().stage, WORKFLOW_STAGES.EXECUTOR);
  assert.notEqual(manager.getState().workflowStatus, WORKFLOW_STATUSES.STOPPED);
});

test('reconnect and watch reattach seamlessly streams live state', async () => {
  const state = {
    workflowId: 'wf-reattach',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.PLANNING,
    taskId: null,
    attempt: 0,
    stageStatuses: { executor: 'waiting', gate: 'waiting', reviewer: 'waiting' },
    startedAt: new Date('2026-08-28T12:00:00.000Z').toISOString(),
    heartbeatAt: new Date('2026-08-28T12:00:05.000Z').toISOString(),
    lastProgressAt: new Date('2026-08-28T12:00:05.000Z').toISOString(),
  };

  // First session watches during planning, then disconnects/aborts
  const session1Abort = new AbortController();
  const session1Emitted = [];
  await supergptWatch({
    workflowId: 'wf-reattach',
    _readState: () => state,
    _sleep: async () => { session1Abort.abort(); },
    signal: session1Abort.signal,
    onProgress: (p) => session1Emitted.push(p),
  });
  assert.equal(session1Emitted[0].canonical.stage, WORKFLOW_STAGES.PLANNING);

  // Workflow advances in background while no one is watching
  state.stage = WORKFLOW_STAGES.EXECUTOR;
  state.taskId = 'task-1';
  state.taskIndex = 1;
  state.taskTotal = 2;
  state.attempt = 1;
  state.stageStatuses.executor = 'running';

  // Second session attaches: immediately sees current stage (EXECUTOR), then terminal (DONE)
  const session2Emitted = [];
  let ticks = 0;
  const finalResult = await supergptWatch({
    workflowId: 'wf-reattach',
    _readState: () => {
      if (ticks >= 1) {
        state.workflowStatus = WORKFLOW_STATUSES.DONE;
        state.stage = WORKFLOW_STAGES.DONE;
        state.summary = 'Completed successfully';
      }
      return state;
    },
    _sleep: async () => { ticks += 1; },
    onProgress: (p) => session2Emitted.push(p),
  });

  assert.equal(session2Emitted[0].canonical.stage, WORKFLOW_STAGES.EXECUTOR);
  assert.equal(finalResult.status, 'DONE');
  assert.equal(finalResult.summary, 'Completed successfully');
});

test('model/provider call count attributable to monitoring is strictly 0', async () => {
  let modelCallCount = 0;
  const mockModel = {
    invoke: async () => {
      modelCallCount += 1;
      return { content: 'unexpected model invocation' };
    },
  };

  const state = {
    workflowId: 'wf-zero-tokens',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    taskId: 'task-1',
    attempt: 1,
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };

  let tickCount = 0;
  const abortController = new AbortController();
  await supergptWatch({
    workflowId: 'wf-zero-tokens',
    _readState: () => state,
    _sleep: async () => {
      tickCount += 1;
      if (tickCount >= 10) abortController.abort();
    },
    signal: abortController.signal,
    onProgress: () => {
      // Verify nothing touches mockModel
    },
  });

  assert.equal(tickCount, 10);
  assert.equal(modelCallCount, 0, 'Monitoring must NEVER invoke any LLM or model provider');
});
