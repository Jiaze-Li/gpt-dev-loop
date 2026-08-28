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
//
// chrome.tabs reaching "complete" only means the outer document finished
// loading — live evidence (2026-08-27) showed a second Reviewer tab reach
// "complete" while ChatGPT's own SPA was still a blank page, and the ask
// sent right after it hung for the full response timeout waiting on a
// composer that was never actually usable. So "complete" is followed by two
// more real-evidence gates, both caller-injected (this module stays
// chrome-API-free, same as every other function here): confirming a content
// script listener actually exists in the tab (injecting it if the
// declarative manifest.json injection hasn't landed yet), then confirming
// ChatGPT's own UI has hydrated a usable composer. Any failure at any stage
// — load, content script, or page readiness — cleans up the orphaned tab
// exactly like the pre-existing load-failure path did, rather than handing
// the caller a tabId that isn't actually usable.
//
// Because ReviewerSession is built by reusing this same supervisorCreate
// wire action (see src/bridge/reviewerSession.js's header comment), this one
// primitive hardens both Supervisor and Reviewer tab creation.
// `active` defaults to false (never steal the user's foreground tab in
// production); a caller may explicitly request `active: true` — added only
// for scripts/test-tab-activation-readiness-live.js's A/B diagnostic of
// whether a background-created tab is the cause of the intermittent blank
// ChatGPT page (2026-08-27 live evidence). No production caller passes
// `active` today, so default behavior is unchanged.
// `windowId` is likewise an optional diagnostic override (undefined by
// default, so chrome.tabs.create's own "current window" default governs) —
// added only for scripts/test-background-automation-window-live.js, which
// creates the tab inside a dedicated, deliberately unfocused window (see
// windowLifecycle.js) rather than whatever window is currently in front. No
// production caller passes `windowId` today.
export async function createSupervisorTab(
  { chatgptUrl, active = false, windowId },
  { createTab, waitForTabComplete, removeTab, ensureContentScriptReady, waitForChatGptReady, log = () => {} }
) {
  const tab = await createTab({ url: chatgptUrl, active, ...(windowId !== undefined ? { windowId } : {}) });
  log(`supervisor tab ${tab.id} created`);
  try {
    await waitForTabComplete(tab.id);
    log(`supervisor tab ${tab.id} finished loading`);
    await ensureContentScriptReady(tab.id);
    log(`supervisor tab ${tab.id} content script ready`);
    await waitForChatGptReady(tab.id);
    log(`supervisor tab ${tab.id} ChatGPT page ready`);
  } catch (err) {
    // A create() that never finishes loading, or never becomes usable, must
    // not leak an orphaned tab the caller has no way to address.
    try {
      await removeTab(tab.id);
    } catch {
      // best effort
    }
    throw err;
  }
  return { tabId: tab.id };
}

// Builds the direct-navigation URL for an existing conversation — the one
// and only way attachSupervisorTab locates a conversation (never a title
// search, never "most recent tab").
export function buildConversationUrl(chatgptUrl, conversationId) {
  const origin = chatgptUrl.replace(/\/+$/, '');
  return `${origin}/c/${encodeURIComponent(conversationId)}`;
}

// Opens one fresh tab navigated DIRECTLY to an existing conversation
// (`/c/<conversationId>`) and leaves it open — never opens a blank chat and
// never creates a new conversation. Mirrors createSupervisorTab's own
// load-failure cleanup (an orphaned, half-loaded tab is removed rather than
// left dangling with no caller-visible id). Whether the tab actually landed
// on the REQUESTED conversation (as opposed to being redirected elsewhere by
// ChatGPT's own router — e.g. the conversation doesn't exist or isn't
// accessible) is not decided here; that real DOM/URL verification happens
// content-script-side via domActions.js's verifyAttachedConversationId,
// after this tab finishes loading (see background.js's
// handleSupervisorAttach).
export async function attachSupervisorTab({ chatgptUrl, conversationId }, { createTab, waitForTabComplete, removeTab, log = () => {} }) {
  const url = buildConversationUrl(chatgptUrl, conversationId);
  log(`attach requested url=${url}`);
  const tab = await createTab({ url, active: false });
  log(`attach tab created tabId=${tab.id}`);
  try {
    await waitForTabComplete(tab.id);
  } catch (err) {
    try {
      await removeTab(tab.id);
    } catch {
      // best effort
    }
    throw err;
  }
  log(`supervisor attach tab ${tab.id} finished loading`);
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
  log(`target tab resolved tabId=${tabId}`);
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
