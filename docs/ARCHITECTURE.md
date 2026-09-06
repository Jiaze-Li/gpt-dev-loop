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
  gitEvidence.js        pre-Worker baseline capture + Worker-delta attribution
  gatePolicy.js         verification discovery + deterministic Gate
  reviewPolicy.js       review normalization + convergence policy
  reviewSpend.js        ReviewLoop-scoped Token Safety (Reviewer + Supervisor)
  prReviewController.js  PR external-review loop (ExternalModelTriggerAuthority)
  providerWiring.js     production Reviewer/Supervisor callables
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
`MAX_EXTERNAL_REVIEW_TRIGGERS`.
