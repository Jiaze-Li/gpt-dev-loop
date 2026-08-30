# SuperGPT V2 Plan

This document freezes the agreed V2 direction so future work does not depend on chat history.

## Product goal

V2 should reduce the user's attention cost without weakening independent verification.

The target experience is:

```text
User -> Claude / Codex / AGY
     -> one shared routing decision
     -> either the front agent handles an obviously tiny task
        or SuperGPT takes full ownership
     -> SuperGPT works unattended
     -> human returns only for a genuine HUMAN_REQUIRED decision
```

Token savings matter, but reliability and reducing repeated human participation take priority.

## V1 baseline — do not re-implement in V2

The following are V1 behavior and should be treated as the starting point:

- one canonical execution engine: `runSuperGPT()`;
- Claude, Codex, and AGY share one global front-agent delegation policy;
- Planner produces a complete structured task queue for normal planned workflows;
- Core advances ordinary task transitions without a model Supervisor;
- Reviewer PASS advances automatically;
- Gate failure and first ordinary Reviewer REWORK return directly to Executor;
- Supervisor is exception-only for ambiguity, non-convergence, plan mismatch, HUMAN_REQUIRED, or another state Core cannot safely resolve;
- Reviewer remains independent and is not broadly batched or removed.

## V2-A — centralized `supergpt_route`

V1 still relies on each front agent interpreting the shared policy. V2 moves that decision into SuperGPT itself.

Every Claude / Codex / AGY coding-modification request should first call `supergpt_route` instead of independently deciding whether to delegate.

The router must be deterministic and consume zero model tokens.

Result contract:

```text
DIRECT
SUPERGPT
```

Routing policy:

- explicit user request not to use SuperGPT -> DIRECT;
- explicit user request to use SuperGPT -> SUPERGPT;
- explanation, research, or other non-modifying requests -> DIRECT;
- clearly trivial single-step low-risk edits -> DIRECT;
- feature work, bug fixes, refactors, migrations, multi-file work, debugging, test-heavy work, or multi-step delivery -> SUPERGPT;
- uncertain classification -> SUPERGPT.

The asymmetry is intentional: an unnecessary SuperGPT run costs tokens, while a substantial task incorrectly kept by the front agent costs user attention and increases rework risk.

Acceptance criterion: the same request receives the same routing result whether it starts from Claude, Codex, or AGY.

## V2-B — Fast Path and Full Path

Routing a task to SuperGPT should not automatically imply the most expensive orchestration path.

### Fast Path

Use when the request is safely representable as one bounded implementation task without architecture decomposition.

```text
Executor
-> deterministic Gate
-> independent Reviewer
-> DONE / REWORK
```

No model Supervisor is used on the normal path. Planning should be skipped when Core can safely materialize the single bounded task contract; otherwise fall back to Full Path.

### Full Path

Use for larger or multi-step work:

```text
Planner once
-> Task queue
-> Executor
-> Gate
-> Reviewer
-> next task / rework
-> exception-only Supervisor
```

The Reviewer stays independent in both paths.

Acceptance criterion: conservative routing to SuperGPT does not force every medium-sized task to pay full Planner/Supervisor orchestration cost.

## V2-C — PR Closeout Loop

Integrate an external trusted PR reviewer as a post-development closeout gate. The intended reviewer is the separate account-wide Claude review service; SuperGPT remains the execution owner.

Target flow:

```text
SuperGPT implements and tests
-> push/update PR
-> request trusted Claude review
-> wait for review
-> clean: DONE
-> actionable finding: create repair task
-> Executor fixes
-> deterministic tests
-> push
-> request review again
-> repeat until clean or escalation
```

Deterministic rules:

- clean trusted review -> DONE;
- actionable P1/P2 finding -> FIX;
- successful fix + tests -> PUSH -> request review again;
- same finding repeated after a repair -> Supervisor escalation;
- unresolved again after escalation -> HUMAN_REQUIRED;
- maximum automatic repair rounds, default target: 5;
- if PR head changes externally, discard stale assumptions and re-read the latest head;
- never force-push;
- do not auto-merge by default;
- do not automatically modify `.github/workflows/**` unless explicitly allowed;
- fork PRs are review-only unless an explicit safe write path exists;
- trust only the configured designated reviewer identity.

Dependency: the account-wide Claude review bot remains a separate read-only inspection system. SuperGPT V2 consumes its findings; it must not collapse reviewer and executor into the same trust boundary.

## V2-D — optional web/browser adviser, not core infrastructure

The previously tested browser/Fixer transport may later be exposed as an optional adviser/provider for unusually difficult cases.

It must not become:

- the always-awake workflow owner;
- the normal Supervisor path;
- a dependency for ordinary execution, review, progress, resume, or delivery.

The deterministic local Core remains the always-awake owner of workflow state.

## Front-agent policy model

Keep the three-layer separation introduced in V1:

```text
COMMON policy
  = universal delegation behavior

Claude / Codex / AGY fragments
  = only how that frontend reaches SuperGPT

repository-local instructions
  = only project-specific build/test/architecture rules
```

In V2, COMMON should instruct all three front agents to call `supergpt_route`; the route result becomes authoritative for DIRECT vs SUPERGPT.

## Suggested implementation order

1. Add and test deterministic `supergpt_route`.
2. Update COMMON + Claude/Codex/AGY integration fragments to use the router.
3. Add Fast Path / Full Path selection while preserving independent Reviewer checks.
4. Add trusted PR review ingestion and the PR Closeout Loop.
5. Add escalation/non-convergence limits and end-to-end unattended tests.
6. Consider the optional browser adviser only after the local path is stable.

## V2 success criteria

V2 is successful when:

- starting from Claude, Codex, or AGY produces consistent delegation behavior;
- substantial coding work normally reaches SuperGPT without the user explicitly naming it;
- trivial work does not unnecessarily invoke the full orchestration stack;
- Supervisor stays off the normal path;
- Reviewer independence is preserved;
- PR review findings can be fixed and re-reviewed without human message forwarding;
- a human is required only for real product/architecture decisions, repeated non-convergence, unsafe repository state, or an explicit safety boundary.

## Non-goals for V2

- no automatic merge by default;
- no replacement of deterministic Core with an always-running model;
- no broad removal or batching of independent Reviewer checks;
- no browser automation as a production-critical dependency;
- no duplication of the V1 execution engine into separate Claude/Codex/AGY paths.
