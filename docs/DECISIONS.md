# ReviewLoop decisions

Current architectural decisions. Historical SuperGPT V1/V2 decisions are under
`docs/history/`.

| # | decision |
|---|---|
| D1 | Worker-owned execution. The coding agent the user is talking to implements, tests, and pushes. |
| D2 | ReviewLoop is not a coding agent. It never writes application code. |
| D3 | Planner removed. The Worker receives the user's prompt directly; there is no task decomposition, no Fast/Full path, no task queue. |
| D4 | Executor pool removed. No internal Executor role, no Sonnet-only chain, no fresh rework sessions. |
| D5 | The Worker uses its host's normal permissions. ReviewLoop does not sandbox the Worker (allowed_files / exact verification commands / no-pipe restrictions are gone). |
| D6 | Git evidence is authoritative. The baseline-to-current diff is the primary Reviewer input. |
| D7 | The Gate is verification, not a command-permission system. 0 model tokens. |
| D8 | P1/P2 block completion; P3 does not. Root `CLAUDE.md` review conventions are aligned to this. |
| D9 | The first actionable REWORK goes directly to the same Worker — no Supervisor, no new session. |
| D10 | Supervisor is exception-only: invoked at most once, only after a genuine changed implementation left the same blocking finding. |
| D11 | Local waiting never wakes the Worker or a model. `WAITING_FOR_REVIEW` is a durable state. |
| D12 | External review is bound to the exact PR HEAD. An old-HEAD clean review never approves a new HEAD. |
| D13 | Same evidence cannot spend twice. `NO NEW INFORMATION → NO NEW MODEL CALL`, enforced at the authority boundary. |
| D14 | ReviewLoop never auto-merges and never force-pushes. |
| D15 | The Worker-facing MCP surface is exactly two tools; COMMON ≤ 2.5 KB; result payloads are compact and never carry raw evidence blobs. |
| D16 | `~/.reviewloop` is the runtime root. `~/.supergpt` is never read, written, or auto-resumed; a legacy V2 snapshot fails closed. |
| D17 | Reviewer/Supervisor transports are narrow single-turn inference from one isolated empty scratch cwd — never a second coding Worker. One physical attempt per call; failover is the controller's, not the transport's. |
| D18 | Stable model-family identity is preserved without concrete version pins: `agy:*` resolves from the runtime catalog, `codex:default` delegates to the Codex default, and `claude:opus` passes the stable provider alias `opus`; telemetry records the concrete model actually used. |
| D19 | A pool family is either a wired, selectable transport or explicitly UNAVAILABLE with a reason. No phantom fallbacks. `codex`/`claude` wire only after zero-token `--version` plus local auth-status preflights succeed. |
| D20 | Authentication has two boundaries: local `codex login status` / `claude auth status` failures are pre-dispatch and make that family unavailable; an auth-looking error after a prompt-bearing invocation starts is `PROVIDER_AUTH_REJECTED`, has unknown spend unless provider usage proves otherwise, and must not authorize failover. |
| D21 | `benchmark:transports` is zero-provider and covers both transport narrowness and controller E2E-A (one-round PASS), E2E-B (REWORK→PASS), and E2E-C (persistent blocker→Supervisor once). |
