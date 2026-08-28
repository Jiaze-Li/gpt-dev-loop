// Codex / OpenAI-compatible Frontend Adapter (PART 9).
//
// Bridges Codex & OpenAI-compatible agents to SuperGPT via MCP.
// Contains 0 orchestrator, task, or reviewer logic.

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

  generateCodexInstructions() {
    return `# SuperGPT Delegation for Codex

Delegate complex autonomous coding tasks to SuperGPT via its MCP tools:
- \`supergpt_plan\`: Generate plan without execution.
- \`supergpt_run\`: Execute plan in isolated worktree and deliver approved changes.
- \`supergpt_status\`: Read local progress deterministically.
- \`supergpt_resume\`: Resume on HUMAN_REQUIRED with user response.
- \`supergpt_stop\`: Abort running workflow safely.
`;
  }
}
