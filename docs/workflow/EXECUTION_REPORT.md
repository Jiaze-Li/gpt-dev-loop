# Execution Report

This document defines the **Execution Report** — the machine-readable
message an executor (Claude, or a future Codex adapter, per
[AGENT_ROLES.md](./AGENT_ROLES.md)) sends back after acting on a
[TASK_PROTOCOL.md](./TASK_PROTOCOL.md) Task Card. It is the evidence the
`DETERMINISTIC GATES → GPT REVIEW` step of [WORKFLOW.md](./WORKFLOW.md)
consumes.

This is a design document. No parser or transport for this format exists
yet. It does not change the MCP tool or browser bridge.

## 1. Format convention

Same convention as TASK_PROTOCOL.md §1: one Markdown document, one level-2
(`##`) heading per field, snake_case, in the order listed below. State
"none" rather than omitting a heading with nothing under it.

## 2. Required fields

- **task_id** — must match the `task_id` of the Task Card this report
  answers. This is the correlation key a reviewer or future automation uses
  to pair a report with its originating task.
- **status** — one of `DONE`, `BLOCKED`, `HUMAN_REQUIRED`, matching the
  `completion_signal` values defined in
  [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §2. This is the single field a
  reviewer or automated gate should check first to decide whether the rest
  of the report is "here is the evidence" (`DONE`) or "here is why I
  stopped" (`BLOCKED` / `HUMAN_REQUIRED`).
- **changed_files** — the actual list of files created, modified, or
  deleted. Should be checked against the Task Card's `allowed_files` /
  `forbidden_files` — a report listing a forbidden file is itself a review
  finding, not something the executor should have decided was fine.
- **tests_run** — the verification commands actually executed (should match
  `verification_commands` from the Task Card unless a deviation is explained
  here).
- **test_results** — the actual output/outcome of each command in
  `tests_run` — pass/fail per command, plus enough output (or a pointer to
  full output) for a reviewer to judge without re-running it themselves.
  Mirrors [ARCHITECTURE.md](../ARCHITECTURE.md) §5's principle that a
  reviewer inspects evidence directly rather than trusting a prose summary —
  this field is the evidence, not a restatement of it.
- **issues** — anything the executor noticed that isn't captured by
  pass/fail: a workaround taken, an assumption made where the task was
  ambiguous, a follow-up that seems necessary but was out of scope. Empty is
  a valid value ("none") but the field should not be skipped as a place to
  surface friction.
- **next_recommendation** — the executor's suggested next step: proceed to
  the next task, request a specific re-plan, or (for `BLOCKED` /
  `HUMAN_REQUIRED`) what input would unblock it. This is a recommendation,
  not a decision — advancing the loop is still GPT's call per
  [WORKFLOW.md](./WORKFLOW.md) §PASS/REWORK.

## 3. Template

```markdown
## task_id
<matches the originating Task Card>

## status
DONE | BLOCKED | HUMAN_REQUIRED

## changed_files
- <path>

## tests_run
- `<command>`

## test_results
- `<command>`: pass/fail — <relevant output or pointer to it>

## issues
- <deviation, assumption, or follow-up; or "none">

## next_recommendation
<proceed / re-plan / what would unblock>
```

## 4. Non-goals

- Does not define how the report is delivered to the reviewer — see
  [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §4.
- Does not define what the reviewer does with a `DONE` report — see
  [REVIEW_RESULT.md](./REVIEW_RESULT.md).
- Does not implement an automatic loop; this document describes the message
  shape only.
