# SuperGPT V1 Architecture — Current Source of Truth

This document describes the active V1 architecture. Historical browser-bridge and pre-V1 orchestration designs are not production contracts.

## 1. Ownership boundary

SuperGPT has two layers:

```text
FRONTEND
Claude / Codex / AGY
= human interface + launcher

SUPERGPT CORE
= workflow owner
```

All three frontends use the same `agent-policy/COMMON.md` and the same global `supergpt` MCP server. Client-specific configuration formats are installer details only; they do not create different product behavior.

There is one canonical execution engine: `src/orchestrator/supergpt.js -> runSuperGPT()`.

## 2. Frontend contract

A frontend may:

- accept the user's goal;
- choose DIRECT vs SuperGPT using the shared V1 policy;
- invoke SuperGPT MCP operations;
- display local persisted progress;
- relay a terminal result or a genuine `HUMAN_REQUIRED` question.

A frontend must not create its own Task Cards, duplicate SuperGPT implementation/review work, or use the CLI as an alternate autonomous-agent path.

When SuperGPT is selected, the normal launch contract is:

```text
supergpt_start({ goal, cwd })
-> { status: "RUNNING", workflowId }
-> supergpt_watch({ workflowId })
-> terminal result
```

`status`, `watch`, and `wait` observe local persisted state. They do not spend model calls asking whether the workflow is still alive.

## 3. Normal workflow

For a structured Planner task queue, Core owns ordinary transitions without a model Supervisor:

```text
Planner once
-> Task 1
-> Executor
-> deterministic Gate
-> independent Reviewer

Reviewer PASS
-> next task automatically

Gate FAIL
-> Executor repair

first ordinary Reviewer REWORK
-> Executor repair using Reviewer findings

last task PASS
-> WORKFLOW_DONE
```

Supervisor is exception-only. Examples include repeated non-convergence, `HUMAN_REQUIRED`, plan/task mismatch, contradictory evidence, or a state Core cannot safely resolve deterministically.

If Planner output is not reliable enough to define the task queue, Core fails closed to the safe fallback path rather than guessing task progression.

## 4. Role separation

Models are role providers, not workflow owners:

- Planner: creates a bounded structured task queue when planning is needed.
- Executor: changes code inside the isolated workspace.
- Gate: local deterministic verification, no model judgment.
- Reviewer: independently evaluates task scope, diff/evidence, and Gate result.
- Supervisor: resolves exceptional judgment states only.

Provider families may fail over through the existing role-routing, quota, health, effort, and session policies without changing these logical responsibilities.

## 5. Workspace and delivery

Before execution, Core snapshots the exact invocation workspace into an owned isolated worktree. Staged, unstaged, and untracked pre-existing changes form the baseline rather than being misclassified as model output.

Approved changes are delivered back only through the Core delivery path. Delivery checks for conflicts and unsafe paths and preserves unrelated user work. Frontends and humans should not manually copy/cherry-pick intermediate worktree changes as a substitute for delivery.

## 6. Persistence and terminal states

Core persists workflow state and owns recovery. Normal terminal states are:

- `WORKFLOW_DONE`
- `HUMAN_REQUIRED`
- `FAILED`
- `TIMEOUT`
- `STALLED`
- `STOPPED`

A frontend disconnect does not stop the workflow. Resume keeps the workflow identity and required isolation state.

## 7. Installation contract

`npm run install-global` installs the same global launcher contract for AGY, Claude, and Codex:

```text
same COMMON policy
+ same supergpt MCP server
+ same MCP operation names
```

There is no active repository-local `.mcp.json`, no separate Claude/Codex/AGY routing policy, and no second agent execution entrypoint.

## 8. Canonical documentation

Active sources of truth:

- `README.md` — product overview;
- `agent-policy/COMMON.md` — only active front-agent policy;
- `docs/ARCHITECTURE.md` — V1 architecture;
- `docs/GLOBAL_INSTALL.md` — global installation contract;
- `docs/V2_PLAN.md` — only active V2 plan.

Historical browser material belongs only under `docs/handoff/archive/` and Git history. When a new active rule or entrypoint replaces an old one, the old active rule/entrypoint must be removed rather than retained as a parallel fallback.
