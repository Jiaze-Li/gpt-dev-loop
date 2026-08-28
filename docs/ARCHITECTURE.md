# SuperGPT V1 architecture — current source of truth

SuperGPT is a local autonomous coding workflow. Its deterministic core owns
state, isolation, delivery, progress, and policy; models supply only bounded
role decisions or execution output.

## V1 functional freeze

V1 is frozen at the production contracts documented here: frontend ->
AutoRoutePolicy -> `supergpt_prepare` -> `supergpt.request/v1`; role-routed
Planner, Supervisor, Executor and Reviewer; deterministic Gate; scoped REWORK;
delivery and cleanup. Cross-cutting policy, quota, health, effort, session,
usage-callId, anomaly, process-telemetry, acceptance-snapshot and workspace
contracts are frozen with it. No V1.1 parallel execution behavior is present.

```text
USER / FRONTEND
  natural engineering request
    -> AutoRoutePolicy -> supergpt_prepare -> supergpt.request/v1
    -> persisted deterministic core

SUPERGPT CORE
  Planner RoleRouter -> Supervisor RoleRouter -> Executor RoleRouter
    -> deterministic Gate -> scoped Reviewer RoleRouter
    -> REWORK (only when required) -> delivery -> cleanup
```

## Frontends and public contract

Frontends are thin adapters. They pass the exact invocation workspace and
never create internal Task Cards, infer state from logs, or perform review.
The stable operations are `supergpt_prepare`, `supergpt_plan`,
`supergpt_run`/`supergpt_start`, `supergpt_status`, `supergpt_wait`,
`supergpt_resume`, and `supergpt_stop`.

`supergpt_prepare` accepts raw natural-language intent and returns the small
portable `supergpt.request/v1` object. Planning then creates internal task
cards. This makes a fresh Gemini, Claude, Codex, or generic frontend
zero-knowledge: tool discovery tells it to call prepare rather than inventing
orchestration syntax.

Status and wait read persisted local state only. They make no model calls.
The generic renderer is portable text; the terminal renderer adds an in-place
spinner, elapsed time, heartbeat, and durable transition lines only for TTYs.
JSON mode has no ANSI output.

### Human-visible progress and ownership

`FrontendProgressObserver` is the chat/agent frontend binding. Immediately
after a non-blocking start returns a `workflowId`, the frontend attaches this
local subscriber and renders only meaningful persisted transitions: task/total
and title, task-local attempt, stage, routed role/provider/model, Gate and
Reviewer result, and terminal state. `HUMAN_REQUIRED` is rendered as a
distinct intervention request with the persisted question. A new frontend can
attach using the same workflow ID and receives the current canonical state;
it never invents state from a model response.

The observer polls `status` locally. Spinner, elapsed time, heartbeat,
last-progress and last-activity formatting are also local. They create zero
provider/model calls. Stopping or disconnecting an observer only stops its
timer: workflow state, provider children, isolation and delivery remain Core
owned. Terminal state stops the observer cleanly.

Normal internal reports and task artifacts are optional/viewable evidence,
never approval prompts or a workflow dependency. A frontend must label them
as optional if its host displays an artifact count. Only `HUMAN_REQUIRED`
means a blocking human action is needed; `resume` is then the sole way to
continue that suspended workflow.

## Roles, aliases, quota, and provider health

Roles are independent of frontends and are routed role-first, not provider-first.
The policy contains stable family aliases; a provider resolves its current
concrete model at invocation time and records both `requestedFamily` and
`resolvedModel`. A resolution change emits routing telemetry and does not
require a policy edit.

```text
Planner:    codex:default > agy:gemini > claude:opus > agy:gpt-oss
Supervisor: agy:gemini > codex:default > claude:opus > agy:gpt-oss
Reviewer:   agy:gpt-oss > codex:default > agy:gemini > claude:opus
Executor:   claude:sonnet > codex:default > claude:opus
Gate:       local deterministic verification
```

`RolePolicy`, `QuotaPoolRegistry`, `ProviderHealthRegistry`, `EffortPolicy`,
and `TokenAwareSessionPolicy` are separate deterministic concerns. The default
quota topology is Codex (`codex:default`), shared Claude (`claude:sonnet` and
`claude:opus`), AGY Gemini, and AGY Claude/GPT (`agy:gpt-oss`). Runtime native
telemetry may add or override family-to-pool membership without changing role
policy. Pool state is user-level runtime state, never target-repository state.

Readiness, cooldown/reset lookup, routing, effort and session decisions are
zero-token. A known cooldown is skipped; an UNKNOWN pool is allowed one real
business invocation when no free native telemetry exists. Quota/rate-limit
errors update every shared pool immediately. Structured reset time wins;
otherwise a configurable persisted exponential local backoff moves from
COOLDOWN to UNKNOWN at expiry. No model prompt is used as a health probe.

Typed provider failures include quota exhaustion, rate limit, auth failure,
unavailable, timeout, and protocol errors. A recoverable failure emits
`ROLE_PROVIDER_FAILED` then `ROLE_PROVIDER_SWITCHED`, preserving workflow and
task state through a local checkpoint. Quota failure never attempts the same
provider at higher effort.

The handoff uses a deterministic checkpoint: goal, canonical request, plan,
completed/current/remaining tasks, attempt, Gate/Reviewer results, constraints
and workflow decisions. It does not copy provider conversation history.
Supervisor physical sessions reuse by default. Native input/cache/latency,
context pressure, provider compaction, protocol instability and a safety call
ceiling can trigger local checkpoint + rotation. Missing telemetry simply
removes that signal; token values are never estimated.

Reasoning effort defaults to medium when supported. Deterministic repeated
reasoning failure, rework cycles, or high-risk work can escalate to high. A
provider without an effort API is invoked normally.

Codex Supervisor uses `codex exec` in read-only, ephemeral,
`--ignore-user-config` mode by default. It has no repository-editing tools,
skills, or inherited MCP servers. Native usage is recorded when present; it
is never estimated. The opt-in `npm run probe:provider-overhead` command is
the only fixed-prompt live transport measurement and never updates baselines.

## Workflow and safety

The workflow is one task at a time: Supervisor -> fresh Claude Executor ->
Gate -> task-scoped Reviewer -> Supervisor. REWORK loops back through a fresh
Executor attempt and preserves the Reviewer for that task. Parallel DAG
execution is deliberately out of scope for v1.

Before execution, SuperGPT snapshots the exact invocation workspace into an
owned isolated worktree. It supports primary checkouts, linked worktrees,
branches, staged/unstaged edits, and untracked files. Delivery is fail-closed
and returns approved changes to the same invocation workspace while preserving
unrelated edits. Successful workflows clean only positively-owned worktrees,
branches, and children; resumable states retain their owned resources.

Every workflow ends durably as `WORKFLOW_DONE`, `HUMAN_REQUIRED`, `FAILED`,
`TIMEOUT`, `STALLED`, or `STOPPED`. Resume retains the workflow ID, completed
tasks, reviewer state, and required isolation resources. Stop terminates
owned active children and persists `STOPPED`.

## Token and operational guardrails

Usage records carry immutable provider call IDs. Deterministic monitoring
detects duplicate accounting, unexpected call count, prompt inflation, and
compatible-baseline regressions plus `SESSION_REUSE_INEFFICIENT` conditions.
`npm test` and `npm run benchmark` make zero model calls. Only explicit live
commands consume provider quota. `doctor` is local-only and checks runtimes,
configuration, aliases, configured pools, persisted cooldowns, writable
storage, and stale owned resources.

Organic Reviewer REWORK is deliberately reported as **NOT YET OBSERVED** until
the passive `OrganicReworkRecorder` captures a genuine production occurrence.
The deterministic REWORK path is verified, and durable recorder evidence is
preserved independently of workflow cleanup; the absence of organic evidence
does not downgrade V1 readiness.

## Installation and extension

`npm run install-global` installs the MCP server and the Gemini-compatible
skill once; see `docs/GLOBAL_INSTALL.md`. A frontend extension implements the
thin public contract. A provider extension implements the logical role
protocol, typed failures, native usage when available, and compact checkpoint
input; it never changes Core semantics.

## History and v1.1

The legacy Chrome/ChatGPT Web bridge, extension transport, browser tabs, and
DOM selectors are explicitly **HISTORY/LEGACY**, not part of the production
SuperGPT entrypoints or active RoleRouter composition. They must not be
presented by doctor or current installation instructions as production
architecture. v1.1 is limited to parallel task DAG execution with isolated
task worktrees and an explicit integration task; it is not implemented in V1.
