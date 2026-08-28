# Agent Lifecycle — SuperGPT V1 Architecture

## 1. Capabilities

SuperGPT orchestrates an autonomous multi-role loop:

- Natural Language Planner (RolePool)
- Task Cards & Execution Reports
- Isolated Git worktrees
- Role-routed Executor (Claude / Codex)
- Deterministic Gate Runner & Git Evidence Collector
- Role-routed Reviewer (agy Gemini / Claude / Codex)
- Safe automatic result delivery

## 2. Current Architecture

```
SuperGPT Orchestrator / MCP Control Plane
    │
    ├──► Planner (RolePool: Codex / Gemini / Claude)
    ├──► Supervisor (RolePool: Gemini / Codex / Claude)
    ├──► Executor (RolePool: Claude Sonnet/Opus / Codex)
    ├──► Verification Gate (Shell / npm test)
    └──► Reviewer (RolePool: Gemini / Codex / Claude)
```

## 3. Role Lifecycles

- **Planner**: Generates structured Task Cards from goals or plans.
- **Supervisor**: Tracks task progression and evaluates loop state; uses compact checkpoints for logical continuity.
- **Executor**: Executes task cards in isolated Git worktrees (`~/.supergpt/worktrees`) with fresh session per attempt.
- **Reviewer**: Evaluates gate evidence and git diffs per attempt; returns machine-parseable `PASS`, `REWORK`, or `HUMAN_REQUIRED`.
- **Delivery**: Performs conflict checks and applies verified changes back to the invocation workspace.
