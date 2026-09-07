// Deterministic provisioning of a dedicated, isolated AGY custom agent used
// ONLY by ReviewLoop's independent Reviewer / Supervisor AGY transports.
//
// Why: AGY's ambient/default agent inherits the user's skills, rules, plugins,
// subagents and MCP servers. For a narrow single-turn review that context is
// pure tax (the live agy:gemini Supervisor was seen carrying ~38.9k input
// tokens — the full default agent). A Markdown custom agent with
// `inheritCustomizations: false` adopts NONE of those ambient customizations.
//
// Where it goes: agy 1.1.27 does NOT discover custom agents from a workspace
// `.agents/agents/<name>/agent.md` — a `--agent` that cannot be resolved
// silently falls back to the default agent. agy DOES discover agents from its
// gemini-dir config tree (`<geminiDir>/config/agents/<name>/agent.md`). The real
// `~/.gemini` is off-limits, so the transport points agy at a redirected,
// isolated gemini dir (`narrowAgyGeminiDir()`, passed via `--gemini_dir`) and
// this module provisions the agent there. Whether agy then actually loads it is
// verified separately — see agyCustomAgentCapability.js.
//
// Boundaries (hard):
//   - The agent is written ONLY under the caller-supplied isolated gemini dir.
//   - It never writes or modifies the user's real `~/.gemini`, `~/.config`,
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

// Relative to the isolated gemini dir. agy discovers agents under its
// config tree; `config/agents/<name>/agent.md` is the canonical location
// (confirmed against agy 1.1.27: the agent's frontmatter `name:` is the
// resolution key, and activation is logged as "agent=true").
export const MINIMAL_AGY_AGENT_RELATIVE_PATH = path.join(
  'config', 'agents', MINIMAL_AGY_AGENT_NAME, 'agent.md',
);

// The exact agent definition. `inheritCustomizations: false` is the single
// switch that drops ambient skills / rules / plugins / subagents / MCP; the
// empty explicit lists and `inheritMcp: false` are belt-and-suspenders for
// versions that read them independently.
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
 * Deterministically write
 * `<geminiDir>/config/agents/reviewloop-minimal/agent.md`.
 *
 * @param {object} opts
 * @param {string} opts.geminiDir  isolated gemini dir root (required)
 * @param {object} [opts.fs] injectable { mkdirSync, readFileSync, writeFileSync }
 * @returns {{ name: string, path: string, relativePath: string, wrote: boolean }}
 * @throws {MinimalAgyAgentProvisionError} on ANY failure — the caller MUST fail
 *   closed (mark the AGY families unavailable) rather than fall back to the
 *   ambient default agent.
 */
export function provisionMinimalAgyAgent({
  geminiDir,
  fs = { mkdirSync, readFileSync, writeFileSync },
} = {}) {
  if (typeof geminiDir !== 'string' || geminiDir.trim() === '') {
    throw new MinimalAgyAgentProvisionError('provisionMinimalAgyAgent requires a non-empty geminiDir');
  }
  const resolvedRoot = path.resolve(geminiDir);
  const home = path.resolve(os.homedir());

  if (resolvedRoot === home) {
    throw new MinimalAgyAgentProvisionError(`refusing to provision into HOME itself: ${resolvedRoot}`);
  }
  for (const seg of ['.gemini', '.config', '.antigravity']) {
    const protectedRoot = path.join(home, seg);
    if (isInside(protectedRoot, resolvedRoot)) {
      throw new MinimalAgyAgentProvisionError(
        `refusing to provision inside a protected config tree (${protectedRoot}): ${resolvedRoot}`,
      );
    }
  }

  const agentDir = path.join(resolvedRoot, 'config', 'agents', MINIMAL_AGY_AGENT_NAME);
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
