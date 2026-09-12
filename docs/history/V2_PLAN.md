# SuperGPT V2 Plan

This document records the agreed V2 direction so the work does not depend on
chat history or revive retired paths.

## Status

Implemented through V2-C and unattended functional certification. V2-A, V2-B,
and V2-C are complete, and implementation-order items 1–5 below are done.
Token Safety and the V2 unattended functional workflow are mock-certified; one
bounded Fast-Path workflow has additionally passed a real-provider smoke.

V2-D (browser adviser) remains optional / deferred and is **not** required for
the V2 release.

For current status tracking see `docs/ROADMAP.md`; for the current architecture
see `docs/ARCHITECTURE.md`.

## Product goal

Reduce user attention cost without weakening independent verification.

```text
User
-> Claude / Codex / AGY (same launcher contract)
-> shared routing decision
-> DIRECT or SuperGPT
-> SuperGPT works unattended
-> human returns only for a genuine HUMAN_REQUIRED decision
```

Reliability and reducing repeated human participation take priority over token savings.

## V1 baseline — do not re-implement

V2 starts from these V1 contracts:

- one canonical execution engine: `runSuperGPT()`;
- one active frontend policy: `agent-policy/COMMON.md`;
- Claude, Codex, and AGY all launch through the same global `supergpt` MCP;
- no client-specific routing policy and no agent CLI fallback;
- Planner provides a structured task queue for normal Full Path workflows;
- Core advances normal task transitions deterministically;
- Reviewer PASS advances automatically;
- Gate failure and first ordinary Reviewer REWORK return directly to Executor;
- Supervisor is exception-only;
- Reviewer remains independent.

## V2-A — centralized `supergpt_route`

V1 still asks the front model to interpret the same COMMON policy. V2 moves DIRECT vs SuperGPT into a shared local deterministic operation.

Every code-modification request from Claude, Codex, or AGY should call:

```text
supergpt_route({ goal, cwd })
-> DIRECT | SUPERGPT
```

The router consumes zero model tokens and is authoritative.

Policy:

- explicit request not to use SuperGPT -> DIRECT;
- explicit request to use SuperGPT -> SUPERGPT;
- explanation/research/non-modifying request -> DIRECT;
- clearly trivial single-step low-risk edit -> DIRECT;
- feature, bug fix, refactor, migration, debugging, tests, multi-file/layer work, or repeated implement/verify work -> SUPERGPT;
- uncertain classification -> SUPERGPT.

Acceptance: the same request gets the same result from Claude, Codex, or AGY because the clients do not implement separate routing logic.

## V2-B — Fast Path and Full Path

Conservative delegation to SuperGPT should not force every task to pay for full planning.

### Fast Path

For one safely bounded implementation task:

```text
Executor
-> deterministic Gate
-> independent Reviewer
-> DONE / REWORK
```

No model Supervisor on the normal path. Planning is skipped only when Core can safely form the single bounded task contract; otherwise use Full Path.

### Full Path

For larger/multi-step work:

```text
Planner once
-> task queue
-> Executor
-> Gate
-> Reviewer
-> next task / ordinary rework
-> Supervisor only on exceptional states
```

Reviewer independence is mandatory in both paths.

## V2-C — PR Closeout Loop

Use the separate trusted account-wide Claude PR reviewer as a post-development closeout gate. SuperGPT remains execution owner; the reviewer remains a separate read-only trust boundary.

```text
SuperGPT implements + tests
-> push/update PR
-> request trusted review
-> clean -> DONE
-> actionable finding -> repair task
-> Executor fixes
-> deterministic tests
-> push
-> request review again
-> repeat or escalate
```

Rules:

- clean trusted review -> DONE;
- actionable P1/P2 -> FIX;
- fix + tests PASS -> PUSH -> review again;
- same finding repeated after repair -> Supervisor;
- unresolved again after escalation -> HUMAN_REQUIRED;
- default maximum automatic repair rounds: 5;
- external PR-head change invalidates stale assumptions; re-read latest head;
- never force-push;
- no automatic merge by default;
- no automatic `.github/workflows/**` modification unless explicitly allowed;
- fork PR is review-only unless a safe write path is explicit;
- trust only the configured reviewer identity.

## V2-D — optional browser adviser

The tested browser/Fixer transport may later exist only as an optional adviser/provider for unusually difficult cases.

It must never become:

- workflow owner;
- normal Supervisor path;
- dependency for execution, review, progress, resume, or delivery;
- a second frontend launch path.

The local deterministic Core remains always awake.

## Frontend rule for V2

Keep exactly one frontend contract:

```text
agent-policy/COMMON.md
-> installed unchanged for Claude, Codex, and AGY
-> same supergpt MCP tools
-> supergpt_route becomes authoritative
```

Do not create CLAUDE/CODEX/AGY policy fragments. Client configuration differences stay private inside the installer.

## Implementation order

1. add/test `supergpt_route` — done;
2. update COMMON to require route-first behavior (and `supergpt_start_and_wait`
   single-call launch-and-block) — done;
3. add Fast/Full Path selection — done;
4. add trusted PR-review ingestion and Closeout Loop — done;
5. add bounded escalation/non-convergence end-to-end tests — done;
6. consider optional browser adviser last — deferred / optional.

## Success criteria

- Claude, Codex, and AGY have identical delegation behavior;
- substantial coding work reaches SuperGPT without the user naming it;
- trivial work avoids unnecessary full orchestration;
- Supervisor remains off normal paths;
- independent Reviewer remains mandatory;
- PR findings can be fixed and re-reviewed without human message forwarding;
- humans are required only for product/architecture decisions, repeated non-convergence, unsafe repository state, or explicit safety boundaries.

## Non-goals

- no default auto-merge;
- no always-running model replacing deterministic Core;
- no broad removal/batching of independent Reviewer checks;
- no browser automation as production-critical infrastructure;
- no separate Claude/Codex/AGY execution paths;
- no legacy fallback retained beside a new canonical rule.
