import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';
import { ROUTE_DECISION, ROUTE_RULE } from '../src/control/autoRoutePolicy.js';

async function createTestMcpClient(options = {}) {
  const server = createSuperGptMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}

test('supergpt_route MCP tool: exposes schema and returns structured routing decisions', async () => {
  const { client } = await createTestMcpClient();

  const tools = await client.listTools();
  const routeTool = tools.tools.find((t) => t.name === 'supergpt_route');
  assert.ok(routeTool, 'supergpt_route tool must be registered on MCP server');
  assert.equal(routeTool.inputSchema.properties.goal.type, 'string');

  // 1. Engineering goal -> SUPERGPT
  const engRes = await client.callTool({
    name: 'supergpt_route',
    arguments: { goal: 'Refactor database migration and add integration tests' },
  });
  assert.equal(engRes.structuredContent.decision, ROUTE_DECISION.SUPERGPT);
  assert.equal(engRes.structuredContent.rule, ROUTE_RULE.SUBSTANTIAL_ENGINEERING);
  assert.match(engRes.structuredContent.reason, /Substantial engineering/);

  // 2. Non-modifying goal -> DIRECT
  const readRes = await client.callTool({
    name: 'supergpt_route',
    arguments: { goal: 'Explain how the MCP server routes requests' },
  });
  assert.equal(readRes.structuredContent.decision, ROUTE_DECISION.DIRECT);
  assert.equal(readRes.structuredContent.rule, ROUTE_RULE.NON_MODIFYING);

  // 3. Trivial edit -> DIRECT
  const typoRes = await client.callTool({
    name: 'supergpt_route',
    arguments: { goal: 'Fix typo in README.md' },
  });
  assert.equal(typoRes.structuredContent.decision, ROUTE_DECISION.DIRECT);
  assert.equal(typoRes.structuredContent.rule, ROUTE_RULE.TRIVIAL_EDIT);

  // 4. Explicit bypass -> DIRECT
  const bypassRes = await client.callTool({
    name: 'supergpt_route',
    arguments: { goal: 'Do not use SuperGPT; update port in config' },
  });
  assert.equal(bypassRes.structuredContent.decision, ROUTE_DECISION.DIRECT);
  assert.equal(bypassRes.structuredContent.rule, ROUTE_RULE.EXPLICIT_BYPASS);

  // 5. Explicit force -> SUPERGPT
  const forceRes = await client.callTool({
    name: 'supergpt_route',
    arguments: { goal: 'Use SuperGPT to fix typo in README' },
  });
  assert.equal(forceRes.structuredContent.decision, ROUTE_DECISION.SUPERGPT);
  assert.equal(forceRes.structuredContent.rule, ROUTE_RULE.EXPLICIT_FORCE);

  await client.close();
});

test('supergpt_route acceptance: identical result across different simulated frontends (Claude, Codex, AGY)', async () => {
  // Claude client
  const { client: claudeClient } = await createTestMcpClient();
  // Codex client
  const { client: codexClient } = await createTestMcpClient();
  // AGY client
  const { client: agyClient } = await createTestMcpClient();

  const testGoals = [
    'Implement user authentication with JWT tokens',
    'Explain this stack trace',
    'Fix typo in README.md',
    'Do not use SuperGPT; change this file',
    'Use SuperGPT to update dependencies',
    'Write unit tests for autoRoutePolicy',
  ];

  for (const goal of testGoals) {
    const claudeRes = await claudeClient.callTool({ name: 'supergpt_route', arguments: { goal } });
    const codexRes = await codexClient.callTool({ name: 'supergpt_route', arguments: { goal } });
    const agyRes = await agyClient.callTool({ name: 'supergpt_route', arguments: { goal } });

    assert.deepEqual(claudeRes.structuredContent, codexRes.structuredContent);
    assert.deepEqual(claudeRes.structuredContent, agyRes.structuredContent);
  }

  await claudeClient.close();
  await codexClient.close();
  await agyClient.close();
});
