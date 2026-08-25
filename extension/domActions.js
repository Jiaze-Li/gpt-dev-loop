// Pure ChatGPT-page DOM interaction logic. No chrome.* APIs here — this
// file is imported two ways:
//   1. by content.js at runtime, via a dynamic import() of its
//      chrome.runtime.getURL() (see manifest.json's web_accessible_resources)
//   2. by tests/extensionDomActions.test.js directly, with a fake
//      `document`-like object (mirrors tests/waitForReply.test.js's
//      createFakePage pattern for the Playwright bridge)
//
// Selector values and the reply-stability algorithm are kept in sync with
// src/bridge/chatgptWeb.js (the Playwright transport) by design — same
// ChatGPT DOM, same waiting rules — but this file must not import from
// src/, since the extension sandbox cannot reach outside its own directory.

export const COMPOSER_SELECTORS = ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'];

export const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button#composer-submit-button'];

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming response"]',
  'button[aria-label="Stop generating"]',
];

export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

const RESPONSE_STABLE_WINDOW_MS = 1200;
const DEFAULT_POLL_MS = 300;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstVisible(doc, selectors) {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && el.isVisible !== false) return el;
  }
  return null;
}

// Polls for the composer up to timeoutMs. Returns the element, or null if
// it never appears — content.js maps null to LOGIN_REQUIRED (Phase 1
// simplification: an absent composer is treated as "needs login", see the
// handoff's "Chrome Extension 内部结构" section).
export async function findComposer(doc, selectors = COMPOSER_SELECTORS, { timeoutMs = 5000, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const el = firstVisible(doc, selectors);
    if (el) return el;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < deadline);
  return firstVisible(doc, selectors);
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

export async function sendPrompt(
  doc,
  composer,
  prompt,
  sendSelectors = SEND_BUTTON_SELECTORS,
  { pressEnter = defaultPressEnter, simulateClick = defaultSimulateClick } = {}
) {
  composer.focus();
  doc.execCommand('insertText', false, prompt);

  const sendButton = firstVisible(doc, sendSelectors);
  if (sendButton) {
    simulateClick(sendButton);
  } else {
    pressEnter(composer);
  }
}

function isAnyVisible(doc, selectors) {
  return selectors.some((selector) => {
    const el = doc.querySelector(selector);
    return !!el && el.isVisible !== false;
  });
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

// Ported from src/bridge/chatgptWeb.js's waitForReply: wait for the
// assistant message count to exceed baselineCount, then wait for the stop
// button to disappear and the text to stay unchanged for
// RESPONSE_STABLE_WINDOW_MS before returning it.
//
// Throws { code, message } (not a bridge/errors.js class — that mapping
// happens on the Node side, in chatgptExtension.js, after this crosses the
// WebSocket as a protocol error code):
//   - RESPONSE_TIMEOUT: deadline hit, some text was seen
//   - RESPONSE_EMPTY: deadline hit, no text was ever produced
export async function waitForReply(
  doc,
  { responseTimeoutMs },
  baselineCount,
  {
    assistantSelector = ASSISTANT_MESSAGE_SELECTOR,
    stopSelectors = STOP_BUTTON_SELECTORS,
    sleep = defaultSleep,
  } = {}
) {
  const deadline = Date.now() + responseTimeoutMs;
  const waiter = createMutationWaiter(doc, sleep);

  try {
    while (Date.now() < deadline && doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      await waiter.tick(DEFAULT_POLL_MS);
    }
    if (doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      const err = new Error(`No assistant response appeared within ${responseTimeoutMs}ms.`);
      err.code = 'RESPONSE_EMPTY';
      throw err;
    }

    let lastText = null;
    let stableSince = null;

    while (Date.now() < deadline) {
      const nodes = doc.querySelectorAll(assistantSelector);
      const lastNode = nodes[nodes.length - 1];
      const currentText = (lastNode?.innerText ?? '').trim();
      const stopVisible = isAnyVisible(doc, stopSelectors);

      if (!stopVisible && currentText.length > 0 && currentText === lastText) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= RESPONSE_STABLE_WINDOW_MS) {
          return currentText;
        }
      } else {
        stableSince = null;
      }

      lastText = currentText;
      await waiter.tick(DEFAULT_POLL_MS);
    }

    const nodes = doc.querySelectorAll(assistantSelector);
    const finalText = (nodes[nodes.length - 1]?.innerText ?? '').trim();
    const err = new Error(`ChatGPT response did not finish within ${responseTimeoutMs}ms.`);
    err.code = finalText ? 'RESPONSE_TIMEOUT' : 'RESPONSE_EMPTY';
    throw err;
  } finally {
    waiter.disconnect();
  }
}
