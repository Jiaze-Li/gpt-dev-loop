# SuperGPT Global Installation & Usage Guide

SuperGPT can be installed once on your system to work seamlessly across **any** Git repository, branch, or linked worktree.

---

## 1. Quick Install

From the SuperGPT repository:

```bash
npm run install-global
# or directly:
node bin/install-plugin.js
```

This performs two automatic configurations:
1. Registers the `supergpt` MCP server in your global configuration (`~/.gemini/config/mcp_config.json`).
2. Copies the SuperGPT Skill to `~/.gemini/config/skills/supergpt/SKILL.md`.

---

## 2. Check Installation Status

```bash
node bin/install-plugin.js --status
```

Expected output:
```text
SuperGPT Global Installation Status:
  Config Dir:      ~/.gemini/config
  MCP Server:      Installed (/path/to/supergpt/bin/supergpt-mcp.js)
  Skill (Global):  Installed (~/.gemini/config/skills/supergpt/SKILL.md)
```

---

## 3. How to Use SuperGPT in Any Project

Once installed, open Antigravity (or Gemini front agent) in **any Git repository**:

```text
User: "Use SuperGPT to add an authentication middleware."
```

### Supported Ordinary Workspaces
SuperGPT works automatically in any state:
- Clean workspace
- Staged changes
- Unstaged changes
- Untracked files
- Feature branches & linked worktrees

### Invariant:
**Invocation workspace in → same workspace changes out.**
Pre-existing uncommitted changes in your workspace are preserved as the baseline. Approved changes are delivered directly back to your workspace.

---

## 4. Natural Language Commands

| You Say | What Happens |
| :--- | :--- |
| **"I want to implement X. Plan it first."** | Plans tasks without executing; displays task breakdown. |
| **"Looks good. Run it."** | Runs the full autonomous loop. |
| **"Use SuperGPT to implement X."** | Plans and executes end-to-end automatically. |
| **"现在做到哪了？"** | Shows compact semantic status & heartbeat with 0 model tokens. |
| **"停掉。"** | Safely aborts and terminates child processes. |
| **"继续。"** | Resumes suspended workflow with your clarification. |

---

## 5. Uninstalling SuperGPT

To cleanly remove the global registration:

```bash
npm run uninstall-global
# or:
node bin/install-plugin.js --uninstall
```
