# SuperGPT (gpt-dev-loop)

SuperGPT is a local autonomous coding system. A front-facing agent launches one workflow; the deterministic Core owns planning, isolated execution, verification, independent review, rework, delivery, persistence, and recovery.

## Product model

Claude, Codex, and AGY have the same role:

```text
User
  -> Claude / Codex / AGY
  -> one shared frontend policy
  -> one shared SuperGPT MCP
  -> runSuperGPT()
  -> Planner
  -> Executor
  -> deterministic Gate
  -> independent Reviewer
  -> next task / rework
  -> Supervisor only for genuine exceptions
  -> safe delivery
```

The front agent is a human interface and launcher, not a second implementation engine. Once SuperGPT owns a task, the front agent does not duplicate planning, coding, testing, review, or rework.

## One frontend contract

`agent-policy/COMMON.md` is the only active front-agent policy. There are no Claude-, Codex-, or AGY-specific routing/launch policies.

Normal SuperGPT execution is MCP-only for front agents:

1. `supergpt_start({ goal, cwd })`
2. `supergpt_watch({ workflowId })`
3. return the terminal result or surface a real `HUMAN_REQUIRED` question

The CLI remains available for humans and diagnostics, but it is not an alternate agent workflow.

## Global install

Prerequisites: Node 20+, Git, AGY, Claude Code, and Codex available on `PATH`.

```bash
npm run install-global
node bin/install-plugin.js --status
```

One installation gives all three frontends the same `supergpt` MCP server and the same `COMMON.md` behavior. Re-open/restart frontend sessions after installation so they reload global configuration.

See `docs/GLOBAL_INSTALL.md` for details.

## V1 workflow

For a reliable Planner task queue, normal transitions are deterministic:

```text
Planner once
  -> Executor
  -> Gate
  -> Reviewer
     PASS -> next task / WORKFLOW_DONE
     first ordinary REWORK -> Executor
     Gate failure -> Executor
     ambiguity / repeated non-convergence / plan mismatch / HUMAN_REQUIRED -> Supervisor
```

Reviewer independence is preserved. Supervisor is not part of the normal happy path.

## Public MCP operations

- `supergpt_prepare`
- `supergpt_plan`
- `supergpt_start`
- `supergpt_run`
- `supergpt_watch`
- `supergpt_status`
- `supergpt_wait`
- `supergpt_verify`
- `supergpt_resume`
- `supergpt_stop`

Status/watch/wait and deterministic control-plane operations read local persisted state and do not need model calls.

## Safety and reliability

- exact invocation workspace snapshot and isolated worktree execution;
- deterministic Gate before independent Reviewer acceptance;
- conflict-checked delivery back to the invocation workspace;
- durable terminal states and phase-aware resume;
- provider failover, quota/health policy, bounded retries, and process cleanup;
- no browser/ChatGPT-Web dependency in the V1 production path.

## Roadmap

V1 is the current production baseline. `docs/V2_PLAN.md` is the sole active V2 plan. V2 adds centralized zero-token `supergpt_route`, Fast/Full paths, and the PR review/fix/re-review closeout loop without reintroducing parallel frontend policies.

Historical browser-bridge material is retained only under `docs/handoff/archive/` and Git history.

## License

MIT
