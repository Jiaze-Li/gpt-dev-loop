# SuperGPT Roadmap

This file is intentionally short. Old browser-bridge phase plans and pre-V1 role designs are retired; Git history and `docs/handoff/archive/` preserve that history.

## V1 — current baseline

V1 is the production foundation:

- one canonical `runSuperGPT()` execution engine;
- one global `COMMON.md` frontend contract for Claude, Codex, and AGY;
- one `supergpt` MCP launch path for all frontends;
- isolated workspace execution and safe delivery;
- deterministic Gate and independent Reviewer;
- Core-controlled normal task progression;
- Supervisor exception-only;
- durable status, stop, resume, provider failover, quota/health, and process cleanup.

## V2 — next planned work

`docs/V2_PLAN.md` is the sole detailed V2 plan.

The planned sequence is:

1. centralized deterministic zero-token `supergpt_route`;
2. Fast Path / Full Path selection without weakening independent review;
3. trusted PR review -> fix -> re-review closeout loop;
4. bounded non-convergence/escalation and unattended end-to-end validation;
5. optional browser adviser only after the local production path remains stable.

Rule: new active policy or entrypoints replace old ones. Do not create V1.1-style parallel frontend behavior or preserve obsolete fallback paths.
