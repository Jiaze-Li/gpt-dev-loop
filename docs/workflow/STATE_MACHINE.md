# State Machine

This document defines the task lifecycle state machine for `gpt-dev-loop`. It
gives [WORKFLOW.md](./WORKFLOW.md)'s prose loop (`SPEC -> TASK -> CLAUDE
EXECUTION -> DETERMINISTIC GATES -> GPT REVIEW -> PASS/REWORK -> NEXT TASK`) a
precise set of states, transitions, and per-state ownership, and expands the
sketch already in [ARCHITECTURE.md](../ARCHITECTURE.md) §6 into something
implementable.

This is a design document only. No state machine, persistence, or scheduler
exists yet. It does not change the MCP tool, the browser bridge, or any of
the protocol documents ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md),
[EXECUTION_REPORT.md](./EXECUTION_REPORT.md),
[REVIEW_RESULT.md](./REVIEW_RESULT.md)) — it consumes and produces those
formats but does not redefine them.

## 1. States

### PENDING

**Meaning:** A Task Card exists but the executor has not started work on it.

**Entry condition:**
- GPT (Planner, per [AGENT_ROLES.md](./AGENT_ROLES.md)) generates a
  [Task Card](./TASK_PROTOCOL.md).

**Allowed transitions:**
- `EXECUTING`

### EXECUTING

**Meaning:** The executor (Claude, or a future Codex adapter per
AGENT_ROLES.md §Codex) is working the Task Card.

**Input:**
- [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) (the Task Card)

**Output:**
- [EXECUTION_REPORT.md](./EXECUTION_REPORT.md)

**Allowed transitions:**
- `VERIFYING` — executor reports `DONE`
- `HUMAN_REQUIRED` — executor reports `HUMAN_REQUIRED` directly (per
  TASK_PROTOCOL.md §2 `completion_signal`), bypassing gates and review
  because the blocker is outside both agents' authority

Note: an executor report of `BLOCKED` also leaves `EXECUTING`, but is routed
through `REVIEWING` rather than transitioning directly — see §2 below, row
`EXECUTING / executor reports BLOCKED`. `BLOCKED` means the executor needs
something only the planner/reviewer can supply, which is a judgment GPT
should make, not an automatic escalation to a human.

### VERIFYING

**Meaning:** Deterministic gates run against the executor's output — the
`DETERMINISTIC GATES` step of WORKFLOW.md.

**Input:**
- `verification_commands` (from the Task Card)

**Output:**
- `test_results` (pass/fail per command, plus raw output)

**Allowed transitions:**
- `REVIEWING` — all verification commands pass
- `REWORK` — one or more verification commands fail

A gate failure never consumes a GPT review call — this mirrors WORKFLOW.md
§DETERMINISTIC GATES.

### REVIEWING

**Meaning:** GPT (Reviewer, per AGENT_ROLES.md) judges the Task Card, the
Execution Report, and Git evidence, per
[REVIEW_POLICY.md](./REVIEW_POLICY.md).

**Input:**
- [TASK_PROTOCOL.md](./TASK_PROTOCOL.md)
- [EXECUTION_REPORT.md](./EXECUTION_REPORT.md)
- Git evidence (diff, base/head coordinates — ARCHITECTURE.md §5)

**Output:**
- [REVIEW_RESULT.md](./REVIEW_RESULT.md)

**Allowed transitions** (driven by `REVIEW_RESULT.decision`):
- `PASS` -> `COMPLETE`
- `REWORK` -> `EXECUTING`
- `HUMAN_REQUIRED` -> `HUMAN_REQUIRED`

### COMPLETE

**Meaning:** The task is done. Terminal state for a successful task.

**Actions on entry:**
- Persist an audit record for this task (see §3).
- Generate the next task request (pulls the next Task Card from the spec's
  breakdown, per WORKFLOW.md §NEXT TASK), or, if no tasks remain, hands
  control back to the human.

**Allowed transitions:** none (terminal).

### REWORK

**Meaning:** Either a deterministic gate failed (from `VERIFYING`) or GPT's
review verdict was `REWORK` (from `REVIEWING`). The executor must address
concrete, actionable feedback before the next attempt.

**Input:**
- From `VERIFYING`: the failing `test_results`.
- From `REVIEWING`: `REVIEW_RESULT.required_changes`.

**Allowed transitions:**
- `EXECUTING`

`REWORK` is not itself a place work happens — it exists to carry the reason
for returning to `EXECUTING` (see §2 for the retry-count check on this
transition, and §4 for the escalation policy this feeds).

### HUMAN_REQUIRED

**Meaning:** Progress requires a decision, credential, or authorization only
the human (product owner) can supply. Mirrors ARCHITECTURE.md §6 and the
`HUMAN_REQUIRED` completion signal defined in TASK_PROTOCOL.md §2.

**Example causes:**
- Spec ambiguity that GPT (Reviewer) cannot resolve unilaterally.
- An irreversible action the executor is not authorized to take.
- Missing permission or credential.

**Allowed transitions:** none from within the loop. Resuming requires a
human decision that produces a new or amended Task Card, which re-enters at
`PENDING` — this is a human action, not an automatic state transition, so it
is intentionally not listed in the transition table in §2.

### ABORTED

**Meaning:** The task cannot continue. Terminal state for an unsuccessful
task.

**Example causes:**
- Retry limit exceeded (see §4).
- Corrupted or unrecoverable persisted state (see §3).

**Allowed transitions:** none (terminal).

## 2. Transition table

| Current      | Event                                        | Next           |
|--------------|-----------------------------------------------|----------------|
| PENDING      | Task Card generated                            | EXECUTING      |
| EXECUTING    | executor reports DONE                          | VERIFYING      |
| EXECUTING    | executor reports BLOCKED                       | REVIEWING      |
| EXECUTING    | executor reports HUMAN_REQUIRED                | HUMAN_REQUIRED |
| VERIFYING    | all verification_commands pass                 | REVIEWING      |
| VERIFYING    | any verification_command fails                 | REWORK         |
| REVIEWING    | REVIEW_RESULT.decision = PASS                  | COMPLETE       |
| REVIEWING    | REVIEW_RESULT.decision = REWORK                | EXECUTING      |
| REVIEWING    | REVIEW_RESULT.decision = HUMAN_REQUIRED        | HUMAN_REQUIRED |
| REWORK       | (immediate, carries required_changes forward)  | EXECUTING      |
| any state    | retry limit exceeded (§4)                      | ABORTED        |
| any state    | persisted state corrupted/unrecoverable         | ABORTED        |

A `BLOCKED` executor report routes through `REVIEWING` rather than jumping
straight to `HUMAN_REQUIRED`: GPT is expected to first judge whether the
blocker is resolvable within the loop (e.g. by amending the Task Card) before
escalating. This is consistent with REVIEW_RESULT.md §2's `HUMAN_REQUIRED`
decision already covering "an executor BLOCKED/HUMAN_REQUIRED report that the
reviewer agrees can't be resolved within the loop."

## 3. Per-state owner

| State          | Owner  |
|----------------|--------|
| PENDING        | GPT    |
| EXECUTING      | Claude |
| VERIFYING      | Shell  |
| REVIEWING      | GPT    |
| COMPLETE       | Shell  |
| REWORK         | Shell  |
| HUMAN_REQUIRED | Human  |
| ABORTED        | Shell  |

"Shell" denotes the orchestrator process itself (the future scheduler this
document is explicitly not designing — see §5) rather than either agent:
running verification commands, persisting audit records, and detecting
retry-limit/corruption conditions are mechanical, not judgment calls.

## 4. Persistence requirements (future `state.json`)

This section describes what a future persisted state file needs to capture —
not a schema, and not an implementation.

- `current_state` — one of the states in §1.
- `task_id` — matches TASK_PROTOCOL.md §2 `task_id`, correlates state with
  its Task Card, Execution Report(s), and Review Result(s).
- `timestamps` — at minimum, entry time for each state transition, so
  duration-in-state is reconstructable for debugging and for future timeout
  policy (ROADMAP.md Phase 6).
- `attempts` — count of `EXECUTING` cycles for this `task_id`, incremented on
  every `REWORK -> EXECUTING` transition. Drives the retry policy in §5.
- `artifacts` — references to the Task Card, each Execution Report, each
  Review Result, and gate `test_results` produced for this task, in
  chronological order. Enough to reconstruct the full history of one task
  without re-deriving it from Git.
- `last_error` — the most recent gate failure, `REWORK` rationale, or
  `ABORTED` cause, kept even after the state moves on, so a human resuming a
  `HUMAN_REQUIRED` or investigating an `ABORTED` task doesn't have to dig
  through `artifacts` to find out what went wrong most recently.

The guiding requirement, per WORKFLOW.md's non-goals: this must be enough to
**resume without accidentally rerunning already-reviewed work** — i.e. a
crash or restart mid-loop should not silently re-execute a task whose
`VERIFYING` or `REVIEWING` step already completed.

## 5. Retry policy (design only, not implemented)

- **Executor failure retry** (`VERIFYING` gate failure, or `REVIEWING`
  `REWORK`): bounded by `attempts` (§4). Each `REWORK -> EXECUTING` cycle
  carries forward the specific failure (`test_results` or
  `required_changes`) as new input to the executor, per WORKFLOW.md
  §PASS/REWORK. A fixed maximum attempt count (exact number: ROADMAP.md
  Phase 6) triggers escalation to `HUMAN_REQUIRED` rather than `ABORTED` —
  the task itself may still be valid, just not solvable by the executor
  alone.
- **Reviewer failure retry**: a GPT call that fails transiently (network,
  malformed REVIEW_RESULT.md that doesn't parse per REVIEW_RESULT.md §1)
  should be retried at the `REVIEWING` step itself, not treated as an
  executor-attributable failure — it does not increment `attempts`.
  Repeated reviewer-side failure (not to be confused with a `REWORK`
  verdict, which is a valid outcome) past its own bound escalates to
  `HUMAN_REQUIRED`.
- **When to escalate to `HUMAN_REQUIRED` vs `ABORTED`**: `HUMAN_REQUIRED` is
  for anything a human decision could unblock (ambiguous spec, missing
  permission, retry limit hit but the task is still plausibly completable).
  `ABORTED` is reserved for states a human decision cannot repair from
  inside the loop — corrupted persisted state, or a task the human has
  already reviewed under `HUMAN_REQUIRED` and declined to continue.
  `ABORTED` is a stronger claim than `HUMAN_REQUIRED` and should be reached
  rarely, generally only after a `HUMAN_REQUIRED` stop, not as a first
  response to failure.

## 6. Non-goals

- Does not implement a scheduler or orchestrator process.
- Does not implement a task queue or persistence layer (`state.json` is
  described in §4 as a future requirement, not created here).
- Does not implement agent execution (Claude/Codex/GPT calls).
- Does not define exact retry-count values or timeout durations — those are
  config, per ROADMAP.md Phase 6.
- Does not modify the MCP server, the browser runtime, or any file under
  `docs/workflow/` other than this one.
