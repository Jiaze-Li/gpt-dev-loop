# gpt-dev-loop

Local, agent-agnostic development loop that lets a coding agent such as Claude Code implement work, push evidence to GitHub, ask an existing ChatGPT web session for review, and continue automatically until the goal is complete or human input is required.

## Why this project exists

The target workflow is simple:

1. A human and ChatGPT discuss requirements, architecture, domain semantics, and acceptance criteria.
2. The agreed plan is written into the target repository, typically as a `SPEC.md` or equivalent task document.
3. The human tells the coding agent to start.
4. The coding agent implements a bounded step, runs tests, and produces Git evidence.
5. The loop asks ChatGPT to independently inspect the repository / commit diff and review the actual changes.
6. `PASS` / `CONTINUE` leads to the next step; `REWORK` leads to another implementation pass; `DONE` ends the run; `HUMAN_REQUIRED` stops for a real product/domain decision.
7. The human receives a final report instead of manually copy-pasting prompts and review feedback between agents.

## Core design principles

- **No OpenAI API dependency for the reviewer path.** The intended reviewer transport uses the user's existing ChatGPT web session rather than the separately billed OpenAI API.
- **Mechanical handoff.** Claude ↔ ChatGPT transport should be ordinary local code, not another model, screenshots, vision, or an agent driving browser UI interactively.
- **GitHub is evidence.** ChatGPT should inspect actual repository state and diffs instead of trusting the executor's natural-language summary.
- **Human owns WHAT / WHY.** Product intent, architecture choices, domain decisions, and final acceptance stay with the human.
- **GPT owns review / planning guidance.** ChatGPT acts as high-quality planner/reviewer.
- **Coding agent owns execution.** Claude Code is the first executor; Codex and other agents should be pluggable later.
- **Local-first and portable.** The project lives in its own Git repository, keeps an independent development history, and should be installable on a new machine with minimal setup.
- **Thin adapters.** Claude-specific integration should not become the core architecture.

## Intended user experience

After initial setup, normal usage should feel like:

```text
Human + ChatGPT -> agree on SPEC.md
Human -> "execute this spec"
Claude -> implement -> test -> commit/push -> ask GPT
GPT -> inspect GitHub -> PASS / REWORK / CONTINUE / DONE / HUMAN_REQUIRED
Claude -> continue automatically
...
Claude -> final report to human
```

The user should not need to remember bridge ports, background `serve` commands, browser selectors, or special login commands during normal operation. If the ChatGPT login is missing or expired, the integration should detect that and ask for the minimum necessary intervention.

## V1 scope

V1 should deliberately stay small:

1. Provide one reliable machine-level tool, conceptually `ask_gpt(message)`, that sends text to an existing ChatGPT web session and returns the response as text.
2. Package that capability for Claude Code so it is available from the normal Claude workflow.
3. Define a development-loop skill/workflow: read spec -> implement -> test -> commit/push -> ask GPT -> continue/rework/stop.
4. Use Git commit coordinates and repository paths as the review contract so large diffs are not copied through the handoff channel.
5. Add minimal safety: retry limit, explicit stop states, Git anchors, and no completion without reviewer approval.
6. Run deterministic end-to-end pilots before adding a large state machine or orchestration framework.

## Non-goals for V1

- Rebuilding a full autonomous-agent platform.
- Reproducing all of `supergpt` immediately.
- Heavy task-card schemas before natural-language contracts prove insufficient.
- Cost dashboards, complex scheduling, or multi-agent routing before the core loop is reliable.
- Letting the coding agent visually operate ChatGPT through screenshots and mouse actions.

## Relationship to `supergpt`

`supergpt` remains an important reference implementation. This project intentionally reuses its strongest ideas—Git evidence, independent review, deterministic gates, rework loops, retry bounds, and auditability—while changing the user-facing architecture.

The key difference is control placement:

- `supergpt`: external orchestrator launches and controls both planner/reviewer and executor.
- `gpt-dev-loop`: the coding environment is the user-facing control surface, while a local core enforces the review loop and exposes a reviewer bridge.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md) for the detailed boundary.

## Planned portability

The core should remain independent of a specific coding agent:

```text
core/
bridge/
adapters/
  claude/
  codex/       # future
```

Claude Code is the first integration. A future Codex integration should reuse the same core and reviewer bridge rather than fork the project.

## Security note

This repository is public. Never commit ChatGPT cookies, browser profiles, session data, authentication tokens, API keys, private repository credentials, or other local secrets. Local auth/profile state must stay outside Git and be ignored by default.

## Status

**Design baseline / pre-implementation.** The requirements and architecture are being frozen before the first proof of concept.
