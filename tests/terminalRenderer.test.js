import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRenderer } from '../src/renderers/terminalRenderer.js';

test('TTY live card is populated from canonical persisted state before terminal completion', () => {
  let output = '';
  const renderer = new TerminalRenderer({ stream: { write: (s) => { output += s; }, isTTY: true }, isTTY: true, showSpinner: false });
  renderer.start();
  renderer.updateState({
    workflowId: 'wf-card', workflowStatus: 'RUNNING', taskIndex: 1, taskTotal: 2,
    taskName: 'Release blocker', attempt: 1, stage: 'EXECUTOR',
    startedAt: new Date(Date.now() - 1000).toISOString(), heartbeatAt: new Date().toISOString(), lastProgressAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    routing: { planner: { provider: 'codex' }, supervisor: { provider: 'agy' }, executor: { provider: 'claude' }, reviewer: { provider: 'agy' } },
  });
  renderer.stop();
  for (const field of ['Task', 'Attempt', 'Stage', 'Planner', 'Supervisor', 'Executor', 'Gate', 'Reviewer', 'Elapsed', 'Heartbeat', 'Last progress', 'Last activity']) assert.match(output, new RegExp(field));
  assert.match(output, /Release blocker/);
});
