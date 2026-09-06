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

- ReviewLoop deterministic/mock certification: **PASS** (`npm test`, `npm run doctor`)
- ReviewLoop real-provider Reviewer/Supervisor E2E: **ATTEMPTED / NOT CERTIFIED**
  (a live `agy` Reviewer has been reached; no run has been carried to a
  certified end-to-end verdict — see `docs/ROADMAP.md`)
- `codex` / `claude` Reviewer/Supervisor transports: **IMPLEMENTED + mock-certified**
  (narrow single-turn; wired only when the CLI is present; no real call made)
- ReviewLoop real PR external-review loop: **NOT RUN**

Historical SuperGPT V1/V2 measured numbers are labelled historical in
`docs/history/` and are not ReviewLoop certification.
