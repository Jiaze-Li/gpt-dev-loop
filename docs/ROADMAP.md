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

## Independent re-verification pass (this change)

Deterministic/mock `npm test` + `npm run doctor` green. Closes the
4 P1 + 3 P2 raised by the independent re-verification of the release-hardening
pass:

- Bounded failover may reuse the one New Information claim ONLY when every
  earlier physical attempt is mechanically proven pre-send zero. An attempt
  that reached the provider (known non-zero usage / open DISPATCHING) →
  "no new information" → no further physical call.
- The cross-process BUSY path is strictly read-only: it no longer runs
  resume reconciliation or touches any RESERVED / DISPATCHING reservation
  belonging to the live owner.
- Lease expiry is owner-aware: a same-host lock whose owner pid is still
  alive is never stolen on the fixed TTL alone; a held lease renews its own
  expiry on a heartbeat; only a provably-gone owner (dead same-host pid, or
  an expired remote lock) is reclaimed.
- A GitHub `CHANGES_REQUESTED` review verdict is unconditionally blocking —
  an empty / P3-only structured findings block can no longer downgrade it to
  CLEAN.
- A review round is bound to the logical (diff + gate) review state; a
  crash/resume of the same chunked review never consumes another round, and
  a resumed incomplete chunk continues the one authorized dispatch sequence
  instead of earning a fresh one.
- Every provider/spend failure that returns `HUMAN_REQUIRED` now also latches
  the durable loop state to `HUMAN_REQUIRED` (returned status == persisted
  state).

## Independent re-verification pass 2 (this change)

Deterministic/mock `npm test` + `npm run doctor` green. Closes the final
Token-Safety P1 from the independent re-verification:

- Failover reuse no longer infers "never reached the provider" from a zero
  token count. `SETTLED_KNOWN` + zero usage proves nothing about pre-send — a
  post-send `PROVIDER_PROTOCOL_ERROR` / `PROVIDER_RATE_LIMITED` can report
  usage `{0,0}` and still have spent. Reuse of the one New Information claim is
  now permitted ONLY when every earlier physical attempt carries a durable,
  unambiguous pre-send provenance: `RESERVED` / `CANCELLED_PRE_DISPATCH` (never
  crossed the durable `DISPATCHING` boundary), or `SETTLED_KNOWN` with
  `settlementReason === PROVEN_PRE_SEND_ZERO` — a reason written solely from an
  explicit orchestrator-set flag on a mechanically-classified spawn/transport
  abort (`AGY_ENOENT` / `AGY_SPAWN_FAILED` / …), never from a provider's own
  `{0,0}`. Missing / ambiguous provenance, an ordinary provider failure, or a
  success all deny the reuse. Durable across a restart.

## CLI transport implementation + safety rework

- Production `codex` + `claude` Reviewer/Supervisor transports are implemented
  as narrow, stateless, single-turn calls from an isolated scratch cwd with no
  repo/history preload, bounded wall-clock timeout, and whole-process-group
  teardown.
- Runtime eligibility is checked without model spend: `--version` plus local
  auth status (`codex login status`, `claude auth status`). Missing or locally
  unauthenticated CLIs are marked UNAVAILABLE before ReviewLoop authorizes a
  model dispatch, so routing can choose the next family safely.
- An authentication-looking failure after a prompt-bearing invocation has
  started is classified separately as `PROVIDER_AUTH_REJECTED`. It is NOT
  treated as mechanically-zero pre-send provenance; absent reliable provider
  usage, Token Safety fails closed and does not fail over on the same evidence.
- Stable family semantics are preserved without concrete release pins:
  `codex:default` delegates to the provider default; `claude:opus` passes the
  stable `opus` alias; `agy:*` families resolve from the runtime model catalog.
  Telemetry still records the concrete model returned by the provider.
- `npm run benchmark:transports` is a zero-provider harness with two layers:
  transport narrowness/overhead plus real ReviewLoop-controller state-machine
  paths E2E-A (one-round PASS), E2E-B (REWORK → changed implementation → PASS),
  and E2E-C (same blocker after a changed implementation → Supervisor exactly
  once → REWORK).

## Real-provider status (needs real providers / real GitHub)

Corrected against this machine's durable reservation + spend ledgers under
`~/.reviewloop/` (not from recollection):

- Last locally reported deterministic/mock certification before the latest
  auth/alias/E2E rework = **PASS** — `npm test` 336/336,
  `npm run doctor` PASS, `npm run benchmark:transports` PASS (0 real spawns).
  The latest rework must be rerun locally before merge; do not infer PASS from
  the unchanged test count.
- `npm run install-global` = **executed** against this machine's agent
  config / dotfiles (managed block + `reviewloop` MCP registration).
- Real ReviewLoop provider calls with a durable record on this machine =
  **2**, both in one loop (`rl-20260906075721-c674d31f`): `reviewer`,
  family `agy:gpt-oss`, model `gpt-oss-120b-medium`, a deterministically
  chunked review — `SETTLED_KNOWN` / `PROVIDER_CALL_SUCCEEDED`, ~122.8k and
  ~26.1k tokens; **dollar cost UNKNOWN** (provider reported none). Three
  older loops hold `reviewer` / `agy:gpt-oss` reservations with
  fixture-shaped usage (`{1,1}`, `{5,2,3}`) that cannot be mechanically
  distinguished from a stubbed Reviewer — **NOT COUNTED** as certified real
  calls.
- Any earlier `claude:sonnet` / Executor-era real call = **UNKNOWN** — no
  durable record survives in the current runtime dir; not asserted.
- No `codex` or `claude` real provider call has any durable record. The
  `codex` / `claude` Reviewer+Supervisor transports are IMPLEMENTED and are
  selectable only when the zero-token version + local-auth preflights succeed.
  Still ZERO real `codex` / `claude` Reviewer/Supervisor calls.
- 2026-09-07 live-certification observations (from a prior controlled run,
  not reproduced here): `agy:gpt-oss` Reviewer ~12.1k input / ~12.0k context
  overhead (`gpt-oss-120b-medium`); `codex:default` Reviewer ~16.9k input /
  ~10.6k cache-read; `agy:gemini` Supervisor ~150.7k input + ~656.8k
  cache-read (**high-context** — now excluded from automatic routing);
  `claude:opus` Reviewer failed `PROVIDER_PROTOCOL_ERROR` (`claude -p` exit 1
  in ~491ms). Root cause: `--mcp-config '{}'` rejected by the installed CLI
  (needs an `mcpServers` key). **Fixed 2026-09-07** (`'{"mcpServers":{}}'`
  plus `--setting-sources '' / --tools '' / --disable-slash-commands /
  --no-session-persistence`); argv is deterministically regression-covered but
  a live `claude:opus` call is **still NOT certified**.
- ReviewLoop real-provider Reviewer/Supervisor E2E over the current
  architecture = **ATTEMPTED / NOT CERTIFIED**. The one real run
  (`rl-20260906075721-c674d31f`) reached a live `agy` Reviewer with 2
  successful physical calls but terminated `HUMAN_REQUIRED`; it was not
  carried to a certified PASS/REWORK end-to-end verdict.
- ReviewLoop real PR external-review loop (`@codex review` / `@claude review`)
  = **NOT RUN**.
- Real multi-provider failover = **NOT RUN** (structurally wired +
  deterministic/mock paths only).
- A controlled `Worker + ReviewLoop` vs `Worker alone` wrapper benchmark
  remains future work because ReviewLoop cannot observe Worker token usage
  through MCP.

## Later

- A first LIVE `codex` / `claude` Reviewer/Supervisor call (transports are
  implemented; no real invocation has been made or recorded).
- Optional read-only ReviewLoop dashboard (removed in this migration; re-add
  only if it can stay zero-token and simple).
