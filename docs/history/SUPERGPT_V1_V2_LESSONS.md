# SuperGPT V1 / V2 — what we kept, what we dropped, and why

This document explains **why** ReviewLoop has the architecture it does. It is
historical; nothing here describes the current active system.

## What V1 got right (kept)

- The product is a development / review loop, not necessarily a new coding
  agent.
- Mechanical, deterministic transport.
- Git diff as primary review evidence.
- An independent Reviewer, separate from whoever wrote the code.
- Reviewer approval gates completion.
- A `HUMAN_REQUIRED` escape hatch.
- Bounded retry (no unlimited loops).

## What V2 added that survives

- Token Safety: `CallIntent → authorize → PhysicalCallPermit → dispatch →
  SETTLED_KNOWN | UNRESOLVED`.
- Reservation settlement; `UNKNOWN != ZERO`.
- New Information gating (`NO NEW INFORMATION → NO NEW MODEL CALL`).
- Provider quota / health routing.
- `ExternalModelTriggerAuthority` for `@codex/@claude review`.
- Explicit PR reviewer identity; exact PR-HEAD binding; stale-review
  invalidation.
- Local zero-model polling for external review.
- Durable state / resume.
- Non-convergence detection; Supervisor as an exception-only role.

## What V2 over-owned (removed in ReviewLoop)

- Front Agent routing (`supergpt_route` → `DIRECT | SUPERGPT`).
- Planner and speculative task decomposition.
- Task splitting / `taskCohesion` / Fast vs Full paths.
- An internal Executor provider pool and a Sonnet-only automatic chain.
- Fresh Executor sessions on rework.
- Isolated execution worktree + "safe delivery" ownership.
- SuperGPT-owned repair / push in PR closeout.

The Worker (the user's own coding agent) already has the repository, the code
it just read, the architecture, its own changes, and the tests it ran.
Re-onboarding a fresh internal Executor threw that context away every round.

## Measured legacy token economics (historical — NOT ReviewLoop numbers)

V2 FAST fresh-session E2E usageVolume: **~2.08× Direct**
V2 forced FULL E2E usageVolume: **~4.66× Direct**

Representative FAST breakdown (usageVolume):

```
Direct        = 88,042
Front         = 70,673
Executor      = 98,208
Reviewer      = 14,299
SuperGPT E2E  = 183,180
```

- The Executor's initial task prompt itself was small.
- Full agent-session bootstrap / context / tool schema / cache dominated.
- Forced FULL suffered from multiple fresh Executor sessions; task splitting
  created repeated onboarding cost.
- Dollar cost and `usageVolume` are separate axes; the multipliers above are
  `usageVolume`. These are measured historical results, not estimates, and not
  a ReviewLoop claim.

ReviewLoop cannot observe the foreground Worker's token usage through MCP, so
its active telemetry does not manufacture an E2E multiplier. Structurally the
first-pass overhead is: Direct Worker + one compact independent Reviewer call.

## Bugs / lessons

1. **Planner known usage was dropped before spend settlement**, incorrectly
   creating an unresolved reservation. Lesson: wrapper layers must preserve
   provider-native usage; unknown is not zero. (Planner is deleted; the
   generic invariant is still tested at the `ModelSpendAuthority` /
   reservation boundary.)
2. **`taskCohesion` could treat an identical broad verifier as a shared
   surface** — e.g. disjoint `auth/` and `billing/` file scopes merged only
   because both ran `npm test`. Lesson: speculative deterministic task
   decomposition introduces semantic edge cases; ReviewLoop removes the whole
   class by having no Planner and no task collapse.
3. **Front-agent polling could repeatedly wake the model.** Lesson: all
   waiting belongs in a local deterministic process / blocking MCP call.
4. **Executor command restrictions created complexity** around probe /
   permission classification. Lesson: do not sandbox the user's own
   foreground Worker; constrain ReviewLoop's automated authority instead.
5. **A pending external review was treated as `HUMAN_REQUIRED`.** Lesson:
   `WAITING_FOR_REVIEW` is a normal durable state that reattaches on resume.
