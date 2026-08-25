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

// MV3-service-worker gotcha: `setTimeout` does NOT keep a service worker
// alive, and the worker can be terminated by Chrome (idle timeout, ~30s of
// no activity) at any point, including while a reconnect setTimeout is still
// pending — silently dropping the reconnect loop until *something* wakes the
// worker again. Top-level code re-runs (and so calls connect() again) every
// time the worker wakes for any reason, so the only gap is having a reason
// to wake up at all: chrome.alarms is the one API guaranteed to revive a
// terminated MV3 service worker on a schedule (setTimeout/setInterval are
// not). RECONNECT_ALARM_PERIOD_MINUTES is the practical floor Chrome
// enforces for alarms.
const RECONNECT_ALARM_NAME = 'gpt-loop-bridge-reconnect';
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;

let ws = null;

function log(message) {
  console.log(`[gpt-loop bridge] ${message}`);
}

function ensureConnected() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  connect();
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
    log('disconnected from local bridge (or nothing was listening yet); retrying shortly');
    ws = null;
    // Best-effort fast retry for the common case (worker still alive, e.g.
    // the bridge server just hadn't started listening yet). The
    // chrome.alarms listener below is the fallback that fires regardless of
    // whether this timer survives.
    setTimeout(ensureConnected, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // 'close' fires right after 'error' for a failed connection; the
    // reconnect loop lives in the 'close' handler, not here.
  });
}

chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME) ensureConnected();
});
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

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
      log(`[${requestId}] no tab matched ${toOriginMatchPattern(payload.chatgptUrl)}`);
      sendResult(requestId, { ok: false, code: 'NO_CHATGPT_TAB', message: 'No open ChatGPT tab was found.' });
      return;
    }
    log(`[${requestId}] using tab ${tab.id} (${tab.url})`);
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

ensureConnected();
