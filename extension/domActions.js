// Pure ChatGPT-page DOM interaction logic. No chrome.* APIs here — this
// file is imported two ways:
//   1. by content.js at runtime, via a dynamic import() of its
//      chrome.runtime.getURL() (see manifest.json's web_accessible_resources)
//   2. by tests/extensionDomActions.test.js directly, with a fake
//      `document`-like object (mirrors tests/waitForReply.test.js's
//      createFakePage pattern for the Playwright bridge)
//
// Selector values are kept in sync with src/bridge/chatgptWeb.js (the
// Playwright transport) by design — same ChatGPT DOM — but the send/reply
// pipeline below (2026-08-26 transport stabilization) is specific to this
// extension transport: it adds explicit send confirmation with bounded
// retry and drops the Playwright transport's fixed post-stream stability
// wait in favor of the stop-control DOM signal, per
// docs/handoff/2026-08-26-extension-transport-stabilization.md.

export const COMPOSER_SELECTORS = ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'];

export const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button#composer-submit-button'];

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming response"]',
  'button[aria-label="Stop generating"]',
];

export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
export const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';

// Confirmed live 2026-08-26 (devtools inspection of the sidebar control) —
// see docs/handoff/2026-08-26-extension-transport-stabilization.md.
export const NEW_CHAT_BUTTON_SELECTORS = ['[data-testid="create-new-chat-button"]'];

const DEFAULT_POLL_MS = 300;
const DEFAULT_SEND_READY_TIMEOUT_MS = 3000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
const DEFAULT_MAX_SEND_ATTEMPTS = 3;
const GENERATION_FINISHED_RECHECKS = 3;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitterMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

// --- Conversation identity --------------------------------------------
//
// ChatGPT's only stable, unambiguous identity for a conversation is the
// `/c/<id>` segment of its own URL (assigned once the conversation's first
// message actually lands — a blank "New chat" has no id yet). Never fall
// back to matching by title: titles are user-visible text, can repeat, can
// be renamed/auto-generated late, and are explicitly out of scope as an
// identity source (see the 2026-08-26 conversation-deletion primitive).
export const CONVERSATION_ID_PATTERN = /\/c\/([a-zA-Z0-9-]+)/;

// A real ChatGPT conversation id is a server-assigned UUID (always
// hyphen-segmented) — never a bare word. CONVERSATION_ID_PATTERN above is
// deliberately loose (any /c/<alnum-or-hyphen> segment) so it still matches
// whatever exact id shape ChatGPT uses; this second check is what rejects a
// stray non-conversation anchor/URL segment (e.g. a nav/mode link that
// happens to start with "/c/") from ever being mistaken for one. This is
// the fix for the live bug where a bare token ("WEB") was captured and
// logged as "identity captured" before deletion refused it as not found in
// the sidebar — with this check it is never accepted as a candidate in the
// first place. Does not change the exact-string /c/<id> lookup used to
// locate a conversation's row for deletion (see conversationLinkSelector).
export const CONVERSATION_ID_SHAPE_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+$/;

export function isValidConversationId(id) {
  return typeof id === 'string' && CONVERSATION_ID_SHAPE_PATTERN.test(id);
}

export function extractConversationId(href) {
  const match = typeof href === 'string' ? href.match(CONVERSATION_ID_PATTERN) : null;
  const id = match ? match[1] : null;
  return isValidConversationId(id) ? id : null;
}

// Reads the current tab's conversation id straight off its own URL. Returns
// null if the URL has no `/c/<id>` segment yet (e.g. right after "New chat"
// before the first message is sent) — callers must treat that as "no
// identity yet", not retry with a guess.
export function readConversationId(doc) {
  return extractConversationId(doc?.location?.href ?? '');
}

// Reads the sidebar's own idea of which conversation is currently active —
// the anchor ChatGPT itself marks current (`aria-current="page"`), not just
// "the most recent /c/<...> link", since the sidebar can (and, mid-navigation,
// does) list other conversations too. This is a second, independent
// identity source alongside the URL: the SPA has been observed to update one
// before the other, so waitForConversationIdentity below checks both rather
// than trusting either alone.
function readActiveSidebarConversationId(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return null;
  const anchors = doc.querySelectorAll('a[href^="/c/"]') || [];
  for (const anchor of anchors) {
    const ariaCurrent = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('aria-current') : anchor.ariaCurrent;
    if (ariaCurrent !== 'page') continue;
    const href = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('href') : anchor.href;
    const id = extractConversationId(href);
    if (id) return id;
  }
  return null;
}

function conversationIdentityNotFoundError(message) {
  const err = new Error(message);
  err.code = 'CONVERSATION_IDENTITY_NOT_FOUND';
  return err;
}

const DEFAULT_IDENTITY_TIMEOUT_MS = 15000;

// Snapshot of both identity sources' raw state, attached to the timeout
// error so a caller without live DOM access (e.g. reading this from the
// Node-side error message/logs) can tell *why* neither source produced an
// id, instead of only "it didn't". Never includes prompt/reply text.
function captureIdentityDiagnostics(doc, baselineId) {
  const anchors = typeof doc?.querySelectorAll === 'function' ? doc.querySelectorAll('a[href^="/c/"]') || [] : [];
  let activeAnchorCount = 0;
  for (const anchor of anchors) {
    const ariaCurrent = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('aria-current') : anchor.ariaCurrent;
    if (ariaCurrent === 'page') activeAnchorCount += 1;
  }
  return {
    baselineId,
    finalUrl: doc?.location?.href ?? null,
    sidebarConversationLinkCount: anchors.length,
    sidebarActiveAnchorCount: activeAnchorCount,
  };
}

// Waits for the freshly-sent conversation's own identity to show up, after
// sendPromptReliably has already confirmed the send. ChatGPT is a SPA: the
// `/c/<id>` URL segment is assigned by client-side routing (history API), not
// a full navigation, so it is NOT guaranteed to be present the instant send
// confirms — reading location.href synchronously right after send (the prior
// bug) can observe the pre-send URL and either miss the id entirely or, worse
// if a stale conversation was still loaded, capture the WRONG id.
//
// Two independent sources are checked, either sufficient: the tab's own URL,
// and the sidebar anchor ChatGPT itself marks as the active conversation.
// Both are compared against `baselineId` (the identity read *before* send)
// so a slow-updating source that still reports the old id is never mistaken
// for the new one. Event-driven first (MutationObserver wakes the check the
// instant the SPA router mutates the DOM), with the timer only as a bounded
// timeout guard — never the sole trigger — matching waitForReply's own
// pattern for exactly the same background-tab-throttling reason.
//
// Returns the new conversation id, or throws CONVERSATION_IDENTITY_NOT_FOUND
// if bounded by timeoutMs with neither source ever producing one. Never
// falls back to a title, a "most recent" guess, or any other heuristic.
export async function waitForConversationIdentity(
  doc,
  { baselineId = null, timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS, sleep = defaultSleep, onStage = () => {} } = {}
) {
  onStage('waiting for conversation identity');

  function readCandidate() {
    const urlId = readConversationId(doc);
    if (urlId && urlId !== baselineId) return urlId;
    const sidebarId = readActiveSidebarConversationId(doc);
    if (sidebarId && sidebarId !== baselineId) return sidebarId;
    return null;
  }

  const immediate = readCandidate();
  if (immediate) {
    onStage(`identity captured (${immediate})`);
    return immediate;
  }

  const deadline = Date.now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  try {
    while (Date.now() < deadline) {
      await waiter.tick(DEFAULT_POLL_MS);
      const candidate = readCandidate();
      if (candidate) {
        onStage(`identity captured (${candidate})`);
        return candidate;
      }
    }
  } finally {
    waiter.disconnect();
  }

  onStage('identity timeout');
  const err = conversationIdentityNotFoundError(
    `No conversation identity (/c/<id>) appeared within ${timeoutMs}ms after send was confirmed — refusing to guess.`
  );
  err.diagnostics = captureIdentityDiagnostics(doc, baselineId);
  throw err;
}

// --- Rate-limit detection ------------------------------------------------
//
// ChatGPT's own throttling banner ("You're making requests too quickly...")
// is a distinct failure mode from any DOM/selector problem: it means
// ChatGPT itself is refusing to proceed for a while, so the right response
// is to back off and retry later (handled Node-side, see
// chatgptExtension.js), not to keep polling/retrying immediately.
const RATE_LIMIT_TEXT_PATTERN = /making requests too quickly|temporarily limited/i;

export function isRateLimited(doc) {
  const text = doc?.body?.innerText ?? doc?.body?.textContent ?? '';
  return RATE_LIMIT_TEXT_PATTERN.test(text);
}

function rateLimitedError(message) {
  const err = new Error(message);
  err.code = 'RATE_LIMITED';
  return err;
}

function firstVisible(doc, selectors) {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && el.isVisible !== false) return el;
  }
  return null;
}

function isAnyVisible(doc, selectors) {
  return selectors.some((selector) => {
    const el = doc.querySelector(selector);
    return !!el && el.isVisible !== false;
  });
}

function sendFailedError(message) {
  const err = new Error(message);
  err.code = 'SEND_FAILED';
  return err;
}

// Polls for the composer up to timeoutMs. Returns the element, or null if
// it never appears — content.js maps null to LOGIN_REQUIRED (Phase 1
// simplification: an absent composer is treated as "needs login", see the
// handoff's "Chrome Extension 内部结构" section).
export async function findComposer(doc, selectors = COMPOSER_SELECTORS, { timeoutMs = 5000, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while looking for the composer.');
    const el = firstVisible(doc, selectors);
    if (el) return el;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < deadline);
  return firstVisible(doc, selectors);
}

// Clicks the sidebar "New chat" control before this review's prompt is
// typed in. Navigating a freshly created tab straight to chatgptUrl is not
// enough on its own — observed live (2026-08-26) restoring the same
// ongoing conversation instead of a blank one (ChatGPT's client-side
// router redirected the bare root URL back to the last active
// conversation), which is exactly the conversation-isolation bug this
// fixes. Never throws: returns a status object so a missing control (a
// layout change, or a chat that's already blank) degrades to "continue
// anyway" rather than failing the whole review — content.js logs whichever
// happened.
export async function startNewChat(
  doc,
  selectors = NEW_CHAT_BUTTON_SELECTORS,
  { timeoutMs = 5000, sleep = defaultSleep, simulateClick = defaultSimulateClick } = {}
) {
  const findDeadline = Date.now() + timeoutMs;
  let button = null;
  do {
    button = firstVisible(doc, selectors);
    if (button) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < findDeadline);

  if (!button) return { clicked: false, cleared: false };

  simulateClick(button);

  // Best-effort confirmation that the conversation actually cleared —
  // not fatal if it doesn't within the timeout (e.g. it was already blank).
  const clearDeadline = Date.now() + timeoutMs;
  do {
    const remaining = doc.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length + doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
    if (remaining === 0) return { clicked: true, cleared: true };
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < clearDeadline);
  return { clicked: true, cleared: false };
}

function readComposerText(composer) {
  if ('value' in composer) return (composer.value ?? '').trim();
  return (composer.innerText ?? composer.textContent ?? '').trim();
}

// Chrome throttles setTimeout/setInterval in background/inactive tabs
// (observed live: 2026-08-26, a 120s responseTimeoutMs elapsed with zero
// polls landing while the ChatGPT tab sat behind the terminal window,
// producing a false RESPONSE_EMPTY even though ChatGPT had replied) — but
// MutationObserver callbacks are NOT subject to that throttling, since they
// fire as a direct consequence of the page's own script mutating the DOM in
// response to the streaming reply, not off a timer wheel. defaultTick races
// the plain poll-interval sleep against "a mutation happened", so a
// backgrounded tab still wakes the loop the instant new text lands instead
// of waiting out the throttled interval. Falls back to pure interval
// polling when MutationObserver/doc.body aren't available (real browser
// only — tests/extensionDomActions.test.js's fake `document` has neither,
// so it exercises the exact same polling path as before this change).
function createMutationWaiter(doc, sleep) {
  if (typeof MutationObserver === 'undefined' || !doc?.body) {
    return { tick: (ms) => sleep(ms), disconnect() {} };
  }

  let wake = null;
  const observer = new MutationObserver(() => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

  return {
    tick(ms) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          wake = null;
          resolve();
        };
        wake = finish;
        sleep(ms).then(finish);
      });
    },
    disconnect() {
      observer.disconnect();
    },
  };
}

// Inserts `prompt` into the composer and verifies the composer's own text
// actually changed — `execCommand('insertText', ...)` has been observed to
// silently no-op on some ChatGPT ProseMirror builds (2026-08-26), which
// previously left gpt-loop waiting out the full responseTimeoutMs for a
// reply to a message that was never actually typed in. Falls back to
// setting the DOM directly and firing the input events ProseMirror's own
// controller listens for when execCommand doesn't take.
export function insertPromptText(doc, composer, prompt, { execCommand } = {}) {
  const runExecCommand = execCommand ?? ((...args) => doc.execCommand(...args));
  composer.focus();
  runExecCommand('insertText', false, prompt);
  // Always fire a real 'input' event after execCommand too, not only in the
  // DOM-fallback branch below — execCommand has been observed to update the
  // visible DOM (satisfying the check just below) without the ProseMirror
  // controller's own state actually registering the change every time,
  // which then leaves ChatGPT's send button permanently disabled even
  // though the composer visibly holds text (observed live, 2026-08-26).
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (readComposerText(composer).length > 0) return true;

  try {
    if ('value' in composer) {
      composer.value = prompt;
    } else {
      composer.textContent = prompt;
      composer.innerText = prompt;
    }
  } catch {
    return false; // composer's text properties aren't writable (e.g. frozen/replaced mid-flight)
  }
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: prompt }));
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return readComposerText(composer).length > 0;
}

// Clears the composer via the same execCommand path insertion prefers (more
// likely to be recognized by ProseMirror's own state than a blunt DOM
// clear), falling back to setting the text directly if that doesn't take.
function clearComposer(doc, composer, { execCommand } = {}) {
  const runExecCommand = execCommand ?? ((...args) => doc.execCommand(...args));
  composer.focus();
  runExecCommand('selectAll');
  runExecCommand('delete');
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (readComposerText(composer).length === 0) return;

  try {
    if ('value' in composer) {
      composer.value = '';
    } else {
      composer.textContent = '';
      composer.innerText = '';
    }
  } catch {
    // best effort — insertPromptText's own execCommand call right after
    // this will still run regardless
  }
}

function isSendReady(el) {
  if (!el) return false;
  if (el.disabled) return false;
  const ariaDisabled = typeof el.getAttribute === 'function' ? el.getAttribute('aria-disabled') : null;
  if (ariaDisabled === 'true') return false;
  return true;
}

// Waits for a visible send button that is also enabled (ChatGPT disables
// it — `aria-disabled="true"` or `.disabled` — until the composer holds
// text it recognizes) before returning it. Returns null if none becomes
// ready in time, so the caller can fall back to the Enter-key path.
export async function waitForSendReady(doc, sendSelectors = SEND_BUTTON_SELECTORS, { timeoutMs = DEFAULT_SEND_READY_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const el = firstVisible(doc, sendSelectors);
    if (isSendReady(el)) return el;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

function defaultPressEnter(composer) {
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
}

// ChatGPT's send button is a Radix/Base-UI-style control that reacts to
// pointer events, not just `click`— a plain `el.click()` synthesizes a
// MouseEvent click but no pointerdown/pointerup, so the button's own
// handlers never fire and the prompt silently stays in the composer
// (observed live: 2026-08-25, aria-disabled="false" button, click() alone
// was a no-op). Only constructs PointerEvent/MouseEvent when those globals
// exist (real browser) — tests/extensionDomActions.test.js runs this
// against a fake `document` in Node, where they don't, and el.click() alone
// is enough to satisfy the fake element's click() stub.
function defaultSimulateClick(el) {
  if (typeof PointerEvent !== 'undefined') {
    const pointerOpts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0 };
    const mouseOpts = { bubbles: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  }
  el.click();
}

// Confirms the send actually took effect using real DOM evidence: either
// the user-message count increased, or the composer went back to empty
// (some UIs clear the composer before the new message node finishes
// rendering) — never just "we clicked something and assume it worked".
async function confirmSent(doc, composer, userBaselineCount, { timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  try {
    do {
      const count = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
      if (count > userBaselineCount || readComposerText(composer).length === 0) return true;
      await waiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < deadline);
    const count = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
    return count > userBaselineCount || readComposerText(composer).length === 0;
  } finally {
    waiter.disconnect();
  }
}

// Explicit staged send pipeline (docs/handoff/2026-08-26-extension-
// transport-stabilization.md): text inserted -> send control ready -> send
// triggered -> send confirmed, with real DOM evidence gating each
// transition into the next, and a bounded number of retries if a send
// can't be confirmed — never leaves the prompt sitting typed-but-unsent
// while the caller waits out the full reply timeout. `onStage(name)` is
// called synchronously at each transition for the caller's own timing
// diagnostics; this module stays chrome-API-free.
export async function sendPromptReliably(
  doc,
  composer,
  prompt,
  sendSelectors = SEND_BUTTON_SELECTORS,
  {
    maxAttempts = DEFAULT_MAX_SEND_ATTEMPTS,
    sendReadyTimeoutMs = DEFAULT_SEND_READY_TIMEOUT_MS,
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    pressEnter = defaultPressEnter,
    simulateClick = defaultSimulateClick,
    sleep = defaultSleep,
    onStage = () => {},
  } = {}
) {
  // A small, randomized pause before the first keystroke — a script that
  // inserts text and clicks send in the same tick is a distinctive,
  // instantly-fireable signature; a brief human-scale jitter here costs
  // nothing functionally and avoids that.
  await sleep(randomJitterMs(150, 500));

  if (!insertPromptText(doc, composer, prompt)) {
    throw sendFailedError('Could not insert the prompt into the ChatGPT composer (both insertText and the DOM fallback left it empty).');
  }
  onStage('text inserted');

  const userBaselineCount = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const sendButton = await waitForSendReady(doc, sendSelectors, { timeoutMs: sendReadyTimeoutMs, sleep });
    onStage('send ready');

    if (sendButton) {
      simulateClick(sendButton);
    } else {
      pressEnter(composer);
    }
    onStage('send triggered');

    const confirmed = await confirmSent(doc, composer, userBaselineCount, { timeoutMs: confirmTimeoutMs, sleep });
    if (confirmed) {
      onStage('send confirmed');
      return;
    }

    // Not confirmed. Retrying the click/Enter alone is not enough when the
    // real cause is that the composer's visible text was never actually
    // registered by ChatGPT's own controller (observed live, 2026-08-26 —
    // the send button then stays disabled and Enter does nothing no matter
    // how many times either is retried, since ChatGPT's own state still
    // thinks the composer is empty). So every retry clears the composer
    // and re-inserts the prompt fresh before trying to send again, rather
    // than only when the composer happens to look empty.
    if (attempt < maxAttempts) {
      clearComposer(doc, composer);
      insertPromptText(doc, composer, prompt);
    }
  }

  throw sendFailedError(`Could not confirm the prompt was sent after ${maxAttempts} attempt(s).`);
}

// Waits for the assistant message count to exceed baselineCount, then
// returns as soon as the stop/generating control is gone and the newest
// assistant message has text — no fixed post-stream stability wait. The
// stop control's visibility is ChatGPT's own signal for "still streaming";
// trusting it directly (instead of also waiting out a fixed window) means
// a real reply is returned as soon as it's actually done, and a
// backgrounded tab's throttled timers don't delay detection past what
// MutationObserver already caught (see createMutationWaiter above).
//
// Throws { code, message } (not a bridge/errors.js class — that mapping
// happens on the Node side, in chatgptExtension.js, after this crosses the
// WebSocket as a protocol error code):
//   - RESPONSE_EMPTY: deadline hit, no new assistant message ever appeared
//   - RESPONSE_TIMEOUT: a new assistant message appeared but never finished
//     (stop control never went away) before the deadline
export async function waitForReply(
  doc,
  { responseTimeoutMs },
  baselineCount,
  {
    assistantSelector = ASSISTANT_MESSAGE_SELECTOR,
    stopSelectors = STOP_BUTTON_SELECTORS,
    sleep = defaultSleep,
    onStage = () => {},
  } = {}
) {
  const deadline = Date.now() + responseTimeoutMs;
  const waiter = createMutationWaiter(doc, sleep);

  try {
    while (Date.now() < deadline && doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while waiting for a reply.');
      await waiter.tick(DEFAULT_POLL_MS);
    }
    if (doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      const err = new Error(`No assistant response appeared within ${responseTimeoutMs}ms.`);
      err.code = 'RESPONSE_EMPTY';
      throw err;
    }
    onStage('assistant started');

    while (Date.now() < deadline) {
      const nodes = doc.querySelectorAll(assistantSelector);
      const lastNode = nodes[nodes.length - 1];
      const currentText = (lastNode?.innerText ?? '').trim();
      const stopVisible = isAnyVisible(doc, stopSelectors);

      if (!stopVisible && currentText.length > 0) {
        // Re-confirm before trusting this — observed live (2026-08-26): a
        // single recheck tick can itself resolve on an unrelated DOM
        // mutation (MutationObserver fires on *any* change, not
        // specifically "more text landed"), so one recheck alone still let
        // a 1-2 character partial reply through. Require several
        // consecutive stable rechecks instead of a fixed wait — this stays
        // event-driven (each tick still wakes instantly on a real mutation
        // in a throttled background tab) but no longer trusts a single
        // coincidentally-quiet tick as proof streaming actually finished.
        let stable = true;
        for (let recheck = 0; recheck < GENERATION_FINISHED_RECHECKS; recheck += 1) {
          await waiter.tick(DEFAULT_POLL_MS);
          const recheckNodes = doc.querySelectorAll(assistantSelector);
          const recheckText = (recheckNodes[recheckNodes.length - 1]?.innerText ?? '').trim();
          const stopVisibleRecheck = isAnyVisible(doc, stopSelectors);
          if (stopVisibleRecheck || recheckText !== currentText) {
            stable = false;
            break;
          }
        }
        if (stable) {
          onStage('generation finished');
          return currentText;
        }
        continue;
      }
      await waiter.tick(DEFAULT_POLL_MS);
    }

    const err = new Error(`Assistant response did not finish within ${responseTimeoutMs}ms.`);
    err.code = 'RESPONSE_TIMEOUT';
    throw err;
  } finally {
    waiter.disconnect();
  }
}

// --- Conversation deletion (2026-08-26 primitive) -------------------------
//
// deleteConversation(doc, conversationId) verifies and deletes exactly one
// ChatGPT conversation, identified only by the `/c/<id>` it was created
// with — never by its sidebar title. It never throws away a real DOM
// postcondition for a click: every stage below is gated on real evidence
// (the row existing, the menu item existing, the confirm button existing,
// and finally the row actually disappearing from the sidebar), and it
// fails loudly with a specific error code rather than guessing when any of
// those don't show up.
//
// SELECTOR CAVEAT: the candidate selectors below were written from
// ChatGPT's known Radix-style sidebar/menu/dialog conventions (a
// conversation row exposing a per-row "options" button, a role="menu"
// popup, a role="dialog" confirmation with a "Delete" button) but were NOT
// confirmed against a live, logged-in ChatGPT session — no such session was
// reachable while writing this. Before this primitive is trusted for
// unattended use, run it once against a real conversation and, if the
// selectors below don't match, update these constants (the algorithm —
// identity-anchored lookup + real postconditions — should not need to
// change).
export const CONVERSATION_MENU_BUTTON_SELECTORS = [
  'button[aria-label="Open conversation options"]',
  'button[data-testid$="-options"]',
  'button[aria-haspopup="menu"]',
];

export const DELETE_MENU_ITEM_SELECTORS = ['[role="menuitem"]', 'div[role="menuitem"]'];
export const DELETE_MENU_ITEM_TEXT_PATTERN = /^delete( chat)?$/i;

export const DELETE_CONFIRM_BUTTON_SELECTORS = [
  '[data-testid="delete-conversation-confirm-button"]',
  'div[role="dialog"] button',
];
export const DELETE_CONFIRM_BUTTON_TEXT_PATTERN = /^delete$/i;

function conversationLinkSelector(conversationId) {
  return `a[href="/c/${conversationId}"]`;
}

// Locates the sidebar row for `conversationId` by its href — the one
// unambiguous identity ChatGPT exposes for a conversation — never by
// title. Returns null if the row isn't currently present in the DOM (not
// visible in the sidebar at all, e.g. scrolled out of the loaded window);
// the caller treats that as CONVERSATION_NOT_FOUND rather than falling back
// to a title search.
function findConversationRow(doc, conversationId) {
  const anchor = doc.querySelector(conversationLinkSelector(conversationId));
  if (!anchor) return null;
  if (typeof anchor.closest === 'function') {
    const li = anchor.closest('li');
    if (li) return li;
  }
  return anchor.parentElement || anchor;
}

function firstVisibleWithin(container, selectors) {
  if (!container || typeof container.querySelector !== 'function') return null;
  for (const selector of selectors) {
    const el = container.querySelector(selector);
    if (el && el.isVisible !== false) return el;
  }
  return null;
}

// Searches (globally, since Radix-style menus/dialogs portal to <body>, not
// into the row that opened them) for an element matching one of `selectors`
// whose own text matches `textPattern` — used for both the "Delete" menu
// item and the confirm-dialog "Delete" button, where a stable data-testid
// isn't known to exist. This is text matching scoped to a just-opened
// native ChatGPT menu/dialog control, not a conversation-title match.
function findControlByText(doc, selectors, textPattern) {
  for (const selector of selectors) {
    const nodes = doc.querySelectorAll(selector) || [];
    for (const node of nodes) {
      const text = (node.innerText ?? node.textContent ?? '').trim();
      if (textPattern.test(text)) return node;
    }
  }
  return null;
}

function conversationNotFoundError(conversationId) {
  const err = new Error(
    `Conversation "${conversationId}" is not visible in the sidebar by its /c/<id> link; refusing to guess by title.`
  );
  err.code = 'CONVERSATION_NOT_FOUND';
  return err;
}

function invalidConversationIdError(conversationId) {
  const err = new Error(
    `"${conversationId}" is not shaped like a real ChatGPT conversation id (/c/<id>); refusing to attempt deletion.`
  );
  err.code = 'CONVERSATION_NOT_FOUND';
  return err;
}

function deleteMenuNotFoundError(message) {
  const err = new Error(message);
  err.code = 'DELETE_MENU_NOT_FOUND';
  return err;
}

function deleteNotConfirmedError(message) {
  const err = new Error(message);
  err.code = 'DELETE_NOT_CONFIRMED';
  return err;
}

export async function deleteConversation(
  doc,
  conversationId,
  {
    menuButtonSelectors = CONVERSATION_MENU_BUTTON_SELECTORS,
    deleteMenuItemSelectors = DELETE_MENU_ITEM_SELECTORS,
    deleteMenuItemTextPattern = DELETE_MENU_ITEM_TEXT_PATTERN,
    confirmButtonSelectors = DELETE_CONFIRM_BUTTON_SELECTORS,
    confirmButtonTextPattern = DELETE_CONFIRM_BUTTON_TEXT_PATTERN,
    simulateClick = defaultSimulateClick,
    sleep = defaultSleep,
    menuOpenTimeoutMs = 3000,
    confirmDialogTimeoutMs = 3000,
    postconditionTimeoutMs = 5000,
    rowLookupTimeoutMs = 5000,
    onStage = () => {},
  } = {}
) {
  if (!conversationId) throw conversationNotFoundError('(missing)');
  if (!isValidConversationId(conversationId)) throw invalidConversationIdError(conversationId);

  // A tab freshly navigated to chatgptUrl reaches "complete" before its
  // sidebar's conversation list (populated by an async fetch) has
  // necessarily hydrated — a single synchronous lookup here was observed
  // live to fail fast with CONVERSATION_NOT_FOUND even though the
  // conversation existed and appeared moments later. This polls (still
  // matching only the exact /c/<id> href, never a title) until the row
  // shows up or rowLookupTimeoutMs elapses, mirroring the menu-open and
  // confirm-dialog waits below.
  const rowWaiter = createMutationWaiter(doc, sleep);
  let row;
  try {
    const rowDeadline = Date.now() + rowLookupTimeoutMs;
    do {
      row = findConversationRow(doc, conversationId);
      if (row) break;
      if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while locating the conversation to delete.');
      await rowWaiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < rowDeadline);
  } finally {
    rowWaiter.disconnect();
  }
  if (!row) throw conversationNotFoundError(conversationId);
  onStage('conversation row located');

  const menuButton = firstVisibleWithin(row, menuButtonSelectors);
  if (!menuButton) {
    throw deleteMenuNotFoundError(
      `Conversation "${conversationId}" was found in the sidebar but no options/menu button matched the known selectors.`
    );
  }
  await sleep(randomJitterMs(150, 400));
  simulateClick(menuButton);
  onStage('conversation menu opened');

  const menuDeadline = Date.now() + menuOpenTimeoutMs;
  let deleteItem = null;
  do {
    if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while deleting a conversation.');
    deleteItem = findControlByText(doc, deleteMenuItemSelectors, deleteMenuItemTextPattern);
    if (deleteItem) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < menuDeadline);
  if (!deleteItem) {
    throw deleteMenuNotFoundError(`Delete menu item did not appear within ${menuOpenTimeoutMs}ms after opening the conversation menu.`);
  }
  onStage('delete menu item found');

  simulateClick(deleteItem);
  onStage('delete clicked');

  const confirmDeadline = Date.now() + confirmDialogTimeoutMs;
  let confirmButton = null;
  do {
    confirmButton = findControlByText(doc, confirmButtonSelectors, confirmButtonTextPattern);
    if (confirmButton) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < confirmDeadline);
  if (!confirmButton) {
    throw deleteMenuNotFoundError(`Delete confirmation dialog did not appear within ${confirmDialogTimeoutMs}ms.`);
  }
  onStage('delete confirmation dialog found');

  simulateClick(confirmButton);
  onStage('delete triggered');

  const waiter = createMutationWaiter(doc, sleep);
  try {
    const postDeadline = Date.now() + postconditionTimeoutMs;
    do {
      if (!doc.querySelector(conversationLinkSelector(conversationId))) {
        onStage('delete confirmed');
        return { deleted: true };
      }
      await waiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < postDeadline);
  } finally {
    waiter.disconnect();
  }

  if (!doc.querySelector(conversationLinkSelector(conversationId))) {
    onStage('delete confirmed');
    return { deleted: true };
  }
  onStage('cleanup failed');
  throw deleteNotConfirmedError(
    `Conversation "${conversationId}" is still visible in the sidebar ${postconditionTimeoutMs}ms after confirming delete — treating this as a failed cleanup rather than assuming success.`
  );
}
