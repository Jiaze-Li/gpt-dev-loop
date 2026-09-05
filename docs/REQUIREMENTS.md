# Requirements

> **Historical initial-design document.**
>
> This file records the project's original browser / ChatGPT-Web concept and is
> **not** the active V2 product contract. The production architecture no longer
> depends on a browser bridge or a ChatGPT web session; SuperGPT routes work to
> a local deterministic Core with role-routed model providers.
>
> Current sources of truth:
> - `README.md`
> - `agent-policy/COMMON.md`
> - `docs/ARCHITECTURE.md`
> - `docs/GLOBAL_INSTALL.md`
> - `docs/V2_PLAN.md`
>
> The requirements below are preserved as historical record. Where they describe
> a ChatGPT-Web reviewer, browser transport, or `ask_gpt` interface as the
> intended path, that reflects the original design, not current production.

## 1. User problem

The current manual workflow requires a human to repeatedly copy prompts from ChatGPT to a coding agent, wait for implementation, copy completion reports back to ChatGPT, ask ChatGPT to inspect GitHub, then copy review feedback back to the coding agent. The latter half of the loop is transport work rather than a valuable human decision.

`gpt-dev-loop` exists to automate that transport and execution/review loop while preserving human control over product intent and final acceptance.

## 2. Hard requirements

### R1 — ChatGPT web reviewer, not OpenAI API

The intended GPT reviewer/planner path must use the user's existing ChatGPT web session rather than the separately billed OpenAI API.

The project must not silently fall back to OpenAI API usage.

### R2 — Machine-level handoff

Claude ↔ GPT handoff must be implemented as deterministic local software. The coding agent must not spend model context on screenshots, locating browser controls, clicking the ChatGPT UI, or visually waiting for replies.

The desired logical interface is:

```text
ask_gpt(message) -> response text
```

Browser automation, if required internally, is an implementation detail hidden below this interface.

### R3 — Minimal operational burden

Normal use must not require the user to remember commands such as starting bridge servers, port numbers, browser profiles, or recurring login commands.

The system should:

- detect whether the reviewer bridge is ready;
- reuse a persisted local ChatGPT login when possible;
- request interactive login only when actually required;
- start/stop required local components automatically where practical;
- provide a single agent-native entry point for normal work.

### R4 — GitHub-backed independent review

The executor's prose summary is not sufficient evidence of correctness.

Each review request should identify the repository and exact Git coordinates needed for ChatGPT to inspect the real implementation, for example:

- repository;
- base commit;
- head commit;
- task/spec path;
- deterministic test/gate results when available.

The reviewer should inspect the actual repository/diff whenever accessible.

### R5 — Claude Code is the first executor

The first supported coding agent is Claude Code. The initial user experience should be available directly inside Claude Code rather than requiring the user to operate a separate orchestration CLI.

### R6 — Agent-agnostic core

Claude-specific behavior must remain in a thin adapter. The core review loop and ChatGPT bridge should be reusable by future executors such as Codex.

A future installation should be able to support an experience conceptually similar to:

```text
install claude adapter
install codex adapter
```

without rewriting the bridge or state model.

### R7 — Local-first, independent repository

The project itself must live locally and in its own Git repository so that:

- implementation history is independent from target application repositories;
- upgrades and rollbacks are auditable;
- moving to another machine is straightforward;
- future adapters can share the same codebase.

### R8 — Configurable loop policy

The following must be configurable rather than permanently hard-coded:

- task granularity;
- planning mode (e.g. incremental vs preplanned);
- review response format (natural language vs structured result);
- maximum rework count;
- deterministic test/gate commands;
- commit/push behavior;
- conditions that require human intervention;
- completion criteria.

The defaults should remain simple.

### R9 — Human remains the authority for non-mechanical decisions

The system should stop rather than improvise when a meaningful decision is required, including:

- ambiguous product behavior;
- unresolved domain semantics;
- architecture changes outside the agreed scope;
- substantial scope expansion;
- contradictory acceptance criteria;
- retry/rework limit exceeded.

The canonical stop state is `HUMAN_REQUIRED`.

### R10 — Reviewer approval gates completion

The executor must not mark a run complete merely because it believes the implementation is finished.

The normal completion path requires explicit reviewer approval such as `DONE` or another agreed terminal result.

## 3. Desired review outcomes

V1 may use a very small result vocabulary:

- `CONTINUE` — current step is acceptable; proceed to the next implementation step.
- `REWORK` — current implementation has issues; fix them and resubmit.
- `DONE` — the agreed goal and acceptance criteria are satisfied.
- `HUMAN_REQUIRED` — further progress requires a human decision.

The exact serialization can evolve later.

## 4. Cost model requirement

The transport layer itself must not invoke an extra reasoning model. It should be ordinary local code.

Expected usage therefore consists of:

- coding-agent usage for implementation;
- ChatGPT subscription usage for planner/reviewer messages;
- no OpenAI API billing in the intended reviewer path;
- negligible compute cost for local transport/orchestration itself.

ChatGPT subscription limits still apply; the project must not describe the web session as literally unlimited.

## 5. Security requirements

Never commit or log:

- ChatGPT cookies;
- browser profile contents;
- session tokens;
- API keys;
- GitHub credentials;
- private repository contents unrelated to the requested evidence;
- secrets extracted from target repositories.

Authentication state must remain local and outside version control.

## 6. Reliability requirements to inherit from supergpt where useful

The project should progressively adopt these proven mechanisms as the core loop matures:

- base/head Git anchors;
- dirty-worktree checks;
- bounded retries;
- deterministic test gates before expensive reviewer calls;
- independent reviewer evidence;
- explicit rework state;
- resumable run state;
- audit log/report;
- protection against executor-driven destructive Git operations.

These are not all prerequisites for the first communication PoC, but they are part of the intended reliable system.
