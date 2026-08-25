# Review Result

This document defines the **Review Result** — the machine-readable verdict
GPT (per [AGENT_ROLES.md](./AGENT_ROLES.md)'s Reviewer role) sends back after
judging an [EXECUTION_REPORT.md](./EXECUTION_REPORT.md) against its
originating [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) Task Card. It is the
output of [WORKFLOW.md](./WORKFLOW.md)'s `GPT REVIEW` step, and its
`decision` field drives the `PASS / REWORK` branch that follows.

This is a design document. No parser or transport for this format exists
yet. It does not change the MCP tool or browser bridge.

## 1. Format convention

Same convention as TASK_PROTOCOL.md §1: one Markdown document, one level-2
(`##`) heading per field, snake_case, in the order listed below. State
"none" rather than omitting a heading with nothing under it.

## 2. Required fields

- **task_id** — must match the `task_id` of the Task Card and Execution
  Report this result answers.
- **repository_context** — which repository *commit* this review was
  actually performed against, same four sub-fields as
  [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §2 (`repository_name`,
  `repository_url`, `branch`, `commit_sha`). Lets a human or a future audit
  confirm the review wasn't run against a stale checkout.
- **decision** — one of:
  - `PASS` — acceptance criteria are met; the loop advances to `NEXT TASK`
    per [WORKFLOW.md](./WORKFLOW.md) §PASS/REWORK.
  - `REWORK` — acceptance criteria are not met; the loop returns to
    execution with this result's `findings` and `required_changes` as new
    input.
  - `HUMAN_REQUIRED` — the reviewer cannot resolve this with a PASS/REWORK
    verdict alone (ambiguous spec, a decision only the product owner can
    make, an executor `BLOCKED`/`HUMAN_REQUIRED` report that the reviewer
    agrees can't be resolved within the loop). Mirrors the same state in
    [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §2 and
    [ARCHITECTURE.md](../ARCHITECTURE.md) §6.
- **findings** — what the reviewer actually observed in the evidence
  (diff, test output) — per [REVIEW_POLICY.md](./REVIEW_POLICY.md) §3, this
  is judgment about intent-alignment, not a restatement of gate results
  already reported. Each finding should point at something specific enough
  for the executor to act on (a file, a criterion, a behavior) rather than a
  general impression.
- **required_changes** — for `REWORK`, the specific, actionable list of what
  must change before the next review. Empty ("none") when `decision` is
  `PASS`. For `HUMAN_REQUIRED`, this field states what decision is needed,
  not what code should change.
- **rationale** — why this decision was reached, tying back to the Task
  Card's `acceptance_criteria`. This is what lets a human or a future Codex
  adversarial auditor (AGENT_ROLES.md §Codex) check the reviewer's own
  judgment rather than taking the verdict on faith.

## 3. Template

```markdown
## task_id
<matches the originating Task Card and Execution Report>

## repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <the commit this review was performed against>

## decision
PASS | REWORK | HUMAN_REQUIRED

## findings
- <specific observation, tied to a file/criterion/behavior>

## required_changes
- <specific, actionable change; or "none" if PASS>

## rationale
<why this decision, tied to acceptance_criteria>
```

## 4. Non-goals

- Does not define retry limits or how many REWORK cycles are allowed before
  escalating to `HUMAN_REQUIRED` — see [ROADMAP.md](../ROADMAP.md) Phase 6.
- Does not change what triggers a review in the first place — see
  [REVIEW_POLICY.md](./REVIEW_POLICY.md).
- Does not implement an automatic loop; this document describes the message
  shape only.
