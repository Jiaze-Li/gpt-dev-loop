# Workflow

This document defines the standard development loop for `gpt-dev-loop` once it
grows from a communication channel into an agent workflow framework.

It is a design document only. No orchestration code exists yet — see
[ROADMAP.md](../ROADMAP.md) Phase 3+ for the implementation path. The
transport primitive this loop depends on (`ask_gpt`) already exists as of
Phase 1/2; everything else described here is still policy, not code.

## 1. The standard loop

```text
SPEC
  |
  v
TASK
  |
  v
CLAUDE EXECUTION
  |
  v
DETERMINISTIC GATES
  |
  v
GPT REVIEW
  |
  v
PASS / REWORK
  |
  v
NEXT TASK
```

### SPEC

A human-authored statement of goal, constraints, and acceptance criteria for
a unit of work. Specs are the only stage where a human injects new intent.
Everything downstream is agents interpreting and executing that intent.

### TASK

A single bounded slice of the spec, small enough to implement, test, and
review in one pass. Breaking a spec into tasks is a planning act (see
[AGENT_ROLES.md](./AGENT_ROLES.md)) and should happen before execution starts,
not be improvised mid-implementation.

### CLAUDE EXECUTION

The executor implements the task: writes code, runs it, iterates locally.
This stage owns the mechanics of change — file edits, local test runs,
debugging — and produces a concrete diff as evidence.

### DETERMINISTIC GATES

Machine-checkable preconditions that must pass before spending a reviewer
call. Examples: build succeeds, test suite passes, lint is clean, working
tree is otherwise scoped to the task. Gates exist so that GPT review time is
spent judging things a machine cannot judge — not re-discovering a failing
test. A gate failure sends the loop back to CLAUDE EXECUTION without
consuming a review.

### GPT REVIEW

Once gates pass, the reviewer is asked to judge the evidence (diff, test
output, task description) against the spec. See
[REVIEW_POLICY.md](./REVIEW_POLICY.md) for exactly when this step is
mandatory versus skippable.

### PASS / REWORK

The reviewer's verdict. `PASS` means the task's acceptance criteria are met
and the loop advances. `REWORK` means the loop returns to CLAUDE EXECUTION
with the reviewer's findings attached as new input. A hard-to-classify
result (ambiguous spec, missing information only a human has) is escalated
out of the loop rather than guessed at — this mirrors the `HUMAN_REQUIRED`
state already defined in [ARCHITECTURE.md](../ARCHITECTURE.md) §6.

### NEXT TASK

On `PASS`, the loop pulls the next task from the spec's breakdown. When no
tasks remain, the spec is complete and control returns to the human.

## 2. Design constraints carried over from the architecture

- The reviewer inspects Git evidence directly (base/head coordinates), not a
  prose summary of the change — see ARCHITECTURE.md §5. This loop does not
  change that contract.
- Gates are cheap and deterministic; review is expensive and judgment-based.
  The loop should never call GPT for something a gate could have caught.
- The loop is agent-agnostic at the execution slot — Claude is the first
  implementation, Codex is a future adapter (ARCHITECTURE.md §3). Nothing in
  this document assumes Claude specifically except where noted.

## 3. Non-goals of this document

- This is not an implementation spec for a state machine — ARCHITECTURE.md
  §6 already sketches one; this document describes the policy loop that
  state machine will eventually enforce.
- This does not define retry limits, timeout values, or config schema —
  those belong in ROADMAP.md Phase 6.
- This does not change or extend the MCP tool or browser bridge.
