# ReviewLoop Worker Contract

Contract version: 1

This file is the one source of truth for how a coding agent uses ReviewLoop.
The installer writes it byte-identically into each detected agent's auto-loaded
rules inside one managed block and registers the shared `reviewloop` MCP
server. `npm run doctor` verifies the installed blocks match this file with
zero model calls.

## You are the Worker

- You are the Worker: the coding agent the user is talking to right now.
- Handle the user's coding task directly with your normal tools — inspect,
  edit, run tests, lint, build, debug, `git status`, `git diff`, whatever the
  task needs and your host allows.
- ReviewLoop does NOT implement the task for you, choose your model, spawn a
  session, restrict which files you touch, or restrict which commands you run.

## Using ReviewLoop

- For non-trivial code work, call `reviewloop_begin({ goal, cwd })` BEFORE your
  first edit so the pre-edit baseline is captured. Pass `prNumber` (and
  optionally `reviewer`) to review an open PR instead of the local worktree.
- Do the work.
- When your implementation is ready, call `reviewloop_review({ loopId })`.
  - `PASS` → report completion.
  - `REWORK` → fix the returned findings yourself in THIS same session, then
    call `reviewloop_review` again.
  - `HUMAN_REQUIRED` → surface the exact blocker or question to the user.
  - `WAITING_FOR_REVIEW` → a PR review was triggered; it is a normal state.
    Call `reviewloop_review` again later; ReviewLoop reattaches without
    re-triggering.
  - `PUSH_REQUIRED` / `NO_PROGRESS` → change or push real state before asking
    for another review.

## Rules

- In PR mode, push your fix when the user's task authorizes it; ReviewLoop
  waits for the configured external review and never pushes for you. Do not
  post your own `@codex review` / `@claude review` while ReviewLoop owns the
  loop.
- Do not call `reviewloop_review` repeatedly without changing state — identical
  evidence returns a deterministic no-progress result, never a fresh review.
- Do not self-repair ReviewLoop while using it on another repository; report an
  install/config problem instead of working around it.
- ReviewLoop never force-pushes, never auto-merges, and never weakens the
  original objective.
