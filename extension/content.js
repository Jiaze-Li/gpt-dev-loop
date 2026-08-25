// Runs on https://chatgpt.com/*. Thin wiring only — the actual DOM
// interaction logic lives in domActions.js (a plain ES module, dynamically
// imported here via chrome.runtime.getURL() because manifest.json's
// declarative content_scripts entries are always classic scripts and can't
// use static `import`/`export`; domActions.js also being a standalone ESM
// is what lets tests/extensionDomActions.test.js import it directly in
// Node, so this is the same file, not a copy).

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'perform') return false;

  (async () => {
    try {
      const domActions = await import(chrome.runtime.getURL('domActions.js'));
      const composer = await domActions.findComposer(document, domActions.COMPOSER_SELECTORS, { timeoutMs: 5000 });
      if (!composer) {
        sendResponse({ ok: false, code: 'LOGIN_REQUIRED', message: 'ChatGPT composer not found; login may be required.' });
        return;
      }

      const baselineCount = document.querySelectorAll(domActions.ASSISTANT_MESSAGE_SELECTOR).length;
      await domActions.sendPrompt(document, composer, message.prompt, domActions.SEND_BUTTON_SELECTORS);

      const text = await domActions.waitForReply(
        document,
        { responseTimeoutMs: message.responseTimeoutMs },
        baselineCount
      );
      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});
