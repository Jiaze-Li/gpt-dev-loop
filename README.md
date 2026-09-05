# SuperGPT (gpt-dev-loop)

SuperGPT is a local autonomous coding system. A front-facing agent takes a
request, gets one deterministic routing decision, and — when the work belongs
to SuperGPT — launches exactly one workflow. The deterministic Core then owns
path selection, planning, isolated execution, verification, independent review,
rework, delivery, persistence, and recovery.

## Product model

Claude, Codex, and AGY have the same role:

```text
User
  -> Claude / Codex / AGY
  -> one shared frontend policy (agent-policy/COMMON.md)
  -> supergpt_route  ->  DIRECT | SUPERGPT
  -> if SUPERGPT: supergpt_start_and_wait
  -> SuperGPT Core
       -> Fast Path:  Executor -> deterministic Gate -> independent Reviewer
       -> Full Path:  Planner once -> ordered task queue -> Executor -> Gate -> Reviewer
       -> PR Closeout: trusted review -> repair -> Gate -> new head -> re-review
       -> Supervisor only for genuine exceptions
  -> safe delivery back to the invocation workspace
  -> terminal result / genuine HUMAN_REQUIRED
```

The front agent is a human interface and launcher, not a second implementation
engine. Once SuperGPT owns a task, the front agent does not duplicate routing,
planning, coding, testing, review, or rework.

## One frontend contract

`agent-policy/COMMON.md` is the only active front-agent policy. There are no
Claude-, Codex-, or AGY-specific routing/launch policies.

Normal SuperGPT execution is MCP-only for front agents:

1. `supergpt_route({ goal, cwd })` -> `DIRECT | SUPERGPT`
2. if `SUPERGPT`: `supergpt_start_and_wait({ goal, cwd })` -> terminal result / `HUMAN_REQUIRED`
3. return the terminal result or surface a real `HUMAN_REQUIRED` question

`supergpt_route` is deterministic and consumes zero model tokens; the frontend
does not re-interpret the policy itself. `supergpt_start_and_wait` starts the
workflow and blocks locally for the terminal result in a single call — the
front agent model is invoked once to start and once to read the result.

`supergpt_watch` and `supergpt_wait` are manual status / debug / recovery
operations. They are **not** an autonomous polling loop and must not be called
in a loop for normal workflow observation.

The CLI remains available for humans and diagnostics, but it is not an
alternate agent workflow.

## Global install

Prerequisites: Node 20+, Git, AGY, Claude Code, and Codex available on `PATH`.

```bash
npm run install-global
node bin/install-plugin.js --status
```

One installation gives all three frontends the same `supergpt` MCP server and
the same `COMMON.md` behavior. Re-open/restart frontend sessions after
installation so they reload global configuration.

See `docs/GLOBAL_INSTALL.md` for details.

## Workflow paths

`supergpt_route` sends substantial work to the Core, which selects a path:

### Fast Path

For one safely bounded implementation task:

```text
Executor
  -> deterministic Gate
  -> independent Reviewer
     PASS   -> WORKFLOW_DONE
     REWORK -> fresh Executor session
```

Planning is skipped only when the Core can safely form a single bounded task
contract; otherwise the Core uses the Full Path.

### Full Path

For larger / multi-step work:

```text
Planner once
  -> ordered task queue
  -> Executor
  -> deterministic Gate
  -> independent Reviewer
     PASS -> next task / WORKFLOW_DONE
     first ordinary REWORK -> Executor
     Gate failure -> Executor
     ambiguity / repeated non-convergence / plan mismatch -> Supervisor
```

Reviewer independence is preserved in both paths. Supervisor is exception-only
and never part of the normal happy path.

### PR Closeout

For "review and fix PR #N" style requests:

```text
trusted review
  -> actionable finding -> repair task -> Executor -> deterministic Gate -> push new head -> re-review
  -> clean -> WORKFLOW_DONE
  -> repeated finding after repair / limit reached -> HUMAN_REQUIRED
```

The trusted reviewer is a separate read-only trust boundary. SuperGPT never
force-pushes and never merges automatically.

## Token Safety

Every metered internal model call passes a fail-closed spend boundary before it
happens:

```text
eligible New Information
  + role capability
  + per-call and aggregate budget
  + reservation safety
  -> PhysicalCallPermit
  -> physical model call
  -> known settlement (or explicit UNRESOLVED)
```

If prior spend cannot be reconstructed, or an identical failure repeats with an
unchanged diff, the workflow stops through the normal `HUMAN_REQUIRED` path
rather than dispatching another call. Aggregate cost and token-volume ceilings
act as a last-resort mechanical fuse.

## Public MCP operations

- `supergpt_route`
- `supergpt_start_and_wait`
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
- `supergpt_telemetry`
- `supergpt_dashboard_open`

`route`, `status`, `watch`, `wait`, and the deterministic control-plane
operations read local persisted state and do not need model calls.

## Safety and reliability

- exact invocation workspace snapshot and isolated worktree execution;
- deterministic Gate before independent Reviewer acceptance;
- conflict-checked delivery back to the invocation workspace;
- durable terminal states and phase-aware resume;
- fail-closed model-spend boundary with per-call and aggregate ceilings;
- provider failover, quota/health policy, bounded retries, and process cleanup;
- no browser/ChatGPT-Web dependency in the production path.

## Release status

SuperGPT **V2 is the current release candidate**. `docs/ROADMAP.md` tracks
status; `docs/V2_PLAN.md` records the agreed V2 design.

- centralized deterministic `supergpt_route` + route-first frontend contract — done
- Fast Path / Full Path selection — done
- PR Closeout review/repair/re-review loop — done
- bounded escalation / non-convergence handling — done
- unattended functional workflow — mock-certified
- Token Safety architecture — mock-certified
- real-provider plumbing — verified for **one bounded Fast Path workflow** only

Provider failover, escalation, PR closeout, and the full provider pools have
**not** been live-certified. An optional browser adviser remains deferred future
work. Historical browser-bridge material is retained only under
`docs/handoff/archive/` and Git history.

## License

MIT
