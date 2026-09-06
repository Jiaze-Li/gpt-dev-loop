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

## Release-hardening pass (this change)

Phased on top of the blocker passes; deterministic/mock `npm test` + `npm run
doctor` green. NOT real-provider E2E.

- Default reviewer allowlists are the exact REST bot logins
  (`chatgpt-codex-connector[bot]` / `claude[bot]`); bare slugs untrusted.
- PR review ingestion aggregates every trusted submission + inline comment per
  HEAD; `COMMENTED` / unstructured / inline / `DISMISSED` can no longer read as
  CLEAN; a later `APPROVED` cannot hide an earlier blocking finding.
- Active evidence path: `lstat` before reading any untracked path (symlink /
  special file fails closed); every baseline/diff/HEAD/ls-files git command
  fails closed on a non-zero exit.
- Verification plan frozen at `reviewloop_begin`; a post-`begin` edit to
  `.reviewloop.json` / the `package.json` test script blocks the review.
- One composite `(diff + gate)` evidenceId authorizes one physical dispatch
  sequence; bounded failover reuses the one claim; crash/resume re-call →
  exactly one dispatch.
- Per-`loopId` in-process + cross-process lease around `reviewloop_review`.
- Every settled physical attempt (success / known-usage failure /
  mechanically-zero pre-send failure) writes a `reservationId`-tagged durable
  accounting record; unified `AGY_ENOENT` / `AGY_SPAWN_FAILED` pre-send
  classification; a normal failover no longer produces a false unaccounted
  block.
- `callAgy` envelope parsing fixed (parse `res.text`, not the transport
  `res.json`); real `{json,text,usage}`-shape tests.
- Unknown provider dollar cost → `costKnown: false` (never a real `$0`); cost
  ceiling semantics adjusted.
- Deterministic Gate FAIL → `gateRepairCount`, not a fresh Reviewer round.
- All public `REVIEWLOOP_MAX_*` env knobs wired (`MAX_REVIEW_ROUNDS` →
  objective; `MAX_EXTERNAL_REVIEW_TRIGGERS` → trigger authority).
- Deterministic Gate command timeout + process-tree teardown.
- Durable per-chunk review checkpoint / crash-resume.
- `safetyEvents` isolated per invocation; early-return telemetry reports
  durable cumulative spend.

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
