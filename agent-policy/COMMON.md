# ReviewLoop Worker Contract

Contract version: 2

The one source of truth for how a coding agent uses ReviewLoop. The installer
writes it byte-identically into each agent's auto-loaded rules inside one
managed block; `npm run doctor` verifies the match with zero model calls.

## You are the Worker

- You are the Worker: the coding agent the user is talking to right now.
- Handle the user's coding task directly with your normal tools — inspect,
  edit, test, lint, build, debug, `git`, whatever the task needs.
- ReviewLoop does NOT implement the task, choose your model, spawn a session,
  or restrict which files or commands you touch.

## Using ReviewLoop

- For non-trivial code work, call `reviewloop_begin({ goal, cwd })` BEFORE your
  first edit to capture the pre-edit baseline. Pass `prNumber` (and optionally
  `reviewer`) to review an open PR instead of the local worktree.
- Do the work.
- When your implementation is ready, call `reviewloop_review({ loopId })`.
  - `PASS` → report completion.
  - `REWORK` → fix the returned findings yourself in THIS same session, then
    call `reviewloop_review` again.
  - `HUMAN_REQUIRED` → **STOP.** Surface the blocker to the user and wait for a
    new explicit instruction. Do not resume by any route — new `reviewloop_begin`,
    other reviewer, new session, fresh HEAD/push all count as bypass.
  - `WAITING_FOR_REVIEW` → a PR review was triggered; normal. Call
    `reviewloop_review` again later; it reattaches without re-triggering.
  - `PUSH_REQUIRED` / `NO_PROGRESS` → change or push real state first.
- A PR `reviewloop_begin` can return `HUMAN_APPROVAL_REQUIRED` (not a `loopId`):
  the PR's prior loop spent its round budget with blocking findings open and is
  latched. You cannot clear it — report it; a human runs `reviewloop pr-latch
  approve <prNumber>` to grant one fresh budget.

## Rules

- In PR mode, push your fix when the user's task authorizes it; ReviewLoop
  waits for the configured external review and never pushes for you. Do not
  post your own `@codex review` / `@claude review` while ReviewLoop owns the
  loop.
- Do not call `reviewloop_review` repeatedly without changing state — identical
  evidence returns a deterministic no-progress result, never a fresh review.
- Do not self-repair ReviewLoop while using it on another repository; report an
  install/config problem instead of working around it.
- ReviewLoop never force-pushes, auto-merges, weakens the objective, or lets
  you reset a spent review-round budget without a human.
