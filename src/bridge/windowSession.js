// Node-side wrapper around the window-lifecycle wire actions
// (windowCreate/windowActivateTab/windowClose — see
// extension/windowLifecycle.js and extensionProtocol.js's buildRequestMessage
// doc comment). Not a persistent Session class like SupervisorSession/
// ReviewerSession — there is no ongoing per-window state to hold beyond the
// windowId the caller already keeps, so this is three thin, stateless
// functions over the same getExtensionServer() singleton those use.
//
// Originally added only for scripts/test-background-automation-window-live.js;
// src/orchestrator/automatedLoop.js now also depends on this shape (as its
// `windowSession` option) to keep every Supervisor/Reviewer tab it opens
// inside one dedicated, permanently unfocused automation window instead of
// the user's normal Chrome window — see that file's module doc comment.

import { randomUUID } from 'node:crypto';
import { getExtensionServer } from './extensionServer.js';
import { withTimeout } from './chromeRuntime.js';
import { mapProtocolError } from './chatgptExtension.js';
import { TransportError, ChromeUnavailableError } from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';

async function runWireCall(promiseFactory) {
  try {
    return await promiseFactory();
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

// Opens one dedicated, deliberately unfocused window and returns its
// windowId. chrome.windows.create() always creates one initial tab of its
// own (navigated to config.chatgptUrl) as a side effect of opening the
// window at all — `initialTabId` is that tab's id, reported back so the
// caller can decide what to do with it (production automatedLoop.js closes
// it once the real Supervisor tab is up, so the window doesn't carry a
// permanent unused placeholder tab alongside the Supervisor/Reviewer tabs —
// see automatedLoop.js's module doc comment).
export async function createAutomationWindow(config) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  const result = await withTimeout(
    runWireCall(() =>
      server.windowCreate({
        requestId,
        chatgptUrl: config.chatgptUrl,
        responseTimeoutMs: config.responseTimeoutMs,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      })
    ),
    config.requestTimeoutMs,
    `Window create request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
  return { windowId: result.windowId, initialTabId: result.initialTabId ?? null };
}

// Makes `tabId` active inside its own window WITHOUT focusing that window.
// Returns the observed state: { tabId, active, windowId, windowFocused }.
export async function activateTabWithoutFocusingWindow(config, tabId) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  const result = await withTimeout(
    runWireCall(() =>
      server.windowActivateTab({
        requestId,
        tabId,
        responseTimeoutMs: config.responseTimeoutMs,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      })
    ),
    config.requestTimeoutMs,
    `Window activate-tab request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
  return result.windowActivation;
}

// Closes exactly `tabId` — a plain tab close, not a window close. Reuses the
// generic supervisorClose wire action (background.js's closeSupervisorTab
// has no supervisor-specific behavior; it just removes whatever tabId it is
// given), so this needs no new wire action of its own. Used to close the
// automation window's own initial placeholder tab once the real Supervisor
// tab has taken its place.
export async function closeTab(config, tabId) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  await withTimeout(
    runWireCall(() =>
      server.supervisorClose({
        requestId,
        tabId,
        responseTimeoutMs: config.responseTimeoutMs,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      })
    ),
    config.requestTimeoutMs,
    `Tab close request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
}

// Zero-GPT-request diagnostic: lists every tab in `windowId`, returning only
// safe metadata (see windowLifecycle.js's listAutomationWindowTabs doc
// comment) — never page text, prompt/reply content, tab titles, or the tab's
// URL itself.
export async function listTabs(config, windowId) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  const result = await withTimeout(
    runWireCall(() =>
      server.windowListTabs({
        requestId,
        windowId,
        responseTimeoutMs: config.responseTimeoutMs,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      })
    ),
    config.requestTimeoutMs,
    `Window list-tabs request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
  return result.tabs;
}

// Closes exactly `windowId` (and every tab inside it).
export async function closeAutomationWindow(config, windowId) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  await withTimeout(
    runWireCall(() =>
      server.windowClose({
        requestId,
        windowId,
        responseTimeoutMs: config.responseTimeoutMs,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      })
    ),
    config.requestTimeoutMs,
    `Window close request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
}
