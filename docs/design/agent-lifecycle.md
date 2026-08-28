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

## 4. Next-Stage Design: Claude Session Manager

Goal: prevent a single Claude conversation from growing unbounded.

Current:

```
Claude session
  → Execution
  → GPT review
  → Continued repair
```

Target:

```
Claude session 1
  → Execution Report
  → GPT Review
  → Claude session 2
  → Repair
```

A Claude session should be a short-lived worker. Lifecycle management is owned by gpt-dev-loop.

## 5. Next-Stage Design: GPT Worker Window

Goal:

- An independent GPT workspace per workflow
- Does not occupy the user's foreground
- Reuses existing Chrome login state
- One workflow binds to one GPT session

## 6. Roadmap

- **Phase 1** — Real GPT reviewer closed loop (done)
- **Phase 2** — Claude Session Manager
- **Phase 3** — GPT Worker Window
- **Phase 4** — Extension auto-configuration
- **Phase 5** — Multi-workflow parallelism

## Constraints

- No changes to existing code logic
- No changes to the state machine
- No new runtime dependencies
