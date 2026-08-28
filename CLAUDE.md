# gpt-dev-loop

## Code review conventions

Label every review finding with a severity prefix and lead each inline comment with it.

- **P1** - must fix before merge: wrong results, data loss or corruption, a fail-closed path failing silently, credential or security exposure, breaking an existing caller or a documented contract.
- **P2** - should fix, does not block merge: unhandled edge cases with bounded blast radius, error paths that swallow context, real but unlikely races, missing test coverage for new branching logic.
- **P3** - nit: naming, structure, duplication, stale comments.

Review output rules:

- Begin every inline comment with the bare label, e.g. `P1: ...`.
- Report at most 8 P3 items; summarise any remainder as a count.
- Skip anything the test suite, `npm run benchmark` or `npm run doctor` already enforces.
- Cite `file:line` for any claim about behaviour. Never infer behaviour from a symbol name alone.
- Prefer silence over speculation: drop findings you cannot trace to concrete code.

## Project context

This repository orchestrates an automated development loop: a Task Card is executed by Claude, verified by deterministic gates, then reviewed by a GPT reviewer; REWORK loops back into a fresh execution session. Operating rules live in `.agents/rules/supergpt.md`.
