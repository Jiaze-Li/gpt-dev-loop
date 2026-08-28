// Pure orchestration for a dedicated, diagnostics-only Chrome window
// lifecycle — the "background automation window" architecture under test by
// scripts/test-background-automation-window-live.js. No chrome.* calls
// directly (same pattern as supervisorLifecycle.js), so this runs under
// plain Node in tests; background.js supplies the chrome.windows-backed
// implementations of each dependency.
//
// Why this exists (live evidence, 2026-08-27): a background-created ChatGPT
// tab sometimes fails to reply while its Chrome WINDOW is not the foreground
// window, even though the tab itself is `active` inside that window. The
// diagnostic hypothesis is that what actually matters is the *window's*
// focus state, not the tab's active state — so this primitive keeps a
// dedicated window permanently unfocused while still letting the tab that
// does the work be `active` inside it. Nothing here changes production
// behavior: no production caller creates one of these windows today.

// Deterministically identifies the one initial tab chrome.windows.create()
// makes inside a freshly created window, from a chrome.tabs.query({
// windowId }) result — never assumes array order alone: a freshly created
// window's own initial tab is always the active one, so that is preferred
// when present, falling back to the first entry only if `active` wasn't
// reported (a test double, or a Chrome build that omits it).
function pickInitialTabId(tabs) {
  if (!tabs || tabs.length === 0) return null;
  const active = tabs.find((tab) => tab.active);
  const chosen = active ?? tabs[0];
  return chosen?.id ?? null;
}

// Creates one dedicated window and leaves it open, unfocused. chrome.windows
// create() always creates exactly one initial tab of its own (navigated to
// `url`) — this function never suppresses that; it only reports the
// resulting tab's id back as `initialTabId` so the caller can decide what to
// do with it (production automatedLoop.js closes it once the real Supervisor
// tab is up — see automatedLoop.js's module doc comment on the 3-tab
// placeholder finding, 2026-08-27). Real work tabs are created afterwards,
// inside this windowId, by the caller (createSupervisorTab's windowId
// option).
//
// `populate` is NOT a valid chrome.windows.create() createData field (it
// only exists on the window-query APIs, e.g. chrome.windows.get/getAll) —
// passing it throws "Unexpected property: 'populate'" and windowCreate fails
// outright (live evidence, 2026-08-27). The initial tab's id is instead
// obtained with a separate, valid chrome.tabs.query({ windowId }) call after
// the window exists. Returns { windowId, initialTabId }.
export async function createAutomationWindow({ url = 'about:blank' } = {}, { createWindow, queryTabs, log = () => {} }) {
  const window = await createWindow({ url, focused: false, type: 'normal' });
  const tabs = await queryTabs(window.id);
  const initialTabId = pickInitialTabId(tabs);
  log(`automation window ${window.id} created focused=false initialTabId=${initialTabId}`);
  return { windowId: window.id, initialTabId };
}

// Classifies a tab's URL into a safe, coarse bucket — never the URL itself.
// Exported for tests; used by listAutomationWindowTabs below.
export function classifyUrlState(url) {
  if (!url) return 'other';
  if (url === 'about:blank') return 'blank';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return 'chrome-internal';
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
  return 'other';
}

// Zero-GPT-request diagnostic: lists every tab in `windowId`, returning only
// safe metadata — never page text, prompt/reply content, or the tab's title.
// `url` itself is read only to classify it into urlState, then discarded.
// Returns { tabs: [{ windowId, tabId, active, status, urlState, openerTabId
// }] }.
export async function listAutomationWindowTabs(windowId, { queryTabs, log = () => {} }) {
  const rawTabs = await queryTabs(windowId);
  const tabs = rawTabs.map((tab) => ({
    windowId,
    tabId: tab.id,
    active: tab.active,
    status: tab.status ?? null,
    urlState: classifyUrlState(tab.url),
    openerTabId: tab.openerTabId ?? null,
  }));
  log(`automation window ${windowId} tabs: ${tabs.map((t) => `${t.tabId}(${t.urlState})`).join(', ') || '<none>'}`);
  return { tabs };
}

// Makes `tabId` the active tab within its own window WITHOUT focusing that
// window — the load-bearing behavior this whole diagnostic exists to prove
// is possible. Returns the observed state (never assumed) so the caller can
// log/verify it: { tabId, active, windowId, windowFocused }.
export async function activateTabWithoutFocus(tabId, { updateTab, getWindow, log = () => {} }) {
  const tab = await updateTab(tabId, { active: true });
  const window = await getWindow(tab.windowId);
  log(`tab ${tabId} active=${tab.active} window ${window.id} focused=${window.focused}`);
  return { tabId, active: tab.active, windowId: window.id, windowFocused: window.focused };
}

// Closes exactly `windowId` (and every tab inside it, per chrome.windows.remove
// semantics) — a no-op, not an error, if the window is already gone.
export async function closeAutomationWindow(windowId, { removeWindow, windowExists, log = () => {} }) {
  if (await windowExists(windowId)) {
    await removeWindow(windowId);
    log(`automation window ${windowId} closed`);
  } else {
    log(`automation window ${windowId} already gone; close() is a no-op`);
  }
}
