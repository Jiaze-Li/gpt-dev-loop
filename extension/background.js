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
import { createSupervisorTab, attachSupervisorTab, askSupervisorTab, closeSupervisorTab } from './supervisorLifecycle.js';
import { createAutomationWindow, activateTabWithoutFocus, closeAutomationWindow, listAutomationWindowTabs } from './windowLifecycle.js';
import { createStageStore } from './stageDiagnostics.js';

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
// How long a freshly created (and now "complete") tab gets to actually
// hydrate ChatGPT's own SPA and mount a usable composer, per
// supervisorLifecycle.js's createSupervisorTab — see its header comment for
// why "complete" alone is not sufficient evidence and TAB_LOAD_TIMEOUT_MS
// above is a different, earlier gate than this one.
const CHATGPT_PAGE_READY_TIMEOUT_MS = 20000;
// Bound for the cheap liveness ping used to confirm a content script
// listener exists before asking it to do anything else — much shorter than
// CHATGPT_PAGE_READY_TIMEOUT_MS since this only proves the listener is
// registered, not that the page has finished hydrating.
const CONTENT_SCRIPT_PING_TIMEOUT_MS = 3000;
// Bound for the reviewer preflight's content-script round trip — short
// because this is a local, single-read diagnostic (no polling/waiting, no
// GPT request); a bit longer than CONTENT_SCRIPT_PING_TIMEOUT_MS to give the
// dynamic domActions.js import room to complete.
const REVIEWER_PREFLIGHT_TIMEOUT_MS = 5000;

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

// Timeout-diagnostics store (2026-08-27) — see stageDiagnostics.js's header
// comment. Only handleSupervisorAsk (below) ever init()s a record; every
// other action's requestId is simply never tracked, so update() calls for
// them (e.g. sendToContentScriptWithRetry's generic 'relay started' below)
// are no-ops.
const supervisorAskStages = createStageStore();

// Fire-and-forget stage reports posted by content.js's own supervisorAsk
// handler (chrome.runtime.sendMessage, not chrome.tabs.sendMessage — there
// is no response to send back, and this must never affect the real
// supervisorAsk relay in flight). Carries only requestId/stage, matching
// stageDiagnostics.js's contract.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'gptLoopStageUpdate' && typeof message.requestId === 'string' && typeof message.stage === 'string') {
    supervisorAskStages.update(message.requestId, message.stage);
  }
  return false;
});

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
    let result;
    switch (payload.action) {
      case 'supervisorCreate':
        result = await handleSupervisorCreate(payload, reqLog, requestId);
        break;
      case 'supervisorAttach':
        result = await handleSupervisorAttach(requestId, payload, reqLog);
        break;
      case 'supervisorAsk':
        result = await handleSupervisorAsk(requestId, payload, reqLog);
        break;
      case 'supervisorClose':
        result = await handleSupervisorClose(payload, reqLog);
        break;
      case 'reviewerPreflight':
        result = await handleReviewerPreflight(requestId, payload, reqLog);
        break;
      case 'diagnosticStage':
        result = handleDiagnosticStage(payload);
        break;
      case 'windowCreate':
        result = await handleWindowCreate(payload, reqLog);
        break;
      case 'windowActivateTab':
        result = await handleWindowActivateTab(payload, reqLog);
        break;
      case 'windowClose':
        result = await handleWindowClose(payload, reqLog);
        break;
      case 'windowListTabs':
        result = await handleWindowListTabs(payload, reqLog);
        break;
      case 'delete':
        result = await runReviewInFreshTab(
          {
            chatgptUrl: payload.chatgptUrl,
            perform: (tabId) =>
              sendToContentScriptWithRetry(tabId, {
                type: 'performDelete',
                requestId,
                conversationId: payload.conversationId,
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
        reqLog('delete confirmed');
        break;
      default:
        result = await runReviewInFreshTab(
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
    }
    sendResult(requestId, result);
  } catch (err) {
    reqLog(`failed: ${err.message}`);
    // Propagate a specific code when one is known (e.g. CHATGPT_PAGE_NOT_READY
    // from handleSupervisorCreate's readiness gate) rather than always
    // collapsing every failure into the generic NO_CHATGPT_TAB.
    sendResult(requestId, { ok: false, code: err.code ?? 'NO_CHATGPT_TAB', message: err.message });
  }
}

// Resolves true if `tabId` currently exists, false otherwise — the
// dependency supervisorLifecycle.js's askSupervisorTab/closeSupervisorTab
// use to give an immediate, unambiguous SUPERVISOR_TAB_LOST rather than
// letting a stale tabId fall through to sendToContentScriptWithRetry's
// "content script not injected yet" retry path (which is for a real,
// existing tab only).
function tabExists(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(!chrome.runtime.lastError && !!tab);
    });
  });
}

// Full chrome.tabs.Tab metadata (url/status/active/discarded), or null if
// the tab no longer exists — the tab-existence half of reviewerPreflight's
// diagnostics below. Never rejects.
function getTabInfo(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

// Zero-GPT-request local preflight for an EXISTING Reviewer tab — gathers
// tab/content-script/composer diagnostics only, never sends a prompt, never
// reloads/retries/creates a tab, and never itself decides pass/fail (that
// judgment, and any resulting fail-fast error, is reviewerSession.js's job
// on the Node side — this handler just reports facts). Always resolves
// ok:true; the caller reads `preflight`'s fields to decide what to do.
async function handleReviewerPreflight(requestId, payload, reqLog) {
  const tabId = payload.tabId;
  const tab = await getTabInfo(tabId);
  if (!tab) {
    reqLog(`reviewer preflight: tab ${tabId} does not exist`);
    return {
      ok: true,
      text: '',
      preflight: {
        tabId,
        tabExists: false,
        url: null,
        tabStatus: null,
        active: null,
        discarded: null,
        contentScriptReachable: false,
        pageReady: null,
        composerExists: null,
        composerConnected: null,
        composerInteractive: null,
      },
    };
  }

  let contentScriptReachable = false;
  let snapshot = null;
  try {
    const result = await sendToContentScriptWithRetry(tabId, {
      type: 'reviewerPreflight',
      requestId,
      responseTimeoutMs: REVIEWER_PREFLIGHT_TIMEOUT_MS,
    });
    if (result?.ok) {
      contentScriptReachable = true;
      snapshot = result.preflight;
    }
  } catch (err) {
    reqLog(`reviewer preflight: content script unreachable in tab ${tabId}: ${err.message}`);
  }

  return {
    ok: true,
    text: '',
    preflight: {
      tabId,
      tabExists: true,
      url: snapshot?.url ?? tab.url ?? null,
      tabStatus: tab.status ?? null,
      active: tab.active ?? null,
      discarded: tab.discarded ?? null,
      contentScriptReachable,
      pageReady: snapshot?.pageReady ?? null,
      composerExists: snapshot?.composerExists ?? null,
      composerConnected: snapshot?.composerConnected ?? null,
      composerInteractive: snapshot?.composerInteractive ?? null,
    },
  };
}

// Thin chrome.tabs-backed wiring over supervisorLifecycle.js's pure
// orchestration — same pattern as runReviewInFreshTab's own wiring just
// below. The Node-side SupervisorSession (src/bridge/supervisorSession.js)
// is what actually remembers tabId across create() -> ask() -> ask() ->
// close(); nothing here does.
async function handleSupervisorCreate(payload, reqLog, requestId) {
  const { tabId } = await createSupervisorTab(
    { chatgptUrl: payload.chatgptUrl, active: payload.active, windowId: payload.windowId },
    {
      createTab: (opts) => chrome.tabs.create(opts),
      waitForTabComplete: (tabId) => waitForTabComplete(tabId),
      removeTab: (tabId) => chrome.tabs.remove(tabId),
      ensureContentScriptReady: (tabId) => ensureContentScriptReady(tabId, requestId),
      waitForChatGptReady: (tabId) => waitForChatGptPageReady(tabId, requestId),
      log: reqLog,
    }
  );
  return { ok: true, text: '', tabId };
}

// Confirms a content script listener exists in `tabId`, injecting it (via
// the same manual chrome.scripting.executeScript fallback
// sendToContentScriptWithRetry already uses elsewhere in this file) if the
// declarative manifest.json content_scripts entry hasn't finished injecting
// yet. A cheap 'ping' round trip, never touching the DOM — the actual page
// readiness check is a separate step (waitForChatGptPageReady below), since
// "the listener exists" and "ChatGPT has hydrated" are different facts.
async function ensureContentScriptReady(tabId, requestId) {
  await sendToContentScriptWithRetry(tabId, { type: 'ping', requestId, responseTimeoutMs: CONTENT_SCRIPT_PING_TIMEOUT_MS });
}

// Asks the (now confirmed-present) content script to wait for ChatGPT's own
// SPA to finish hydrating a usable composer (domActions.js's
// waitForChatGptReady) before this resolves. Throws with the extension's
// reported code (CHATGPT_PAGE_NOT_READY on a real not-ready page, or
// whatever domActions.js's waitForChatGptReady itself threw, e.g.
// RATE_LIMITED) and the observed URL/readiness diagnostics in the message —
// this is what stops a not-ready tab from ever reaching supervisorAsk/
// reviewer.review and hanging out the full response timeout there instead.
async function waitForChatGptPageReady(tabId, requestId) {
  const result = await sendToContentScript(tabId, {
    type: 'waitForChatGptReady',
    requestId,
    responseTimeoutMs: CHATGPT_PAGE_READY_TIMEOUT_MS,
  });
  if (!result.ok) {
    const err = new Error(result.message || `ChatGPT page in tab ${tabId} did not become ready.`);
    err.code = result.code || 'CHATGPT_PAGE_NOT_READY';
    err.diagnostics = result.diagnostics;
    throw err;
  }
  return result;
}

// Attaches to an EXISTING conversation by its exact conversationId — never
// creates a new one. Opens a tab navigated straight to that conversation
// (supervisorLifecycle.js's attachSupervisorTab), then requires the content
// script to verify (real DOM/URL evidence — see domActions.js's
// verifyAttachedConversationId) that the tab actually ended up showing that
// exact conversation before this resolves. Fails closed on any mismatch/
// not-found/tab-lost outcome: the mismatched or unverifiable tab is closed
// rather than left dangling in the wrong conversation, and this never falls
// back to creating a fresh conversation for the caller.
async function handleSupervisorAttach(requestId, payload, reqLog) {
  let tabId;
  try {
    ({ tabId } = await attachSupervisorTab(
      { chatgptUrl: payload.chatgptUrl, conversationId: payload.conversationId },
      {
        createTab: (opts) => chrome.tabs.create(opts),
        waitForTabComplete: (tabId) => waitForTabComplete(tabId),
        removeTab: (tabId) => chrome.tabs.remove(tabId),
        log: reqLog,
      }
    ));
  } catch (err) {
    return {
      ok: false,
      code: 'SUPERVISOR_ATTACH_MISMATCH',
      message: `Could not load conversation "${payload.conversationId}": ${err.message}`,
    };
  }

  const verifyResult = await sendToContentScriptWithRetry(tabId, {
    type: 'supervisorVerifyIdentity',
    requestId,
    expectedConversationId: payload.conversationId,
  });

  if (!verifyResult.ok) {
    // Never leave a tab sitting on the wrong (or unverifiable) conversation
    // behind for the caller to accidentally address later.
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // best effort
    }
    return verifyResult;
  }

  return { ok: true, text: '', tabId, conversationId: verifyResult.conversationId };
}

async function handleSupervisorAsk(requestId, payload, reqLog) {
  reqLog(`background received supervisorAsk request tabId=${payload.tabId}`);
  supervisorAskStages.init(requestId, payload.tabId, 'background request received');
  // askSupervisorTab (supervisorLifecycle.js) logs 'target tab resolved
  // tabId=...' right after its tabExists() check passes — this wrapper
  // stays a thin, chrome-API-free log sink from that pure module's point of
  // view (it can't and shouldn't know about the stage store), while still
  // letting this handler capture that milestone.
  const stageAwareLog = (stage) => {
    reqLog(stage);
    if (stage.startsWith('target tab resolved')) supervisorAskStages.update(requestId, 'target tab resolved');
  };
  const result = await askSupervisorTab(
    payload.tabId,
    {
      type: 'supervisorAsk',
      requestId,
      prompt: payload.prompt,
      expectedConversationId: payload.expectedConversationId ?? null,
      responseTimeoutMs: payload.responseTimeoutMs,
    },
    { tabExists, sendToContentScript: sendToContentScriptWithRetry, log: stageAwareLog }
  );
  reqLog(`response returned to background tabId=${payload.tabId}`);
  return result;
}

// Zero-chrome-API local read of the last known stage for a PREVIOUSLY
// issued requestId (typically one whose own request already timed out or
// was cancelled) — called with a NEW requestId of its own (see
// reviewerSession.js's captureFailureSnapshot), so this never depends on
// the original request's promise/connection/tab still being alive. Always
// resolves ok:true; `stageRecord` is null if the id is unknown or its
// record has already expired (see stageDiagnostics.js's TTL).
function handleDiagnosticStage(payload) {
  return { ok: true, text: '', stageRecord: supervisorAskStages.get(payload.originalRequestId) };
}

async function handleSupervisorClose(payload, reqLog) {
  await closeSupervisorTab(payload.tabId, {
    tabExists,
    removeTab: (tabId) => new Promise((resolve) => chrome.tabs.remove(tabId, resolve)),
    log: reqLog,
  });
  return { ok: true, text: '' };
}

// The window-lifecycle quartet backing the dedicated automation window
// architecture (see windowLifecycle.js's header comment). Originally added
// only for scripts/test-background-automation-window-live.js's diagnostic;
// src/orchestrator/automatedLoop.js (via src/bridge/windowSession.js) is now
// also a production caller of windowCreate/windowActivateTab/windowClose.

async function handleWindowCreate(payload, reqLog) {
  const { windowId, initialTabId } = await createAutomationWindow(
    { url: payload.chatgptUrl },
    {
      createWindow: (opts) => chrome.windows.create(opts),
      queryTabs: (windowId) => new Promise((resolve) => chrome.tabs.query({ windowId }, resolve)),
      log: reqLog,
    }
  );
  return { ok: true, text: '', windowId, initialTabId };
}

// Zero-GPT-request diagnostic: lists every tab in an explicit windowId,
// returning only safe metadata (see windowLifecycle.js's
// listAutomationWindowTabs doc comment) — never page text, prompt/reply
// content, tab titles, or the tab's URL itself.
async function handleWindowListTabs(payload, reqLog) {
  const { tabs } = await listAutomationWindowTabs(payload.windowId, {
    queryTabs: (windowId) => new Promise((resolve) => chrome.tabs.query({ windowId }, resolve)),
    log: reqLog,
  });
  return { ok: true, text: '', tabs };
}

async function handleWindowActivateTab(payload, reqLog) {
  const diagnostics = await activateTabWithoutFocus(payload.tabId, {
    updateTab: (tabId, opts) => new Promise((resolve, reject) => {
      chrome.tabs.update(tabId, opts, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab);
      });
    }),
    getWindow: (windowId) => new Promise((resolve, reject) => {
      chrome.windows.get(windowId, (window) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(window);
      });
    }),
    log: reqLog,
  });
  return { ok: true, text: '', windowActivation: diagnostics };
}

function windowExists(windowId) {
  return new Promise((resolve) => {
    chrome.windows.get(windowId, (window) => {
      resolve(!chrome.runtime.lastError && !!window);
    });
  });
}

async function handleWindowClose(payload, reqLog) {
  await closeAutomationWindow(payload.windowId, {
    windowExists,
    removeWindow: (windowId) => new Promise((resolve) => chrome.windows.remove(windowId, resolve)),
    log: reqLog,
  });
  return { ok: true, text: '' };
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
  log(`[${message.requestId}] content-script relay started tabId=${tabId} type=${message.type}`);
  supervisorAskStages.update(message.requestId, 'relay started');
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
  // `text` is required by the wire protocol's 'response' shape even for a
  // delete result, which has none — an empty string keeps the shape valid
  // without inventing a second response schema for one action.
  const message = result.ok
    ? {
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId,
        payload: {
          text: result.text ?? '',
          conversationId: result.conversationId,
          ...(result.tabId !== undefined ? { tabId: result.tabId } : {}),
          ...(result.identityDiagnostics !== undefined ? { identityDiagnostics: result.identityDiagnostics } : {}),
          ...(result.preflight !== undefined ? { preflight: result.preflight } : {}),
          ...(result.windowId !== undefined ? { windowId: result.windowId } : {}),
          ...(result.initialTabId !== undefined ? { initialTabId: result.initialTabId } : {}),
          ...(result.tabs !== undefined ? { tabs: result.tabs } : {}),
          ...(result.windowActivation !== undefined ? { windowActivation: result.windowActivation } : {}),
          ...(result.stageRecord !== undefined ? { stageRecord: result.stageRecord } : {}),
        },
      }
    : { protocol: PROTOCOL_ID, type: 'error', requestId, error: { code: result.code, message: result.message } };
  ws.send(JSON.stringify(message));
}

ensureConnected();
