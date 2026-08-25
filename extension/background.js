// Service worker: owns the WebSocket connection to the local gpt-loop
// bridge server (src/bridge/extensionServer.js) and relays each `request`
// to whichever tab is running content.js. Protocol constants mirror
// src/bridge/extensionProtocol.js — the extension sandbox can't import
// files outside this directory, so this is a second, small copy of the
// same wire contract; keep both in sync when the protocol changes.

const PROTOCOL_ID = 'gpt-loop-extension/v1';
const WS_HOST = '127.0.0.1';
const WS_PORT = 8877; // must match config.js's DEFAULTS.extensionPort
const RECONNECT_DELAY_MS = 2000;
// Headroom over the request's own responseTimeoutMs deadline (content.js
// enforces that deadline itself) — this is a last-resort guard against a
// content script that hangs entirely (e.g. the tab crashed), not the
// primary way requests are expected to finish.
const TAB_MESSAGE_TIMEOUT_MARGIN_MS = 10000;

let ws = null;

function log(message) {
  console.log(`[gpt-loop bridge] ${message}`);
}

function connect() {
  ws = new WebSocket(`ws://${WS_HOST}:${WS_PORT}`);

  ws.addEventListener('open', () => {
    log('connected to local bridge; sending hello');
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'hello',
        requestId: crypto.randomUUID(),
        payload: { extensionVersion: '0.1.0', capabilities: ['chatgpt-dom-v1'] },
      })
    );
  });

  ws.addEventListener('message', (event) => handleMessage(event.data));

  ws.addEventListener('close', () => {
    log('disconnected from local bridge; retrying shortly');
    ws = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // 'close' fires right after 'error' for a failed connection; the
    // reconnect loop lives in the 'close' handler, not here.
  });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.protocol !== PROTOCOL_ID || msg.type !== 'request') return;

  const { requestId, payload } = msg;
  try {
    const tab = await findChatGptTab(payload.chatgptUrl);
    if (!tab) {
      sendResult(requestId, { ok: false, code: 'NO_CHATGPT_TAB', message: 'No open ChatGPT tab was found.' });
      return;
    }
    const result = await sendToContentScript(tab.id, {
      type: 'perform',
      requestId,
      prompt: payload.prompt,
      responseTimeoutMs: payload.responseTimeoutMs,
    });
    sendResult(requestId, result);
  } catch (err) {
    sendResult(requestId, { ok: false, code: 'NO_CHATGPT_TAB', message: err.message });
  }
}

// Turns the request's chatgptUrl into a chrome.tabs.query match pattern
// (e.g. "https://chatgpt.com/" -> "https://chatgpt.com/*"), so the tab we
// operate on actually matches what the caller configured rather than always
// being hardcoded to chatgpt.com. Falls back to the default origin if the
// request didn't supply one or it doesn't parse.
function toOriginMatchPattern(chatgptUrl) {
  try {
    return `${new URL(chatgptUrl).origin}/*`;
  } catch {
    return 'https://chatgpt.com/*';
  }
}

async function findChatGptTab(chatgptUrl) {
  const tabs = await chrome.tabs.query({ url: toOriginMatchPattern(chatgptUrl) });
  if (tabs.length === 0) return null;
  return tabs.reduce((best, tab) => ((tab.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? tab : best));
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('content script did not respond')),
      (message.responseTimeoutMs ?? 120000) + TAB_MESSAGE_TIMEOUT_MARGIN_MS
    );
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendResult(requestId, result) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const message = result.ok
    ? { protocol: PROTOCOL_ID, type: 'response', requestId, payload: { text: result.text } }
    : { protocol: PROTOCOL_ID, type: 'error', requestId, error: { code: result.code, message: result.message } };
  ws.send(JSON.stringify(message));
}

connect();
