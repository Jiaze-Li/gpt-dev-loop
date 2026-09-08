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
| D22 | Every AGY family runs through the `reviewloop-minimal` custom agent (`inheritCustomizations: false`), provisioned deterministically/idempotently at `<isolated gemini dir>/config/agents/reviewloop-minimal/agent.md` and reached with `--gemini_dir` — **not** a workspace `.agents/` path (agy does not reliably discover a workspace-local custom agent and silently falls back to the default agent when `--agent` is unresolvable). Never provisioned into the user's HOME or AGY global config. Effective loading is checked by a zero-model startup capability probe **and** per-call verification; any failure fails closed (AGY families UNAVAILABLE) — ReviewLoop never accepts an AGY default-agent reply. Definitive isolated-agent live result: `agy:gemini` medium Supervisor `usageVolume 2933`, `effectiveLoadingVerified`. Earlier ~40k (isolation not in effect — default agent) and ~6.7k (pre-verification) figures are **not** a baseline. No production family is `highContext`; `agy:gemini` is in ordinary automatic routing. |
| D23 | `usageVolume` (the `MAX_USAGE_VOLUME` safety ceiling) is provider/family-aware (`usageAccountingOf`), keyed off the family/provider in the CallIntent, never a model name. Precedence: authoritative provider-reported total (trusted **only** from a token-total field confirmed for that class — `AUTHORITATIVE_TOTAL_ALIASES`; a bare `total` and any total on an unknown provider are ignored) → family fallback (`openai` = input+output, cache-read is a subset; `anthropic` = input+output+cache_creation+cache_read, separate categories) → conservative additive flagged `semanticsKnown:false` for AGY-without-total / unknown providers. A fallback reports known only when its mechanically-required fields are present; a partial post-dispatch usage object (`volumeResolved:false`) fails closed into the existing `MODEL_SPEND_USAGE_UNRESOLVED` / `ReservationLedger` UNRESOLVED path, never read as 0. Cached tokens are never double-counted; raw breakdown + `usageAccounting` provenance persisted per record. UNKNOWN != ZERO preserved. |
