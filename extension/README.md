# gpt-dev-loop bridge (Chrome extension)

Lets `gpt-loop` send review prompts to, and read replies from, a ChatGPT tab
in the Chrome you already use day to day — no separate Chrome profile, no
launch flags, no re-login. See
`docs/handoff/2026-08-25-chrome-extension-bridge.md` for the full design;
this file only covers install/run steps.

## 1. Install the extension

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this `extension/` directory.
4. Copy the extension's ID shown on its card (a long lowercase string).

## 2. Point gpt-loop at it

The local bridge server only accepts connections whose `Origin` matches
this extension's ID, so it has to be configured once:

```bash
export GPT_LOOP_EXTENSION_ID=<the ID you copied>
export GPT_BROWSER_MODE=extension
```

Optional overrides (defaults shown):

```bash
export GPT_LOOP_EXTENSION_HOST=127.0.0.1
export GPT_LOOP_EXTENSION_PORT=8877
export GPT_LOOP_EXTENSION_CONNECT_TIMEOUT_MS=15000
```

`GPT_LOOP_EXTENSION_HOST`/`GPT_LOOP_EXTENSION_PORT` only move the address
gpt-loop's own local bridge server listens on — they don't reach the
extension. If you change either one, also edit the `WS_HOST`/`WS_PORT`
constants at the top of `extension/background.js` to match and reload the
extension from `chrome://extensions`; otherwise the extension keeps trying
to connect to the old default address.

## 3. Log into ChatGPT normally

Open `https://chatgpt.com/` in a regular tab in the same Chrome and make
sure you're logged in — the extension does not automate login.

## 4. Run a review

There's no separate "start the bridge" command — the local WebSocket server
starts automatically on the first request:

```bash
npm run ask -- "return handshake-ok"
```

The first call may take a couple of seconds while the extension's
background worker reconnects and finds your ChatGPT tab. If it fails with a
"no Chrome extension connected" style error, double-check the extension is
loaded and `GPT_LOOP_EXTENSION_ID`/`GPT_BROWSER_MODE` are set in the same
shell you're running `npm run ask` from.

## Known Phase 1 limits

- One ChatGPT tab, one Chrome, one request in flight at a time (later
  requests queue).
- If the extension can't find the composer on the page (e.g. you're logged
  out), it reports "login required" — it will not attempt to log in for
  you.
- No cookies, tokens, or ChatGPT content are stored by the extension or the
  bridge server; the prompt/reply only pass through memory for the duration
  of one request.
