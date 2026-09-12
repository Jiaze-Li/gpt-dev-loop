# Agent Roles

This document defines what each agent is responsible for in the workflow
described in [WORKFLOW.md](./WORKFLOW.md). It is a design document, not an
implementation guide — none of these roles are enforced in code yet.

The guiding principle: **no agent is both sole implementer and sole judge of
its own work.** Execution and review are separate roles even when they run
on different underlying models, and even more so when the same model could
in principle do both.

## GPT

GPT plays the judgment and planning roles — the ones that require standing
outside the implementation and evaluating it against intent.

- **Planner** — breaks a SPEC into an ordered sequence of TASKs sized for one
  loop pass. Planning happens before execution starts; re-planning mid-task
  is a signal the task was too large or the spec was underspecified, not a
  routine occurrence.
- **Architect** — weighs in on structural decisions that affect more than
  the current task: module boundaries, contracts between components, choices
  that would be expensive to reverse later. Architecture questions are
  escalated to GPT rather than decided unilaterally by the executor.
- **Reviewer** — inspects Git evidence (diff, gate results) against the
  spec/task and returns PASS or REWORK, per REVIEW_POLICY.md.
- **Acceptance judge** — for a full SPEC (not just one task), makes the final
  call on whether the delivered result satisfies the original acceptance
  criteria before the loop reports completion to the human.

GPT does not write implementation code and does not run the local
environment. Its only interface into the loop is the `ask_gpt` review/plan
request and its text response.

## Claude

Claude plays the execution role — turning a TASK into a working, tested
change.

- **Executor** — owns the CLAUDE EXECUTION and DETERMINISTIC GATES stages of
  the loop: makes the edits, runs the build/tests, and produces the Git
  evidence the reviewer will inspect.
- **Implementation** — makes the local, tactical decisions needed to satisfy
  a task (naming, file layout, which existing utility to reuse) without
  escalating every choice — only structural/architectural questions go to
  GPT as Architect.
- **Debugging** — when gates fail or GPT returns REWORK, Claude is
  responsible for diagnosing and fixing within the current task's scope
  before re-requesting review.

Claude does not grant itself final PASS on its own work — that authority
sits with GPT as Reviewer, per the separation-of-roles principle above.

## Codex

Codex is optional and, where present, plays an adversarial auditing role
distinct from both GPT's review and Claude's execution.

- **Optional adversarial auditor** — reviews Claude's implementation (or
  GPT's plan) looking specifically for what the primary reviewer might miss:
  edge cases, scope creep, unverified assumptions. Codex's presence adds a
  second independent check; its absence should degrade the loop's
  confidence, not silently skip a step (see the single-AI fallback
  principle already in use for Claude's own global workflow).
- Codex does not replace GPT as Reviewer or Claude as Executor. When Codex
  disagrees with GPT's verdict, that disagreement itself is evidence worth
  surfacing rather than something one agent should resolve by overriding
  the other.

Codex is not part of the loop's critical path in early phases —
[ROADMAP.md](../ROADMAP.md) Phase 7 is where a Codex adapter is planned. This
document defines the role in advance so the loop's design does not need to
change shape when that adapter arrives.

## Why the split is fixed this way

- GPT sits outside the code and judges it — the same reason ARCHITECTURE.md
  §5 has the reviewer inspect the diff directly instead of trusting a
  self-reported summary.
- Claude sits inside the code and changes it — it has the most context on
  *how* to fix something, but the least objectivity about *whether* its own
  fix is sufficient.
- Codex, when available, is the check on the check — it exists so that a
  single reviewer's blind spot doesn't become the loop's blind spot.
