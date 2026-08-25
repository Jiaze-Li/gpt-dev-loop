import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveAskGpt } from '../bridge/transport.js';
import { loadConfig } from '../config.js';

export function createMcpServer({ askGptFn, config = loadConfig() } = {}) {
  const askGptImpl = askGptFn ?? resolveAskGpt(config);
  const server = new McpServer({
    name: 'gpt-dev-loop',
    version: '0.1.0',
  });

  server.registerTool(
    'ask_gpt',
    {
      description: 'Ask ChatGPT (via the configured browser bridge) a prompt and return its reply.',
      inputSchema: { prompt: z.string().min(1, 'prompt must not be empty') },
      outputSchema: { reply: z.string() },
    },
    async ({ prompt }) => {
      const reply = await askGptImpl(prompt, config);
      return {
        content: [{ type: 'text', text: reply }],
        structuredContent: { reply },
      };
    }
  );

  return server;
}

export async function startMcpServer(options = {}) {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
