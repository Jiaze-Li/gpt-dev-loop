# Task Protocol

This document defines the **Task Card** — the machine-readable message a
planner (GPT, per [AGENT_ROLES.md](./AGENT_ROLES.md)) sends to an executor to
start one pass of [WORKFLOW.md](./WORKFLOW.md)'s `TASK → CLAUDE EXECUTION`
step.

This is a design document. No parser or transport for this format exists
yet — see [ROADMAP.md](../ROADMAP.md) for the implementation path. It does
not change the MCP tool or browser bridge.

The protocol is **executor-agnostic**: it names no specific model. Claude is
the first implementation of the executor role; Codex is a planned second one
(AGENT_ROLES.md §Codex). Nothing in the format assumes which one is reading
it.

## 1. Format convention

A Task Card is a single Markdown document. Each field is a level-2 (`##`)
heading matching the field name exactly (snake_case, as listed below),
followed by the field's content. This makes the card parseable by splitting
on `^## ` without requiring a Markdown AST — any tool that can split on a
heading regex can extract fields.

Fields appear in the order listed in §2. A field with no content still gets
its heading, followed by `none` or `n/a` — omitting a heading entirely means
"not provided," which a parser cannot distinguish from a missing/malformed
card. Don't omit; state "none."

## 2. Required fields

- **task_id** — a short, stable, unique identifier for this task (e.g.
  `phase3.1-task-protocol`). Used to correlate this card with its eventual
  [EXECUTION_REPORT.md](./EXECUTION_REPORT.md) and
  [REVIEW_RESULT.md](./REVIEW_RESULT.md).
- **repository_context** — which repository this Task Card belongs to, so
  every downstream reader (executor, reviewer, human) knows what it's
  looking at without inferring it from `cwd`. Four sub-fields, one per line:
  - `repository_name` — short human-readable repo name.
  - `repository_url` — the repo's remote URL (e.g. GitHub), or "none" for a
    repo with no remote.
  - `branch` — the branch this task is scoped to.
  - `commit_sha` — the commit this Task Card was planned against.
- **goal** — one to three sentences: what should be true when this task is
  done. States intent, not implementation steps.
- **context** — the minimum background the executor needs that isn't
  derivable from reading the repo: why this task exists, what came before it,
  links to the SPEC or prior task cards it descends from.
- **scope** — what this task does and does not cover. Exists to keep a task
  "small enough to implement, test, and review in one pass" per
  [WORKFLOW.md](./WORKFLOW.md) §TASK. Explicitly listing out-of-scope items
  is as important as listing in-scope ones.
- **allowed_files** — paths or globs the executor may create or modify.
- **forbidden_files** — paths or globs the executor must not touch even if
  doing so would be convenient (e.g. protocol meta-documents, unrelated
  modules). Takes precedence over `allowed_files` if the two ever overlap.
- **acceptance_criteria** — a checklist of concrete, checkable conditions.
  Each item should be phrased so a reviewer (or a future automated gate) can
  mark it met or not met without further judgment calls where possible.
- **verification_commands** — the exact commands (build, test, lint) the
  executor must run and report the output of. Corresponds to
  [WORKFLOW.md](./WORKFLOW.md)'s `DETERMINISTIC GATES` step — these are the
  gates for this specific task.
- **completion_signal** — which of the three terminal states the executor
  must emit in its EXECUTION_REPORT.md when it stops working on this task:
  - `DONE` — all acceptance criteria met, all verification commands pass.
  - `BLOCKED` — the executor cannot proceed without something only the
    planner/reviewer can supply (a decision, a missing dependency, a
    contradiction in the task itself). Not a judgment call the executor
    should resolve unilaterally.
  - `HUMAN_REQUIRED` — the blocker is outside both agents' authority (credits,
    an irreversible action, a product decision) — mirrors the
    `HUMAN_REQUIRED` state already defined in
    [ARCHITECTURE.md](../ARCHITECTURE.md) §6 and referenced in
    [WORKFLOW.md](./WORKFLOW.md) §PASS/REWORK.

  This field in the Task Card states which signals are *possible* for this
  task (normally all three); the field of the same name in
  [EXECUTION_REPORT.md](./EXECUTION_REPORT.md) states which one actually
  happened.

## 3. Template

```markdown
## task_id
<short unique id>

## repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <sha>

## goal
<1-3 sentences>

## context
<background, links to SPEC / prior tasks>

## scope
In scope:
- ...
Out of scope:
- ...

## allowed_files
- <path or glob>

## forbidden_files
- <path or glob>

## acceptance_criteria
- [ ] <checkable condition>

## verification_commands
- `<command>`

## completion_signal
DONE | BLOCKED | HUMAN_REQUIRED
```

## 4. Non-goals

- Does not define how Task Cards are transported between agents (file,
  message, queue) — that is an implementation detail for later phases.
- Does not define retry or re-planning behavior — see
  [WORKFLOW.md](./WORKFLOW.md) §PASS/REWORK and §3 for what happens after a
  card's task completes or fails.
- Does not implement an automatic loop; this document describes the message
  shape only.
