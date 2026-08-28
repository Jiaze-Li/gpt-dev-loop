---
name: supergpt
description: Delegate a coding task to SuperGPT, an autonomous Supervisor→Executor→Reviewer development loop that runs in an isolated worktree and delivers reviewed changes back to the workspace. Use when the user wants a feature built, a bug fixed, or a refactor done end-to-end without step-by-step guidance — and let SuperGPT run without micromanaging it.
---

# SuperGPT

SuperGPT is an autonomous development loop. You hand it a goal; it plans,
implements, verifies, and self-reviews inside an isolated git worktree, then
safely delivers the approved changes back to the invocation workspace. Your
job as the front-facing agent is to **launch it, monitor it, and relay
results** — not to drive each step.

## When to use

- The user asks for a feature, bug fix, or refactor that SuperGPT can own
  end-to-end.
- The user explicitly wants autonomous / hands-off execution.

Do **not** use it for one-line edits you can do directly, or for tasks the
user wants to pair on interactively.

## Interfaces

Prefer MCP tools when the MCP server (`bin/supergpt-mcp.js`) is connected.
Otherwise use the CLI.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `supergpt_plan` | Turn an instruction into a bounded plan **without executing**. Returns `status: "READY"` (summary + tasks) or `"AMBIGUOUS"` (one question). |
| `supergpt_run` | Run the full loop. Returns `{ status, summary, deliveredFiles, workflowId, reason, question, events }`. |
| `supergpt_status` | List started workflows from safe workspace metadata. Pass `workflowId` to narrow. |

### CLI

```
supergpt "<instruction>"                      # run from a natural-language goal
supergpt --plan=<path>                         # run from an existing plan file
supergpt "<goal>" --output-format=json|text    # json streams ndjson events
supergpt "<goal>" --cwd=<path>                 # invocation workspace
```

`SUPERVISOR_PROVIDER=agy REVIEWER_PROVIDER=agy` must be set for a real run.

## Workflow

1. **(Optional) Plan first.** For a large or vague request, call
   `supergpt_plan` (or read the plan file) and show the user the summary +
   tasks before running. If it returns `AMBIGUOUS`, ask the user the
   `question` and stop — do not guess.
2. **Run.** Call `supergpt_run` with the goal (or run the CLI with
   `--output-format=json`). Let it run to completion; do not interrupt it to
   "check in".
3. **Monitor events.** Each ndjson line / `events[]` entry is
   `{ type, timestamp, ... }`. Useful types:
   `workflow_started`, `stage_changed`, `task_started`,
   `task_attempt_started`, `verification_started`, `verification_finished`,
   `review_finished`, `rework_requested`, `human_required`,
   `delivery_succeeded`, `delivery_failed`, `workflow_finished`.
   Report progress in plain language ("planning", "implementing task 2 of
   3", "self-review passed", "delivering").
4. **Handle the terminal status:**
   - `WORKFLOW_DONE` — present the **delivery summary**: the one-line
     `summary` plus the list of `deliveredFiles`. Tell the user the changes
     are in their workspace.
   - `HUMAN_REQUIRED` — **surface `question` verbatim** to the user and
     stop. This is a real decision SuperGPT will not make. Relay `reason`
     too. Resume only after the user answers.
   - `CANCELLED` — say it was cancelled; nothing was delivered.
   - `FAILED` — report `reason`; recommend re-planning or a narrower goal.

## Rules

- Never fabricate progress or a result — only report events/results you
  actually received.
- On `human_required` / `HUMAN_REQUIRED`, always show the question and wait.
- The isolated worktree is never auto-deleted; if delivery reports a
  conflict, relay which files conflict and that the user must resolve them
  in their workspace, then resume.
- `supergpt_status` and events never contain file contents, diffs, or
  model prompt/reply text — do not claim otherwise.
