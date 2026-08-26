// Stand-in for extension/domActions.js's deleteConversation, used only by
// tests/contentScriptInjection.test.js to count how many times content.js's
// handlePerformDelete actually invokes it — decoupled from the real DOM
// postcondition logic (covered separately in tests/extensionDomActions.test.js).
export let deleteCallCount = 0;

export async function deleteConversation() {
  deleteCallCount += 1;
  return { deleted: true };
}
