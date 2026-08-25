# Review Policy

This document defines when the loop described in [WORKFLOW.md](./WORKFLOW.md)
must call GPT for review, and when it should not. It is a design document —
the actual gate/skip logic does not exist in code yet.

The purpose of this policy is to protect review calls as an expensive,
judgment-based resource (see [ARCHITECTURE.md](../ARCHITECTURE.md) §5) and
spend them only where a deterministic gate cannot substitute.

## 1. Must call GPT

- **Architecture decision** — any choice that affects module boundaries,
  cross-component contracts, or would be expensive to reverse later. This is
  GPT's Architect role (see [AGENT_ROLES.md](./AGENT_ROLES.md)); Claude
  should not decide these unilaterally even if a plausible answer is
  obvious locally.
- **Task completion** — every TASK that reaches DETERMINISTIC GATES with a
  passing result still needs a GPT PASS before the loop advances to NEXT
  TASK. Gates prove the code runs; they do not prove it satisfies the task.
- **Test failure that survives one debugging pass** — a first gate failure
  sends the loop back to CLAUDE EXECUTION without review (see §2). A test
  that is still failing after Claude's own attempted fix is no longer a
  routine gate failure — it may indicate a wrong assumption in the task or
  spec, which is GPT's Reviewer/Architect judgment to make, not something to
  keep retrying silently.
- **Unclear requirement** — if the SPEC or TASK is ambiguous enough that two
  reasonable implementations would diverge, that ambiguity is resolved by
  asking GPT (Planner/Architect) rather than by Claude picking an
  interpretation and proceeding.

## 2. Should not call GPT

- **Trivial edits** — changes with no behavioral surface: typo fixes,
  renaming for clarity, comment adjustments, reordering imports.
- **Formatting** — anything a formatter/linter would produce deterministically
  and that a gate already enforces.
- **Obvious fixes** — a first-pass fix for a gate failure with an
  unambiguous cause (e.g., a straightforward compile error, an off-by-one
  caught by the failing test itself). Claude fixes and re-runs gates; GPT is
  only pulled in if the fix doesn't resolve it or the cause isn't obvious
  (see §1, "test failure that survives one debugging pass").

## 3. The line between the two lists

The dividing question is: **does resolving this require judgment about
intent, or only mechanical correctness?**

- Mechanical correctness (does it compile, does it pass, is it formatted) is
  a gate's job and never needs GPT.
- Judgment about intent (is this the right design, does this satisfy the
  task, is the requirement even clear) is GPT's job every time, because
  Claude judging its own intent-alignment collapses the separation of roles
  that AGENT_ROLES.md depends on.

When a case doesn't obviously fall on one side, default to calling GPT. An
unnecessary review call costs time; a skipped one that should have happened
can let a wrong task get marked PASS.

## 4. Relationship to Codex

Where a Codex adversarial auditor is available (ROADMAP.md Phase 7), it does
not change what triggers a GPT review — it adds a second, independent check
on top of GPT's verdict, per AGENT_ROLES.md. Codex's absence should not
loosen this policy's must-call list.
