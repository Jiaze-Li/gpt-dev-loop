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
- \`supergpt_start\`: Normal non-blocking entrypoint. Call \`supergpt_start({ goal, cwd })\`; it immediately returns \`{ status: "RUNNING", workflowId }\`. Then immediately attach \`supergpt_watch({ workflowId })\` to stream progress until terminal.
- \`supergpt_watch\`: Watch active workflow locally with live streaming MCP progress notifications until terminal (0 model tokens).
- \`supergpt_run\`: Blocking convenience API for callers that explicitly want one call to wait for the full terminal result.
- \`supergpt_status\`: Read local on-demand progress snapshot deterministically.
- \`supergpt_resume\`: Resume on HUMAN_REQUIRED with user response.
- \`supergpt_stop\`: Abort running workflow safely.
`;
  }
}
