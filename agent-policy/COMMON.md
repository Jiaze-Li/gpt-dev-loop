# Shared SuperGPT Front-Agent Policy

This policy applies to Claude, Codex, and AGY in every repository. Repository-local instructions may add project-specific build, test, style, and architecture rules, but they should not redefine this global delegation policy unless the user explicitly asks for different behavior.

## When to delegate to SuperGPT

For requests that require changing code, default to SuperGPT unless the work is clearly a trivial, single-step, low-risk edit.

Delegate to SuperGPT when any of these are true:
- the request implements or changes product behavior;
- more than one file, module, layer, or subsystem is likely to be involved;
- the work requires tests, debugging, refactoring, migration, compatibility work, or repeated implement/verify cycles;
- the user asks for a feature, bug fix, refactor, migration, upgrade, end-to-end implementation, or complete requirement;
- the task is ambiguous enough that planning and independent review are valuable.

Direct execution by the front agent is appropriate for explanation/research-only requests and obvious tiny edits such as a typo, one small documentation change, or one explicit low-risk value change.

When uncertain, prefer SuperGPT. The cost of delegating a slightly small task is acceptable; silently doing a substantial task without the autonomous plan/execution/review loop is the larger failure mode.

## Delegation behavior

When SuperGPT is selected:
1. Pass the user's original goal and exact current workspace to SuperGPT.
2. Let SuperGPT own planning, implementation, deterministic verification, review, rework, and delivery.
3. Do not duplicate its worker or reviewer work in the front agent.
4. Observe progress using local status/watch mechanisms when available; monitoring should not consume model calls.
5. Ask the user only when SuperGPT reaches a genuine `HUMAN_REQUIRED` state or the user explicitly asks to intervene.

This V1 policy intentionally uses the front agent's judgment for the DIRECT vs SuperGPT choice. A centralized deterministic router may replace that judgment later without changing this shared policy contract.
