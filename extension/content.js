// Runs on https://chatgpt.com/*. Thin wiring only — the actual DOM
// interaction logic lives in domActions.js (a plain ES module, dynamically
// imported here via chrome.runtime.getURL() because manifest.json's
// declarative content_scripts entries are always classic scripts and can't
// use static `import`/`export`; domActions.js also being a standalone ESM
// is what lets tests/extensionDomActions.test.js import it directly in
// Node, so this is the same file, not a copy).

// Stage-only logging (no prompt/reply content), with elapsed time since
// this request's "received" stage, so a stuck or slow run can be diagnosed
// from the tab's devtools console (chrome://extensions -> this extension ->
// "service worker" link only shows background.js logs; this content
// script's logs show up in the *page's* own devtools console, opened on
// the chatgpt.com tab itself) without ever printing prompt/reply text.
function makeLogger(requestId, startedAt) {
  return (stage) => {
    console.log(`[gpt-loop bridge] [${requestId}] ${stage} +${Date.now() - startedAt}ms`);
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'perform') return false;

  const { requestId } = message;
  const startedAt = Date.now();
  const log = makeLogger(requestId, startedAt);

  (async () => {
    try {
      log('request received');
      const domActions = await import(chrome.runtime.getURL('domActions.js'));

      const newChatResult = await domActions.startNewChat(document, domActions.NEW_CHAT_BUTTON_SELECTORS);
      if (!newChatResult.clicked) {
        log('new chat control not found; continuing in whatever conversation is already loaded');
      } else if (!newChatResult.cleared) {
        log('new chat clicked but conversation did not visibly clear before continuing');
      } else {
        log('new chat started');
      }

      const composer = await domActions.findComposer(document, domActions.COMPOSER_SELECTORS, { timeoutMs: 5000 });
      if (!composer) {
        log('composer not found within 5000ms (treated as LOGIN_REQUIRED)');
        sendResponse({ ok: false, code: 'LOGIN_REQUIRED', message: 'ChatGPT composer not found; login may be required.' });
        return;
      }
      log('composer found');

      const baselineCount = document.querySelectorAll(domActions.ASSISTANT_MESSAGE_SELECTOR).length;
      await domActions.sendPromptReliably(document, composer, message.prompt, domActions.SEND_BUTTON_SELECTORS, { onStage: log });

      const text = await domActions.waitForReply(document, { responseTimeoutMs: message.responseTimeoutMs }, baselineCount, { onStage: log });
      log('reply returned');
      sendResponse({ ok: true, text });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});
