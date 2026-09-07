// Deterministic provisioning of a dedicated, workspace-local AGY custom agent
// used ONLY by ReviewLoop's independent Reviewer / Supervisor AGY transports.
//
// Why: AGY's ambient/default agent inherits the user's skills, rules, plugins,
// subagents and MCP servers. For a narrow single-turn review that context is
// pure tax (the live agy:gemini Supervisor was seen carrying ~150k input +
// ~657k cache-read tokens). A Markdown custom agent with
// `inheritCustomizations: false` adopts NONE of those ambient customizations
// (agy >= 1.1.22; confirmed against agy 1.1.27 `--help` / changelog and the
// on-disk `agy-customizations` guide + a real `agent.md` example).
//
// Boundaries (hard):
//   - The agent is written ONLY under the caller-supplied scratch workspace
//     (`narrowReviewTransportCwd()`), i.e. AGY's workspace customization root
//     `<cwd>/.agents/agents/<name>/agent.md`.
//   - It never writes or modifies the user's `~/.gemini`, `~/.config`,
//     `~/.antigravity`, AGY global settings / MCP config, or any pre-existing
//     user agents / skills / plugins / rules. `provisionMinimalAgyAgent` refuses
//     to run if its target resolves into HOME or a known global-config tree.
//   - No model call, no network. Pure filesystem.
//
// Idempotent: the file is rewritten only when its content differs, then
// re-read and verified before success is reported.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const MINIMAL_AGY_AGENT_NAME = 'reviewloop-minimal';

// Relative to the scratch workspace root. AGY discovers workspace customizations
// under `.agents/` (also `.agent/`, `_agents/`, `_agent/`); agents live at
// `agents/<name>/agent.md` within that root.
export const MINIMAL_AGY_AGENT_RELATIVE_PATH = path.join(
  '.agents', 'agents', MINIMAL_AGY_AGENT_NAME, 'agent.md',
);

// The exact agent definition. Frontmatter fields are all confirmed present in
// the installed agy binary's `customizations.AgentFrontmatter` struct:
//   name, description, inheritCustomizations, inheritMcp, mainAgent, subagent,
//   hidden, tools, skills, agents, plugins, rules, model, commandExecutionPolicy
// `inheritCustomizations: false` is the single switch that drops ambient
// skills / rules / plugins / subagents / MCP; the empty explicit lists and
// `inheritMcp: false` are belt-and-suspenders for versions that read them
// independently.
export const MINIMAL_AGY_AGENT_MARKDOWN = `---
name: ${MINIMAL_AGY_AGENT_NAME}
description: >-
  ReviewLoop isolated Reviewer/Supervisor transport agent. Single-turn,
  stateless, no tools, no ambient customizations. Not for interactive use.
inheritCustomizations: false
inheritMcp: false
mainAgent: true
subagent: false
hidden: true
tools: []
skills: []
agents: []
plugins: []
rules: []
---

# ${MINIMAL_AGY_AGENT_NAME}

You are a stateless, single-turn JSON responder used only by ReviewLoop's
independent Reviewer and Supervisor.

Rules:
- Do not call any tool. Do not read repository or workspace files.
- Do not resume or reference any prior conversation.
- Use only the information contained in the prompt you were given.
- Reply with exactly the JSON object the prompt asks for and nothing else.
`;

export class MinimalAgyAgentProvisionError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MinimalAgyAgentProvisionError';
    this.code = 'AGY_MINIMAL_AGENT_PROVISION_FAILED';
  }
}

// True when `target` is `root` itself or lives underneath it.
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Deterministically write `<cwd>/.agents/agents/reviewloop-minimal/agent.md`.
 *
 * @param {object} opts
 * @param {string} opts.cwd  isolated scratch workspace root (required)
 * @param {object} [opts.fs] injectable { mkdirSync, readFileSync, writeFileSync }
 * @returns {{ name: string, path: string, relativePath: string, wrote: boolean }}
 * @throws {MinimalAgyAgentProvisionError} on ANY failure — the caller MUST fail
 *   closed (mark the AGY families unavailable) rather than fall back to the
 *   ambient default agent.
 */
export function provisionMinimalAgyAgent({
  cwd,
  fs = { mkdirSync, readFileSync, writeFileSync },
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new MinimalAgyAgentProvisionError('provisionMinimalAgyAgent requires a non-empty cwd');
  }
  const resolvedCwd = path.resolve(cwd);
  const home = path.resolve(os.homedir());

  if (resolvedCwd === home) {
    throw new MinimalAgyAgentProvisionError(`refusing to provision into HOME itself: ${resolvedCwd}`);
  }
  for (const seg of ['.gemini', '.config', '.antigravity']) {
    const protectedRoot = path.join(home, seg);
    if (isInside(protectedRoot, resolvedCwd)) {
      throw new MinimalAgyAgentProvisionError(
        `refusing to provision inside a protected config tree (${protectedRoot}): ${resolvedCwd}`,
      );
    }
  }

  const agentDir = path.join(resolvedCwd, '.agents', 'agents', MINIMAL_AGY_AGENT_NAME);
  const agentFile = path.join(agentDir, 'agent.md');

  try {
    let current = null;
    try { current = fs.readFileSync(agentFile, 'utf8'); } catch { current = null; }

    let wrote = false;
    if (current !== MINIMAL_AGY_AGENT_MARKDOWN) {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(agentFile, MINIMAL_AGY_AGENT_MARKDOWN, 'utf8');
      wrote = true;
    }

    const verify = fs.readFileSync(agentFile, 'utf8');
    if (verify !== MINIMAL_AGY_AGENT_MARKDOWN) {
      throw new Error('post-write content verification mismatch');
    }

    return {
      name: MINIMAL_AGY_AGENT_NAME,
      path: agentFile,
      relativePath: MINIMAL_AGY_AGENT_RELATIVE_PATH,
      wrote,
    };
  } catch (err) {
    if (err instanceof MinimalAgyAgentProvisionError) throw err;
    throw new MinimalAgyAgentProvisionError(
      `could not provision ${agentFile}: ${err.message}`,
      { cause: err },
    );
  }
}
