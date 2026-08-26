// Service worker: owns the WebSocket connection to the local gpt-loop
// bridge server (src/bridge/extensionServer.js) and relays each `request`
// to a fresh, background ChatGPT tab created just for that request (see
// reviewSession.js — 2026-08-26 transport stabilization: one review
// conversation was previously reused across every review, which let GPT's
// judgment on one review bleed into the next). Protocol constants mirror
// src/bridge/extensionProtocol.js — the extension sandbox can't import
// files outside this directory, so this is a second, small copy of the
// same wire contract; keep both in sync when the protocol changes.

import { runReviewInFreshTab } from './reviewSession.js';

const PROTOCOL_ID = 'gpt-loop-extension/v1';
const WS_HOST = '127.0.0.1';
const WS_PORT = 8877; // must match config.js's DEFAULTS.extensionPort
const RECONNECT_DELAY_MS = 2000;
// Headroom over the request's own responseTimeoutMs deadline (content.js
// enforces that deadline itself) — this is a last-resort guard against a
// content script that hangs entirely (e.g. the tab crashed), not the
// primary way requests are expected to finish.
const TAB_MESSAGE_TIMEOUT_MARGIN_MS = 10000;
// How long a freshly created tab gets to reach "complete" load status
// before this request gives up on it — separate from responseTimeoutMs,
// since a slow initial chatgpt.com load shouldn't eat into the caller's
// reply-wait budget.
const TAB_LOAD_TIMEOUT_MS = 20000;

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

// Resolves once `tabId` reaches status "complete", or rejects after
// timeoutMs. Checks the tab's current status first (race-safe against a
// load that already finished before this was called), then falls back to
// chrome.tabs.onUpdated.
function waitForTabComplete(tabId, { timeoutMs = TAB_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error(`tab ${tabId} did not finish loading within ${timeoutMs}ms`))), timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return; // tab may not exist yet from the caller's point of view; onUpdated will still fire
      if (tab.status === 'complete') finish(resolve);
    });
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
  const startedAt = Date.now();
  const reqLog = (stage) => log(`[${requestId}] ${stage} +${Date.now() - startedAt}ms`);
  reqLog('request received');

  try {
    const result = await runReviewInFreshTab(
      {
        chatgptUrl: payload.chatgptUrl,
        perform: (tabId) =>
          sendToContentScriptWithRetry(tabId, {
            type: 'perform',
            requestId,
            prompt: payload.prompt,
            responseTimeoutMs: payload.responseTimeoutMs,
          }),
      },
      {
        createTab: (opts) => chrome.tabs.create(opts),
        waitForTabComplete: (tabId) => waitForTabComplete(tabId),
        removeTab: (tabId) => chrome.tabs.remove(tabId),
        log: reqLog,
      }
    );
    reqLog('reply returned');
    sendResult(requestId, result);
  } catch (err) {
    reqLog(`failed: ${err.message}`);
    sendResult(requestId, { ok: false, code: 'NO_CHATGPT_TAB', message: err.message });
  }
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

// A freshly created tab needs a moment after reaching "complete" for
// manifest.json's declarative content_scripts entry to actually finish
// injecting content.js — the first sendMessage can beat that by a beat and
// surface as chrome.runtime's generic "Could not establish connection.
// Receiving end does not exist." rather than anything actionable. Since
// manifest.json already grants the "scripting" permission, inject
// content.js ourselves once and retry rather than polling/guessing at a
// fixed extra delay.
const NO_RECEIVER_ERROR_PATTERN = /Receiving end does not exist|Could not establish connection/;

async function sendToContentScriptWithRetry(tabId, message) {
  try {
    return await sendToContentScript(tabId, message);
  } catch (err) {
    if (!NO_RECEIVER_ERROR_PATTERN.test(err.message)) throw err;
    log(`[${message.requestId}] no content script listener in tab ${tabId} yet; injecting and retrying`);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return sendToContentScript(tabId, message);
  }
}

function sendResult(requestId, result) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const message = result.ok
    ? { protocol: PROTOCOL_ID, type: 'response', requestId, payload: { text: result.text } }
    : { protocol: PROTOCOL_ID, type: 'error', requestId, error: { code: result.code, message: result.message } };
  ws.send(JSON.stringify(message));
}

ensureConnected();
