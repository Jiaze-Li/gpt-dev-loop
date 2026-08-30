// Generic Frontend Adapter for any standard CLI or agent.

import { BaseFrontendAdapter } from './baseFrontendAdapter.js';

export class GenericFrontendAdapter extends BaseFrontendAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'generic' });
  }

  generateConfig({ mcpBinPath = 'bin/supergpt-mcp.js' } = {}) {
    return {
      mcpServers: {
        supergpt: {
          command: 'node',
          args: [mcpBinPath],
        },
      },
    };
  }
}
