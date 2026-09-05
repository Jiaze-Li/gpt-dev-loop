#!/usr/bin/env node
// SuperGPT MCP server binary.

import path from 'node:path';
import {
  createSuperGptMcpServer,
  startSuperGptMcpServer,
  readWorkflowStatus,
  checkPollingRegression,
  FRONT_AGENT_CONTRACT_VERSION,
} from '../src/mcp/supergptMcpServer.js';

export {
  createSuperGptMcpServer,
  startSuperGptMcpServer,
  readWorkflowStatus,
  checkPollingRegression,
  FRONT_AGENT_CONTRACT_VERSION,
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  await startSuperGptMcpServer();
}
