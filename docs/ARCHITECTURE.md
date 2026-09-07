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
    minimalAgyAgent.js      deterministic provisioning of the workspace-local `reviewloop-minimal` AGY custom agent (inheritCustomizations:false)
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
| `agy:gpt-oss` | `--agent reviewloop-minimal` (workspace-local custom agent, `inheritCustomizations: false`), `--disable-slash-commands`, scratch cwd | the `agy` base agent/system prompt and built-in tool schemas — no flag lever; admin/managed config | ~12.1k input, ~196 output, cache-read 0, provider total ~12.3k — acceptable |
| `agy:gemini` | same as `agy:gpt-oss` | same as `agy:gpt-oss` | minimal-agent: input 6713 + output 539 + thinking 506, cache-read 8128, **provider total 7252**, 8.4s (was ~150.7k input + ~656.8k cache-read, ~92.7s) |

**AGY minimal-agent transport — production transport live-certified
(2026-09-07)**: ReviewLoop runs both AGY families through a workspace-local
`reviewloop-minimal` agent (`.agents/agents/reviewloop-minimal/agent.md` with
`inheritCustomizations: false`) instead of AGY's ambient/default agent. It is
provisioned deterministically and idempotently into the isolated scratch
workspace only — never into `~/.gemini`, `~/.config`, AGY global settings/MCP
config, or any pre-existing user agent/skill/plugin/rule, so plain `agy` use in
a terminal is unchanged. It drops the inherited MCP/skills/rules/plugins/
subagents context while preserving existing Antigravity authentication and
subscription entitlement. If provisioning fails, the AGY families are marked
**UNAVAILABLE** (fail closed) — ReviewLoop never silently falls back to the
default AGY agent.

A controlled `gemini-3.8-flash-high` Supervisor smoke (one real narrow-transport
call, promptChars 502) confirms the token-context collapse:

```
before minimal agent:  input 150668, output 8078, thinking 5916,
                       cache-read 656768, duration ~92734 ms
after minimal agent:   input 6713, output 539, thinking 506,
                       cache-read 8128, provider total 7252,
                       duration 8375 ms, promptChars 502
```

This is a **controlled single-turn smoke of the production transport**, not a
full ReviewLoop controller E2E. `agy:gemini` stays `highContext` / out of
automatic routing (see below) pending a controller-level run.

**`agy:gemini` is marked `highContext` in `DEFAULT_ROLE_POLICY` and excluded
from automatic Reviewer/Supervisor routing** (`RoleRouter` skips a
`highContext` candidate unless a caller passes `signals.allowHighContext ===
true`). It stays last in both policy lists so a future `agy` release that adds
a real narrowing flag can re-enable it with a one-line change; the production
transport is now live-certified (smoke above), but re-adding `agy:gemini` to
automatic routing is gated on a full controller-level E2E, not done here. `agy mcp disable` (the only other narrowing path) mutates
the user's global config, which ReviewLoop must not do. Routing order here
follows the measured token cost above, not a subjective model-quality
judgement.

**Claude `PROVIDER_PROTOCOL_ERROR` root cause (fixed 2026-09-07)**: the
transport passed `--mcp-config '{}'`. The installed CLI (2.1.x) validates the
value as an object that MUST carry an `mcpServers` key and rejects a bare
`{}` with `Invalid MCP configuration: mcpServers: Invalid input`, exiting 1 in
~0.5s — before any model dispatch, which is why the failure looked like a
protocol error rather than an auth or inference failure. The value is now
`'{"mcpServers":{}}'`.

**Dynamic model-family resolution** preserves family semantics without
concrete release pins. `agy:gemini` / `agy:gpt-oss` resolve from the probed
`agy models` catalog when available; `codex:default` omits a model flag and
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
| any | `provider_total` | an authoritative provider-reported total wins verbatim (AGY Gemini live: input 6713 + output 539 == reported total 7252; cache-read 8128 is **not** added) |
| `openai` (`codex:default`) | `openai_input_plus_output` | `cache_read ⊂ input`, reasoning `⊂ output` — add neither (Codex live: input 16922 incl. 10624 cache-read, output 9 → volume **16931**, not 27555) |
| `anthropic` (`claude:opus`) | `anthropic_cache_additive` | `input + output + cache_creation + cache_read` — the two cache categories are separate billing lines, never dropped (live: 2 + 1549 + 2168 + 1285 → **5004**) |
| `agy` w/o total, or unknown provider | `conservative_additive_unknown` | sum every reported field, **flagged `semanticsKnown:false`** — UNKNOWN != ZERO: never under-count a safety ceiling, never present the number as an exact provider figure |

The raw per-field breakdown (`usageBreakdownOf`) is always preserved for
telemetry regardless of method — `reportedTotalTokens` is strictly what the
provider reported (null otherwise); `derivedTotalTokens` is our own additive
roll-up and is never presented as a provider figure. Every durable spend record
carries `usageAccounting: { method, semanticsKnown, accountingClass,
reportedTotalTokens }` provenance; telemetry surfaces `unknownSemanticsCalls`.

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
