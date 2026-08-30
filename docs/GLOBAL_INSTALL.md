# SuperGPT Global Installation & Usage Guide

SuperGPT can be installed once on your system to work consistently across **any** Git repository, branch, or linked worktree.

## 1. Quick Install

From the SuperGPT repository:

```bash
npm run install-global
# or directly:
node bin/install-plugin.js
```

One install now configures the three front-agent entry points from one repository-owned policy source:

1. **AGY / Gemini-compatible frontend**
   - registers the `supergpt` MCP server in `~/.gemini/config/mcp_config.json`;
   - installs the generated SuperGPT skill in `~/.gemini/config/skills/supergpt/SKILL.md`.
2. **Claude Code**
   - installs a managed SuperGPT policy block in the user-level `~/.claude/CLAUDE.md` that Claude loads across projects.
3. **Codex**
   - installs a managed SuperGPT policy block in the user-level `~/.codex/AGENTS.md` that Codex loads across projects.

The source of truth is `agent-policy/COMMON.md`. `CLAUDE.md`, `CODEX.md`, and `AGY.md` beside it contain only frontend-specific integration details. Re-running the installer replaces only SuperGPT's managed blocks and preserves unrelated personal instructions.

Claude and Codex prefer `supergpt_*` MCP tools when already available. Their generated policy also records the absolute SuperGPT CLI path as a cross-repository fallback, so a substantial task can still be delegated instead of being silently executed by the front agent itself.

## 2. Check Installation Status

```bash
node bin/install-plugin.js --status
```

Expected output reports AGY MCP/skill plus Claude and Codex policy installation independently.

## 3. Default Delegation Policy

The same global policy is visible from Claude, Codex, and AGY in every repository:

- explanation, research, and obvious tiny single-step edits can stay with the current front agent;
- substantial coding work defaults to SuperGPT, especially features, bug fixes, refactors, migrations, multi-file work, testing/debugging, or repeated implement/verify cycles;
- when uncertain, prefer SuperGPT;
- once delegated, the front agent must not duplicate Executor or Reviewer work;
- repository-local instruction files should contain repository-specific build/test/style/architecture rules, not copies of the global SuperGPT routing policy.

V1 intentionally leaves the DIRECT vs SuperGPT judgment with the front agent. A future centralized router can replace that judgment without requiring three separate policy rewrites.

## 4. Supported Ordinary Workspaces

SuperGPT works from:
- clean workspaces;
- staged or unstaged changes;
- untracked files;
- feature branches and linked worktrees.

Invariant: **invocation workspace in → same workspace changes out.** Pre-existing changes remain the baseline and approved SuperGPT changes are delivered back to that same workspace.

## 5. Natural Language Commands

| You Say | What Happens |
| :--- | :--- |
| **"I want to implement X. Plan it first."** | Plans tasks without executing; displays task breakdown. |
| **"Looks good. Run it."** | Runs the full autonomous loop. |
| **"Use SuperGPT to implement X."** | Plans and executes end-to-end automatically. |
| **"现在做到哪了？"** | Shows compact semantic status & heartbeat with 0 model tokens. |
| **"停掉。"** | Safely aborts and terminates child processes. |
| **"继续。"** | Resumes suspended workflow with your clarification. |

## 6. Uninstalling SuperGPT

```bash
npm run uninstall-global
# or:
node bin/install-plugin.js --uninstall
```

Uninstall removes the AGY MCP/skill installation and only the marked SuperGPT blocks from Claude/Codex global instruction files. Unrelated personal instructions are preserved.
