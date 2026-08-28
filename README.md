# SuperGPT (gpt-dev-loop)

Autonomous multi-role coding engine with role-routed Planner, Supervisor,
Executor, and Reviewer providers; complete Git worktree isolation;
deterministic verification gates; and safe automatic result delivery.

> **"Normal coding UX, larger autonomous scope."**  
> Run in any repository or linked worktree: provide natural-language instructions, and SuperGPT plans, isolates, executes, tests, reviews, and delivers verified changes back to your workspace.

---

## High-Level Architecture

```text
User Request / Front-Facing Agent
           │
           ▼
    Natural Language Planner (RolePool)
           │
           ▼
    Invocation Workspace Snapshot (HEAD, staged, unstaged, untracked)
           │
           ▼
    Isolated Git Worktree Sandbox (~/.supergpt/worktrees)
           │
           ├──► Supervisor RolePool (Persistent workflow conversation)
           │          │ (Task Cards)
           │          ▼
           ├──► Executor RolePool (Fresh session per attempt)
           │          │ (Code Edits)
           │          ▼
           ├──► Verification Gate [Shell / npm test] (Bounded diagnostics)
           │          │ (Git Evidence)
           │          ▼
           └──► Reviewer RolePool (Persistent per-task conversation)
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
  - **RolePools and failover**: Planner, Supervisor, Executor, and Reviewer are routed independently through provider health, quota, and effort policies.
  - **Supervisor**: Tracks tasks, handles rework requests, and surfaces real domain ambiguities as `HUMAN_REQUIRED`.
  - **Executor and Reviewer**: Execute task cards in clean worktrees and independently audit Git diffs plus Gate evidence.
- **Persistent Role Conversations**: Single conversation ID maintained for the Supervisor across the entire workflow; per-task conversation IDs maintained across Reviewer rework rounds.
- **Workspace Snapshotting**: Operates cleanly on dirty workspaces with untracked files without requiring `git stash` or manual commits. Pre-existing changes become the baseline and are never misclassified as model output.
- **Safe Automatic Result Delivery**: Approved changes are delivered directly into the exact invocation workspace with atomic conflict detection. Unrelated dirty changes are preserved.
- **Worktree Lifecycle**: Successfully delivered worktrees are pruned automatically; failed or `HUMAN_REQUIRED` runs are preserved for auditing and resumption.
- **Human-visible progress**: Frontend observers show task, attempt, stage, active role/provider, Gate/Reviewer state, and terminal status without model calls.
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
- `node` (>= 20)
- `agy` CLI (Google Antigravity CLI, authenticated)
- `claude` (Claude Code CLI)

### 2. Run Tests
Run the deterministic unit test suite (802 tests):
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
  - `orchestrator/`: Core state machine, RolePools, provider routing, workspace snapshotting, result delivery, and persistent sessions.
  - `agy/`: Headless Antigravity CLI client with fail-closed conversation resumption.
  - `adapters/`: Gate runner, git evidence collector, and executor adapters.
  - `bridge/` and `extension/`: Historical Chrome/browser bridge code, retained only as legacy source and not exposed by production entrypoints.
- `skills/` / `.agents/skills/supergpt/`: Antigravity Skill definition.
- `tests/`: 802 deterministic unit tests across all subsystem boundaries.

---

## License

MIT
