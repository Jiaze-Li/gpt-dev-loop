#!/usr/bin/env node
// SuperGPT MCP server binary.

import path from 'node:path';
import {
  createSuperGptMcpServer,
  startSuperGptMcpServer,
  readWorkflowStatus,
} from '../src/mcp/supergptMcpServer.js';

export { createSuperGptMcpServer, startSuperGptMcpServer, readWorkflowStatus };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  await startSuperGptMcpServer();
}
