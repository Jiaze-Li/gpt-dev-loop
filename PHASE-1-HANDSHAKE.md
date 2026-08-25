# Phase 1 — ChatGPT Web Handshake PoC

## Goal

Prove the single most important technical assumption of `gpt-dev-loop`:

> A local program can send a plain-text prompt to the user's already-authenticated ChatGPT web session and synchronously return the assistant's plain-text reply, without using the OpenAI API and without requiring the coding agent to inspect screenshots or manually operate the browser UI.

This phase is intentionally narrow. Do **not** implement the full Claude plugin, autonomous development loop, Git review workflow, or Codex adapter yet.

## User story

From a local terminal on macOS, the user should eventually be able to run something conceptually equivalent to:

```bash
gpt-loop ask "Reply with exactly HANDSHAKE_OK"
```

and receive:

```text
HANDSHAKE_OK
```

The transport should use the user's normal logged-in ChatGPT web session.

## Hard requirements

1. **No OpenAI API**
   - Do not call `api.openai.com` or any separately billed OpenAI API endpoint.
   - Do not require an OpenAI API key.

2. **ChatGPT web session only**
   - Use a real browser session authenticated to `chatgpt.com`.
   - Persist browser/profile state locally so the user normally logs in only when the session is missing or expired.

3. **Mechanical transport**
   - The handshake layer must be ordinary deterministic code.
   - Do not ask Claude or another model to inspect screenshots, locate buttons, or reason about browser state.
   - Browser automation may use DOM-level automation such as Playwright.

4. **Text in, text out**
   - Expose a minimal programmatic interface whose core behavior is equivalent to:

```text
ask_gpt(prompt) -> assistant_text
```

5. **Local auth data must never enter Git**
   - Browser profiles, cookies, session files, tokens, local credentials, and `.env` secrets must remain outside the repository or be ignored.
   - Reuse and strengthen the repository `.gitignore` where needed.

6. **macOS first**
   - Phase 1 only needs to work reliably on the user's current macOS machine.
   - Avoid unnecessary platform-specific assumptions that would make later Linux/Windows support difficult.

7. **Keep the core portable**
   - Do not tightly couple the handshake implementation to Claude Code.
   - Claude integration will be an adapter in a later phase.

## Reference implementation

You may study the architecture and implementation ideas in:

- `https://github.com/ChildeRolando/gpt-web-bridge`

Useful concepts from that project include:

- Playwright controlling the system Chrome browser.
- Persistent local browser profile.
- Reusing an authenticated ChatGPT web session.
- DOM-based prompt submission and response extraction.
- Session continuation.

However, `gpt-dev-loop` must remain an independent project. Prefer the smallest amount of code necessary for this PoC rather than copying an entire application.

## Scope

### In scope

- Minimal Node.js implementation suitable for macOS.
- Automatic detection of whether a usable ChatGPT login/session exists.
- Opening a visible browser for first-time/manual login when needed.
- Sending one plain-text prompt.
- Waiting for one completed assistant reply.
- Returning/printing the reply as plain text.
- Clear timeout and transport errors.
- Minimal README or usage documentation for the PoC.
- Automated tests for deterministic code that does not require live ChatGPT access.
- One explicit live smoke-test procedure for the developer to run locally.

### Out of scope

Do **not** implement yet:

- Claude Code MCP integration.
- Claude Code Skill/plugin packaging.
- Codex integration.
- Autonomous `SPEC -> implement -> review -> rework` loop.
- GitHub diff review orchestration.
- Complex task-card schemas.
- Multi-agent state machines.
- Cost tracking.
- CI that logs into ChatGPT.
- Headless-cloud deployment.

## Suggested interface

The exact internal structure is up to the implementer, but the external PoC should stay very small. One acceptable shape is:

```bash
npm install
npm run ask -- "Reply with exactly HANDSHAKE_OK"
```

or:

```bash
node ./bin/gpt-loop.js ask "Reply with exactly HANDSHAKE_OK"
```

A later phase can turn this into an MCP tool such as `ask_gpt()`.

## Behavioral expectations

### First use

```text
local command
  -> detects no authenticated profile
  -> opens visible Chrome
  -> user logs into ChatGPT manually
  -> local profile is persisted outside tracked repository data
  -> command can continue or clearly instruct the user to retry
```

### Normal use

```text
local command
  -> reuses authenticated profile
  -> opens/reuses ChatGPT session
  -> submits text prompt
  -> waits for completed assistant response
  -> returns plain-text response
```

### Failure cases

The implementation should fail clearly rather than hang indefinitely when:

- Chrome is unavailable.
- ChatGPT is logged out.
- The page structure/selectors no longer match.
- ChatGPT response exceeds the configured timeout.
- A response cannot be extracted safely.

## Acceptance criteria

Phase 1 is complete only when all of the following are true.

### Deterministic checks

- `npm test` passes if tests are added.
- The project contains no OpenAI API key requirement.
- Searching the implementation shows no intended call to `api.openai.com`.
- Auth/browser profile files are outside tracked source or covered by `.gitignore`.
- The CLI/tool returns a non-zero exit code on transport failure.

### Live smoke test

On the user's Mac, after authenticating ChatGPT if necessary, run a command equivalent to:

```bash
gpt-loop ask "Reply with exactly HANDSHAKE_OK and nothing else."
```

Expected terminal output:

```text
HANDSHAKE_OK
```

Then run a second independent prompt without manually logging in again, for example:

```bash
gpt-loop ask "Reply with exactly SECOND_OK and nothing else."
```

Expected terminal output:

```text
SECOND_OK
```

The second request must reuse the persisted authenticated session/profile.

## Completion report

When implementation is finished, report:

1. Files changed.
2. How the local browser profile/session is stored.
3. Exact install command.
4. Exact live smoke-test command.
5. Automated test results.
6. Any fragility or known limitation, especially DOM selector dependencies.
7. Commit SHA and pushed branch.

## Stop conditions

Stop and ask for human input instead of broadening scope if any of the following occurs:

- The implementation would require an OpenAI API key or separately billed API.
- A design decision would materially change the user-visible architecture agreed in `README.md` / `docs/`.
- Authentication requires storing secrets inside the Git repository.
- The reference project's implementation appears incompatible with the current ChatGPT web UI and no narrow fix is obvious.

## Non-goals for this phase

Success does **not** mean the final product is complete. Success means only that this chain is proven on the user's Mac:

```text
local deterministic code
    -> authenticated ChatGPT web session
    -> GPT reply
    -> local deterministic code
```

Once this works reliably, Phase 2 can expose the same capability to Claude Code through MCP/plugin packaging.
