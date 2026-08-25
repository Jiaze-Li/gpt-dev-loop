# Roadmap

The project should be built in small, testable stages. The first milestone is not a full autonomous orchestrator; it is a reliable machine-level ChatGPT review channel that can be used from Claude Code.

## Phase 0 — Freeze requirements and safety boundaries

Status: **in progress**

Deliverables:

- project requirements;
- architecture boundary;
- explicit non-goals;
- security rules;
- initial comparison with `supergpt`;
- public-repo secret policy.

Exit criterion:

- we can describe the V1 loop without relying on hidden assumptions.

## Phase 1 — `ask_gpt` communication PoC

Goal: prove reliable bidirectional text exchange between local code and an existing ChatGPT web session without OpenAI API usage.

Tasks:

1. Study and isolate the smallest useful parts of the existing `gpt-web-bridge` approach.
2. Establish persistent local browser/session storage outside Git.
3. Detect login state.
4. Send a text prompt deterministically.
5. Detect completion of the assistant response.
6. Return plain text to the caller.
7. Expose explicit errors for login expiration, DOM mismatch, timeout, and session failure.
8. Verify that the coding agent does not inspect screenshots or drive the browser itself.

Acceptance test:

```text
local caller -> ask_gpt("return handshake-ok") -> ChatGPT web -> "handshake-ok"
```

This phase is the most important technical feasibility test.

## Phase 2 — Claude Code integration

Goal: make the bridge available naturally inside Claude Code.

Tasks:

1. Package the reviewer call as a local tool, preferably through an MCP-compatible boundary.
2. Add a Claude Code Skill / plugin workflow.
3. Add automatic bridge health check/startup.
4. Automatically request login only when the session is unavailable.
5. Hide ports, daemons, browser selectors, and internal commands from normal use.
6. Define one obvious entry path such as natural language or a discoverable skill.

Acceptance test:

```text
User in Claude Code: "ask GPT to review this change"
Claude -> local tool -> ChatGPT web -> reply visible to Claude
```

No manual copy/paste and no manually started `serve` process.

## Phase 3 — Minimal development loop

Goal: automate the current human transport loop.

Flow:

```text
read spec
-> implement bounded step
-> test
-> produce/push Git evidence
-> ask GPT to inspect evidence
-> CONTINUE / REWORK / DONE / HUMAN_REQUIRED
-> repeat or stop
```

Tasks:

1. Define the minimal review request contract.
2. Define result vocabulary.
3. Track base/head commits.
4. Add retry/rework count.
5. Require reviewer approval before terminal completion.
6. Produce a final human-readable report.

Acceptance test:

Run a small real repository task that intentionally requires one rework cycle:

```text
SPEC -> implementation -> GPT REWORK -> fix -> GPT DONE
```

with no human prompt forwarding.

## Phase 4 — Deterministic gates and Git safety

Goal: make the loop safe enough for unattended multi-step runs.

Adopt proven mechanisms from `supergpt` where appropriate:

- clean-worktree precondition;
- deterministic test gates before GPT review;
- allowed-file / scope protection;
- before/after branch and HEAD anchors;
- protection against destructive Git surgery;
- trusted evidence commit/push policy;
- no degraded reviewer pass when required evidence failed to publish.

Acceptance tests should cover:

- normal pass;
- deterministic gate failure without reviewer call;
- reviewer rework;
- Git-surgery detection;
- out-of-scope modification;
- evidence-push failure.

## Phase 5 — Resume and unattended reliability

Goal: recover from crashes or session failures without rerunning the wrong phase.

Tasks:

- persistent run state;
- phase-aware resume;
- reviewer-only retry for transport failures;
- idempotent handling of already-reviewed heads;
- audit log/report;
- run locking to prevent accidental duplicate loops.

Acceptance test:

Interrupt execution independently during EXECUTING, VERIFYING, and REVIEWING, then confirm resume performs only the necessary remaining work.

## Phase 6 — Configuration and task strategy

Goal: expose useful policy without making normal use complicated.

Potential configuration:

```yaml
planning:
  mode: incremental

task:
  size: medium

review:
  transport: chatgpt-web
  max_rework: 3

git:
  publish_evidence: true

stop:
  on_human_required: true
```

Possible future planning strategy:

- global architecture / milestone plan;
- materialize only the next concrete implementation card;
- replan explicitly when architecture assumptions or scope change.

## Phase 7 — Codex adapter

Goal: prove the core is genuinely agent-agnostic.

Tasks:

1. Add Codex-native installation/instructions.
2. Reuse the same local reviewer bridge.
3. Reuse the same config and state format.
4. Reuse Git evidence and reviewer result contracts.
5. Keep Claude and Codex adapters thin.

Acceptance criterion:

A target repo can switch executor integration without forking the reviewer bridge or orchestration core.

## Phase 8 — One-step setup and migration

Goal: make the project easy to move between machines.

Desired experience:

```text
git clone <repo>
./install claude
```

The installer should:

- check runtime prerequisites;
- install/link the local plugin/tooling;
- create local secret/profile directories outside Git;
- validate ChatGPT login when first needed;
- provide self-diagnostics;
- be safely repeatable.

Later:

```text
./install codex
```

## Pilot strategy

Do not begin with a large production feature. Use progressively harder pilots:

1. handshake-only;
2. GPT review of an already-pushed trivial commit;
3. one implementation + PASS;
4. one forced REWORK cycle;
5. multi-step spec;
6. interruption/resume;
7. real personal-development workflow.

Any point where the human still has to act as a mechanical message relay should be logged as a product defect or missing requirement.
