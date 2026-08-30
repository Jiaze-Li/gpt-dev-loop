// Gemini / Antigravity frontend transport adapter.
// Client-specific responsibility is limited to MCP configuration mechanics.
// Shared routing and launch behavior lives only in agent-policy/COMMON.md.

import { BaseFrontendAdapter } from './baseFrontendAdapter.js';

export class GeminiFrontendAdapter extends BaseFrontendAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'gemini' });
  }

  generateMcpConfig({ nodePath = process.execPath || 'node', mcpBinPath } = {}) {
    if (!mcpBinPath) throw new Error('GeminiFrontendAdapter requires mcpBinPath');
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
