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

// Fire-and-forget stage report to background.js's timeout-diagnostics store
// (extension/stageDiagnostics.js) — carries only requestId/stage, never
// prompt/reply/page content. Never throws and never awaited: a failure to
// report a diagnostic stage (e.g. the service worker is momentarily
// unreachable) must never affect the real supervisorAsk flow above it.
function reportStage(requestId, stage) {
  try {
    const sent = chrome.runtime.sendMessage({ type: 'gptLoopStageUpdate', requestId, stage });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    // best effort
  }
}

// Maps the fine-grained onStage() strings domActions.js's
// sendPromptReliably/waitForReply already emit (console-logged verbatim by
// every log() call below regardless of this map) to the small, fixed set of
// coarse "extension stage" names background.js's stage store understands —
// see stageDiagnostics.js's header comment for why only these specific
// milestones matter for timeout diagnostics. Deliberately narrow: not every
// onStage string needs a canonical counterpart, only the ones this
// diagnostics task asked to be able to see after the fact.
const SUPERVISOR_ASK_STAGE_MAP = [
  [/^composer found$/, 'composer found'],
  [/^prompt insertion started$/, 'prompt insertion started'],
  // Granular insertion sub-stages (2026-08-27 hang investigation): a live
  // Reviewer request stuck at "prompt insertion started" for the full
  // overall timeout with no further diagnosable detail, because none of
  // these finer-grained onStage() calls from domActions.js's
  // insertPromptReliably were ever persisted into background.js's
  // stageDiagnostics store — only console-logged in the page's own devtools,
  // which the post-timeout diagnostic snapshot can't retroactively read.
  // Mapped 1:1 (not renamed) so a future stuck report can name exactly which
  // insertion phase it never got past.
  [/^insertion target re-resolved$/, 'insertion target re-resolved'],
  [/^insertion target resolved$/, 'insertion target resolved'],
  [/^insertion target focused$/, 'insertion target focused'],
  [/^content write started$/, 'content write started'],
  [/^content write finished$/, 'content write finished'],
  [/^input\/change events dispatched$/, 'events dispatched'],
  [/^inserted-content verification started$/, 'verification started'],
  [/^inserted-content verification succeeded$/, 'verification succeeded'],
  [/^prompt insertion completed$/, 'prompt insertion completed'],
  [/^send ready$/, 'send-ready'],
  [/^send triggered$/, 'send triggered'],
  [/^new user message observed$/, 'user message observed'],
  [/^assistant response first observed/, 'assistant response observed'],
  [/^generation active$/, 'generation active'],
  [/^completed-message signal present/, 'completed-message signal observed'],
  [/^assistant response completed$/, 'assistant response completed'],
  // Identity acquisition now runs AFTER reply completion (2026-08-27
  // decoupling), so these let a stuck run be told apart: "still waiting for
  // the reply" vs "reply is done, still waiting for /c/<id>".
  [/^waiting for identity after reply completion$/, 'waiting for identity after reply completion'],
  [/^conversation identity observed/, 'conversation identity observed'],
  [/^reply returned$/, 'reply extracted'],
  [/^returning response$/, 'returning response'],
];

// Wraps a plain console logger (from makeLogger above) so every stage
// string it already logs is also, when it matches a known milestone,
// reported to background.js's stage store — used ONLY by
// handleSupervisorAsk below (the request type this diagnostics task is
// scoped to), never by handlePerform's one-shot Reviewer flow.
function makeSupervisorAskStageLog(requestId, baseLog) {
  return (stage) => {
    baseLog(stage);
    for (const [pattern, canonical] of SUPERVISOR_ASK_STAGE_MAP) {
      if (pattern.test(stage)) {
        reportStage(requestId, canonical);
        return;
      }
    }
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
    if (message?.type === 'supervisorVerifyIdentity') return handleSupervisorVerifyIdentity(message, sendResponse);
    if (message?.type === 'ping') return handlePing(sendResponse);
    if (message?.type === 'waitForChatGptReady') return handleWaitForChatGptReady(message, sendResponse);
    if (message?.type === 'reviewerPreflight') return handleReviewerPreflight(message, sendResponse);
    return false;
  });
}

// Cheap, synchronous liveness check — background.js's ensureContentScriptReady
// (extension/background.js) uses this (via sendToContentScriptWithRetry's
// existing inject-and-retry) to confirm a content script listener actually
// exists in a freshly created tab before asking it to do anything else.
// Never touches the DOM/domActions.js — a plain ack is enough to prove the
// listener is registered and responsive.
function handlePing(sendResponse) {
  sendResponse({ ok: true });
  return false;
}

// Confirms the ChatGPT SPA in THIS tab has actually finished hydrating a
// usable composer — see domActions.js's waitForChatGptReady for why
// chrome.tabs "complete" alone is not sufficient evidence of that. Called
// by background.js's supervisorLifecycle.createSupervisorTab right after a
// fresh tab is created (and content script readiness confirmed), before
// that tab is ever handed back to a caller for supervisorAsk/reviewer.review
// — never touches the composer itself (no prompt is sent here).
function handleWaitForChatGptReady(message, sendResponse) {
  const { requestId } = message;
  const startedAt = Date.now();
  const log = makeLogger(requestId, startedAt);

  (async () => {
    try {
      log('page readiness check received');
      const domActions = await import(chrome.runtime.getURL('domActions.js'));
      const result = await domActions.waitForChatGptReady(document, { timeoutMs: message.responseTimeoutMs, onStage: log });
      sendResponse({ ok: true, text: '', url: result.url });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message, diagnostics: err.diagnostics });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
}

// Zero-GPT-request local diagnostic — reviewerSession.js's preflight gate,
// run immediately before a review() actually sends anything. Reads the
// tab's current composer/page state via domActions.snapshotReviewerPreflight
// and reports it back; never touches the composer, never sends a prompt,
// never waits/polls (that's what makes this safe to call on every review()
// without adding GPT load or timeout risk). The response itself proves
// "content script reachable" to the caller — reaching this handler at all
// is that evidence.
function handleReviewerPreflight(message, sendResponse) {
  (async () => {
    try {
      const domActions = await import(chrome.runtime.getURL('domActions.js'));
      const preflight = domActions.snapshotReviewerPreflight(document);
      sendResponse({ ok: true, text: '', preflight });
    } catch (err) {
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
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

      // Reply observation is started FIRST and is never blocked by a slow
      // `/c/<id>` (the 2026-08-27 decoupling — see observeReplyAndIdentity
      // in domActions.js). identityRequired: false keeps this one-shot
      // path's documented contract: a timeout acquiring identity is
      // non-fatal (the reply is still worth returning), conversationId then
      // comes back null with identityDiagnostics, and callers (e.g. anything
      // about to delete this conversation) must treat null as "no identity"
      // and refuse to proceed — never guess by title or "most recent".
      const { text, conversationId, identityDiagnostics } = await domActions.observeReplyAndIdentity(document, {
        baselineCount,
        baselineId: baselineConversationId,
        responseTimeoutMs: message.responseTimeoutMs,
        identityRequired: false,
        onStage: log,
      });
      log('reply returned');
      sendResponse({ ok: true, text, conversationId: conversationId ?? null, identityDiagnostics });
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

// Verifies the tab background.js just navigated straight to /c/<id> (via
// supervisorLifecycle.js's attachSupervisorTab) actually settled on that
// EXACT conversation — the SupervisorSession.attach()/ReviewerSession.
// attach() primitive's only real evidence, per
// domActions.js's verifyAttachedConversationId (URL-only, real elapsed
// quiet time, fails closed on any redirect/mismatch/missing conversation).
// Never sends a prompt and never touches the composer — attach() must not
// send anything into the conversation just to identify it.
function handleSupervisorVerifyIdentity(message, sendResponse) {
  const { requestId, expectedConversationId } = message;
  const startedAt = Date.now();
  const log = makeLogger(requestId, startedAt);

  (async () => {
    try {
      log('supervisor attach verify request received');
      const domActions = await import(chrome.runtime.getURL('domActions.js'));
      const conversationId = await domActions.verifyAttachedConversationId(document, expectedConversationId, { onStage: log });
      log('attach identity verified');
      sendResponse({ ok: true, text: '', conversationId });
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
  const log = makeSupervisorAskStageLog(requestId, makeLogger(requestId, startedAt));

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

      // Reply observation is started FIRST and can never be blocked by a
      // slow `/c/<id>` (the 2026-08-27 decoupling — see
      // observeReplyAndIdentity in domActions.js). A successful return still
      // requires BOTH a completed reply AND a validated exact identity for
      // this same tab; identity is never guessed.
      //
      // baselineId: null is correct for both the first ask (the URL
      // genuinely has no id yet) and every later ask in the SAME
      // conversation (the URL already carries the existing id, which is
      // accepted immediately since any real id differs from `null`).
      const { text, conversationId } = await domActions.observeReplyAndIdentity(document, {
        baselineCount,
        baselineId: null,
        responseTimeoutMs: message.responseTimeoutMs,
        expectedConversationId,
        onStage: log,
        onMismatch: supervisorIdentityMismatchError,
      });
      log('reply returned');
      sendResponse({ ok: true, text, conversationId });
    } catch (err) {
      log(`failed: ${err.code ?? 'INTERNAL_ERROR'} — ${err.message}`);
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
}
