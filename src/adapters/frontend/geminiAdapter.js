// Gemini / Antigravity Frontend Adapter (PART 8).
//
// Bridges Google Gemini / Antigravity IDE & CLI to SuperGPT via MCP and Skill definitions.
// Contains 0 orchestrator, task, or reviewer logic.

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

  generateSkillDefinition() {
    return `---
name: supergpt
description: Delegate a coding task to SuperGPT, an autonomous Supervisor→Executor→Reviewer development loop that runs in an isolated worktree and delivers reviewed changes back to the workspace. Use when the user wants a feature built, a bug fixed, or a refactor done end-to-end without step-by-step guidance — and let SuperGPT run without micromanaging it.
---

# SuperGPT

SuperGPT is an autonomous development loop. You hand it a goal; it plans,
implements, verifies, and self-reviews inside an isolated git worktree, then
safely delivers the approved changes back to the invocation workspace. Your
job as the front-facing agent is to **launch it, monitor it, and relay
results** — not to drive each step.

## Hard Invariants

1. **Invocation workspace in → same workspace changes out**: Always pass the user's current working directory as \`cwd\` to \`supergpt_plan\`, \`supergpt_run\`, \`supergpt_status\`, etc.
2. **Never duplicate worker effort**: Do NOT reread the entire repository, redo Reviewer code reviews, or re-implement Claude's tasks in the front agent.
3. **Zero model tokens for monitoring**: Heartbeat, status queries, and wait mechanisms read local disk state. Never ask an LLM "are you still working?".

## Natural Language Front-Agent Behavior

| User Says | Front Agent Action |
| --- | --- |
| *"I want to implement X. Plan it first."* / *"先规划一下"* | Call \`supergpt_plan({ goal, cwd })\`. Show the concise plan summary and tasks. |
| *Normal autonomous chat/frontend execution* | Call \`supergpt_start({ goal, cwd })\` to receive \`workflowId\`, then immediately call \`supergpt_watch({ workflowId })\` to display live streaming progress until terminal. Do not repeatedly call \`supergpt_status\`. |
| *"Looks good. Run it."* / *"可以，开始跑"* | Call \`supergpt_start({ goal, cwd })\`, then immediately attach \`supergpt_watch({ workflowId })\` until terminal. |
| *"Use SuperGPT to implement X"* / *"用 SuperGPT 实现 X"* | If sufficiently clear, call \`supergpt_start({ goal, cwd })\`, then immediately attach \`supergpt_watch({ workflowId })\` until terminal. |
| *"现在做到哪了？"* / *"What's the status?"* | Call \`supergpt_status({ workflowId })\`. Output the on-demand snapshot without LLM calls. |
| *"停掉。"* / *"Stop it."* | Call \`supergpt_stop({ workflowId })\`. Confirm safe termination. |
| *"继续。"* / *"Resume."* | Call \`supergpt_resume({ workflowId, answer, cwd })\`. |

### Handling HUMAN_REQUIRED

When SuperGPT encounters a genuine human question, it halts safely and returns \`status: "HUMAN_REQUIRED"\` with \`question\` and \`reason\`.

1. **Present the question verbatim**:
   \`\`\`
   SuperGPT needs one decision:
   <question>
   \`\`\`
2. **Wait for user answer**: Do not guess or make architectural decisions on the user's behalf.
3. **Resume the workflow**:
   Call \`supergpt_resume({ workflowId, answer: "<user_answer>", cwd })\`. The exact same worktree, state, and conversations will resume automatically.

## Tool return behavior

- \`supergpt_start\` is the normal non-blocking entrypoint and returns exactly \`{ status: "RUNNING", workflowId }\`.
- \`supergpt_watch\` is the long-running local watcher tool that streams live progress updates via MCP notifications until terminal.
- \`supergpt_run\` is a blocking convenience API for callers that explicitly want one call to wait for the full terminal result.
`;
  }
}
