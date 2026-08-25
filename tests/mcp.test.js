import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';

async function connectedClient(askGptFn) {
  const server = createMcpServer({
    askGptFn,
    config: { chatgptUrl: 'https://chatgpt.com/', profileDir: '/tmp/unused' },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('ask_gpt tool is exposed with the expected input/output schema', async () => {
  const { client } = await connectedClient(async () => 'unused');
  const { tools } = await client.listTools();
  const askGptTool = tools.find((tool) => tool.name === 'ask_gpt');

  assert.ok(askGptTool, 'ask_gpt tool should be registered');
  assert.deepEqual(Object.keys(askGptTool.inputSchema.properties), ['prompt']);
  assert.ok(askGptTool.inputSchema.required.includes('prompt'));
  assert.deepEqual(Object.keys(askGptTool.outputSchema.properties), ['reply']);

  await client.close();
});

test('ask_gpt calls the injected askGpt function and returns its reply', async () => {
  const calls = [];
  const askGptFn = async (prompt, config) => {
    calls.push({ prompt, config });
    return `echo: ${prompt}`;
  };
  const { client } = await connectedClient(askGptFn);

  const result = await client.callTool({ name: 'ask_gpt', arguments: { prompt: 'HANDSHAKE_OK' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, 'HANDSHAKE_OK');
  assert.equal(result.structuredContent.reply, 'echo: HANDSHAKE_OK');
  assert.equal(result.content[0].text, 'echo: HANDSHAKE_OK');

  await client.close();
});

test('ask_gpt rejects an empty prompt before reaching askGpt', async () => {
  let called = false;
  const { client } = await connectedClient(async () => {
    called = true;
    return 'unused';
  });

  const result = await client.callTool({ name: 'ask_gpt', arguments: { prompt: '' } });
  assert.equal(result.isError, true);
  assert.equal(called, false);

  await client.close();
});
