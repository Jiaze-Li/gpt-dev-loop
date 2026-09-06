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

## Independent-review blocker pass (this change)

- Malformed Reviewer/Supervisor output fails closed (never CLEAN, never valid
  REWORK guidance).
- Aggregate Token Safety is durable across rounds and restarts.
- Production PR backend wired via the `gh` CLI (read + one trigger comment).
- Strict PR trust boundary (reviewer identity + explicit reviewed HEAD ==
  current HEAD), reusing the V2 trusted-review primitives.
- No silent diff truncation — bounded or deterministically chunked review.
- Reviewer/Supervisor pool routed through RoleRouter; the CallIntent binds the
  actually-selected family; bounded failover re-authorizes.
- Full baseline attribution via `git stash create`; unattributable state and
  "no Worker change yet" both fail safely.
- Baseline Gate evidence captured at `begin` (0 model tokens).
- PR reviewer default = `codex`; `internal` can never be a PR trigger identity.

## Not yet run (needs real providers / real GitHub)

- ReviewLoop real-provider Reviewer/Supervisor E2E (only the `agy` families
  have a live transport in this build; `codex`/`claude` families are
  capability-declared but marked unavailable until their transports are wired).
- ReviewLoop real PR external-review loop (`@codex review` / `@claude review`).
- Real multi-provider failover (structurally wired + mock-certified).
- A controlled `Worker + ReviewLoop` vs `Worker alone` wrapper benchmark
  (ReviewLoop cannot observe Worker token usage through MCP).

## Later

- Live `codex` / `claude` Reviewer/Supervisor transports.
- Optional read-only ReviewLoop dashboard (removed in this migration; re-add
  only if it can stay zero-token and simple).
