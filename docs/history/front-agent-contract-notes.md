# Front-Agent Contract — background notes

On-demand companion to `agent-policy/COMMON.md`. This file is **not** auto-loaded
into any frontend; read it when you need the reasoning or worked examples behind
a contract rule. The normative rules live in `COMMON.md` and nowhere else.

## Why route-first is a separate deterministic tool

`supergpt_route` is a zero-token, deterministic classifier shared by Claude,
Codex, and AGY so the launch decision is identical regardless of which frontend
received the request. It removes per-frontend heuristics and keeps the "when do
we escalate to the full workflow" judgement in one audited place.

- `DIRECT` examples: "what does this function do?", "fix this typo", "bump the
  timeout constant", "explain the failure in this log".
- `SUPERGPT` examples: "add pagination to the results endpoint", "fix the race
  in the cache", "migrate the config loader to the new schema", "closeout PR
  #123", "review and fix PR #123", "檢查並修復 PR #123".

## Why exactly one launch path

The retired contract was `supergpt_start` followed by a client-side
`supergpt_watch` / `supergpt_wait` loop. Every poll re-invoked the front-agent
model, so a long workflow burned front-agent tokens proportional to its wall
time. `supergpt_start_and_wait` blocks locally and consumes zero model tokens
during the wait; the front-agent model runs exactly twice per workflow (start,
read result). Any design that re-invokes the front-agent model per interval is a
`FRONT_AGENT_POLLING_REGRESSION` and is projected as a WARNING safety event.

## Terminal result projection

`supergpt_start_and_wait` returns only what the front agent needs to relay:
`status`, `stage`, `workflowId`, `path`, `summary`, `reason`, `question`,
`deliveredFiles`, `safetyEvents`, `blockingSafetyEvent`. On `HUMAN_REQUIRED` the
`reason` / `question` carry enough to act on. Verbose progress, evidence bundles,
and internal accounting stay in persisted workflow state and are reachable via
`supergpt_status` / `supergpt_telemetry` / the dashboard when explicitly needed —
they are deliberately kept out of the default terminal payload.

## Workflow replacement

`supersedesWorkflowId` is only for an explicit user request to retry/rerun the
same previously blocked or failed workflow ("再試一次", "修好以後重跑", "rerun the
same task"). An unrelated new prompt must never supersede an existing
`HUMAN_REQUIRED` workflow — that would silently discard a workflow still waiting
on a human. Internal roles never make this decision.

## Internal roles are already inside SuperGPT

Planner / Supervisor / Executor / Reviewer / Gate sessions operate on a frozen
Task Card within an active workflow. They must never call `supergpt_route`,
`supergpt_start`, or `supergpt_start_and_wait`, and must never report an error
about missing `supergpt_*` MCP tools — those tools belong only to the outermost
front agent.

## Contract version

Bump `Contract version:` in `COMMON.md` (and `FRONT_AGENT_CONTRACT_VERSION` in
`src/mcp/supergptMcpServer.js`, plus the telemetry assertions) whenever the
launch or polling semantics change, so a stale global install is reported as
`stale-content` by `npm run doctor`. Pure prose edits that do not change launch
or polling semantics do not require a bump — `checkGlobalPolicy` compares the
full normalized block content and flags any drift regardless of version.
