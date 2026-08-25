// Runs on https://chatgpt.com/*. Thin wiring only — the actual DOM
// interaction logic lives in domActions.js (a plain ES module, dynamically
// imported here via chrome.runtime.getURL() because manifest.json's
// declarative content_scripts entries are always classic scripts and can't
// use static `import`/`export`; domActions.js also being a standalone ESM
// is what lets tests/extensionDomActions.test.js import it directly in
// Node, so this is the same file, not a copy).

// Stage-only logging (no prompt/reply content) so a stuck run can be
// diagnosed from the tab's devtools console (chrome://extensions -> this
// extension -> "service worker" link only shows background.js logs; this
// content script's logs show up in the *page's* own devtools console,
// opened on the chatgpt.com tab itself).
function log(requestId, message) {
  console.log(`[gpt-loop bridge] [${requestId}] ${message}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'perform') return false;

  const { requestId } = message;
  (async () => {
    try {
      log(requestId, 'received request; loading domActions.js');
      const domActions = await import(chrome.runtime.getURL('domActions.js'));

      log(requestId, 'looking for composer');
      const composer = await domActions.findComposer(document, domActions.COMPOSER_SELECTORS, { timeoutMs: 5000 });
      if (!composer) {
        log(requestId, 'composer not found within 5000ms (treated as LOGIN_REQUIRED)');
        sendResponse({ ok: false, code: 'LOGIN_REQUIRED', message: 'ChatGPT composer not found; login may be required.' });
        return;
      }

      log(requestId, 'composer found; sending prompt');
      const baselineCount = document.querySelectorAll(domActions.ASSISTANT_MESSAGE_SELECTOR).length;
      await domActions.sendPrompt(document, composer, message.prompt, domActions.SEND_BUTTON_SELECTORS);

      log(requestId, `prompt sent (baseline assistant message count: ${baselineCount}); waiting for reply`);
      const text = await domActions.waitForReply(
        document,
        { responseTimeoutMs: message.responseTimeoutMs },
        baselineCount
      );
      log(requestId, 'reply received');
      sendResponse({ ok: true, text });
    } catch (err) {
      log(requestId, `failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});
