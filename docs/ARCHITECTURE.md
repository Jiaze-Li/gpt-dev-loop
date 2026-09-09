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
the SAME strict normalization as agy — a malformed Reviewer result →
`HUMAN_REQUIRED`, never a clean empty result (a malformed Supervisor result is
a transient failure — see Convergence). One physical attempt per call; bounded
failover lives in the controller, not in the transport.

### Per-family context isolation (what each CLI can and cannot narrow)

All argv below is verified against the installed CLIs' own `--help`; the
`benchmark:transports` harness pins the narrow-flag set mechanically.

| Family | Per-call narrowing available | Not closable per call | Measured live tax |
| --- | --- | --- | --- |
| `claude:opus` | `--setting-sources ''` (no user/project/local settings → no hooks, custom agents, output styles, statusline), `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (no MCP), `--tools ''` (no built-in tools/schemas), `--disable-slash-commands` (no skills), `--no-session-persistence` (no resume/write), `--exclude-dynamic-system-prompt-sections`, scratch cwd | admin/managed (policy) settings; the built-in `claude -p` base system prompt (zeroing it needs `--system-prompt`, which also kills the dynamic-section trim). `--bare` would remove more but forces API-key-only auth. | live-certified: Reviewer usageVolume 3449, Supervisor 3741 (resolvedModel `opus`) |
| `codex:default` | `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only`, scratch cwd | the `codex exec` harness system prompt + built-in tool schemas (apply_patch/shell) — no flag lever | live-certified: Reviewer usageVolume 16535, Supervisor 16899 (the `codex exec` harness prompt dominates) |
| `agy:gpt-oss` | `--agent reviewloop-minimal` (`inheritCustomizations: false`) discovered from an isolated **redirected gemini dir** (`--gemini_dir`, `adapters/scratchCwd.js#narrowAgyGeminiDir`), `--disable-slash-commands`, scratch cwd | the `agy` base agent/system prompt and built-in tool schemas — no flag lever; admin/managed config | live-certified Reviewer: usageVolume 2427, resolvedModel `gpt-oss-120b-medium`, isolationVerified |
| `agy:gemini-reviewer` | same as `agy:gpt-oss` (fixed effort **low** → catalog resolves `gemini-*-low`) | same as `agy:gpt-oss` | Reviewer head; shares the `agy-gemini` quota pool with `agy:gemini-supervisor` |
| `agy:gemini-supervisor` | same as `agy:gpt-oss` (fixed effort **medium** → catalog resolves `gemini-*-medium`, currently `gemini-3.8-flash-medium`) | same as `agy:gpt-oss` | **definitive isolated-agent live result**: Supervisor usageVolume 2933, resolvedModel `gemini-3.8-flash-medium`, effectiveLoadingVerified + isolationVerified |
| `agy:sonnet` | same as `agy:gpt-oss` (AGY-hosted Claude Sonnet; `catalogPrefix: 'claude-sonnet-'` → newest catalog Sonnet, currently `claude-sonnet-4-6`) | same as `agy:gpt-oss` | live-certified: Reviewer usageVolume 3191, Supervisor 3303, resolvedModel `claude-sonnet-4-6`, isolationVerified |

**AGY minimal-agent transport — effective loading**:
ReviewLoop runs every AGY family through the `reviewloop-minimal` agent
(`inheritCustomizations: false`) instead of AGY's ambient/default agent. The
agent lives at `<isolated gemini dir>/config/agents/reviewloop-minimal/agent.md`
and is reached with `--gemini_dir` — **not** a workspace `.agents/` path.

Why the redirected gemini dir: agy does **not** reliably discover a custom
agent from a workspace `.agents/agents/<name>/agent.md`. An unresolvable
`--agent` **silently falls back to the default agent** (`session.go:81 Agent
"…" not found, falling back to default`), so a file merely existing on disk
proves nothing. agy *does* discover agents from its gemini-dir config tree. The
real `~/.gemini` is off-limits (user data + daily `agy`), so the transport:

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

Historical AGY token figures are **not** a baseline:

- the earlier ~40k `gemini-*` Supervisor call had a valid controller/provider
  path but isolation did **not** take effect — it silently ran the default
  agent — so it is not a minimal-agent cost baseline;
- the still-earlier ~6.7k "minimal" smoke was taken before effective loading
  was verified, so it is not a trusted isolation baseline either.

The definitive isolated-agent live result is the `agy:gemini-supervisor` medium
Supervisor: **usageVolume 2933, effectiveLoadingVerified**. The live certification
(`scripts/live-reviewloop-certify.mjs`) asserts `customAgentSupport.supported`
plus per-call effective-loading verification and reports the real numbers.

### Final fixed routing (deterministic — NO risk-based selection)

`DEFAULT_ROLE_POLICY` is a fixed ordered list per role. There is no diff-size,
filename, or keyword heuristic and no risk classifier — automatic failover
simply walks the list in order.

| Order | Reviewer | Supervisor |
| --- | --- | --- |
| 1 | `agy:gemini-reviewer` (effort **low**) | `agy:gemini-supervisor` (effort **medium**) |
| 2 | `codex:default` | `codex:default` |
| 3 | `agy:sonnet` | `agy:sonnet` |
| 4 | `agy:gpt-oss` | `claude:opus` |
| 5 | `claude:opus` | — |

Normal production path: Worker = Claude (external), Reviewer = AGY Gemini at
**low** effort, Supervisor = AGY Gemini at **medium** effort. The two Gemini
heads are distinct role-scoped family identities (`agy:gemini-reviewer` /
`agy:gemini-supervisor`), each locked to one role and one effort, sharing the
single `agy-gemini` quota pool. GPT-OSS is a deliberate low-cost Reviewer
fallback (not degraded).

**`agy:gpt-oss` is NOT a Supervisor candidate.** Its live Supervisor
certification succeeded on transport, token accounting and agent isolation, but
its decision output violated the Supervisor decision schema (it returned
`recommendation = "REWORK|HUMAN_REQUIRED"` where the schema permits exactly one
of `"REWORK"` or `"HUMAN_REQUIRED"`). The Supervisor parser is deliberately not
loosened; `agy:gpt-oss` was removed from the Supervisor production pool instead.
Its family / transport / accounting support is unchanged and it remains a
Reviewer candidate. `PRODUCTION_ROLE_CAPABILITIES['agy:gpt-oss']` is therefore
`['reviewer']`.

No production family is `highContext`: every AGY family (`agy:gemini-reviewer`,
`agy:gemini-supervisor`, `agy:gpt-oss`, `agy:sonnet`) runs through the isolated
`reviewloop-minimal` agent, and the definitive `agy:gemini-supervisor` result
(usageVolume 2933) is in line with the other families, so the Gemini heads
participate in ordinary automatic routing — they are **not** excluded on a
high-context basis. The generic
`RoleRouter` `highContext` mechanism (a candidate so marked is skipped unless
`signals.allowHighContext === true`) is retained for any future family that
needs it, but nothing sets the flag today.

### Shared quota topology

```
agy:sonnet             ─┐
                        ├─ agy-claude-gpt  (one AGY "Claude & GPT" quota pool)
agy:gpt-oss            ─┘
agy:gemini-reviewer    ─┐
                        ├─ agy-gemini      (one separate Gemini quota pool —
agy:gemini-supervisor  ─┘                   both role heads share its cooldown)
codex:default          ── codex
claude:opus            ── claude
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
hard-coded `MAX_PROVIDER_ATTEMPTS = 3` which could leave the 4th Reviewer /
Supervisor candidate permanently unreachable. `MAX_SUPERVISOR_CALLS` tracks the
Supervisor pool size (**4**) so one supervised round can traverse the whole
pool. A `PROVIDER_ATTEMPT_HARD_CEILING` (16) remains purely as a runaway guard.

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
concrete release pins. `agy:gemini-reviewer` / `agy:gemini-supervisor` /
`agy:gpt-oss` / `agy:sonnet` resolve from the probed `agy models` catalog when
available (by `catalogPrefix`: `gemini-` / `gemini-` / `gpt-oss-` /
`claude-sonnet-`, honouring the family's `defaultEffort` —
`agy:gemini-reviewer` = `low`, `agy:gemini-supervisor` = `medium`,
`agy:gpt-oss` = `medium`, `agy:sonnet` = none; when the exact effort variant is
absent, resolution falls back to the newest entry, preferring higher effort on
a version tie). The two Gemini heads are SEPARATE stable family identities, one
per role, so the concrete `-low` / `-medium` id is bound at pool construction
from the family's own effort and can never drift: the id the AGY transport
passes as `--model` is exactly what telemetry persists — a `-low` family never
dispatches a `-medium` model. `codex:default` omits a model flag and
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

`ExternalModelTriggerAuthority` posts **at most one** `@codex/@claude review`
per semantic HEAD (workflow + PR + HEAD), caps the total distinct review rounds
(`MAX_EXTERNAL_REVIEW_TRIGGERS`), and puts a **per-round** wall clock on the
external-review wait: it is armed when a round's trigger is authorized and
**re-armed every time `authorize()` runs for a genuinely new reviewable HEAD**
(a new HEAD means the Worker moved on, so the old round's deadline no longer
applies — this does not depend on historical trigger records being "settled", so
a lost best-effort `recordResult()` write can't wedge later HEADs). It
deliberately does not span the Worker's between-round implementation time or the
whole multi-round loop (the review-round budget is that runaway guard). A
reviewer that accepted the trigger for a HEAD and then hung is still caught per
round: a same-HEAD re-authorize hits the deadline check before REUSE, and the
reattach poll path (which never calls authorize) checks the in-flight round's
deadline via `checkInFlightDeadline`. A late review that eventually lands is
still ingested on the next call (the
existing-review check runs first).

## Convergence

Default: `blockingSeverities = [P1, P2]`, `maxReviewRounds = 3`.

- Round 1: Gate → Reviewer. P1/P2 → direct REWORK (Supervisor calls = 0).
- Round 2: same blocking finding survives a genuine changed diff → Supervisor
  **exactly once** → guidance → REWORK.
- Round 3: P1/P2 still present → HUMAN_REQUIRED.
- Any round with no P1 and no P2 → PASS. Waiting never consumes a round.
- Identical evidence resubmitted → deterministic `NO_PROGRESS`, no model call.

Only a Supervisor that actually adjudicates the loop non-convergent
(`recommendation = "HUMAN_REQUIRED"`) ends it — that HUMAN_REQUIRED is terminal
(`budgetExhausted`). A *degradable transient* Supervisor failure — caller
cancelled before dispatch, provider pool exhausted with settled accounting,
output unusable but the call settled — is never valid guidance and never
terminal: the round degrades to a plain REWORK
(`REVIEWLOOP_SUPERVISOR_UNAVAILABLE` non-blocking safety event,
`supervisorInvoked` reset so a later persistent round can retry). The
`maxReviewRounds` cap remains the stagnation circuit-breaker regardless. The one
exception is the same spend-safety stop as everywhere else: a Supervisor call
that was dispatched but whose usage cannot be settled
(`MODEL_SPEND_USAGE_UNRESOLVED`, UNKNOWN ≠ ZERO) fails closed to a
non-terminal `HUMAN_REQUIRED` and does not degrade.

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
`MAX_EXTERNAL_REVIEW_TRIGGERS`, `MAX_REVIEW_DIFF_CHARS`, `MAX_REVIEW_CHUNKS`,
`MAX_SINGLE_CALL_USAGE`, `MAX_CONTEXT_OVERHEAD_TOKENS` (single-call Token
Sentinel — see below).

The aggregate budget (call counts, `usageVolume`, `costUsd`) is **durable** and
keyed by `loopId`: it accumulates across every `reviewloop_review` round, the
Supervisor call, and a process restart. A crash after provider settlement
cannot reset it — the reservation ledger is cross-checked on load and any
settled/blocking metered reservation with no matching spend record is counted
conservatively (call counted, usage UNKNOWN, never zero).

### Single-call Token Sentinel (post-settlement circuit breaker)

The aggregate ceilings only fire once the *running total* crosses the line, so
one call that suddenly balloons (running total 10k → a single 150k call) has
already spent the 150k before the aggregate blocks the *next* call. The Token
Sentinel closes that gap. It is **post-settlement**: it cannot un-spend the
anomalous call — its job is *anomalous call → precise accounting → explicit
alarm → durable block → no more automatic burn*.

After a physical Reviewer/Supervisor call whose usage settled **reliably**
(`volumeResolved === true` — an UNKNOWN/unresolved call keeps the existing
UNRESOLVED fail-closed path and is never guessed at), the Sentinel trips when
either:

- `usageVolume > REVIEWLOOP_MAX_SINGLE_CALL_USAGE` (default **40 000**), or
- a *known* `contextOverheadTokens > REVIEWLOOP_MAX_CONTEXT_OVERHEAD_TOKENS`
  (default **30 000**).

Both are env-overridable but clamped to `(0, hard-cap]`
(`TOKEN_SENTINEL_HARD_CAPS` — 250 000 / 200 000): an illegal value (non-finite,
`≤ 0`, unparseable) falls back to the default and can never *disable* the
protection, and no value can inflate the ceiling to infinity.

On a trip:

1. the anomalous call's real usage is **fully, durably accounted first** (never
   treated as 0);
2. a **BLOCKING** `MODEL_SPEND_TOKEN_ANOMALY` safety event is recorded (role,
   family/provider, `resolvedModel`, `usageVolume`, `contextOverheadTokens`,
   configured threshold, reason, `actionTaken`);
3. the anomaly is **durably latched** for the loop
   (`reviewLoopTokenAnomaly` in workflow state);
4. `meteredCall` throws `MODEL_SPEND_TOKEN_ANOMALY_BLOCKED` (an
   `AuthorizationError`) — every further Reviewer/Supervisor model call in the
   loop is refused at the **authorization stage**, and the latch is re-read
   from durable state so the block **survives a process restart**.

It is an orchestrator safety stop, never provider failure: **no auto-failover**
to the next candidate, **no** provider health/quota mutation, and it is never
disguised as a provider health failure. Clearing it requires a human.

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

**Baseline-diff suppression is objective-bound**: a review-time Gate FAIL is
downgraded to WARN only for failures the begin-time baseline Gate already had.
That begin-time evidence lives in `workflow.json` (outside the tamper-checked
objective), so its stable identity (`pass`, `source`, a hash of the failure
evidence) is folded into the objective fingerprint. At review the persisted
evidence is used for suppression only when it still matches that bound identity;
otherwise it is ignored (a real regression stays FAIL) and a
`REVIEWLOOP_BASELINE_GATE_EVIDENCE_UNVERIFIED` safety event is recorded.

**Bounded Gate output**: each verification command's stdout/stderr is capped as
chunks arrive (not only sliced after concat), so a runaway command that streams
hundreds of MB cannot OOM the MCP host before the Gate timeout fires.

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
a deleted pre-existing untracked file is recognised as a Worker change. A file
that was untracked at baseline (only a digest was kept) but is now modified —
whether still untracked, staged, or newly `.gitignore`d — cannot yield an
honest baseline→current delta and fails the evidence closed rather than
emitting its whole content; likewise a brand-new untracked path whose bytes are
identical to a baseline-untracked file (a rename or copy of pre-existing
content). The same protections extend to a brand-new **tracked** addition
(`git diff --diff-filter=A`) that was neither tracked nor untracked at baseline
— a rename/copy of a baseline-untracked file into a staged new name would
otherwise be rendered as a wholly-new file and leak its pre-existing bytes:
an exact-digest match fails closed, and — since the baseline kept only digests
— a brand-new file (tracked or untracked) appearing in the same review where a
baseline-untracked path disappeared (an undetectable rename+edit) fails closed.
For the *edited copy with the source left in place*, the baseline additionally
retains the full bytes (latin1) of every **non-binary** untracked file ≤ 400 KB:
a brand-new Worker file that reproduces a substantial contiguous character run
of that content — a rolling hash over *every* window offset, confirmed with a
direct substring check, so a large single-line file (minified JSON, a lockfile
fragment) is covered exactly like a multi-line one and a non-aligned copy cannot
slip between strides — fails the evidence closed. A baseline-untracked file
whose content was **not** retained — binary (re-encodable, e.g. NUL bytes
stripped, so no contiguous run survives a clean comparison), oversized, or
stripped from state so it no longer matches its fingerprinted digest — makes the
baseline *uncomparable*: every brand-new Worker file then fails closed. A baseline-untracked path missing from the
current listing is called *deleted* only when its absence is definitively
confirmed (`ENOENT`); any other `lstat`/read failure (`EACCES`, a mid-read
race) fails the evidence closed instead. Every untracked path
is `lstat`'d before it is read — a symlink, FIFO, socket, or device is never
followed (it would fold an out-of-tree target's bytes into Reviewer evidence)
and fails the evidence closed. Any git command that feeds
baseline / diff / HEAD / untracked attribution fails closed on a non-zero exit
— never absorbed as an empty diff, an empty set, or a fallback HEAD.

**Per-invocation isolation**: `safetyEvents` in a result are scoped to that one
`reviewloop_review` call (a long-lived controller shared by many `loopId`s
never leaks one loop's events into another's). `NO_PROGRESS` /
`WAITING_FOR_REVIEW` / `PUSH_REQUIRED` / terminal results report the durable
cumulative spend, never zeros.
