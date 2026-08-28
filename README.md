# SuperGPT (gpt-dev-loop)

Autonomous multi-role coding engine coordinating **Gemini Supervisor**, **Claude Executor**, and **GPT-OSS Reviewer** with complete Git worktree isolation, automated verification gates, and safe automatic result delivery.

> **"Normal coding UX, larger autonomous scope."**  
> Run in any repository or linked worktree: provide natural-language instructions, and SuperGPT plans, isolates, executes, tests, reviews, and delivers verified changes back to your workspace.

---

## High-Level Architecture

```text
User Request / Front-Facing Agent
           │
           ▼
    Natural Language Planner (Gemini via agy)
           │
           ▼
    Invocation Workspace Snapshot (HEAD, staged, unstaged, untracked)
           │
           ▼
    Isolated Git Worktree Sandbox (~/.supergpt/worktrees)
           │
           ├──► Supervisor [gemini-3.7-flash-high] (Persistent workflow conversation)
           │          │ (Task Cards)
           │          ▼
           ├──► Executor [Claude Code] (Fresh session per attempt)
           │          │ (Code Edits)
           │          ▼
           ├──► Verification Gate [Shell / npm test] (Bounded diagnostics)
           │          │ (Git Evidence)
           │          ▼
           └──► Reviewer [gpt-oss-120b-medium] (Persistent per-task conversation)
                      │ (PASS / REWORK / HUMAN_REQUIRED)
                      ▼
    Safe Automatic Result Delivery (Pre-flight conflict check & verification)
           │
           ▼
Invocation Workspace (Approved changes applied, worktree cleaned up)
```

---

## Features

- **Autonomous Multi-Role Loop**:
  - **Supervisor**: Gemini 3.7 Flash High plans tasks, tracks progression, handles rework requests, and surfaces real domain ambiguities as `HUMAN_REQUIRED`.
  - **Executor**: Claude Code executes task cards in clean worktrees with automatically symlinked dependencies.
  - **Reviewer**: GPT-OSS 120B Medium independently audits Git diffs and gate verification evidence.
- **Persistent Role Conversations**: Single conversation ID maintained for the Supervisor across the entire workflow; per-task conversation IDs maintained across Reviewer rework rounds.
- **Workspace Snapshotting**: Operates cleanly on dirty workspaces with untracked files without requiring `git stash` or manual commits. Pre-existing changes become the baseline and are never misclassified as model output.
- **Safe Automatic Result Delivery**: Approved changes are delivered directly into the exact invocation workspace with atomic conflict detection. Unrelated dirty changes are preserved.
- **Worktree Lifecycle**: Successfully delivered worktrees are pruned automatically; failed or `HUMAN_REQUIRED` runs are preserved for auditing and resumption.
- **Multiple Front-End Surfaces**:
  - **CLI**: `bin/supergpt.js "<goal>"` supporting text or streaming JSON (`--output-format=json`).
  - **Antigravity Skill**: `.agents/skills/supergpt/SKILL.md` for AI pair programmers.
  - **MCP Server**: `bin/supergpt-mcp.js` exposing `supergpt_run`, `supergpt_plan`, and `supergpt_status`.

---

## Quickstart

### 1. Check Prerequisites
Run the built-in diagnostic doctor:
```bash
npm run doctor
```
Verifies local availability of:
- `git` (system version)
- `node` (>= 18)
- `agy` CLI (Google Antigravity CLI, authenticated)
- `claude` (Claude Code CLI)

### 2. Run Tests
Run the deterministic unit test suite (700 tests):
```bash
npm test
```

### 3. CLI Usage

Run a coding task from natural language:
```bash
node bin/supergpt.js "Add a healthcheck endpoint with unit tests"
```

Stream machine-readable typed events (NDJSON):
```bash
node bin/supergpt.js "Add a healthcheck endpoint with unit tests" --output-format=json
```

Run from an explicit plan file:
```bash
node bin/supergpt.js --plan=plan.txt
```

---

## Machine-Readable Event Stream

When invoked with `--output-format=json`, SuperGPT streams typed events:
- `workflow_started`
- `stage_changed` (`workspace`, `planning`, `executing`, `supervisor`, `delivery`)
- `task_started` / `task_attempt_started`
- `verification_started` / `verification_finished`
- `review_finished` (`PASS`, `REWORK`, `HUMAN_REQUIRED`)
- `rework_requested`
- `delivery_succeeded` / `delivery_failed`
- `workflow_finished`

---

## Project Structure

- `bin/`
  - `supergpt.js`: Production CLI entrypoint.
  - `supergpt-mcp.js`: Model Context Protocol (MCP) server.
- `src/`
  - `orchestrator/`: Core state machine, planner, workspace snapshotting, result delivery, and persistent sessions.
  - `agy/`: Headless Antigravity CLI client with fail-closed conversation resumption.
  - `adapters/`: Gate runner, git evidence collector, and executor adapters.
  - `legacy/` (deprecated): Historical Chrome extension bridge and web automation transports.
- `skills/` / `.agents/skills/supergpt/`: Antigravity Skill definition.
- `tests/`: 700 deterministic unit tests across all subsystem boundaries.

---

## License

MIT
