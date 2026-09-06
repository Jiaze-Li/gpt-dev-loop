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

## 3a. PR Closeout GitHub reviewer (separate path)

This section governs **only** the PR Closeout review path
(`src/orchestrator/prCloseoutLoop.js`,
`src/orchestrator/adapters/githubPrReviewAdapter.js`). It does not change the
ordinary Task Reviewer selection, protocol, or behaviour described above.

- **Default reviewer:** `codex`. Fallback order `codex -> claude -> internal`;
  `internal` is retained as the last-resort reviewer. Once a reviewer produces
  a valid review the workflow locks onto it for all later repair / push /
  re-review. Failover and infrastructure waiting never consume a repair round.
- **Trigger contract (confirmed, not invented):**
  - **Claude:** a PR issue comment whose body contains **`@claude review`**.
    Evidence: `.github/workflows/claude-code-review.yml` on branch
    `claude-global-review` gates its review job on
    `contains(github.event.comment.body, '@claude review')`.
  - **Codex:** a PR issue comment body **`@codex review`** — the same
    `@<bot> review` issue-comment shape.
  - A tested injection override (`triggerOverrides`) may replace the body from
    verified GitHub metadata / repo config; an unknown reviewer with no
    override fails closed rather than guessing a format.
- **Head-SHA binding:** on trigger the adapter persists the PR latest head SHA,
  trigger comment id, timestamp, reviewer, and pending flag. A poll result is
  accepted only when it is newer than the trigger, authored by the target
  reviewer identity, and bound to the current head SHA. Older reviews are
  ignored.
- **Pending de-dup:** at most one live trigger per `(reviewer, head)`. A resume
  or retry with a matching persisted pending record reuses it instead of
  posting a second comment.
- **Bounded polling:** local GitHub polling only (no model call, zero model
  tokens), interval clamped to the 15–30s band with backoff inside the band,
  bounded by `maxWaitMs`.
- **External head change:** any head movement during the wait invalidates the
  pending review, rebinds to the new head, de-dupes, and re-triggers; a late
  result for the old head can never match.
- **Classified failures** (each drives reviewer failover, never a repair round):
  `REVIEWER_UNAVAILABLE`, `TRIGGER_FAILED`, `REVIEW_TIMEOUT`,
  `GITHUB_INFRASTRUCTURE`. When every reviewer is exhausted the closeout loop
  enters HUMAN_REQUIRED with `REVIEW_INFRASTRUCTURE`.
- **Safety:** never edits `.github/workflows/**`, never force-pushes, merges,
  or deletes comments/reviews.

### Regression coverage

Every invariant above is locked by offline tests that use a fake GitHub
client, a fake clock, and provider fixtures — no test touches real GitHub and
no test performs a real wait:

- `tests/prCloseoutLoop.test.js` — trigger comment body, stale-review
  exclusion (wrong author / old head / pre-trigger), head-SHA binding,
  external head-change invalidation and re-trigger, pending de-dup on resume,
  classified failures, `codex -> claude -> internal` timeout fallback with no
  repair round burned, all-reviewers-exhausted -> `REVIEW_INFRASTRUCTURE`, and
  the zero-model-token guarantee of the polling wait (a recording proxy proves
  only the injected GitHub client and clock are touched and back-off runs
  entirely through the fake clock).
- `tests/prCloseoutPolicy.test.js` — default reviewer `codex`, fallback order,
  reviewer lock, `max repair rounds = 3`, three-rounds-then-Supervisor,
  repeated-finding early escalation, normalized review schema, safe-repair /
  no-force-push / no-auto-merge assertions.
- `tests/prCloseoutAutoWorkflow.test.js` — request recognition and routing,
  clean -> zero repair, P1 -> repair -> push -> re-review -> DONE,
  infrastructure failure not consuming a repair round.
- `tests/persistence.test.js` — PR closeout reviewer state merges without
  clobbering siblings and survives a restart without re-triggering a locked
  reviewer.

The Dashboard surface for PR Closeout (PR number, short head, reviewer,
review round / budget, WAITING / ACTIONABLE / CLEAN status, P1 / P2 counts,
last-review relative time, and the reviewer-request / repair-pushed /
re-review / review-clean / closeout-completed timeline milestones) is
specified in the improvement plan §5 and delivered with its own persisted
projection and `tests/dashboard.test.js` coverage under that work item; it
reads persisted state only and spends zero model tokens.

The ordinary Task Reviewer path has its own unchanged coverage
(`tests/reviewerConvergence.test.js`, `tests/trustedPrReview.test.js`,
`tests/pr3*.test.js`); the full suite `node --test tests/*.test.js` gates
all of the above.

## 4. Relationship to Codex

Where a Codex adversarial auditor is available (ROADMAP.md Phase 7), it does
not change what triggers a GPT review — it adds a second, independent check
on top of GPT's verdict, per AGENT_ROLES.md. Codex's absence should not
loosen this policy's must-call list.
