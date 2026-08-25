# Agent Lifecycle — Current State & Next-Stage Design

## 1. Current Capabilities

gpt-dev-loop currently has the following working end-to-end:

- Task Card
- Workflow state machine
- Claude execution
- GPT reviewer
- Chrome extension bridge
- Real Chrome + ChatGPT login-state closed-loop validation

Current flow:

```
PENDING
  → EXECUTING
  → VERIFYING
  → REVIEWING
  → COMPLETE
```

## 2. Current Architecture

gpt-dev-loop is a locally-run control program.

It is responsible for:

- Workflow management
- State transitions
- Dispatching the Claude executor
- Dispatching the GPT reviewer

```
gpt-dev-loop
    |
    +-- Claude Executor
    |       |
    |       +-- Claude Code
    |
    +-- GPT Reviewer
            |
            +-- Chrome Extension
                    |
                    +-- ChatGPT Web
```

## 3. Architecture Principles

- Claude and GPT do not communicate directly.
- All agent interaction passes through gpt-dev-loop.
- The Chrome extension is only a communication adapter for the GPT reviewer.
- Claude plugins/MCP (if present) are responsible only for capability access, not lifecycle management.

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
