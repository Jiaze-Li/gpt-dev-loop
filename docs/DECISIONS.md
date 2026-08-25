# Architecture / Product Decisions

This file records decisions already agreed during initial design discussion so that later implementation does not accidentally reopen them without cause.

## D-001 — The product is a development loop, not a new coding agent

**Decision:** `gpt-dev-loop` is deterministic orchestration and transport around existing models. It is not itself an AI agent.

**Reason:** The value is removing manual prompt forwarding while preserving clear role separation.

## D-002 — Human and GPT discuss the plan before autonomous execution

**Decision:** The normal workflow begins with the human and ChatGPT agreeing on requirements / architecture / acceptance and writing that agreement into the target repo.

**Reason:** Product and domain decisions should be made before the unattended implementation loop whenever possible.

## D-003 — Claude does not need GPT to actively wake it

**Decision:** The coding side runs the loop and synchronously calls GPT when review is required.

**Reason:** This avoids building a complex bidirectional event-notification system. GPT only needs to answer review/planning calls.

## D-004 — Reviewer path should use ChatGPT web session, not OpenAI API

**Decision:** The intended GPT reviewer path uses the user's existing ChatGPT web session and must not silently switch to separately billed OpenAI API usage.

**Reason:** Avoid incremental API billing and reuse the interactive ChatGPT environment the user already uses for planning/review.

**Caveat:** ChatGPT plan usage limits still apply. Web automation is not treated as an official stable machine API and may require maintenance when the website changes.

## D-005 — Handoff must be mechanical

**Decision:** Agent-to-GPT transport is local deterministic code. Claude should not use vision/screenshots or visually operate the ChatGPT website.

**Reason:** Browser reasoning wastes executor context/usage and is less reliable than a narrow machine interface.

## D-006 — GitHub diff is primary implementation evidence

**Decision:** Reviewer requests should identify the repository and exact base/head state. GPT should inspect the actual GitHub diff when possible.

**Reason:** Executor summaries are lossy and can omit mistakes. Git evidence is reproducible and independently auditable.

## D-007 — Claude Code is the first UI, but Claude is not the architecture

**Decision:** V1 should feel native inside Claude Code, but Claude-specific integration remains an adapter.

**Reason:** The user wants one familiar control surface today, while future Codex support should require only a new adapter rather than a rewrite.

## D-008 — Local independent repository

**Decision:** `gpt-dev-loop` lives in its own local/GitHub repository with its own development history.

**Reason:** Clean versioning, portability, easy migration, and separation from target application repositories.

## D-009 — Prefer invisible setup over remembered commands

**Decision:** Normal operation should not require the user to remember `serve`, port, login, or daemon commands.

**Reason:** Operational simplicity is a core product requirement, not cosmetic polish.

**Implementation implication:** readiness/login should be detected automatically; human interaction should occur only when authentication truly needs intervention.

## D-010 — V1 stays smaller than supergpt

**Decision:** Do not port the entire `supergpt` state machine and protocol before proving the communication and review loop.

**Reason:** The minimum valuable product is `ask_gpt` + Claude workflow + Git evidence + review/rework loop.

## D-011 — Reuse supergpt lessons selectively

**Decision:** Carry forward proven ideas such as deterministic gates, Git anchors, independent evidence, bounded retry, rework state, phase-aware resume, and Git-safety controls as reliability needs appear.

**Reason:** These mechanisms solve real failure modes already encountered, but they should not obscure the initial PoC.

## D-012 — Reviewer approval gates completion

**Decision:** The executor cannot declare success solely on its own judgment. A normal autonomous run ends only after explicit reviewer `DONE` / equivalent approval.

**Reason:** Otherwise the executor also becomes its own quality authority, defeating the purpose of the loop.

## D-013 — Human intervention must be explicit

**Decision:** Use a terminal `HUMAN_REQUIRED` outcome for decisions that are not safe to automate.

Typical triggers:

- ambiguity in product behavior;
- architecture decision outside agreed constraints;
- scope expansion;
- contradictory requirements;
- repeated failed rework;
- unsafe or destructive action requiring approval.

## D-014 — Task representation and size are policy, not architecture

**Decision:** Natural-language task descriptions are acceptable initially. Task cards, task size, planning horizon, retry limits, and stop policy remain configurable.

**Reason:** These questions require empirical tuning from real use rather than premature schema design.

## D-015 — Long-term planning strategy should be hybrid

**Decision:** Prefer global architectural/milestone planning with local incremental task materialization rather than either fully preplanning every coding card or replanning the entire project after every commit.

**Reason:** This preserves architectural coherence while reducing stale detailed plans and unnecessary reviewer/planner context.

## D-016 — Secrets never enter the repository

**Decision:** ChatGPT login state, browser profile data, cookies, tokens, and credentials remain local and ignored by Git.

**Reason:** The repository may be public and must remain safe to clone/share.

## Open decisions

These are intentionally not frozen yet:

- exact runtime/language for the local core;
- whether to embed/fork `gpt-web-bridge` code or depend on it as a module;
- exact ChatGPT conversation/session strategy;
- exact Claude Plugin packaging layout;
- whether evidence commit/push is performed by the agent or a trusted core process in the earliest V1;
- structured vs natural-language review response for the first prototype;
- exact task sizing defaults;
- public/private distribution strategy once implementation contains bridge details.

These should be resolved through Phase 1–3 experiments rather than assumption.
