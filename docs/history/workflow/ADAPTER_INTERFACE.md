# Adapter Interfaces

This document defines the abstract contract for the three adapters
introduced in [ORCHESTRATOR_DESIGN.md](./ORCHESTRATOR_DESIGN.md) §2/§5 —
Executor Adapter, Reviewer Adapter, Gate Runner — precisely enough that a
concrete implementation of any one of them is a drop-in replacement for
another, without the orchestrator core changing.

This is a design document only. No adapter, interface, or code exists yet.
It does not change the MCP tool, the browser bridge, or any protocol
document ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md),
[EXECUTION_REPORT.md](./EXECUTION_REPORT.md),
[REVIEW_RESULT.md](./REVIEW_RESULT.md)) — every adapter signature below
consumes and produces those existing formats unmodified. It does not
redefine [ORCHESTRATOR_DESIGN.md](./ORCHESTRATOR_DESIGN.md) — it narrows
that document's §2 component list and §5 adapter boundary into concrete
call signatures.

## 1. Executor Adapter

**Purpose:** hide the implementation details of whichever coding agent
plays Executor (AGENT_ROLES.md — Claude, Codex, or any future agent) behind
one call.

**Input:** a Task Card, per [TASK_PROTOCOL.md](./TASK_PROTOCOL.md).

**Output:** an Execution Report, per
[EXECUTION_REPORT.md](./EXECUTION_REPORT.md).

**Signature:**

```text
execute(task_card) -> execution_report
```

**Implementations** (interchangeable, none privileged by the interface):

- Claude Code CLI
- Codex CLI
- a DeepSeek agent, or any other coding agent that can consume a Task Card
  and produce an Execution Report

The core does not know which of these is behind `execute`. Nothing in the
signature, the input, or the output names an agent — TASK_PROTOCOL.md §1
already establishes the Task Card as executor-agnostic; this adapter is
what makes that guarantee load-bearing for the orchestrator.

## 2. Reviewer Adapter

**Purpose:** hide how the Reviewer role (AGENT_ROLES.md — GPT) is actually
invoked behind one call.

**Input:**

- the Task Card
- the Execution Report
- Evidence (Git diff/base-head coordinates and gate results, per
  ARCHITECTURE.md §5's "Review contract" and STATE_MACHINE.md §1
  `REVIEWING`)

**Output:** a Review Result, per [REVIEW_RESULT.md](./REVIEW_RESULT.md).

**Signature:**

```text
review(task_card, execution_report, evidence) -> review_result
```

**Implementations** (interchangeable):

- GPT via the web bridge's `ask_gpt` MCP tool (ARCHITECTURE.md §3
  "Reviewer bridge")
- a direct OpenAI API call
- any other reviewer capable of consuming the same three inputs and
  returning a REVIEW_RESULT.md-shaped verdict

The core does not know whether `review` is backed by a browser session, an
API key, or something else — only that it returns a parseable Review
Result.

## 3. Gate Runner Adapter

**Purpose:** run deterministic verification without the core knowing how
commands are actually executed (shell, container, remote runner).

**Input:** `verification_commands`, per TASK_PROTOCOL.md §2.

**Output:** Evidence — pass/fail per command plus raw output
(`test_results`, per STATE_MACHINE.md §1 `VERIFYING`).

**Signature:**

```text
run(verification_commands) -> evidence
```

`run` makes no PASS/REWORK judgment — it reports what happened, mechanically,
per ORCHESTRATOR_DESIGN.md §2's Gate Runner responsibility. The
REWORK/REVIEWING decision based on this Evidence stays in the state
machine (STATE_MACHINE.md §2), not in this adapter.

## 4. Interface rules

The core Workflow Manager (ORCHESTRATOR_DESIGN.md §2) may call:

- `execute(task_card) -> execution_report`
- `review(task_card, execution_report, evidence) -> review_result`
- `run(verification_commands) -> evidence`

The core Workflow Manager must not depend on, import, or contain
conditional logic for:

- Claude
- GPT
- MCP
- the browser (ChatGPT web bridge)
- any specific CLI

If a piece of core logic needs to change because a specific agent, browser
behavior, or CLI flag changed, that logic does not belong in the core — it
belongs behind one of the three adapters above. This restates
ORCHESTRATOR_DESIGN.md §5's adapter boundary as an interface-level rule: the
three signatures above are the *entire* surface the core is allowed to
touch.

## 5. Error model

Each adapter call either returns its documented output or fails with one of
a small set of named error conditions. The core reacts to the error's
category, never to adapter-specific detail (a stack trace, an HTTP status,
a DOM error) — that detail is logged by the adapter for debugging but does
not cross the interface.

**Executor Adapter:**

- `EXECUTOR_UNAVAILABLE` — the executor process/session could not be
  started or reached at all (maps to ORCHESTRATOR_DESIGN.md §4 "Executor
  crash" when it occurs mid-run rather than at start).
- `EXECUTOR_TIMEOUT` — the executor was reached but did not produce an
  Execution Report within the allotted time.
- `EXECUTOR_INVALID_OUTPUT` — the executor returned something that does not
  parse as an Execution Report per EXECUTION_REPORT.md (maps to
  ORCHESTRATOR_DESIGN.md §4's "invalid protocol" handling for a malformed
  Execution Report).

**Reviewer Adapter:**

- `REVIEWER_UNAVAILABLE` — the reviewer could not be reached (maps to
  ORCHESTRATOR_DESIGN.md §4 "GPT unavailable").
- `REVIEWER_TIMEOUT` — the reviewer was reached but did not respond in
  time.
- `REVIEWER_INVALID_OUTPUT` — the response does not parse as a Review
  Result per REVIEW_RESULT.md (maps to ORCHESTRATOR_DESIGN.md §4's
  "invalid protocol" handling for a malformed Review Result).

**Gate Runner:**

- `GATE_FAILED` — one or more `verification_commands` exited non-zero (or
  otherwise failed per the command's own success criterion). This is an
  expected, deterministic outcome, not a fault — it still returns Evidence
  (the failing `test_results`), it does not abort the call.
- `GATE_RUNNER_ERROR` — the Gate Runner itself could not execute the
  commands at all (e.g. the environment to run them in is unavailable) —
  distinct from `GATE_FAILED`, which means the commands ran and failed.

Every error case above is something STATE_MACHINE.md §2/§5 already has a
transition or retry rule for (crash recovery, reviewer failure retry,
`REWORK` on gate failure, escalation to `HUMAN_REQUIRED`/`ABORTED`); this
section only names the error values the adapters must produce so that
logic can be written against them, it does not introduce new handling
behavior beyond what ORCHESTRATOR_DESIGN.md §4 already describes.

## 6. Non-goals

- Does not implement any adapter, or any concrete binding to Claude, Codex,
  GPT, DeepSeek, MCP, or a shell/container runner.
- Does not define retry counts, timeout durations, or transport formats —
  those are configuration, per ROADMAP.md Phase 6 and
  ORCHESTRATOR_DESIGN.md's existing non-goals.
- Does not redefine the Task Card, Execution Report, or Review Result
  formats — see TASK_PROTOCOL.md, EXECUTION_REPORT.md, REVIEW_RESULT.md.
- Does not modify the MCP server, the browser runtime, or any existing
  protocol/design document under `docs/workflow/`.
