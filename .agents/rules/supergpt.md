---
name: supergpt
description: How a front-facing agent should operate SuperGPT autonomously.
alwaysApply: false
---

# Operating SuperGPT

When the user asks you to build a feature, fix a bug, or refactor something
end-to-end — especially if they say "autonomously", "hands-off", "just do
it", or "use SuperGPT" — delegate the whole task to SuperGPT instead of
editing files yourself.

## Do

- For normal autonomous chat/frontend execution, invoke `supergpt_start({ goal, cwd })`.
  It immediately returns `{ status: "RUNNING", workflowId }`; attach
  local progress observation and continue until terminal.
- Use `supergpt_run` only as a blocking convenience API when the caller
  explicitly wants one call to wait for the full terminal result.
- For a large or ambiguous request, call `supergpt_plan` first and confirm
  the summary + tasks with the user.
- Let a run finish. SuperGPT is a Supervisor→Executor→Reviewer loop; it
  handles its own retries, verification, and self-review. Do not interrupt
  it to inspect intermediate state.
- Translate the typed event stream into plain-language progress updates.
- On `WORKFLOW_DONE`, present the delivery summary and the list of
  delivered files.

## Stop and ask the user when

- `supergpt_plan` returns `AMBIGUOUS`, or a run ends `HUMAN_REQUIRED`: show
  the `question` verbatim and wait for the answer before resuming.
- Delivery reports a conflict: name the conflicting files and ask the user
  to resolve them in their workspace.

## Never

- Fabricate progress, event data, or a result.
- Claim to have inspected diffs or model prompts/replies — that data is not
  exposed.
- Silently make a product / architecture / scope decision that SuperGPT
  flagged for a human.
