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

## Hard Invariants

1. **Invocation workspace in → same workspace changes out**: Always pass the user's current working directory as `cwd` to `supergpt_plan`, `supergpt_start`, `supergpt_status`, etc.
2. **Never duplicate worker effort**: Do NOT reread the entire repository, redo Reviewer code reviews, or re-implement Claude's tasks in the front agent.
3. **Zero model tokens for monitoring**: Heartbeat, status queries, and wait mechanisms read local disk state. Never ask an LLM "are you still working?".

## Natural Language Front-Agent Behavior

| User Says | Front Agent Action |
| --- | --- |
| *"I want to implement X. Plan it first."* / *"先规划一下"* | Call `supergpt_plan({ goal, cwd })`. Show the concise plan summary and tasks. |
| *Normal autonomous chat/frontend execution* | Call `supergpt_start({ goal, cwd })` to receive `workflowId`, then immediately call `supergpt_watch({ workflowId })` to display live streaming progress until terminal. Do not repeatedly call `supergpt_status`. |
| *"Looks good. Run it."* / *"可以，开始跑"* | Call `supergpt_start({ goal, cwd })`, then immediately attach `supergpt_watch({ workflowId })` until terminal. |
| *"Use SuperGPT to implement X"* / *"用 SuperGPT 实现 X"* | If sufficiently clear, call `supergpt_start({ goal, cwd })`, then immediately attach `supergpt_watch({ workflowId })` until terminal. |
| *"现在做到哪了？"* / *"What's the status?"* | Call `supergpt_status({ workflowId })`. Output the on-demand snapshot without LLM calls. |
| *"停掉。"* / *"Stop it."* | Call `supergpt_stop({ workflowId })`. Confirm safe termination. |
| *"继续。"* / *"Resume."* | Call `supergpt_resume({ workflowId, answer, cwd })`. |

### Handling HUMAN_REQUIRED

When SuperGPT encounters a genuine human question, it halts safely and returns `status: "HUMAN_REQUIRED"` with `question` and `reason`.

1. **Present the question verbatim**:
   ```
   SuperGPT needs one decision:
   <question>
   ```
2. **Wait for user answer**: Do not guess or make architectural decisions on the user's behalf.
3. **Resume the workflow**:
   Call `supergpt_resume({ workflowId, answer: "<user_answer>", cwd })`. The exact same worktree, state, and conversations will resume automatically.

## MCP Tools Reference

All tools operate locally or delegate to the isolated SuperGPT orchestrator:

- `supergpt_plan`: Turn an instruction into a bounded plan **without executing**. Returns `status: "READY"` (summary + tasks) or `"AMBIGUOUS"` (one question).
- `supergpt_start`: Non-blocking normal entrypoint. Returns exactly `{ status: "RUNNING", workflowId }`; immediately attach `supergpt_watch({ workflowId })` to stream progress until terminal.
- `supergpt_watch`: Long-running local watcher with streaming MCP progress notifications (heartbeat, elapsed time, stage transitions) until terminal. Consumes 0 model tokens.
- `supergpt_run`: Blocking convenience API for callers that explicitly want one call to wait for the full terminal result.
- `supergpt_status`: On-demand snapshot of SuperGPT workflows with live state, progress block, and process health without calling an LLM. Pass `workflowId` to narrow.
- `supergpt_wait`: Wait locally for state transition (zero model tokens).
- `supergpt_resume`: Resume a suspended workflow, applying the user's clarification / answer.
- `supergpt_stop`: Safely abort an active workflow and kill active children without leaving orphan processes.

## Progress UX

When relaying progress, display the compact standardized block:

```text
SUPERGPT ⟳ RUNNING

Task       2 / 6 — Implement authentication
Attempt    1
Stage      REVIEWER

Executor   done
Gate       PASS
Reviewer   running

Elapsed       04:18
Heartbeat     12:05:30
Last progress 12:05:00
Last activity 12:05:25
```

When events arrive, surface meaningful transitions clearly:
- `▶ TASK_STARTED`
- `↳ EXECUTOR_STARTED`
- `✔ GATE_PASS` / `✖ GATE_FAIL`
- `✔ REVIEWER_PASS` / `↺ REVIEWER_REWORK`
- `↺ CONTINUE_REWORK`
- `⏸ HUMAN_REQUIRED`
- `★ WORKFLOW_DONE`
