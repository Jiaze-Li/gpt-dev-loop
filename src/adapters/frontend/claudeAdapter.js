// Claude Code / Claude Desktop Frontend Adapter (PART 9).
//
// Bridges Anthropic Claude Code & Claude Desktop to SuperGPT via MCP.
// Contains 0 orchestrator, task, or reviewer logic.

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

  generateClaudeInstructions() {
    return `# SuperGPT Integration for Claude Code

When the user asks to use SuperGPT (e.g. "Use SuperGPT to build X" or "Plan X with SuperGPT"):

1. Use the \`supergpt_plan\` tool to create a structured plan first if the user requested planning.
2. For normal autonomous execution, use \`supergpt_start({ goal, cwd })\`. It immediately returns \`{ status: "RUNNING", workflowId }\`; attach local progress observation and continue until terminal.
3. Use \`supergpt_status\` to check progress without calling external LLMs.
4. If SuperGPT returns \`HUMAN_REQUIRED\`, ask the user the exact question and call \`supergpt_resume\` with their answer.
5. Never micromanage SuperGPT or duplicate reviewer/worker logic.

\`supergpt_run\` is only a blocking convenience API for callers that explicitly want one call to wait for the full terminal result.
`;
  }
}
