# Phase 1 — Usage

This covers only the Phase 1 handshake PoC described in `PHASE-1-HANDSHAKE.md`.
It does not describe the Claude/Codex adapters or the review loop — those are
later phases.

## What this is

A minimal CLI, `gpt-loop ask "<prompt>"`, that sends one plain-text prompt to
your existing ChatGPT web session (`chatgpt.com`) via Playwright-controlled
Chrome and prints the assistant's plain-text reply. No OpenAI API key or
`api.openai.com` call is involved anywhere in this path.

## Install

```bash
npm install
```

This requires a system installation of Google Chrome (Playwright drives it
via `channel: "chrome"`, not the bundled Chromium).

## Run

```bash
node ./bin/gpt-loop.js ask "Reply with exactly HANDSHAKE_OK and nothing else."
```

or, equivalently:

```bash
npm run ask -- "Reply with exactly HANDSHAKE_OK and nothing else."
```

### First run

No local session exists yet, so a visible Chrome window opens at
`chatgpt.com`. The command waits (up to `GPT_LOOP_LOGIN_TIMEOUT_MS`, default
5 minutes) for the chat composer to appear, so you have time to log in,
clear a Cloudflare/bot check, or dismiss a cookie-consent dialog in that
window. Once the composer appears, the command proceeds automatically and
prints the reply.

### Later runs

The authenticated session is persisted in a local Chrome profile directory
outside this repository, at `~/.gpt-dev-loop/chrome-profile/` by default —
those cookies are account-equivalent, so they must never live inside a Git
work tree even a gitignored one. Later invocations reuse that profile and
normally require no further login.

## Live smoke test

```bash
node ./bin/gpt-loop.js ask "Reply with exactly HANDSHAKE_OK and nothing else."
# expect: HANDSHAKE_OK

node ./bin/gpt-loop.js ask "Reply with exactly SECOND_OK and nothing else."
# expect: SECOND_OK, with no manual login prompt this time
```

## Configuration (optional)

All overrides are environment variables; defaults are otherwise used:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GPT_LOOP_CHATGPT_URL` | `https://chatgpt.com/` | Target page |
| `GPT_LOOP_PROFILE_DIR` | `~/.gpt-dev-loop/chrome-profile` | Persistent browser profile location (account-equivalent cookies — keep it outside any Git work tree) |
| `GPT_LOOP_HEADLESS` | `false` | Run Chrome headless once login is no longer needed |
| `GPT_LOOP_LOGIN_TIMEOUT_MS` | `300000` | How long to wait for manual login |
| `GPT_LOOP_RESPONSE_TIMEOUT_MS` | `120000` | How long to wait for a completed reply |

## Exit codes

Non-zero on any transport failure (Chrome unavailable, login timeout,
selector/layout mismatch, response timeout, empty/unextractable response).
`0` only on a successfully extracted reply.

## Automated tests

```bash
npm test
```

Covers argument parsing, config resolution, and error/exit-code mapping —
deterministic code that does not touch a live browser or ChatGPT session.
The browser-driving code in `src/bridge/chatgptWeb.js` is exercised only by
the live smoke test above, since it depends on the real, currently-live
ChatGPT DOM.

## Known limitations

- DOM selectors for the composer, send button, stop button, and assistant
  message container are best-effort matches against the current ChatGPT web
  UI. If OpenAI changes that markup, the command fails with a clear
  `SelectorMismatchError` rather than hanging or silently misbehaving — but
  the selectors themselves will need updating. Timeout/failure messages
  include the page's current URL and title so a login wall, a Cloudflare/bot
  check, and an actual selector mismatch can be told apart; a Cloudflare
  interstitial title is reported as `LoginRequiredError` instead.
- Response completion is detected by watching for the "stop generating"
  control to disappear combined with the reply text becoming stable; an
  unusual UI state could in principle cause a slightly early or late read.
- Phase 1 always drives a real, persistent Chrome profile; there is no
  headless/CI mode for the live path (see `docs/ARCHITECTURE.md` §"Non-goals"
  for why CI login is explicitly out of scope).
