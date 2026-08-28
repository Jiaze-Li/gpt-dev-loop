// Deterministic tests for the SuperGPT MCP server. The real pipeline
// (Chrome / agy / git worktrees) is never exercised — every dependency is
// injected.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer, readWorkflowStatus } from '../bin/supergpt-mcp.js';

async function connect(overrides = {}) {
  const server = createSuperGptMcpServer(overrides);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test('lists supergpt_run, supergpt_plan, and supergpt_status with schemas', async () => {
  const client = await connect({
    runSuperGptFn: async () => ({}),
    resolveWorkflowPlanFn: async () => ({}),
    readWorkflowStatusFn: async () => [],
  });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['supergpt_plan', 'supergpt_run', 'supergpt_status']);

  const plan = tools.find((t) => t.name === 'supergpt_plan');
  assert.deepEqual(Object.keys(plan.inputSchema.properties).sort(), ['cwd', 'goal']);
  assert.ok(plan.inputSchema.required.includes('goal'));

  const run = tools.find((t) => t.name === 'supergpt_run');
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(), ['cwd', 'goal', 'planPath']);

  await client.close();
});

test('supergpt_plan returns a READY plan from the injected resolver', async () => {
  const calls = [];
  const client = await connect({
    resolveWorkflowPlanFn: async (args) => {
      calls.push(args);
      return { plan: 'PLAN TEXT', summary: 'do X then Y', tasks: [{ task_id: 't-1' }], source: 'nl' };
    },
  });

  const result = await client.callTool({
    name: 'supergpt_plan',
    arguments: { goal: 'add a feature', cwd: '/tmp/repo' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].planArg, 'add a feature');
  assert.equal(calls[0].cwd, '/tmp/repo');
  assert.equal(result.structuredContent.status, 'READY');
  assert.equal(result.structuredContent.summary, 'do X then Y');
  assert.equal(result.structuredContent.planText, 'PLAN TEXT');
  assert.deepEqual(result.structuredContent.tasks, [{ task_id: 't-1' }]);
  assert.equal(result.structuredContent.question, null);

  await client.close();
});

test('supergpt_plan surfaces an AMBIGUOUS question', async () => {
  const client = await connect({
    resolveWorkflowPlanFn: async () => ({ status: 'AMBIGUOUS', question: 'REST or GraphQL?', source: 'nl' }),
  });

  const result = await client.callTool({ name: 'supergpt_plan', arguments: { goal: 'build an API' } });

  assert.equal(result.structuredContent.status, 'AMBIGUOUS');
  assert.equal(result.structuredContent.question, 'REST or GraphQL?');
  assert.equal(result.structuredContent.planText, null);

  await client.close();
});

test('supergpt_run drives runSuperGPT and returns result + collected events', async () => {
  const calls = [];
  const client = await connect({
    runSuperGptFn: async ({ goal, cwd, onEvent }) => {
      calls.push({ goal, cwd });
      onEvent({ type: 'workflow_started', timestamp: 't0' });
      onEvent({ type: 'delivery_succeeded', timestamp: 't1', changedFiles: ['a.js'] });
      onEvent({ type: 'workflow_finished', timestamp: 't2' });
      return {
        status: 'WORKFLOW_DONE',
        summary: 'all done',
        deliveredFiles: ['a.js', 'b.js'],
        workflowId: 'wf-agy-123',
        reason: null,
        question: null,
      };
    },
  });

  const result = await client.callTool({
    name: 'supergpt_run',
    arguments: { goal: 'do the thing', cwd: '/tmp/ws' },
  });

  assert.equal(calls[0].goal, 'do the thing');
  assert.equal(calls[0].cwd, '/tmp/ws');
  const sc = result.structuredContent;
  assert.equal(sc.status, 'WORKFLOW_DONE');
  assert.equal(sc.summary, 'all done');
  assert.deepEqual(sc.deliveredFiles, ['a.js', 'b.js']);
  assert.equal(sc.workflowId, 'wf-agy-123');
  assert.equal(sc.events.length, 3);
  assert.equal(sc.events[0].type, 'workflow_started');
  assert.equal(sc.events.at(-1).type, 'workflow_finished');

  await client.close();
});

test('supergpt_run reports HUMAN_REQUIRED with the question, not an error', async () => {
  const client = await connect({
    runSuperGptFn: async () => ({
      status: 'HUMAN_REQUIRED',
      summary: null,
      deliveredFiles: [],
      workflowId: 'wf-agy-9',
      reason: 'plan ambiguous',
      question: 'Which database?',
    }),
  });

  const result = await client.callTool({ name: 'supergpt_run', arguments: { goal: 'x' } });

  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.status, 'HUMAN_REQUIRED');
  assert.equal(result.structuredContent.question, 'Which database?');

  await client.close();
});

test('supergpt_run rejects a call with neither goal nor planPath', async () => {
  const client = await connect({ runSuperGptFn: async () => ({}) });
  const result = await client.callTool({ name: 'supergpt_run', arguments: {} });
  assert.equal(result.isError, true);
  await client.close();
});

test('supergpt_status returns the injected workflow metadata', async () => {
  const client = await connect({
    readWorkflowStatusFn: async ({ workflowId }) => {
      assert.equal(workflowId, 'wf-agy-7');
      return [{ workflow_id: 'wf-agy-7', source_branch: 'main', isolated_worktree_path: '/w/7' }];
    },
  });

  const result = await client.callTool({
    name: 'supergpt_status',
    arguments: { workflowId: 'wf-agy-7' },
  });

  assert.equal(result.structuredContent.workflows.length, 1);
  assert.equal(result.structuredContent.workflows[0].workflow_id, 'wf-agy-7');

  await client.close();
});

test('readWorkflowStatus tolerates a missing root directory', async () => {
  const out = await readWorkflowStatus({
    readDir: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual(out, []);
});

test('readWorkflowStatus parses *.workspace.json, skips junk, and filters by id', async () => {
  const files = {
    'wf-agy-1.workspace.json': JSON.stringify({ workflow_id: 'wf-agy-1', source_branch: 'main' }),
    'wf-agy-2.workspace.json': JSON.stringify({ workflow_id: 'wf-agy-2', source_branch: 'dev' }),
    'broken.workspace.json': '{not json',
    'notes.txt': 'ignored',
  };
  const all = await readWorkflowStatus({
    root: '/fake',
    readDir: async () => Object.keys(files),
    readTextFile: async (p) => files[p.split('/').pop()],
  });
  assert.deepEqual(all.map((w) => w.workflow_id), ['wf-agy-2', 'wf-agy-1']);

  const one = await readWorkflowStatus({
    root: '/fake',
    workflowId: 'wf-agy-1',
    readDir: async () => Object.keys(files),
    readTextFile: async (p) => files[p.split('/').pop()],
  });
  assert.deepEqual(one.map((w) => w.workflow_id), ['wf-agy-1']);
});
