# Architecture

## 1. Target shape

`gpt-dev-loop` is a local review-loop core with thin integrations for coding agents.

```text
                    ┌─────────────────────┐
                    │       Human         │
                    │ WHAT / WHY / final  │
                    └──────────┬──────────┘
                               │
                               v
                    ┌─────────────────────┐
                    │   Target repo SPEC  │
                    │  goals + acceptance │
                    └──────────┬──────────┘
                               │
                               v
┌─────────────────────────────────────────────────────────┐
│                    Coding-agent adapter                 │
│            Claude first, Codex later                    │
└──────────────────────────┬──────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────┐
│                     gpt-dev-loop core                   │
│                                                         │
│  policy -> state -> gates -> git evidence -> reviewer  │
└──────────────────────────┬──────────────────────────────┘
                           │ ask_gpt(review request)
                           v
┌─────────────────────────────────────────────────────────┐
│                 Local ChatGPT Web Bridge                │
│  session reuse / login detection / deterministic I/O   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           v
                    ┌─────────────────────┐
                    │   ChatGPT web chat  │
                    │ planner / reviewer  │
                    └──────────┬──────────┘
                               │
                               v
                    ┌─────────────────────┐
                    │ GitHub repo / diff  │
                    │ primary evidence    │
                    └─────────────────────┘
```

## 2. Important control decision

ChatGPT does **not** need to actively wake the coding agent.

The coding side owns the long-running loop and calls the reviewer synchronously when a review is required:

```text
implement -> test -> publish evidence -> ask_gpt -> interpret result -> continue
```

This removes the hardest bidirectional event-delivery problem. The reviewer only needs to answer requests.

## 3. Separation of concerns

### Core

The core should eventually own only deterministic orchestration concerns:

- run state;
- allowed transitions;
- retry policy;
- deterministic gates;
- Git evidence coordinates;
- reviewer result validation;
- stop conditions;
- audit events.

It should not contain Claude-specific prompt text or ChatGPT DOM selectors.

### Reviewer bridge

The bridge exposes a small transport contract such as:

```text
ask_gpt(request) -> response
```

Responsibilities:

- ensure a usable local ChatGPT session exists;
- reuse persisted browser/session state;
- send text to the selected conversation/session;
- wait for the completed assistant response;
- return plain text / structured result;
- expose meaningful transport errors.

Non-responsibilities:

- deciding whether code is correct;
- deciding task scope;
- interpreting Git diffs itself;
- invoking the OpenAI API as an implicit fallback.

### Claude adapter

The Claude adapter should make the loop feel native inside Claude Code.

Likely mechanisms:

- a Claude Code Skill describing the implementation/review protocol;
- an MCP-exposed local tool for reviewer calls and possibly run-state operations;
- optional plugin hooks for startup/status checks.

The adapter should be thin enough that removal of Claude does not remove the core system.

### Future Codex adapter

A Codex adapter should reuse:

- the same reviewer bridge;
- the same config format;
- the same run-state format;
- the same Git evidence contract;
- the same reviewer result vocabulary.

Only agent-native installation and workflow instructions should differ.

## 4. Proposed repository layout

This is a direction, not a frozen implementation detail:

```text
gpt-dev-loop/
├── core/
│   ├── loop
│   ├── state
│   └── policy
├── bridge/
│   └── chatgpt-web
├── evidence/
│   └── git
├── gates/
├── adapters/
│   ├── claude/
│   └── codex/
├── config/
├── scripts/
├── docs/
└── tests/
```

V1 may begin with fewer files. Boundaries matter more than directory count.

## 5. Review contract

The handoff should be coordinate-based instead of copying implementation content through the bridge.

Example conceptual request:

```text
Task: implement feature X
Spec: docs/SPEC.md
Repo: owner/repo
Base: abc123
Head: def456
Gates: PASS
Instruction: inspect the GitHub diff and decide CONTINUE / REWORK / DONE / HUMAN_REQUIRED
```

Benefits:

- low transport volume;
- reviewer sees authoritative code;
- executor cannot hide mistakes in a prose summary;
- fewer duplicated tokens/context;
- easy auditing and reproduction.

## 6. Loop state

V1 can use a lightweight state model:

```text
READY
  -> EXECUTING
  -> VERIFYING
  -> REVIEWING
      -> EXECUTING       (CONTINUE / REWORK)
      -> COMPLETE        (DONE)
      -> HUMAN_REQUIRED
      -> ABORTED         (hard failure / retry limit)
```

A full state machine is not required for the first `ask_gpt` PoC, but the eventual system should persist enough information to resume without accidentally rerunning already-reviewed work.

## 7. Git policy

GitHub is the primary code evidence channel.

Recommended mature flow:

1. Capture clean-worktree and branch/HEAD anchors.
2. Let the coding agent modify files and run tests.
3. Validate scope and deterministic gates.
4. Publish a mechanical evidence commit/push through trusted orchestration logic where practical.
5. Ask GPT to review `base...head`.
6. Record reviewer result against that exact head.

The executor should not have unrestricted authority to perform destructive history operations as part of ordinary task execution.

## 8. Browser/session boundary

The browser should be hidden beneath the bridge.

The coding agent must not need to:

- inspect screenshots;
- locate DOM elements;
- click controls;
- poll visual state;
- reason about browser layout.

If DOM automation is necessary, deterministic bridge code owns it. A DOM change should fail as a bridge error, not consume coding-agent reasoning trying to recover visually.

## 9. Installation direction

The desired end state is one local checkout plus adapter installation.

Conceptually:

```text
git clone .../gpt-dev-loop
./install claude
```

and later:

```text
./install codex
```

Normal use should not require separately managing a bridge daemon. Startup and health checks should be handled by the adapter/plugin or a local process manager hidden behind it.

## 10. What stays configurable

Policy belongs in configuration, including:

- task size;
- planning horizon;
- reviewer conversation strategy;
- retry count;
- test commands;
- commit policy;
- human-gate triggers;
- structured vs natural-language review output.

The architecture should not assume one permanent answer to these choices.

## 11. Modern Headless Architecture (SuperGPT Production)

The modern production architecture operates entirely headless through the Google Antigravity CLI (`agy`) and local Claude Code without any browser extension, DOM interaction, or open tabs:

1. **Invocation State**: The user or agent invokes SuperGPT from any workspace. `src/orchestrator/workspaceSnapshot.js` captures HEAD, staged changes, unstaged changes, and untracked files into an isolated git worktree (`~/.supergpt/worktrees`).
2. **Planner**: `src/orchestrator/planner.js` uses Gemini via `agy` to decompose natural-language intent into bounded, verification-ready tasks.
3. **Supervisor**: `src/orchestrator/adapters/agySupervisorProvider.js` maintains a single persistent conversation across the workflow to guide task sequencing and evaluate rework.
4. **Executor**: Clean Claude Code session per attempt in the isolated worktree with symlinked `node_modules`.
5. **Gate**: `src/orchestrator/adapters/gateRunner.js` runs verification commands with output bounding to protect reviewer context.
6. **Reviewer**: `src/orchestrator/adapters/agyReviewerProvider.js` independently audits git diffs in a persistent per-task conversation across rework cycles.
7. **Delivery**: `src/orchestrator/resultDelivery.js` applies approved deltas safely back into the invocation workspace, preserving user dirty files and pruning the worktree.

*(Note: The legacy Chrome extension and Playwright web bridge located in `src/adapters/gpt-reviewer/` and `src/extension-bridge/` are deprecated historical implementations preserved for reference).*
