// Claude frontend transport adapter.
// Client-specific responsibility is limited to MCP configuration mechanics.
// Shared routing and launch behavior lives only in agent-policy/COMMON.md.

import { BaseFrontendAdapter } from './baseFrontendAdapter.js';

export class ClaudeFrontendAdapter extends BaseFrontendAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'claude' });
  }

  generateMcpConfig({ nodePath = process.execPath || 'node', mcpBinPath } = {}) {
    if (!mcpBinPath) throw new Error('ClaudeFrontendAdapter requires mcpBinPath');
    return {
      mcpServers: {
        supergpt: {
          command: nodePath,
          args: [mcpBinPath],
        },
      },
    };
  }
}
