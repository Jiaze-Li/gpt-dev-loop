# Persistence and Recovery

This document defines how `gpt-dev-loop` will save state, resume interrupted
tasks, and keep an auditable history of what happened — the future
`state.json` and event log that [STATE_MACHINE.md](./STATE_MACHINE.md) §4
describes only as a requirement, not a schema.

This is a design document only. No `state.json`, event log, or recovery code
exists yet. It does not change the MCP tool, the browser bridge, or any of
the protocol documents ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md),
[EXECUTION_REPORT.md](./EXECUTION_REPORT.md),
[REVIEW_RESULT.md](./REVIEW_RESULT.md)) — it consumes and archives those
formats but does not redefine them.

## 1. State storage (`state.json`)

One `state.json` per task, keyed by `task_id`. Represents the current,
mutable snapshot of where that task sits in the
[STATE_MACHINE.md](./STATE_MACHINE.md) lifecycle. It is overwritten on every
transition — history lives in the event log (§2), not here.

Fields:

- **workflow_id** — identifier for the overall spec/run this task belongs to
  (one workflow breaks down into many tasks per WORKFLOW.md §NEXT TASK).
  Lets recovery find "everything in progress for this run" without scanning
  every task file.
- **task_id** — matches TASK_PROTOCOL.md §2 `task_id`. Primary key.
- **current_state** — one of the states in STATE_MACHINE.md §1
  (`PENDING`, `EXECUTING`, `VERIFYING`, `REVIEWING`, `COMPLETE`, `REWORK`,
  `HUMAN_REQUIRED`, `ABORTED`).
- **created_at** — timestamp the Task Card was generated (entry into
  `PENDING`).
- **updated_at** — timestamp of the most recent state transition. Used by
  recovery (§3) to judge staleness — e.g. an `EXECUTING` state that hasn't
  updated in an implausible amount of time is a crash, not slow progress.
- **attempt_count** — count of `EXECUTING` cycles for this task, per
  STATE_MACHINE.md §4/§5. Drives the retry policy and the `ABORTED`
  escalation.
- **current_executor** — which agent currently owns the task
  (`claude`, `codex`, `gpt`, or `human`), per STATE_MACHINE.md §3's
  per-state owner table. Lets recovery know who it's waiting on without
  re-deriving it from `current_state`.
- **artifacts** — references (file paths or content hashes, not inline
  content) to the Task Card, each Execution Report, each Review Result, and
  each gate `test_results` blob produced so far, in chronological order.
  Points into the artifact store (§4) rather than duplicating content.
- **last_error** — the most recent gate failure, `REWORK` rationale, or
  `ABORTED`/`HUMAN_REQUIRED` cause. Kept even after the state moves past it,
  so a human resuming a stopped task doesn't have to walk `artifacts` to
  find out what went wrong most recently.

`state.json` is a snapshot, not a log: fields are overwritten in place on
each transition, except `attempt_count` (increments) and `artifacts`
(appends).

## 2. Event history

A separate append-only event log per task (e.g. `events.jsonl`, one JSON
object per line) — never edited in place, only appended to. This is the
audit trail; `state.json` is a projection of "apply every event in this log
in order."

Each event records one state transition:

- **timestamp** — when the transition happened.
- **previous_state** — the state before the transition.
- **new_state** — the state after the transition.
- **trigger** — what caused it, using the vocabulary already defined in
  STATE_MACHINE.md §2's transition table (e.g. `executor reports DONE`,
  `verification_command failed`, `REVIEW_RESULT.decision = REWORK`,
  `retry limit exceeded`).
- **actor** — which party caused the trigger (`claude`, `codex`, `gpt`,
  `shell` for mechanical/orchestrator-driven transitions per
  STATE_MACHINE.md §3, or `human`).

Example:

```json
{"timestamp": "2026-08-25T10:14:02Z", "previous_state": "EXECUTING", "new_state": "VERIFYING", "trigger": "executor reports DONE", "actor": "claude"}
```

The event log is what makes `state.json` reconstructible from scratch (§3)
and is the source of truth if the two ever disagree — `state.json` is a
cache of "replay the log," not an independent record.

## 3. Recovery

On process restart, for every task whose `current_state` is not terminal
(`COMPLETE` or `ABORTED`), recovery inspects `current_state` and decides
what to do next. No state resumes by silently continuing as if nothing
happened — every recovery path either re-derives fresh evidence or
explicitly waits.

- **PENDING** — nothing was in flight. Reschedule: hand the existing Task
  Card back to the executor, entering `EXECUTING` as normal.
- **EXECUTING** — check whether the executor process/session that owned
  this task is still running. If yes, leave it alone (it will report
  `DONE`/`BLOCKED`/`HUMAN_REQUIRED` and drive its own transition). If no
  (the process is gone, or `updated_at` is stale past a threshold — exact
  threshold is config, per ROADMAP.md Phase 6), treat it as a crashed
  attempt: re-enter `EXECUTING` with the same Task Card, incrementing
  `attempt_count` per STATE_MACHINE.md §5's retry policy.
- **VERIFYING** — gate output is cheap and deterministic to reproduce, and a
  crash mid-run leaves no reliable partial result. Re-run
  `verification_commands` from scratch rather than trusting any partial
  `test_results`.
- **REVIEWING** — resume the reviewer call. If a prior REVIEW_RESULT.md was
  fully written and persisted as an artifact before the crash, recovery may
  use it directly instead of re-invoking GPT (avoids burning a redundant
  review call); if no complete artifact exists, re-invoke the reviewer per
  STATE_MACHINE.md §5's "reviewer failure retry" (does not increment
  `attempt_count`).
- **HUMAN_REQUIRED** — no automatic action. Wait for the human decision that
  produces a new/amended Task Card, per STATE_MACHINE.md §1's note that
  resuming from `HUMAN_REQUIRED` is a human action, not an automatic
  transition.
- **COMPLETE** — terminal; nothing to recover. Confirm the audit record (§4)
  is fully persisted and move on.

The guiding requirement, carried over from STATE_MACHINE.md §4: recovery
must never silently re-run work whose `VERIFYING` or `REVIEWING` step
already completed and was persisted — only `EXECUTING` (crash-only) and
`VERIFYING` (cheap, deterministic) are ever safe to blindly redo.

## 4. Artifact management

An artifact store, keyed by `task_id`, holding the durable record of
everything produced for that task:

- the Task Card ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md))
- each Execution Report ([EXECUTION_REPORT.md](./EXECUTION_REPORT.md)) —
  one task may accumulate several across `REWORK` cycles
- each Review Result ([REVIEW_RESULT.md](./REVIEW_RESULT.md)) — likewise,
  one per `REVIEWING` pass
- raw test output from `VERIFYING` (STATE_MACHINE.md's `test_results`)
- the Git commit reference (SHA) associated with the attempt, per
  ARCHITECTURE.md §5's base/head coordinates

Artifacts are immutable once written — a `REWORK` cycle appends a new
Execution Report rather than overwriting the previous one, so the full
history of a task (including abandoned attempts) stays reconstructable from
the artifact store plus the event log (§2), independent of Git history.

`state.json`'s `artifacts` field (§1) is a list of references into this
store, not a copy of the content.

## 5. Non-goals

- Does not implement a database, queue, or scheduler.
- Does not implement a distributed system — this design assumes a single
  orchestrator process on one machine.
- Does not define exact staleness thresholds, retry counts, or file formats
  beyond the illustrative JSON above — those are implementation/config
  details for later phases (ROADMAP.md Phase 6).
- Does not modify the MCP server, the browser runtime, or any protocol
  document ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md),
  [EXECUTION_REPORT.md](./EXECUTION_REPORT.md),
  [REVIEW_RESULT.md](./REVIEW_RESULT.md)) — this document consumes and
  archives those formats, it does not redefine them.
- Does not implement the state machine itself or its transition logic — see
  [STATE_MACHINE.md](./STATE_MACHINE.md), which this document only extends
  with persistence and recovery detail.
