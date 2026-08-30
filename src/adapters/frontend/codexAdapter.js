// Codex frontend transport adapter.
// Client-specific responsibility is limited to MCP configuration mechanics.
// Shared routing and launch behavior lives only in agent-policy/COMMON.md.

import { BaseFrontendAdapter } from './baseFrontendAdapter.js';

export class CodexFrontendAdapter extends BaseFrontendAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'codex' });
  }

  generateMcpConfig({ nodePath = process.execPath || 'node', mcpBinPath } = {}) {
    if (!mcpBinPath) throw new Error('CodexFrontendAdapter requires mcpBinPath');
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
