// Orchestrates one review request as its own fresh, background ChatGPT tab
// (2026-08-26 transport stabilization): a single ChatGPT conversation
// reused across multiple review requests was observed live to bleed
// context between unrelated Task Cards, producing a PASS verdict whose
// stated rationale didn't match the actual evidence it was given. One
// review attempt now always gets its own conversation — a tab created,
// used, and closed for that request alone — never a tab shared with any
// other request.
//
// Pure orchestration only, no chrome.* calls directly — every browser
// effect is injected, so this runs under plain Node in tests the same way
// domActions.js does. background.js is the only real caller, supplying the
// chrome.tabs-backed implementations of each dependency.

// `perform(tabId)` does the actual send/read work in that tab (relaying to
// its content script) and resolves/rejects with the review outcome. The
// tab is always closed afterward — on success, on a rejected `perform`, or
// if `createTab`/`waitForTabComplete` itself throws after the tab exists.
export async function runReviewInFreshTab(
  { chatgptUrl, perform },
  { createTab, waitForTabComplete, removeTab, log = () => {} }
) {
  const tab = await createTab({ url: chatgptUrl, active: false });
  log(`fresh tab ${tab.id} created`);

  try {
    await waitForTabComplete(tab.id);
    log(`tab ${tab.id} finished loading`);
    return await perform(tab.id);
  } finally {
    try {
      await removeTab(tab.id);
      log(`tab ${tab.id} closed`);
    } catch (err) {
      log(`tab ${tab.id} close failed (ignored): ${err.message}`);
    }
  }
}
