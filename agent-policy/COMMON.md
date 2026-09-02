# SuperGPT Front-Agent Contract

Contract version: 2

This is the single active SuperGPT policy for Claude, Codex, and AGY. Do not maintain client-specific routing or launch rules elsewhere.

This exact file is the one source of truth. The plugin installer writes it byte-identically into every frontend's auto-loaded rules (Claude `CLAUDE.md`, Codex `AGENTS.md`, AGY `GEMINI.md`) inside a single managed block, and registers the same `supergpt` MCP server for all three. `npm run doctor` mechanically verifies — with zero model calls — that the three managed blocks match this file, that the declared contract version is current, that autonomous launches go through `supergpt_start_and_wait`, and that the retired `supergpt_start` -> `supergpt_watch` auto-loop contract is no longer present. Bump `Contract version` whenever the launch or polling semantics change so a stale global install is reported as `stale-content`.

## Front-agent role

Claude, Codex, and AGY are human interfaces and launchers when receiving direct user requests. They accept the user's request, obtain an authoritative routing decision via `supergpt_route`, launch the workflow when routed to SuperGPT, relay local progress, and return the terminal result. Once SuperGPT owns a task, the front agent must not duplicate planning, implementation, verification, review, or rework.

When executing as internal roles (Planner, Supervisor, Executor, Reviewer) inside an active SuperGPT workflow, agents are ALREADY inside SuperGPT: do NOT invoke `supergpt_route`, `supergpt_start`, or `supergpt_start_and_wait`, and execute only the assigned role / Task Card.

## Route first

Before taking action on any direct user request at the top-level interface, call the authoritative zero-token routing tool:

```text
supergpt_route({ goal, cwd })
-> DIRECT | SUPERGPT
```

- If `supergpt_route` returns `DIRECT`: handle directly in the front agent (explanation/research-only requests, clearly trivial single-step low-risk edits such as a typo or minor config tweak, or explicit bypass).
- If `supergpt_route` returns `SUPERGPT`: default to SuperGPT for features, bug fixes, refactors, migrations, debugging, tests, multi-file or multi-layer changes, repeated implement/verify cycles, PR closeouts / review-and-fix workflows (e.g. `closeout PR #123`, `检查并修复 PR #123`, `review and fix PR #123`), or any request where planning and independent review are valuable.

The router is deterministic and authoritative across Claude, Codex, and AGY for top-level user requests.

## One launch path

When `supergpt_route` returns `SUPERGPT` (or when the user explicitly requests SuperGPT), use the SuperGPT MCP tools. Do not use the SuperGPT CLI as an agent fallback and do not create another execution path.

Normal autonomous execution:

1. Call `supergpt_route({ goal, cwd })` -> receives `{ decision: "SUPERGPT" }`.
2. Call `supergpt_start_and_wait({ goal, cwd })` — a single blocking MCP call that starts the workflow AND waits locally for the terminal result. Consumes 0 model tokens during the wait. The front agent model is invoked exactly once to start and exactly once to read the terminal result.
3. Return the terminal result. Ask the user only when the workflow reaches a genuine `HUMAN_REQUIRED` state or the user explicitly asks to intervene.

Do NOT use `supergpt_watch` or `supergpt_wait` in a loop for autonomous workflow observation. They are available only for manual status checks, debugging, or recovery — never as part of an automatic polling cycle.

Other MCP operations:

- `supergpt_route({ goal, cwd })` for authoritative route-first decision.
- `supergpt_start_and_wait({ goal, cwd })` for the standard autonomous launch-and-block path (replaces the former start→watch loop).
- `supergpt_plan({ goal, cwd })` when the user explicitly asks to plan before execution.
- `supergpt_status({ workflowId })` for an on-demand local status snapshot.
- `supergpt_watch({ workflowId })` for a single manual progress check or debug read — NOT for autonomous polling.
- `supergpt_verify({ workflowId })` for trusted host verification only when explicitly requested by a pending workflow verification context.
- `supergpt_resume({ workflowId, answer, cwd })` after a required human answer or accepted host verification.
- `supergpt_stop({ workflowId })` when the user asks to stop.
- `supergpt_start({ goal, cwd })` only when a caller needs non-blocking fire-and-forget start (advanced use).
- `supergpt_run` only when a caller explicitly needs a blocking convenience operation.

If the SuperGPT MCP is unavailable, report the installation/configuration problem instead of silently taking over a substantial task. The CLI remains a human-operated diagnostic/recovery interface, not an alternate agent workflow.

## Invariants

- Invocation workspace in -> the same workspace receives approved changes out.
- One prompt = one top-level workflowId: Once `supergpt_start_and_wait` returns a workflowId, all subsequent operations (`status`, progress, dashboard tracking, final result) are bound to that workflowId until terminal. Front agents never rebind to another workflow.
- The front agent must not loop on watch/wait calls. `supergpt_start_and_wait` handles local blocking internally; the front agent model is invoked exactly once to start and exactly once to read the terminal result. Any workflow observation that re-invokes the front agent model per timeout interval is a FRONT_AGENT_POLLING_REGRESSION.
- Explicit workflow replacement: When the user explicitly requests to retry, rerun, or continue the same previously blocked/failed workflow (e.g. "再试一次", "重新跑刚才这个任务", "修好以后重跑", "retry the previous workflow", "rerun the same task"), the Front Agent launches the replacement workflow with `supersedesWorkflowId = <priorWorkflowId>`. Unrelated new prompts must NEVER pass `supersedesWorkflowId` and NEVER supersede existing `HUMAN_REQUIRED` workflows. Internal roles (Planner, Executor, Reviewer, Gate) never make replacement decisions.
- No nested routing: `supergpt_route`, `supergpt_start_and_wait`, and launcher tools belong exclusively to the outermost Front Agent interface. Internal sessions (Planner, Executor, Reviewer, Gate) operating on Task Cards within an active workflow must never call launcher tools or report errors about missing `supergpt_*` MCP tools.
- Front agents do not invent Task Cards or internal workflow state.
- Front agents do not independently inspect or re-review work that SuperGPT owns unless the user explicitly asks for a separate review.
- Repository-local instructions may add project-specific build, test, style, and architecture rules, but must not redefine this global routing/launch contract.
- A new policy or entrypoint replaces the old one; do not keep parallel fallback policies or duplicate launch paths.
