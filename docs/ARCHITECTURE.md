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

## Token Safety

`UNKNOWN != ZERO`. `CallIntent → authorize → PhysicalCallPermit → dispatch →
SETTLED_KNOWN | UNRESOLVED`. Scoped to ReviewLoop-owned spend (Reviewer,
Supervisor). External `@codex/@claude review` crosses
`ExternalModelTriggerAuthority`. Worker usage is reported as
`external / not observable by ReviewLoop` — never as zero.

Limits (`REVIEWLOOP_*`): `MAX_COST_USD`, `MAX_USAGE_VOLUME`,
`MAX_REVIEW_ROUNDS`, `MAX_REVIEWER_CALLS`, `MAX_SUPERVISOR_CALLS`,
`MAX_EXTERNAL_REVIEW_TRIGGERS`, `MAX_REVIEW_DIFF_CHARS`, `MAX_REVIEW_CHUNKS`.

The aggregate budget (call counts, `usageVolume` = input + output + cache
creation + cache read, `costUsd`) is **durable** and keyed by `loopId`: it
accumulates across every `reviewloop_review` round, the Supervisor call, and a
process restart. A crash after provider settlement cannot reset it — the
reservation ledger is cross-checked on load and any settled/blocking metered
reservation with no matching spend record is counted conservatively (call
counted, usage UNKNOWN, never zero).

**Malformed provider output** (unparseable, no findings channel, invalid
severity, empty Supervisor guidance) is never reduced to a clean empty result —
it fails closed to `HUMAN_REQUIRED`.

**Review evidence coverage**: the Worker's full attributed diff is reviewed —
either in one bounded call or split into deterministic chunks that are EACH
reviewed and metered; `PASS` requires every chunk to have been reviewed
successfully. Evidence too large to chunk within the cap → `REVIEW_TOO_LARGE` →
`HUMAN_REQUIRED`.

**Baseline attribution**: `git stash create` snapshots the exact pre-Worker
tracked state without touching the tree; the review diff is `baseline..current`
(never `HEAD..current`), so pre-existing staged/unstaged/untracked user work is
never attributed to the Worker. Unattributable state → `HUMAN_REQUIRED`. No
Worker change since `begin` → deterministic `NO_PROGRESS`, zero Reviewer calls.

**PR trust boundary** (`prTrust.js`, reusing `trustedPrReview.js`): a trusted
external review must prove its **real GitHub login is in the EXACT allowlist**
for the configured reviewer (exact string match — never substring/includes, so
`evil-codex-bot` / `fake-claude` are rejected; override via
`REVIEWLOOP_{CODEX,CLAUDE}_REVIEWER_LOGINS`), an explicit reviewed HEAD in the
payload, and reviewed HEAD == current PR HEAD. Missing any → reject. The
payload is never first rewritten to the configured reviewer name and then
"verified" against itself; the normalizer never substitutes the current HEAD.

**Unrecoverable spend fails closed**: if a crash leaves a `SETTLED_KNOWN`
metered reservation with no matching spend-log record, its real usage/cost are
gone — `UNKNOWN != ZERO`, so every further metered call is refused
(`MODEL_SPEND_USAGE_UNRESOLVED`) until a human acknowledges it
(`REVIEWLOOP_ACK_UNACCOUNTED_SPEND`).

**Untracked evidence** is never silently truncated: a Worker-touched untracked
text file's full content reaches the Reviewer via the chunker; a binary or
unreadable Worker-created file marks the evidence incomplete → `HUMAN_REQUIRED`;
a deleted pre-existing untracked file is recognised as a Worker change.
