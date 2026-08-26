// Pure orchestration for the Supervisor tab lifecycle — the mirror image of
// reviewSession.js's runReviewInFreshTab, for the opposite lifecycle:
// reviewSession.js creates a tab, uses it once, and always closes it; this
// creates a tab once and leaves it open across many later asks, closing it
// only when explicitly told to. No chrome.* calls directly, so — like
// reviewSession.js — this runs under plain Node in tests; background.js is
// the only real caller, supplying the chrome.tabs-backed implementations of
// each dependency.
//
// None of these functions keep any state of their own between calls — the
// caller (background.js, and above it the Node-side SupervisorSession in
// src/bridge/supervisorSession.js) is the one that remembers `tabId` across
// create() -> ask() -> ask() -> close(). That is deliberate: it is what
// makes "ask() must address the exact tab the caller already holds, never
// the most recently active ChatGPT tab" true by construction — there is no
// implicit "current tab" anywhere in this module to fall back to.

// Opens one fresh tab and leaves it open (never closes it here) — returns
// { tabId }. No prompt is sent and no conversation identity exists yet
// (ChatGPT does not assign one until the first message is sent).
export async function createSupervisorTab({ chatgptUrl }, { createTab, waitForTabComplete, removeTab, log = () => {} }) {
  const tab = await createTab({ url: chatgptUrl, active: false });
  log(`supervisor tab ${tab.id} created`);
  try {
    await waitForTabComplete(tab.id);
  } catch (err) {
    // A create() that never finishes loading must not leak an orphaned tab
    // the caller has no id for yet.
    try {
      await removeTab(tab.id);
    } catch {
      // best effort
    }
    throw err;
  }
  log(`supervisor tab ${tab.id} finished loading`);
  return { tabId: tab.id };
}

// Relays `message` to exactly `tabId` — never any other tab. If the tab no
// longer exists, resolves with a SUPERVISOR_TAB_LOST result (mirrors
// content.js's `{ ok: false, code, message }` shape, matching the existing
// error-reporting convention for every other action) instead of throwing or
// silently trying a different tab.
export async function askSupervisorTab(tabId, message, { tabExists, sendToContentScript, log = () => {} }) {
  if (!(await tabExists(tabId))) {
    log(`supervisor tab ${tabId} no longer exists`);
    return { ok: false, code: 'SUPERVISOR_TAB_LOST', message: `Supervisor tab ${tabId} no longer exists (closed?).` };
  }
  log(`relaying supervisor ask to existing tab ${tabId}`);
  return sendToContentScript(tabId, message);
}

// Closes exactly `tabId` and no other tab (a plain tab close — never the
// ChatGPT in-page delete flow). A no-op, not an error, if the tab is
// already gone: the caller's intent ("make sure this is closed") is already
// satisfied.
export async function closeSupervisorTab(tabId, { tabExists, removeTab, log = () => {} }) {
  if (await tabExists(tabId)) {
    await removeTab(tabId);
    log(`supervisor tab ${tabId} closed`);
  } else {
    log(`supervisor tab ${tabId} already gone; close() is a no-op`);
  }
}
