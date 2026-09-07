# ReviewLoop architecture

ReviewLoop current source of truth.

Worker owns execution.
ReviewLoop owns independent verification and repair control.

## Ownership

| concern | owner |
|---|---|
| implement / test / lint / build / debug / commit / push | **Worker** (external coding agent) |
| immutable review objective + baseline / PR-HEAD identity | ReviewLoop |
| deterministic Gate (0 model tokens) | ReviewLoop |
| independent Reviewer | ReviewLoop |
| external PR review trigger + zero-model wait | ReviewLoop |
| review normalization + finding signatures | ReviewLoop |
| convergence / non-convergence policy | ReviewLoop |
| Supervisor exception guidance | ReviewLoop |
| durable loop state / resume | ReviewLoop |
| ReviewLoop's own token + external-trigger safety | ReviewLoop |

ReviewLoop cannot autonomously: rewrite files, execute repair code, commit,
push, force-push, merge, weaken the objective, or spend models without fresh
evidence.

## Modules

```
src/reviewloop/
  objective.js          immutable ReviewObjective (fingerprinted, never weakened)
  state.js              durable loop state + deterministic state machine
  gitEvidence.js        pre-Worker baseline (git stash create) + exact Worker-delta attribution
  gatePolicy.js         verification discovery + deterministic Gate + baseline-diff
  diffChunker.js        deterministic diff chunking (no silent truncation)
  reviewPolicy.js       review normalization + convergence policy
  reviewSpend.js        DURABLE ReviewLoop-scoped Token Safety (Reviewer + Supervisor)
  prTrust.js            PR trust boundary (reviewer id + explicit reviewed HEAD == current HEAD)
  prReviewController.js  PR external-review loop (ExternalModelTriggerAuthority)
  githubBackend.js      production PR transport via the `gh` CLI (read + one trigger comment)
  providerWiring.js     production Reviewer/Supervisor pool (RoleRouter) + PR backend
  adapters/
    scratchCwd.js          shared isolated empty scratch cwd for every narrow transport
    boundedCli.js          bounded argv-only CLI runner (wall-clock timeout, process-group teardown)
    cliReviewTransports.js  narrow single-turn codex / claude Reviewer+Supervisor transports
    minimalAgyAgent.js      deterministic provisioning of the `reviewloop-minimal` AGY custom agent (inheritCustomizations:false) into the isolated gemini dir
    agyCustomAgentCapability.js  startup capability probe + per-call effective-loading verification (agy must actually LOAD reviewloop-minimal, not silently fall back)
  controller.js         reviewloop_begin + reviewloop_review
  runtimeDir.js         ~/.reviewloop

src/mcp/reviewloopMcpServer.js   exactly 2 Worker-facing tools
```

Preserved generic primitives: `ModelSpendAuthority`, `ReservationLedger`,
`NewInformationLedger`, `ExternalModelTriggerAuthority`, provider
health/quota routing (`roleRouting.js`), Git evidence collector, normalized
PR review, `baselineDiffGate`, `gateFailureIdentity`, process-tree cleanup.

## Active model roles

Exactly `reviewer` and `supervisor` (`DEFAULT_ROLE_POLICY`). No `planner`, no
`executor`. The Worker is outside role routing entirely.

## Reviewer / Supervisor transports

Both roles are NARROW, stateless, single-turn inference — never a second
coding Worker. Every transport (agy, `codex`, `claude`) runs from one shared
isolated empty scratch cwd (`adapters/scratchCwd.js`): no repo, no
`CLAUDE.md` / `GEMINI.md` / `AGENTS.md`, no project or agent memory to
preload. The `codex` / `claude` transports additionally disable user config,
project rules and MCP servers, run read-only with no tool use, and never
resume a conversation; each is bounded by a wall-clock timeout with
whole-process-tree teardown (`adapters/boundedCli.js`). Output goes through
the SAME strict normalization as agy — malformed → `HUMAN_REQUIRED`, never a
clean empty result. One physical attempt per call; bounded failover lives in
the controller, not in the transport.

### Per-family context isolation (what each CLI can and cannot narrow)

All argv below is verified against the installed CLIs' own `--help`; the
`benchmark:transports` harness pins the narrow-flag set mechanically.

| Family | Per-call narrowing available | Not closable per call | Measured live tax |
| --- | --- | --- | --- |
| `claude:opus` | `--setting-sources ''` (no user/project/local settings → no hooks, custom agents, output styles, statusline), `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (no MCP), `--tools ''` (no built-in tools/schemas), `--disable-slash-commands` (no skills), `--no-session-persistence` (no resume/write), `--exclude-dynamic-system-prompt-sections`, scratch cwd | admin/managed (policy) settings; the built-in `claude -p` base system prompt (zeroing it needs `--system-prompt`, which also kills the dynamic-section trim). `--bare` would remove more but forces API-key-only auth. | argv-fixed 2026-09-07; **live-cert pending** (was `PROVIDER_PROTOCOL_ERROR` — see below) |
| `codex:default` | `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only`, scratch cwd | the `codex exec` harness system prompt + built-in tool schemas (apply_patch/shell) — no flag lever | ~16.9k input (~10.6k cache-read), output ~9 |
| `agy:gpt-oss` | `--agent reviewloop-minimal` (`inheritCustomizations: false`) discovered from an isolated **redirected gemini dir** (`--gemini_dir`, `adapters/scratchCwd.js#narrowAgyGeminiDir`), `--disable-slash-commands`, scratch cwd | the `agy` base agent/system prompt and built-in tool schemas — no flag lever; admin/managed config | pending re-measurement (see effective-loading note below) |
| `agy:gemini` | same as `agy:gpt-oss` (production default effort **medium** → catalog resolves `gemini-*-medium`, currently `gemini-3.8-flash-medium`) | same as `agy:gpt-oss` | prior smoke was pre-fix (default agent) — pending re-measurement in the live Supervisor cert |
| `agy:sonnet` | same as `agy:gpt-oss` (AGY-hosted Claude Sonnet; `catalogPrefix: 'claude-sonnet-'` → newest catalog Sonnet, currently `claude-sonnet-4-6`) | same as `agy:gpt-oss` | routing finalized; effective-loading + controller live certification pending |

**AGY minimal-agent transport — effective loading (2026-09-07 fix)**:
ReviewLoop runs both AGY families through a `reviewloop-minimal` agent
(`inheritCustomizations: false`) instead of AGY's ambient/default agent.

Root cause found 2026-09-07: agy 1.1.27 does **not** discover a custom agent
from a workspace `.agents/agents/<name>/agent.md`. An unresolvable `--agent`
**silently falls back to the default agent** (`session.go:81 Agent "…" not
found, falling back to default`), so every prior AGY review call actually ran
the full default agent — the file existing on disk proved nothing. agy *does*
discover agents from its gemini-dir config tree. The real `~/.gemini` is
off-limits (user data + daily `agy`), so the transport now:

- provisions the agent at
  `<geminiDir>/config/agents/reviewloop-minimal/agent.md` in an **isolated
  redirected gemini dir** (`narrowAgyGeminiDir()`), and points agy at it with
  the `--gemini_dir=<dir>` flag. That flag is **not** in `agy --help` for
  1.1.27, so it is never assumed: `detectAgyCustomAgentSupport()` runs a
  zero-model-turn probe at MCP startup (stream-json, stdin closed → agy emits
  `init` and exits) and only enables the AGY families if the agy log confirms
  `Starting new conversation (agent=true)`. A build that rejects `--gemini_dir`,
  or that still falls back, → AGY families **UNAVAILABLE** (fail closed).
- verifies **per call**: the transport captures the agy `--log-file` and
  raises `AGY_ISOLATION_UNVERIFIED` (and fences off all AGY families so bounded
  failover routes away) if that call did not activate the custom agent. The
  default-agent reply is never returned as a usable result.
- auth is unaffected — agy authenticates via the OS keyring, not the gemini
  dir — and agy's own logs/cache now land in the isolated dir instead of
  polluting `~/.gemini`. Plain `agy` in a terminal is untouched.

If provisioning fails, the AGY families are marked **UNAVAILABLE** — ReviewLoop
never silently falls back to the default AGY agent.

Token-context figures are pending re-measurement: earlier "after minimal agent"
smoke numbers were taken before this fix, i.e. against the default agent or an
unverified path, and must not be trusted. The live Supervisor certification
(`scripts/live-reviewloop-certify.mjs --mode supervisor`) now asserts
`customAgentSupport.supported` and per-call effective-loading verification and
reports the real before/after.

### Final fixed routing (deterministic — NO risk-based selection)

`DEFAULT_ROLE_POLICY` is a fixed ordered list per role. There is no diff-size,
filename, or keyword heuristic and no risk classifier — automatic failover
simply walks the list in order.

| Order | Reviewer | Supervisor |
| --- | --- | --- |
| 1 | `codex:default` | `agy:gemini` |
| 2 | `agy:sonnet` | `codex:default` |
| 3 | `agy:gpt-oss` | `agy:sonnet` |
| 4 | `claude:opus` | `claude:opus` |
| 5 | — | `agy:gpt-oss` (`degraded: true`) |

Normal production path keeps the three roles on different model families:
Worker = Claude (external), Reviewer = Codex, Supervisor = AGY Gemini. GPT-OSS
is a deliberate low-cost third Reviewer fallback (not degraded); as a Supervisor
it is only the last-resort degraded保底 when every stronger family is down.

No family is `highContext` any more: every AGY family (`agy:gemini`,
`agy:gpt-oss`, `agy:sonnet`) runs through the `reviewloop-minimal` agent, which
collapsed the measured `agy:gemini` tax into line with the other families, so
`agy:gemini` participates in ordinary automatic routing. The generic
`RoleRouter` `highContext` mechanism (skipped unless
`signals.allowHighContext === true`) is retained for any future family that
needs it.

### Shared quota topology

```
agy:sonnet  ─┐
             ├─ agy-claude-gpt  (one AGY "Claude & GPT" quota pool)
agy:gpt-oss ─┘
agy:gemini  ─── agy-gemini      (separate Gemini quota pool)
codex:default ─ codex
claude:opus  ── claude
```

A `PROVIDER_QUOTA_EXHAUSTED` / `PROVIDER_RATE_LIMITED` cooldown on `agy:sonnet`
puts `agy-claude-gpt` into cooldown, so the sibling `agy:gpt-oss` is skipped at
route time — no wasted physical call to confirm the same pool is empty. A
model-specific `agy:sonnet` health failure that is NOT a quota failure leaves
the shared pool healthy and `agy:gpt-oss` still selectable; family health and
shared-pool health stay independent.

### Automatic failover (the user does not participate)

Any of the following, when the existing spend-safety semantics allow it,
automatically advances to the next candidate — up to one attempt per unique
candidate, then the pool is exhausted and the loop stops (never an infinite
retry; the `tried` set + a null route both stop it early):

- quota exhausted / rate limited
- pre-send CLI unavailable / executable missing / local auth unavailable
- mechanically pre-send spawn failure
- provider family health unavailable
- known-settled retryable provider/protocol failure

The effective attempt bound is the role's own candidate count
(`providerAttemptBudget(role)` in `controller.js`), replacing the old
hard-coded `MAX_PROVIDER_ATTEMPTS = 3` which could leave the 4th Reviewer / 5th
Supervisor candidate permanently unreachable. `MAX_SUPERVISOR_CALLS` is
likewise raised to the Supervisor pool size (5) so one supervised round can
traverse the whole pool. A `PROVIDER_ATTEMPT_HARD_CEILING` (16) remains purely
as a runaway guard.

**The one spend-safety stop that is NOT a failover:** if a physical call was
already dispatched and its usage cannot be reliably settled
(`MODEL_SPEND_USAGE_UNRESOLVED`), UNKNOWN ≠ ZERO — ReviewLoop fails closed to a
deterministic terminal and does NOT burn another provider "to be safe". This is
a safety stop, not an interactive prompt.

### Pool-completeness invariant

`tests/reviewLoopFinalRoutingPool.test.js` mechanically asserts, with zero
provider calls, that every `DEFAULT_ROLE_POLICY` candidate is: in
`MODEL_FAMILY_REGISTRY`, role-declared in `PRODUCTION_ROLE_CAPABILITIES`, has a
quota topology, a provider-capability record, a known accounting class, a wired
transport, a reported runtime status, and (AGY families) runs
`--agent reviewloop-minimal`. Plus full ordered traversal at both `route()` and
controller (`meteredWithFailover`) level, including the no-skip regression for
the retired attempt cap and the shared-quota sibling skip.

**Claude `PROVIDER_PROTOCOL_ERROR` root cause (fixed 2026-09-07)**: the
transport passed `--mcp-config '{}'`. The installed CLI (2.1.x) validates the
value as an object that MUST carry an `mcpServers` key and rejects a bare
`{}` with `Invalid MCP configuration: mcpServers: Invalid input`, exiting 1 in
~0.5s — before any model dispatch, which is why the failure looked like a
protocol error rather than an auth or inference failure. The value is now
`'{"mcpServers":{}}'`.

**Dynamic model-family resolution** preserves family semantics without
concrete release pins. `agy:gemini` / `agy:gpt-oss` / `agy:sonnet` resolve from
the probed `agy models` catalog when available (by `catalogPrefix`: `gemini-` /
`gpt-oss-` / `claude-sonnet-`, honouring the family's `defaultEffort` —
`agy:gemini` = `medium`, `agy:gpt-oss` = `medium`, `agy:sonnet` = none; when the
exact effort variant is absent, resolution falls back to the newest entry,
preferring higher effort on a version tie); `codex:default` omits a model flag and
tracks the Codex provider default; `claude:opus` passes the stable Claude CLI
alias `--model opus`, which tracks the current Opus release. Provider-returned
concrete model identity is persisted by telemetry. `doctor` must report
`versionPinnedByDefault=no` for every family.

**Pool composition is honest**: a family is either a WIRED transport that can
actually be selected and called, or explicitly UNAVAILABLE with a recorded
reason. The `codex` / `claude` adapters always exist, but production wires them
only after two zero-model startup checks succeed: `--version` and the local
auth-status command (`codex login status` / `claude auth status`). A missing or
locally unauthenticated CLI is removed from eligibility before any ReviewLoop
model permit is requested; routing can therefore choose the next family with
zero model spend.

**Authentication has two safety boundaries**. Local auth preflight is the only
mechanically pre-dispatch authentication signal. If a prompt-bearing CLI
invocation has already started and then returns a 401/403/authentication-looking
failure, the transport classifies it as `PROVIDER_AUTH_REJECTED`, not as
pre-send zero. Absent reliable provider usage, ModelSpendAuthority settles it
UNRESOLVED and further spend/failover on the same evidence is blocked.
`UNKNOWN != ZERO` wins over convenience.

## State machine

```
READY_FOR_WORK → REVIEWING → PASS
                          ├→ REWORK → REVIEWING
                          ├→ SUPERVISING → REWORK
                          ├→ WAITING_FOR_REVIEW → REVIEWING
                          └→ HUMAN_REQUIRED
```

`WAITING_FOR_REVIEW` is a normal durable state, not an error. A restart
reattaches to the pending external trigger without re-posting.

## Convergence

Default: `blockingSeverities = [P1, P2]`, `maxReviewRounds = 3`.

- Round 1: Gate → Reviewer. P1/P2 → direct REWORK (Supervisor calls = 0).
- Round 2: same blocking finding survives a genuine changed diff → Supervisor
  **exactly once** → guidance → REWORK.
- Round 3: P1/P2 still present → HUMAN_REQUIRED.
- Any round with no P1 and no P2 → PASS. Waiting never consumes a round.
- Identical evidence resubmitted → deterministic `NO_PROGRESS`, no model call.

The zero-provider `benchmark:transports` harness mechanically covers the
controller paths E2E-A (one-round PASS), E2E-B (REWORK → changed implementation
→ PASS), and E2E-C (persistent blocker after changed implementation →
Supervisor exactly once → REWORK), in addition to CLI transport narrowness.

## Token Safety

`UNKNOWN != ZERO`. `CallIntent → authorize → PhysicalCallPermit → dispatch →
SETTLED_KNOWN | UNRESOLVED`. Scoped to ReviewLoop-owned spend (Reviewer,
Supervisor). External `@codex/@claude review` crosses
`ExternalModelTriggerAuthority`. Worker usage is reported as
`external / not observable by ReviewLoop` — never as zero.

Limits (`REVIEWLOOP_*`): `MAX_COST_USD`, `MAX_USAGE_VOLUME`,
`MAX_REVIEW_ROUNDS`, `MAX_REVIEWER_CALLS`, `MAX_SUPERVISOR_CALLS`,
`MAX_EXTERNAL_REVIEW_TRIGGERS`, `MAX_REVIEW_DIFF_CHARS`, `MAX_REVIEW_CHUNKS`.

The aggregate budget (call counts, `usageVolume`, `costUsd`) is **durable** and
keyed by `loopId`: it accumulates across every `reviewloop_review` round, the
Supervisor call, and a process restart. A crash after provider settlement
cannot reset it — the reservation ledger is cross-checked on load and any
settled/blocking metered reservation with no matching spend record is counted
conservatively (call counted, usage UNKNOWN, never zero).

**`usageVolume` is provider/family-aware** (`usageAccountingOf({ usage, family,
provider })`, keyed off the actual family/provider bound into the CallIntent —
never guessed from a model name). Cached tokens must not be double-counted into
this hard ceiling:

| Class | Method | Rule |
| --- | --- | --- |
| any (confirmed total field only) | `provider_total` | an authoritative provider-reported total wins verbatim — trusted **only** from a token-total field mechanically confirmed for that class (`AUTHORITATIVE_TOTAL_ALIASES`: `openai` → `total_tokens`; `anthropic` → *none*, the Messages API returns no aggregate total; `agy` → `total_tokens`/`totalTokenCount`). A bare `total`, or any total on an unknown provider, is never trusted. AGY Gemini live: reported total 7252, cache-read 8128 not added |
| `openai` (`codex:default`) | `openai_input_plus_output` | `cache_read ⊂ input`, reasoning `⊂ output` — add neither (Codex live: input 16922 incl. 10624 cache-read, output 9 → volume **16931**, not 27555) |
| `anthropic` (`claude:opus`) | `anthropic_cache_additive` | `input + output + cache_creation + cache_read` — the two cache categories are separate billing lines, never dropped (live: 2 + 1549 + 2168 + 1285 → **5004**). Absent `cache_*` is a schema-defined 0; absent `input`/`output` is not |
| `agy` w/o confirmed total, or unknown provider | `conservative_additive_unknown` | sum every reported field, **flagged `semanticsKnown:false`** — UNKNOWN != ZERO: never under-count a safety ceiling, never present the number as an exact provider figure |

**Partial usage fails closed.** A fallback method reports `semanticsKnown:true`
/ `volumeResolved:true` **only** when every field it mechanically requires
(`openai`/`anthropic`: `input` + `output`) is actually present. If a
post-dispatch usage object exists but a required field is absent, it is
`volumeResolved:false` and `meteredCall` routes it into the existing
`MODEL_SPEND_USAGE_UNRESOLVED` / `ReservationLedger` UNRESOLVED path — the
reservation latches UNRESOLVED and blocks all further internal model spend for
the loop until a human clears it. Missing fields are never silently read as 0.
(The `agy`/unknown conservative path stays `volumeResolved:true` — a
floor-safe over-count is its accepted posture.)

The raw per-field breakdown (`usageBreakdownOf`) is always preserved for
telemetry regardless of method — `reportedTotalTokens` is strictly a total-ish
field the provider reported (not necessarily the authoritative one for that
family); `rawFieldSumTokens` is a **diagnostic** arithmetic sum, never a
token-accounting total. Every durable spend record carries `usageAccounting:
{ method, semanticsKnown, volumeResolved, accountingClass, reportedTotalTokens }`
provenance; telemetry surfaces `unknownSemanticsCalls`.

**Malformed provider output** (unparseable, no findings channel, invalid
severity, empty Supervisor guidance) is never reduced to a clean empty result —
it fails closed to `HUMAN_REQUIRED`.

**Review evidence coverage**: the Worker's full attributed diff is reviewed —
either in one bounded call or split into deterministic chunks that are EACH
reviewed and metered; `PASS` requires every chunk to have been reviewed
successfully. Evidence too large to chunk within the cap → `REVIEW_TOO_LARGE` →
`HUMAN_REQUIRED`. Each completed chunk's result is durably checkpointed
(keyed to `sha(deltaFingerprint :: gateFingerprint)`); a crash mid-round
resumes at the next unreviewed chunk without re-calling the model for the ones
already done.

**One logical review state → one dispatch sequence**: a chunk cites ONE
composite evidenceId (`sha(diffChunkHash :: gateFingerprint)`). Attempt 1
durably consumes it; bounded failover retries (`attempt > 1`) may reuse that
one claim ONLY when every earlier physical attempt is durably proven never to
have reached the provider (`RESERVED` / `CANCELLED_PRE_DISPATCH`, or
`SETTLED_KNOWN` with `settlementReason === PROVEN_PRE_SEND_ZERO` — set from an
explicit pre-send provenance flag, never inferred from a zero token count); a
first attempt on already-consumed evidence is denied — so a re-call on an
identical `(diff+gate)` state across crash/resume yields exactly one physical
Reviewer dispatch, and a post-send provider error is never a licence to retry.
`NO NEW INFORMATION → NO NEW MODEL CALL` holds.

**Per-`loopId` serialization**: an in-process lock chain plus a durable
cross-process lock file (`<runtime>/<loopId>/reviewloop.lock`) serialize every
`reviewloop_review` for a loop. Overlapping calls run one after another (the
second then hits the deterministic `NO_PROGRESS` guard — one dispatch, no lost
update); a live foreign holder makes the call return `WAITING_FOR_REVIEW`
without touching state; a stale/expired/dead-pid lock is reclaimed.

**Gate FAIL is a repair cycle, not a Reviewer round**: a deterministic Gate
FAIL increments `gateRepairCount`, never `round`, so Gate-repair loops never
exhaust the objective's max fresh Reviewer rounds. Each Gate command has a
deterministic timeout (`REVIEWLOOP_GATE_TIMEOUT_MS`) with whole-process-tree
teardown.

**Frozen verification plan**: `reviewloop_begin` resolves and freezes the Gate
verification plan (`source`, exact `commands`, a `manifestFingerprint` of the
`.reviewloop.json` / `package.json` test-script bytes) into the immutable
objective. `reviewloop_review` runs those exact frozen commands; any manifest
drift since `begin` blocks the review (REWORK) rather than trusting a Gate the
Worker can edit mid-loop.

**Baseline attribution**: `git stash create` snapshots the exact pre-Worker
tracked state without touching the tree; the review diff is `baseline..current`
(never `HEAD..current`), so pre-existing staged/unstaged/untracked user work is
never attributed to the Worker. Unattributable state → `HUMAN_REQUIRED`. No
Worker change since `begin` → deterministic `NO_PROGRESS`, zero Reviewer calls.

**PR trust boundary** (`prTrust.js`, reusing `trustedPrReview.js`): a trusted
external review must prove its **real GitHub login is in the EXACT allowlist**
for the configured reviewer. The defaults are the literal REST `user.login`
strings a GitHub App produces on a PR — `chatgpt-codex-connector[bot]` /
`claude[bot]` (the bare, suffix-less slug is never what REST returns and is not
trusted). Exact string match — never substring/includes, so `evil-codex-bot` /
`chatgpt-codex-connector` / `claude[bot]x` are rejected; override via
`REVIEWLOOP_{CODEX,CLAUDE}_REVIEWER_LOGINS`. Also required: an explicit reviewed
HEAD in the payload, and reviewed HEAD == current PR HEAD. The payload is never
first rewritten to the configured reviewer name and then "verified" against
itself; the normalizer never substitutes the current HEAD.

**PR review ingestion** aggregates EVERY trusted review submission and EVERY
trusted inline review comment for the exact HEAD (exact bot login). Per-state
semantics: `APPROVED` clears only with a structured empty findings list or a
benign body; `CHANGES_REQUESTED` blocks; `COMMENTED` / any unstructured state
blocks (never an empty findings list); `DISMISSED` is void and fails closed
when nothing else clears the HEAD; `PENDING` is ignored. A later `APPROVED`
cannot erase an earlier `CHANGES_REQUESTED` / `COMMENTED` finding on the same
HEAD.

**Complete physical-attempt accounting**: every settled metered attempt —
success, known-usage failure, OR mechanically-zero pre-send failure
(`PROVIDER_UNAVAILABLE` / `AGY_ENOENT` / `AGY_SPAWN_FAILED` /
`AGY_BAD_INPUT`) — writes a durable spend-log record tagged with its
`reservationId` before the business error propagates. Production CLI auth
preflight happens before a model-spend permit and therefore creates no metered
attempt at all. A normal failover never looks like unaccounted spend on the
next load. If a crash still leaves a `SETTLED_KNOWN` reservation with no
matching record (orphan by `reservationId`), its real usage/cost are gone —
`UNKNOWN != ZERO`, so every further metered call is refused
(`MODEL_SPEND_USAGE_UNRESOLVED`) until a human acknowledges it
(`REVIEWLOOP_ACK_UNACCOUNTED_SPEND`).

**Unknown dollar cost is never $0**: a provider that reports no cost yields
`costKnown: false`; telemetry's `costUsd` is then a lower bound. The cost
ceiling fires on the known sum, and also once the known sum passes half the
ceiling while any unknown-cost call exists; `usageVolume` stays the hard
runaway guard.

**Untracked evidence** is never silently truncated: a Worker-touched untracked
text file's full content reaches the Reviewer via the chunker; a binary or
unreadable Worker-created file marks the evidence incomplete → `HUMAN_REQUIRED`;
a deleted pre-existing untracked file is recognised as a Worker change. Every
untracked path is `lstat`'d before it is read — a symlink, FIFO, socket, or
device is never followed (it would fold an out-of-tree target's bytes into
Reviewer evidence) and fails the evidence closed. Any git command that feeds
baseline / diff / HEAD / untracked attribution fails closed on a non-zero exit
— never absorbed as an empty diff, an empty set, or a fallback HEAD.

**Per-invocation isolation**: `safetyEvents` in a result are scoped to that one
`reviewloop_review` call (a long-lived controller shared by many `loopId`s
never leaks one loop's events into another's). `NO_PROGRESS` /
`WAITING_FOR_REVIEW` / `PUSH_REQUIRED` / terminal results report the durable
cumulative spend, never zeros.
