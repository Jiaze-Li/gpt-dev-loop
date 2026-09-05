# SuperGPT Global Installation

## Goal

One install, one frontend contract:

```text
Claude ─┐
Codex  ─┼-> same COMMON policy -> same supergpt MCP -> same SuperGPT Core
AGY    ─┘
```

The three frontends are human interfaces and launchers. They do not have separate SuperGPT routing or launch strategies.

## Install

Prerequisites: `node`, `git`, `agy`, `claude`, and `codex` are available locally.

From the SuperGPT repository:

```bash
npm run install-global
```

The installer preflights all three supported frontends before changing configuration. It then installs the same `supergpt` MCP server and the same `agent-policy/COMMON.md` behavior for each frontend.

The only internal differences are configuration mechanics required by the clients:

- AGY uses its global Gemini-compatible MCP/skill configuration directory and its auto-loaded `~/.gemini/GEMINI.md` rules file;
- Claude registers `supergpt` at user scope through Claude Code's MCP CLI;
- Codex registers `supergpt` in its global user MCP configuration through the Codex CLI.

Those are installer adapters only. The visible tool name, policy, launch sequence, and workflow semantics are identical.

## Normal frontend launch

All three frontends follow the same sequence:

```text
supergpt_route({ goal, cwd })
-> DIRECT | SUPERGPT

if SUPERGPT:
supergpt_start_and_wait({ goal, cwd })
-> terminal result / HUMAN_REQUIRED
```

`supergpt_route` is deterministic and consumes zero model tokens.
`supergpt_start_and_wait` starts the workflow and blocks locally for the
terminal result in a single call.

`supergpt_watch` / `supergpt_wait` loops are forbidden for normal autonomous
observation. They exist only for manual status checks, debugging, or recovery.

The SuperGPT CLI is not an agent fallback. If MCP is unavailable, the frontend should report the installation/configuration problem rather than silently create a second execution path.

## Check status

```bash
node bin/install-plugin.js --status
```

Expected result:

```text
SuperGPT Global Frontend Status:
  AGY:     Installed
  Claude:  Installed
  Codex:   Installed
```

After install/update, open a new Claude/Codex/AGY session so the client reloads its global policy and MCP configuration.

## Policy ownership

`agent-policy/COMMON.md` is the only active SuperGPT frontend policy in the repository.

The installer:

- inserts this exact policy into the managed SuperGPT block of `~/.claude/CLAUDE.md` (Claude's auto-loaded rules);
- inserts this exact policy into the managed SuperGPT block of `~/.codex/AGENTS.md` (Codex's auto-loaded rules);
- inserts this exact policy into the managed SuperGPT block of `~/.gemini/GEMINI.md` (AGY's auto-loaded rules), and also generates AGY's on-demand skill and MCP registration from the same file.

All three auto-loaded rule targets are checked for content consistency against `agent-policy/COMMON.md`; a target file that exists but lacks the correct managed block counts as not installed.

Unrelated personal instructions are preserved. Re-running installation replaces only the SuperGPT-managed content.

## Uninstall

```bash
npm run uninstall-global
# or
node bin/install-plugin.js --uninstall
```

Uninstall removes the SuperGPT MCP registration and SuperGPT-managed policy from all three frontends while preserving unrelated user configuration.
