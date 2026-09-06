# ReviewLoop roadmap

## Shipped (this migration)

- Worker-owned execution architecture; Front Agent / Planner / Executor pool /
  Sonnet-only chain / Fast-Full / taskCohesion removed.
- Active model roles reduced to `reviewer` + `supervisor`.
- ReviewLoop local review loop: baseline capture → Gate → Reviewer →
  convergence policy → Supervisor (exception-only) → PASS / REWORK /
  HUMAN_REQUIRED.
- PR review controller: one `@codex/@claude review` per HEAD, zero-model local
  wait, durable `WAITING_FOR_REVIEW`, exact-HEAD binding, duplicate-trigger
  prevention.
- Token Safety migrated to `REVIEWLOOP_*` limits, scoped to Reviewer +
  Supervisor; `UNKNOWN != ZERO` and reservation-settlement invariants retained.
- MCP surface reduced to `reviewloop_begin` + `reviewloop_review`.
- CLI / MCP / package renamed to `reviewloop`.
- Global installer migrates a legacy SuperGPT install transactionally
  (managed block, MCP registration, AGY skill) with rollback; partial-agent
  installs supported.
- Deterministic/mock test suite for the new architecture.

## Not yet run (needs real providers / real GitHub)

- ReviewLoop real-provider Reviewer/Supervisor E2E.
- ReviewLoop real PR external-review loop (`@codex review` / `@claude review`).
- A controlled `Worker + ReviewLoop` vs `Worker alone` wrapper benchmark
  (ReviewLoop cannot observe Worker token usage through MCP, so active
  telemetry must not manufacture an E2E multiplier).

## Later

- Production wiring of provider-specific Reviewer/Supervisor adapters through
  `roleRouting` (currently a lean `callAgy` path).
- PR backend wired to the `gh` CLI.
- Optional read-only ReviewLoop dashboard (removed in this migration; re-add
  only if it can stay zero-token and simple).
