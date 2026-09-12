# Orchestrator Design

This document defines the core coordinator for `gpt-dev-loop` — the process
that drives one task through [STATE_MACHINE.md](./STATE_MACHINE.md)'s
lifecycle, calling the executor and reviewer, running gates, and persisting
progress per [PERSISTENCE.md](./PERSISTENCE.md). It is the "Shell" referred
to as the state machine's owner for mechanical transitions in
STATE_MACHINE.md §3, given a concrete internal shape.

This is a design document only. No orchestrator process exists yet. It does
not change the MCP tool, the browser bridge, or any of the protocol
documents ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md),
[EXECUTION_REPORT.md](./EXECUTION_REPORT.md),
[REVIEW_RESULT.md](./REVIEW_RESULT.md)) — it consumes and produces those
formats but does not redefine them. It also does not redefine
[STATE_MACHINE.md](./STATE_MACHINE.md) or [PERSISTENCE.md](./PERSISTENCE.md)
— it assumes both and describes the component that acts on them.

## 1. Responsibility

The orchestrator is responsible for:

- **Creating a workflow** — accepting a SPEC breakdown (per WORKFLOW.md
  §NEXT TASK) and assigning it a `workflow_id` (PERSISTENCE.md §1), then
  generating or receiving the first Task Card.
- **Managing state transitions** — driving each task through
  STATE_MACHINE.md §1's states, applying the transition table in §2, and
  enforcing the retry/escalation policy in §5.
- **Calling the executor** — handing a Task Card to whichever agent is
  playing the Executor role (AGENT_ROLES.md — Claude first, Codex later)
  and collecting its Execution Report.
- **Calling the reviewer** — sending a review request to GPT (Reviewer, per
  AGENT_ROLES.md) and collecting its Review Result.
- **Saving persistence** — writing `state.json`, appending to the event log,
  and archiving artifacts, per PERSISTENCE.md §1–§4, on every transition.
- **Recovering an interrupted workflow** — on restart, applying
  PERSISTENCE.md §3's recovery procedure per task, grouped by
  `workflow_id`.

The orchestrator does not itself implement any agent's judgment (it does not
decide PASS/REWORK, and it does not write code) — it sequences calls to the
agents that do, and persists the result. This mirrors ARCHITECTURE.md §3's
"Core" separation-of-concerns: the orchestrator owns run state, transitions,
retry policy, gates, evidence coordinates, and audit events — not
implementation or review judgment.

## 2. Components

### Workflow Manager

**Owns:** `workflow_id` allocation and task lifecycle bookkeeping for one
workflow.

- Allocates a `workflow_id` when a SPEC breakdown starts (PERSISTENCE.md
  §1).
- Tracks which tasks belong to the workflow and their current states,
  without itself owning per-task transition logic (that's the state
  machine, applied per task — see §1 above).
- Decides what "next task" means once one task reaches `COMPLETE`
  (WORKFLOW.md §NEXT TASK): pull the next Task Card from the SPEC
  breakdown, or, if none remain, report workflow completion upward.
- Is the component that groups by `workflow_id` during recovery
  (PERSISTENCE.md §3).

### Executor Adapter

**Owns:** the boundary between the orchestrator and whichever agent plays
Executor.

- Calls Claude (or, later, Codex — AGENT_ROLES.md §Codex) with a Task Card
  formatted per TASK_PROTOCOL.md.
- Passes the Task Card through unmodified — the adapter is a transport, not
  a rewriter of task content.
- Collects the resulting EXECUTION_REPORT.md and returns it to the
  orchestrator's state-transition logic (STATE_MACHINE.md §1 `EXECUTING`).
- Is where agent-specific invocation detail lives (CLI invocation, session
  handling, prompt scaffolding) — see §6 Adapter Boundary.

### Gate Runner

**Owns:** the `VERIFYING` state's mechanical work.

- Executes each command in the Task Card's `verification_commands`
  (TASK_PROTOCOL.md §2) exactly as specified, with no judgment about what
  the results mean.
- Collects raw output and pass/fail per command as `test_results`
  (STATE_MACHINE.md §1 `VERIFYING`).
- Makes no PASS/REWORK decision itself — a failing command routes to
  `REWORK` deterministically per STATE_MACHINE.md §2, never to a judgment
  call.

### Reviewer Adapter

**Owns:** the boundary between the orchestrator and GPT.

- Calls GPT via the `ask_gpt` MCP tool (ARCHITECTURE.md §3 "Reviewer
  bridge"), sending a review request built from the Task Card, Execution
  Report, and Git evidence coordinates (STATE_MACHINE.md §1 `REVIEWING`).
- Receives GPT's response and parses it into a REVIEW_RESULT.md per
  REVIEW_RESULT.md's format.
- Retries transient failures (network, malformed result that doesn't parse)
  at this layer per STATE_MACHINE.md §5's "reviewer failure retry" — these
  retries do not increment the task's `attempt_count`.
- Is where MCP transport detail and ChatGPT-bridge specifics live — see §6.

### Persistence Layer

**Owns:** everything defined in [PERSISTENCE.md](./PERSISTENCE.md).

- Writes `state.json` on every transition (PERSISTENCE.md §1).
- Appends one event per transition to the event log (PERSISTENCE.md §2).
- Stores artifacts — Task Card, Execution Reports, Review Results, gate
  output, commit references (PERSISTENCE.md §4).
- Is the only component the other four read from and write to for anything
  that must survive a restart; no other component keeps its own
  authoritative copy of task state.

## 3. Data flow

One pass through the loop, per task:

```text
TASK_CARD
  |
  v
Executor Adapter  -->  Executor (Claude/Codex)
  |
  v
Execution Report
  |
  v
Gate Runner  -->  verification_commands
  |
  v
Reviewer Adapter  -->  GPT via ask_gpt
  |
  v
Review Result
  |
  v
State Update  -->  Persistence Layer (state.json + event log + artifacts)
```

Each arrow corresponds to one STATE_MACHINE.md §2 transition; the
Persistence Layer is invoked after every step, not only at the end — a
crash between any two boxes must leave enough on disk for PERSISTENCE.md §3
recovery to determine which box was last completed. `State Update` is not a
separate agent call; it is the orchestrator recording the transition emitted
by whichever component just ran (Gate Runner or Reviewer Adapter) and
handing control to the next box or looping back to `EXECUTING` per the
transition table.

## 4. Error handling

- **Executor crash** — the Executor Adapter's call does not return
  (process died, session lost). The orchestrator does not treat this as a
  Task Card failure; it leaves `current_state` at `EXECUTING` and lets
  PERSISTENCE.md §3's `EXECUTING` recovery path pick it up on the next
  cycle (liveness check, then re-attempt with incremented `attempt_count`
  if the executor is confirmed gone).
- **GPT unavailable** — the Reviewer Adapter's `ask_gpt` call fails
  (bridge/session error, per ARCHITECTURE.md §3's "Reviewer bridge"
  responsibilities). Handled as STATE_MACHINE.md §5's "reviewer failure
  retry": retried at the `REVIEWING` step without incrementing
  `attempt_count`; repeated failure past its own bound escalates to
  `HUMAN_REQUIRED`, not `ABORTED` — GPT being unreachable is not evidence
  the task itself is unsolvable.
- **Gate failure** — a `verification_command` fails. Deterministic, expected
  path: STATE_MACHINE.md §2 routes this directly to `REWORK` without
  consuming a reviewer call, carrying `test_results` forward as the
  Executor Adapter's next input.
- **Invalid protocol** — a Task Card, Execution Report, or Review Result
  that doesn't parse per its format document (TASK_PROTOCOL.md,
  EXECUTION_REPORT.md, REVIEW_RESULT.md). Treated as a producer-side defect,
  not a task-content problem: for a malformed Review Result this is the
  same "reviewer failure retry" path above; for a malformed Execution
  Report, the orchestrator treats it as an executor crash (the executor
  did not produce a usable result) and applies the `EXECUTING` recovery
  path.
- **Corrupted state** — `state.json` or the event log for a task is
  unreadable or internally inconsistent (e.g. `current_state` not
  reachable from the event log's last recorded transition). Per
  STATE_MACHINE.md §2/§5, this routes to `ABORTED` — corrupted persisted
  state is explicitly called out as one of the two cases (alongside a
  human-declined `HUMAN_REQUIRED`) that `ABORTED` exists for, since there
  is no reliable state to resume from.

## 5. Adapter boundary

The orchestrator core must not know:

- **Claude CLI details** — invocation flags, session/output format,
  prompt scaffolding. Lives entirely in the Executor Adapter (§2).
- **GPT/browser bridge details** — DOM selectors, session reuse, login
  detection, the ChatGPT web UI. Lives entirely behind the Reviewer
  Adapter, which only sees `ask_gpt(request) -> response`
  (ARCHITECTURE.md §3 "Reviewer bridge", §8 "Browser/session boundary").
- **MCP implementation details** — how `ask_gpt` is exposed as an MCP tool,
  transport framing, server process management. Lives in the Reviewer
  Adapter's implementation, not in the orchestrator's transition logic.

The core (Workflow Manager, Gate Runner, Persistence Layer, and the
transition logic that sequences the two adapters) speaks only in the
protocol documents' vocabulary — Task Card, Execution Report, Review
Result, `test_results` — and the two adapter interfaces:

```text
Executor Adapter:  execute(task_card) -> execution_report
Reviewer Adapter:  review(request)    -> review_result
```

This is the same boundary ARCHITECTURE.md §3 draws for "Core" vs. the
Claude adapter and reviewer bridge, restated here at the orchestrator's
component granularity: swapping Claude for Codex, or replacing the
ChatGPT-web bridge with a direct API call, should require changes only
inside the relevant adapter, never inside the Workflow Manager, Gate
Runner, or Persistence Layer.

## 6. Non-goals

- Does not implement a scheduler — no polling loop, timers, or process
  supervisor; this document describes what the orchestrator does when
  invoked, not what invokes it or when.
- Does not implement parallel execution — one task, one workflow at a time,
  in this design; concurrent workflows or concurrent tasks within a
  workflow are not addressed here.
- Does not implement distributed agents — a single-machine, single-process
  orchestrator is assumed, consistent with PERSISTENCE.md §5.
- Does not implement a web UI or any human-facing interface beyond what
  `HUMAN_REQUIRED` already requires (STATE_MACHINE.md §1).
- Does not implement any of the five components in §2 — this document
  defines their responsibilities and boundaries, not their code.
- Does not modify the MCP server, the browser runtime, or any existing
  protocol/design document under `docs/workflow/`.
