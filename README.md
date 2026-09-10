# ReviewLoop (gpt-dev-loop)

ReviewLoop adds an autonomous review/fix loop around the coding agent you are
already using. It does not replace or spawn that coding agent.

> ReviewLoop is a post-execution review and repair controller for coding
> agents. The user's current coding agent (the **Worker**) owns execution;
> ReviewLoop owns independent verification, review, external-review waiting,
> non-convergence detection, and exception guidance.

## Model

```
USER
  ↓
WORKER  (Claude Code / Codex / Gemini / any coding agent)
  ↓  implements, tests, lints, builds directly in its current session
ReviewLoop
  ├─ deterministic Gate      (0 model tokens)
  ├─ Reviewer                (independent; metered by Token Safety)
  └─ Supervisor              (exception-only, on non-convergence)
```

ReviewLoop does **not**: write application code, commit, push, merge,
force-push, choose the Worker's model, spawn or restart the Worker, or budget
the Worker.

## Worker usage

The Worker calls two MCP tools:

| tool | when | cost |
|---|---|---|
| `reviewloop_begin({ goal, cwd, prNumber?, reviewer? })` | before the first edit | 0 model calls |
| `reviewloop_review({ loopId })` | when the implementation is ready | Gate (0) + Reviewer if justified |

`reviewloop_review` returns one of: `PASS`, `REWORK` (fix the findings in the
same session, call again), `HUMAN_REQUIRED`, `WAITING_FOR_REVIEW` (PR review
triggered — call again later), `NO_PROGRESS`, `PUSH_REQUIRED`.

Full Worker contract: [`agent-policy/COMMON.md`](agent-policy/COMMON.md).

## PR mode

Pass `prNumber` to review an open PR. ReviewLoop posts **one**
`@codex review` / `@claude review` per PR HEAD, waits locally with **zero**
model tokens, normalizes the findings, and hands `REWORK` back to the Worker,
who fixes and pushes. ReviewLoop then reviews the new HEAD. It never pushes or
merges.

## CLI

```
reviewloop doctor        zero-token prerequisite + repo-invariant check
reviewloop status        list local ReviewLoop sessions
npm run install-global   install/refresh the global policy + MCP for present agents
npm run doctor
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current source of truth
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architectural decisions
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/GLOBAL_INSTALL.md`](docs/GLOBAL_INSTALL.md)
- [`docs/history/SUPERGPT_V1_V2_LESSONS.md`](docs/history/SUPERGPT_V1_V2_LESSONS.md) — why ReviewLoop replaced SuperGPT V1/V2

## Certification status

Certified implementation snapshot: **`ce02f1e83276d7349ac6dfec332f75c7b972fd32`**
(branch `v2-routing`, PR #4) — the frozen implementation head the certification
below was run against. Later closeout commits on `v2-routing` change
documentation only and do not alter the certified implementation.

- Deterministic bar at `ce02f1e`: **PASS** — `npm test` **573/573**,
  `npm run doctor` PASS, `npm run benchmark:transports` PASS (0 real spawns),
  `git diff --check` clean.
- **LOCAL controller-level real-provider certification: PASS.** A full
  `reviewloop_begin` → Gate → Reviewer → verdict loop was carried to a
  controller `PASS` over the `ce02f1e` implementation snapshot against the
  byte-exact frozen delta `bb0c36e → ce02f1e`:
  - Reviewer first choice **`agy:opus`**, live-resolved model
    **`claude-opus-4-6-thinking`**, quota pool **`agy-claude-gpt`**.
  - Supervisor first choice **`agy:gemini-supervisor`** (Gemini, medium effort);
    not invoked (loop converged in one round).
  - Physical Reviewer calls **1**, Supervisor calls **0**;
    input/output **6358 / 2602**, `usageVolume` **8960**.
  - AGY `reviewloop-minimal` isolation / effective-loading verification: **PASS**
    (startup capability probe + per-call check).
  - Blocking P1/P2 findings: **none**. The Reviewer's `OTHER` / cosmetic
    findings are non-blocking and are deliberately left unchanged after the
    freeze.
- ReviewLoop **PR external-review** mode (`@codex review` / `@claude review`):
  **NOT CERTIFIED** — no real PR external-review loop has been run. The LOCAL
  certification above does **not** cover PR mode.
- Real multi-provider failover chain end-to-end: **NOT RUN** (structurally
  wired; the certified loop above exercised the first-choice Reviewer only).
- `claude:opus` uses the stable provider alias `opus`; `codex:default` follows
  the provider default. No concrete release is pinned by default.

Historical SuperGPT V1/V2 measured numbers are labelled historical in
`docs/history/` and are not ReviewLoop certification.
