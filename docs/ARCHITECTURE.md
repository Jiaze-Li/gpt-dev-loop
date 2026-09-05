# SuperGPT V2 Architecture — Current Source of Truth

This document describes the active V2 architecture. V1 is the historical
foundation (see `docs/ROADMAP.md`). Historical browser-bridge and pre-V1
orchestration designs are not production contracts.

## 1. Ownership boundary

SuperGPT has two layers:

```text
FRONTEND
Claude / Codex / AGY
= human interface + launcher

SUPERGPT CORE
= workflow owner
```

All three frontends use the same `agent-policy/COMMON.md` and the same global
`supergpt` MCP server. Client-specific configuration formats are installer
details only; they do not create different product behavior.

There is one canonical execution engine: `src/orchestrator/supergpt.js -> runSuperGPT()`.

## 2. Frontend contract

A frontend may:

- accept the user's goal;
- obtain a routing decision from the shared deterministic operation;
- launch one SuperGPT workflow when routed to SuperGPT;
- display local persisted progress;
- relay a terminal result or a genuine `HUMAN_REQUIRED` question.

A frontend must not decide routing on its own, create its own Task Cards,
duplicate SuperGPT implementation/review work, or use the CLI as an alternate
autonomous-agent path.

The normal contract is:

```text
supergpt_route({ goal, cwd })
-> DIRECT | SUPERGPT

DIRECT
-> handled in the front agent (explanation/research, trivial low-risk edit, explicit bypass)

SUPERGPT
-> supergpt_start_and_wait({ goal, cwd })
-> { status, summary, deliveredFiles, workflowId, ... }  (terminal)
   or a genuine HUMAN_REQUIRED question
```

`supergpt_route` is deterministic and consumes zero model tokens.
`supergpt_start_and_wait` starts the workflow and blocks locally for the
terminal result; the front agent model is invoked once to start and once to
read the result.

`supergpt_status`, `supergpt_watch`, and `supergpt_wait` observe local
persisted state. They are manual / debug / recovery operations and must not be
run as an autonomous polling loop.

## 3. Core path selection

The Core selects one path per workflow:

```text
route decision = SUPERGPT
-> Core path selection
     FAST        — one safely bounded task
     FULL        — multi-step / planning required / ambiguous
     PR_CLOSEOUT — "review and fix PR #N" style request
```

### Fast Path

```text
Executor
-> deterministic Gate
-> independent Reviewer
-> DONE / REWORK
```

Planning is skipped only when the Core can safely form the single bounded task
contract; otherwise it falls closed to the Full Path.

### Full Path

```text
Planner once
-> ordered task queue
-> Executor
-> deterministic Gate
-> independent Reviewer

Reviewer PASS            -> next task automatically
Gate FAIL                -> Executor repair
first ordinary REWORK    -> Executor repair using Reviewer findings
last task PASS           -> WORKFLOW_DONE
```

### PR Closeout

```text
trusted review
-> clean                     -> WORKFLOW_DONE
-> actionable P1/P2 finding   -> repair task
-> Executor fixes
-> deterministic Gate
-> push new head
-> re-review
-> repeat, or escalate to Supervisor, or HUMAN_REQUIRED
```

The trusted reviewer is a separate read-only trust boundary. Never force-push;
no automatic merge by default.

### Supervisor

Supervisor is exception-only in every path: repeated non-convergence,
`HUMAN_REQUIRED`, plan/task mismatch, contradictory evidence, or a state the
Core cannot safely resolve deterministically. If Planner output is not reliable
enough to define the task queue, the Core fails closed rather than guessing.

## 4. Role separation

Models are role providers, not workflow owners:

- Planner: creates a bounded structured task queue when planning is needed.
- Executor: changes code inside the isolated workspace.
- Gate: local deterministic verification, no model judgment.
- Reviewer: independently evaluates task scope, diff/evidence, and Gate result.
- Supervisor: resolves exceptional judgment states only.

Provider families may fail over through the existing role-routing, quota,
health, effort, and session policies without changing these logical
responsibilities.

## 5. Model-spend control boundary

Every metered internal model call (Planner, Supervisor, Executor, internal
Reviewer, PR-closeout repair Executor) passes a fail-closed boundary before it
is dispatched:

```text
eligible New Information
  + role capability
  + per-call budget + aggregate task/workflow ceilings
  + reservation safety
-> PhysicalCallPermit  (default-deny; one permit per physical attempt)
-> physical model call
-> known settlement   (usage recorded)
   or explicit UNRESOLVED
```

Properties:

- an authorization failure is never reported as a provider failure;
- an identical failure fingerprint with an unchanged diff does not trigger
  another Executor dispatch — the workflow goes to `HUMAN_REQUIRED`;
- if prior spend cannot be reconstructed on resume and any ceiling is enabled,
  the workflow does not resume with a fresh zero budget;
- aggregate cost / token-volume ceilings are a last-resort mechanical fuse
  independent of every heuristic.

Token Safety implementation details live in the source and its tests, not here.

## 6. Workspace and delivery

Before execution, the Core snapshots the exact invocation workspace into an
owned isolated worktree. Staged, unstaged, and untracked pre-existing changes
form the baseline rather than being misclassified as model output.

Approved changes are delivered back only through the Core delivery path.
Delivery checks for conflicts and unsafe paths and preserves unrelated user
work. Frontends and humans should not manually copy/cherry-pick intermediate
worktree changes as a substitute for delivery.

## 7. Persistence and terminal states

The Core persists workflow state and owns recovery. Normal terminal states are:

- `WORKFLOW_DONE`
- `HUMAN_REQUIRED`
- `FAILED`
- `TIMEOUT`
- `STALLED`
- `STOPPED`

A frontend disconnect does not stop the workflow. Resume keeps the workflow
identity and required isolation state.

## 8. Installation contract

`npm run install-global` installs the same global launcher contract for AGY,
Claude, and Codex:

```text
same COMMON policy
+ same supergpt MCP server
+ same MCP operation names
```

There is no active repository-local `.mcp.json`, no separate Claude/Codex/AGY
routing policy, and no second agent execution entrypoint.

## 9. Canonical documentation

Active sources of truth:

- `README.md` — product overview;
- `agent-policy/COMMON.md` — only active front-agent policy;
- `docs/ARCHITECTURE.md` — V2 architecture;
- `docs/GLOBAL_INSTALL.md` — global installation contract;
- `docs/V2_PLAN.md` — agreed V2 design plan.

Historical browser material belongs only under `docs/handoff/archive/` and Git
history. When a new active rule or entrypoint replaces an old one, the old
active rule/entrypoint is removed rather than retained as a parallel fallback.
