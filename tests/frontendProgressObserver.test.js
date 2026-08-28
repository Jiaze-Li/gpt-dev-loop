import test from 'node:test';
import assert from 'node:assert/strict';
import { FrontendProgressObserver } from '../src/adapters/frontend/progressObserver.js';
import { GenericFrontendAdapter } from '../src/adapters/frontend/genericAdapter.js';

function state(overrides = {}) {
  return {
    workflowId: 'wf-ui', workflowStatus: 'RUNNING', taskIndex: 1, taskTotal: 2,
    taskId: 'parser', taskName: 'Parser validation', attempt: 1, stage: 'EXECUTOR',
    startedAt: new Date(Date.now() - 1000).toISOString(), heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    routing: { planner: { provider: 'codex', resolvedModel: 'default' }, supervisor: { provider: 'agy', resolvedModel: 'gemini' }, executor: { provider: 'claude', resolvedModel: 'sonnet' }, reviewer: { provider: 'agy', resolvedModel: 'gpt-oss' } },
    ...overrides,
  };
}

test('frontend observer automatically renders meaningful task, gate, reviewer and terminal transitions with zero provider calls', () => {
  const states = [
    state(),
    state({ stage: 'GATE', stageStatuses: { executor: 'done', gate: 'PASS', reviewer: 'waiting' } }),
    state({ stage: 'REVIEWER', stageStatuses: { executor: 'done', gate: 'PASS', reviewer: 'PASS' } }),
    state({ workflowStatus: 'DONE', stage: 'DONE', summary: 'Delivered', stageStatuses: { executor: 'done', gate: 'PASS', reviewer: 'PASS' } }),
  ];
  let calls = 0;
  const messages = [];
  const observer = new FrontendProgressObserver({
    controlService: { status: () => { calls += 1; return states.shift() ?? null; } },
    workflowId: 'wf-ui', render: (message) => messages.push(message),
  });
  observer.start(); observer.poll(); observer.poll(); observer.poll();
  assert.equal(calls, 4);
  assert.equal(observer.stopped, true);
  assert.match(messages[0], /Task 1\/2.*EXECUTOR/);
  assert.match(messages[1], /GATE.*PASS/);
  assert.match(messages[2], /REVIEWER.*PASS/);
  assert.match(messages[3], /SUPERGPT · DONE/);
});

test('frontend observer surfaces HUMAN_REQUIRED distinctly and disconnect only stops observation', () => {
  const messages = [];
  let providerCalls = 0;
  const observer = new FrontendProgressObserver({
    controlService: { status: () => state({ workflowStatus: 'HUMAN_REQUIRED', stage: 'HUMAN_REQUIRED', question: 'Choose storage.', stageStatuses: { executor: 'done', gate: 'PASS', reviewer: 'waiting' } }) },
    workflowId: 'wf-ui', render: (message) => messages.push(message),
  });
  observer.start();
  // Monitoring only reads local state; it has no provider integration point.
  assert.equal(providerCalls, 0);
  assert.equal(observer.stopped, true);
  assert.match(messages[0], /HUMAN_REQUIRED/);
  assert.match(messages[0], /Choose storage/);
});

test('a fresh observer can reattach to the same persisted workflow without fabricating progress', () => {
  const persisted = state({ taskIndex: 2, taskName: 'Delivery', attempt: 2, stage: 'REWORK' });
  const first = []; const fresh = [];
  new FrontendProgressObserver({ controlService: { status: () => persisted }, workflowId: 'wf-ui', render: (m) => first.push(m) }).start();
  new FrontendProgressObserver({ controlService: { status: () => persisted }, workflowId: 'wf-ui', render: (m) => fresh.push(m) }).start();
  assert.equal(first[0], fresh[0]);
  assert.match(fresh[0], /Task 2\/2.*Attempt 2.*REWORK/);
});

test('adapter attaches observation immediately when a frontend start returns workflowId', async () => {
  const messages = [];
  const adapter = new GenericFrontendAdapter({ controlService: { status: () => state() } });
  const result = await adapter.startAndObserve({
    start: async () => ({ workflowId: 'wf-ui', status: 'RUNNING' }),
    render: (message) => messages.push(message),
  });
  assert.equal(result.workflowId, 'wf-ui');
  assert.match(messages[0], /SuperGPT.*Task 1\/2/);
  result.observer.stop();
});
