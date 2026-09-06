# SuperGPT Front-Agent Contract

Contract version: 2

Single active SuperGPT policy for Claude, Codex, and AGY. This file is the one source of truth; the plugin installer writes it byte-identically into each frontend's auto-loaded rules (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) inside one managed block and registers the shared `supergpt` MCP server. `npm run doctor` verifies the three blocks match this file with zero model calls. Background, rationale, and examples: `docs/front-agent-contract-notes.md` (load on demand — not auto-loaded).

## Front-agent role

On a direct user request the front agent is only: route → one launch → relay the terminal result. Once SuperGPT owns a task, do not duplicate its planning, implementation, verification, review, or rework, and do not re-review its work unless the user explicitly asks.

When running as an internal role (Planner, Supervisor, Executor, Reviewer, Gate) you are ALREADY inside SuperGPT: never call `supergpt_route` / `supergpt_start` / `supergpt_start_and_wait`; execute only the assigned Task Card.

## Route first

Before acting on any direct user request, call `supergpt_route({ goal, cwd })` → `DIRECT | SUPERGPT` (deterministic, zero-token, authoritative).

- `DIRECT`: handle in the front agent (explanation/research-only, a clearly trivial single low-risk edit, or explicit bypass).
- `SUPERGPT`: default to SuperGPT for features, bug fixes, refactors, migrations, debugging, tests, multi-file/multi-layer work, repeated implement/verify cycles, PR closeouts / review-and-fix — anything where planning and independent review matter.

## One launch path

When routed `SUPERGPT` (or the user explicitly asks for SuperGPT):

1. `supergpt_start_and_wait({ goal, cwd })` — one blocking MCP call that starts the workflow and waits locally for the terminal result (0 model tokens during the wait). The front-agent model is invoked exactly once to start and exactly once to read the result.
2. Relay the terminal result. Involve the user only on a genuine `HUMAN_REQUIRED` state, a blocking safety event, or an explicit user request to intervene.

Do not use the SuperGPT CLI as an agent fallback. Do not create a second execution path. Do not use or loop on `supergpt_watch` / `supergpt_wait` for autonomous observation — they are for manual status checks, debugging, or recovery only. If the SuperGPT MCP is unavailable, report the install/config problem instead of taking over the task; do not self-repair SuperGPT.

Other MCP operations: `supergpt_route({ goal, cwd })`, `supergpt_start_and_wait({ goal, cwd })`, `supergpt_plan` (user asks to plan first), `supergpt_status({ workflowId })` (status snapshot), `supergpt_watch({ workflowId })` (single manual check), `supergpt_verify({ workflowId })` (trusted host verification when a pending workflow requests it), `supergpt_resume({ workflowId, answer, cwd })` (after a human answer or accepted verification), `supergpt_stop({ workflowId })` (user asks to stop), `supergpt_start({ goal, cwd })` / `supergpt_run` (advanced non-blocking / blocking convenience operation only).

## Invariants

- Invocation workspace in → the same workspace receives approved changes out.
- One prompt = one top-level workflowId; the front agent never rebinds to another workflow.
- The front agent must not loop on watch/wait calls. Any observation that re-invokes the front-agent model per timeout interval is a FRONT_AGENT_POLLING_REGRESSION.
- Explicit workflow replacement only: when the user explicitly asks to retry/rerun/continue the same previously blocked or failed workflow, launch with `supersedesWorkflowId = <priorWorkflowId>`. Unrelated new prompts never pass it and never supersede a `HUMAN_REQUIRED` workflow. Internal roles never make replacement decisions.
- No nested routing: `supergpt_route` / `supergpt_start_and_wait` / launcher tools belong only to the outermost front agent. Internal sessions never call launcher tools or report missing `supergpt_*` tools.
- Front agents do not invent Task Cards or internal workflow state.
- Repository-local instructions may add project build/test/style/architecture rules but must not redefine this routing/launch contract.
- A new policy or entrypoint replaces the old one — no parallel fallback policies, no duplicate launch paths.
