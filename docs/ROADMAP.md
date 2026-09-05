# SuperGPT Roadmap

This file is intentionally short. Old browser-bridge phase plans and pre-V1
role designs are retired; Git history and `docs/handoff/archive/` preserve that
history.

## V1 — foundation / historical baseline

V1 established the production foundation:

- one canonical `runSuperGPT()` execution engine;
- one global `COMMON.md` frontend contract for Claude, Codex, and AGY;
- one `supergpt` MCP launch path for all frontends;
- isolated workspace execution and safe delivery;
- deterministic Gate and independent Reviewer;
- Core-controlled normal task progression;
- Supervisor exception-only;
- durable status, stop, resume, provider failover, quota/health, and process cleanup.

## V2 — current release candidate

`docs/V2_PLAN.md` records the agreed V2 design.

- ✓ centralized deterministic zero-token `supergpt_route` (route-first frontend contract)
- ✓ `supergpt_start_and_wait` single-call launch-and-block; no autonomous watch/wait loop
- ✓ Fast Path / Full Path selection without weakening independent review
- ✓ trusted PR review -> fix -> re-review closeout loop
- ✓ bounded non-convergence / escalation handling
- ✓ zero-token Dashboard + attention/history workflow lifecycle
- ✓ Token Safety architecture — mock-certified
- ✓ V2 unattended functional workflow — mock-certified
- ✓ bounded real Fast-Path provider smoke — PASS (one bounded workflow only)

Not live-certified: provider failover, escalation, PR closeout, and the full
provider pools.

## Optional / deferred future work

- optional browser adviser (`V2-D`): only as an adviser/provider for unusually
  difficult cases, never a workflow owner, Supervisor path, execution/review
  dependency, or second frontend launch path. Deferred; not required for the V2
  release.

Rule: new active policy or entrypoints replace old ones. Do not create
V1.1-style parallel frontend behavior or preserve obsolete fallback paths.
