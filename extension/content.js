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

// background.js's sendToContentScriptWithRetry manually re-injects this
// file via chrome.scripting.executeScript when it beats manifest.json's
// declarative content_scripts injection to the punch — that manual
// injection can also land *after* the declarative one finishes, running
// this whole script a second time in the same page. Without this guard,
// each execution would register its own chrome.runtime.onMessage
// listener, so a single request could be picked up (and its DOM actions,
// e.g. deleteConversation, executed) by both listeners concurrently.
// globalThis persists across script executions within the same page, so
// this flag reliably survives into the second run.
if (!globalThis.__gptLoopContentScriptInstalled) {
  globalThis.__gptLoopContentScriptInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'perform') return handlePerform(message, sendResponse);
    if (message?.type === 'performDelete') return handlePerformDelete(message, sendResponse);
    if (message?.type === 'supervisorAsk') return handleSupervisorAsk(message, sendResponse);
    return false;
  });
}

function handlePerform(message, sendResponse) {
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
      const baselineConversationId = domActions.readConversationId(document);
      await domActions.sendPromptReliably(document, composer, message.prompt, domActions.SEND_BUTTON_SELECTORS, { onStage: log });

      // ChatGPT is a SPA: the /c/<id> URL segment is assigned by client-side
      // routing, not guaranteed to be present the instant send confirms —
      // so this waits (event-driven, bounded) for it rather than reading it
      // once. A timeout here is non-fatal to the ask itself (the reply is
      // still worth returning) but conversationId comes back null, which
      // callers (e.g. anything about to delete this conversation) must
      // treat as "no identity" and refuse to proceed — never fall back to
      // guessing by title or "most recent".
      let conversationId = null;
      let identityDiagnostics;
      try {
        conversationId = await domActions.waitForConversationIdentity(document, { baselineId: baselineConversationId, onStage: log });
      } catch (err) {
        if (err.code !== 'CONVERSATION_IDENTITY_NOT_FOUND') throw err;
        identityDiagnostics = err.diagnostics;
        log(`identity diagnostics: ${JSON.stringify(identityDiagnostics)}`);
      }

      const text = await domActions.waitForReply(document, { responseTimeoutMs: message.responseTimeoutMs }, baselineCount, { onStage: log });
      log('reply returned');
      sendResponse({ ok: true, text, conversationId, identityDiagnostics });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
}

function handlePerformDelete(message, sendResponse) {
  const { requestId, conversationId } = message;
  const startedAt = Date.now();
  const log = makeLogger(requestId, startedAt);

  (async () => {
    try {
      log(`delete request received (${conversationId})`);
      const domActions = await import(chrome.runtime.getURL('domActions.js'));
      await domActions.deleteConversation(document, conversationId, { onStage: log });
      sendResponse({ ok: true });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
}

function supervisorIdentityMismatchError(expectedConversationId, actualConversationId) {
  const err = new Error(
    `Supervisor conversation identity changed: expected "${expectedConversationId}" but the tab is now showing "${actualConversationId}" — refusing to continue in a different conversation.`
  );
  err.code = 'SUPERVISOR_IDENTITY_MISMATCH';
  return err;
}

// Sends one prompt into the Supervisor's already-open tab/conversation and
// waits for the reply — deliberately never calls startNewChat (that would
// break the whole point of a persistent conversation). Reuses exactly the
// same DOM primitives as handlePerform (findComposer/sendPromptReliably/
// waitForConversationIdentity/waitForReply); the only Supervisor-specific
// behavior is here: identity capture is fatal (not optional, since
// SupervisorSession.getIdentity() must always be trustworthy), and if the
// caller already knows the expected id, a mismatch fails safe instead of
// silently continuing in whatever conversation the tab now shows.
function handleSupervisorAsk(message, sendResponse) {
  const { requestId, prompt, expectedConversationId } = message;
  const startedAt = Date.now();
  const log = makeLogger(requestId, startedAt);

  (async () => {
    try {
      log('supervisor ask request received');
      const domActions = await import(chrome.runtime.getURL('domActions.js'));

      const composer = await domActions.findComposer(document, domActions.COMPOSER_SELECTORS, { timeoutMs: 5000 });
      if (!composer) {
        log('composer not found within 5000ms (treated as LOGIN_REQUIRED)');
        sendResponse({ ok: false, code: 'LOGIN_REQUIRED', message: 'ChatGPT composer not found; login may be required.' });
        return;
      }
      log('composer found');

      const baselineCount = document.querySelectorAll(domActions.ASSISTANT_MESSAGE_SELECTOR).length;
      await domActions.sendPromptReliably(document, composer, prompt, domActions.SEND_BUTTON_SELECTORS, { onStage: log });

      // baselineId: null is correct for both the first ask (the URL
      // genuinely has no id yet) and every later ask in the SAME
      // conversation (the URL already carries the existing id, which is
      // accepted immediately since any real id differs from `null`) — see
      // waitForConversationIdentity's doc comment in domActions.js.
      const conversationId = await domActions.waitForConversationIdentity(document, { baselineId: null, onStage: log });

      if (expectedConversationId && conversationId !== expectedConversationId) {
        throw supervisorIdentityMismatchError(expectedConversationId, conversationId);
      }

      const text = await domActions.waitForReply(document, { responseTimeoutMs: message.responseTimeoutMs }, baselineCount, { onStage: log });
      log('reply returned');
      sendResponse({ ok: true, text, conversationId });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
}
