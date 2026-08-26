import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findComposer,
  startNewChat,
  insertPromptText,
  waitForSendReady,
  sendPromptReliably,
  waitForReply,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  ASSISTANT_MESSAGE_SELECTOR,
  USER_MESSAGE_SELECTOR,
  NEW_CHAT_BUTTON_SELECTORS,
} from '../extension/domActions.js';

// Instant fake "sleep" so tests don't actually wait.
function instantSleep() {
  return Promise.resolve();
}

function fakeElement(overrides = {}) {
  return { isVisible: true, focus() {}, click() {}, dispatchEvent() {}, ...overrides };
}

// Fake `document` supporting only what domActions.js calls.
function createFakeDoc({ presentSelectors = [], execCommandCalls = [], nodes = {} } = {}) {
  return {
    querySelector(selector) {
      return presentSelectors.includes(selector) ? fakeElement() : null;
    },
    querySelectorAll(selector) {
      return nodes[selector] ?? [];
    },
    execCommand(...args) {
      execCommandCalls.push(args);
      return true;
    },
  };
}

test('findComposer returns the first matching selector immediately', async () => {
  const doc = createFakeDoc({ presentSelectors: [COMPOSER_SELECTORS[1]] });
  const composer = await findComposer(doc, COMPOSER_SELECTORS, { timeoutMs: 1000, sleep: instantSleep });
  assert.ok(composer);
});

test('findComposer returns null when no selector ever matches within the timeout', async () => {
  let now = 0;
  const doc = createFakeDoc({ presentSelectors: [] });
  const composer = await findComposer(doc, COMPOSER_SELECTORS, {
    timeoutMs: 5,
    sleep: async () => {
      now += 10;
    },
  });
  assert.equal(composer, null);
});

test('startNewChat clicks the "New chat" control and confirms once the conversation clears', async () => {
  let clicked = false;
  let messages = [{ role: 'user' }, { role: 'assistant' }];
  let tick = 0;
  const doc = {
    querySelector(selector) {
      return selector === NEW_CHAT_BUTTON_SELECTORS[0] ? fakeElement({ click: () => (clicked = true) }) : null;
    },
    querySelectorAll(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return messages.filter((m) => m.role === 'assistant');
      if (selector === USER_MESSAGE_SELECTOR) return messages.filter((m) => m.role === 'user');
      return [];
    },
  };
  const result = await startNewChat(doc, NEW_CHAT_BUTTON_SELECTORS, {
    sleep: async () => {
      tick += 1;
      if (tick === 1) messages = []; // conversation clears one tick after the click
    },
  });
  assert.equal(clicked, true);
  assert.deepEqual(result, { clicked: true, cleared: true });
});

test('startNewChat reports clicked-but-not-cleared if the conversation never visibly empties', async () => {
  const doc = {
    querySelector: (selector) => (selector === NEW_CHAT_BUTTON_SELECTORS[0] ? fakeElement() : null),
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? [{ innerText: 'still here' }] : []),
  };
  const result = await startNewChat(doc, NEW_CHAT_BUTTON_SELECTORS, { timeoutMs: 5, sleep: async () => {} });
  assert.deepEqual(result, { clicked: true, cleared: false });
});

test('startNewChat reports not-clicked (and never throws) when the control is not found', async () => {
  const doc = { querySelector: () => null, querySelectorAll: () => [] };
  const result = await startNewChat(doc, NEW_CHAT_BUTTON_SELECTORS, { timeoutMs: 5, sleep: async () => {} });
  assert.deepEqual(result, { clicked: false, cleared: false });
});

test('insertPromptText succeeds via execCommand when the composer text actually changes', () => {
  const doc = { execCommand: () => true };
  // Fake ProseMirror-style composer: execCommand mutates innerText, as it
  // does on a working ChatGPT build.
  const composer = fakeElement({ innerText: '' });
  const ok = insertPromptText(doc, composer, 'hello world', {
    execCommand: () => {
      composer.innerText = 'hello world';
      return true;
    },
  });
  assert.equal(ok, true);
});

test('insertPromptText falls back to setting the DOM directly when execCommand silently no-ops', () => {
  // execCommand "succeeds" (returns true, as ChatGPT's real ProseMirror
  // build was observed doing live on 2026-08-25) but never actually
  // changes the composer's text — the documented failure mode this guards.
  const doc = { execCommand: () => true };
  const composer = fakeElement({ innerText: '' });
  const ok = insertPromptText(doc, composer, 'hello world');
  assert.equal(ok, true);
  assert.equal(composer.value ?? composer.textContent, 'hello world');
});

test('insertPromptText returns false when both execCommand and the DOM fallback fail to produce text', () => {
  const doc = { execCommand: () => true };
  // A composer whose text properties can't actually be written (pathological
  // case — e.g. the page removed/replaced the composer mid-flight).
  const composer = Object.freeze({ isVisible: true, innerText: '', focus() {}, dispatchEvent() {} });
  const ok = insertPromptText(doc, composer, 'hello world');
  assert.equal(ok, false);
});

test('waitForSendReady waits for the button to become enabled, not just visible', async () => {
  let disabled = true;
  const doc = {
    // Not built through fakeElement()'s object spread — spreading a getter
    // evaluates it once into a static value, which would defeat the point
    // of a `disabled` flag that flips during the test.
    querySelector(selector) {
      if (selector !== SEND_BUTTON_SELECTORS[0]) return null;
      return {
        isVisible: true,
        get disabled() {
          return disabled;
        },
        focus() {},
        click() {},
        dispatchEvent() {},
      };
    },
  };
  const button = await waitForSendReady(doc, SEND_BUTTON_SELECTORS, {
    timeoutMs: 1000,
    sleep: async () => {
      disabled = false;
    },
  });
  assert.ok(button);
});

test('waitForSendReady returns null if the button never becomes ready within the timeout', async () => {
  const doc = {
    querySelector(selector) {
      if (selector !== SEND_BUTTON_SELECTORS[0]) return null;
      return fakeElement({ disabled: true });
    },
  };
  let now = 0;
  const button = await waitForSendReady(doc, SEND_BUTTON_SELECTORS, {
    timeoutMs: 5,
    sleep: async () => {
      now += 10;
    },
  });
  assert.equal(button, null);
});

// Builds a fake document for sendPromptReliably scenarios: tracks the
// composer's own text, the count of "sent" user messages, and how many
// times the send button was clicked.
function createSendScenarioDoc({ composerText = '', confirmAfterClicks = 1 } = {}) {
  let clicks = 0;
  let userMessageCount = 0;
  // Built directly (not through fakeElement()'s object spread, which would
  // collapse this accessor pair into a one-time static value) so composer
  // text genuinely round-trips through get/set like a real DOM property.
  const composer = {
    isVisible: true,
    focus() {},
    dispatchEvent() {},
    get innerText() {
      return composerText;
    },
    set innerText(v) {
      composerText = v;
    },
  };
  const sendButton = fakeElement({
    disabled: false,
    click: () => {
      clicks += 1;
      if (clicks >= confirmAfterClicks) {
        userMessageCount += 1;
        composerText = '';
      }
    },
  });
  const doc = {
    execCommand: (_cmd, _ui, text) => {
      composerText = text;
      return true;
    },
    querySelector(selector) {
      if (selector === SEND_BUTTON_SELECTORS[0]) return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === USER_MESSAGE_SELECTOR) return Array.from({ length: userMessageCount });
      return [];
    },
  };
  return { doc, composer, getClicks: () => clicks };
}

test('sendPromptReliably confirms send via a real user-message-count increase', async () => {
  const { doc, composer } = createSendScenarioDoc({ confirmAfterClicks: 1 });
  const stages = [];
  await sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, {
    sleep: instantSleep,
    onStage: (s) => stages.push(s),
  });
  assert.deepEqual(stages, ['text inserted', 'send ready', 'send triggered', 'send confirmed']);
});

test('sendPromptReliably retries a click that does not register, then confirms', async () => {
  // The send button's own click handler only actually "sends" (increments
  // the user-message count) starting from the 2nd click — mirrors the
  // live-observed failure where a plain click() silently no-ops once.
  const { doc, composer, getClicks } = createSendScenarioDoc({ confirmAfterClicks: 2 });
  const stages = [];
  await sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, {
    confirmTimeoutMs: 5,
    sleep: async () => {},
    onStage: (s) => stages.push(s),
  });
  assert.equal(getClicks(), 2);
  assert.equal(stages.filter((s) => s === 'send confirmed').length, 1);
  assert.equal(stages.filter((s) => s === 'send triggered').length, 2);
});

test('sendPromptReliably throws SEND_FAILED after exhausting retries with no confirmation, instead of waiting forever', async () => {
  // confirmAfterClicks higher than maxAttempts: never actually confirms.
  const { doc, composer } = createSendScenarioDoc({ confirmAfterClicks: 999 });
  await assert.rejects(
    () =>
      sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, {
        maxAttempts: 3,
        confirmTimeoutMs: 5,
        sleep: async () => {},
      }),
    (err) => err.code === 'SEND_FAILED'
  );
});

test('sendPromptReliably throws SEND_FAILED immediately if the prompt can never be inserted', async () => {
  const doc = { execCommand: () => true, querySelector: () => null, querySelectorAll: () => [] };
  const composer = Object.freeze({ isVisible: true, innerText: '', focus() {}, dispatchEvent() {} });
  await assert.rejects(
    () => sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, { sleep: instantSleep }),
    (err) => err.code === 'SEND_FAILED'
  );
});

test('sendPromptReliably falls back to Enter when no send button is found', async () => {
  let composerText = '';
  let userMessageCount = 0;
  let pressed = false;
  const composer = {
    isVisible: true,
    focus() {},
    dispatchEvent() {},
    get innerText() {
      return composerText;
    },
    set innerText(v) {
      composerText = v;
    },
  };
  const doc = {
    execCommand: (_cmd, _ui, text) => {
      composerText = text;
      return true;
    },
    querySelector: () => null, // no send button anywhere
    querySelectorAll: (selector) => (selector === USER_MESSAGE_SELECTOR ? Array.from({ length: userMessageCount }) : []),
  };
  await sendPromptReliably(doc, composer, 'hello', SEND_BUTTON_SELECTORS, {
    sendReadyTimeoutMs: 5,
    sleep: instantSleep,
    pressEnter: () => {
      pressed = true;
      userMessageCount += 1;
      composerText = '';
    },
  });
  assert.equal(pressed, true);
});

test('waitForReply resolves once the stop control disappears and assistant text is present (no fixed stability wait)', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  let tick = 0;
  const doc = {
    querySelectorAll(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistantNodes;
      return [];
    },
    querySelector(selector) {
      return STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null;
    },
  };
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    sleep: async () => {
      tick += 1;
      if (tick === 1) assistantNodes = [{ innerText: 'streaming...' }];
      if (tick === 2) assistantNodes = [{ innerText: 'still streaming' }];
      if (tick === 3) {
        stopVisible = false;
        assistantNodes = [{ innerText: 'final reply' }];
      }
    },
  });
  assert.equal(text, 'final reply');
});

test('waitForReply does not return on a single-frame false-finish (stop control not yet mounted) if text keeps growing', async () => {
  // Reproduces a real race observed live (2026-08-26): the stop control
  // hasn't mounted yet even though the first token already rendered, which
  // briefly looks identical to "finished". waitForReply must not return
  // the 1-character text this produces.
  let assistantNodes = [];
  let stopVisible = true;
  let tick = 0;
  const doc = {
    querySelectorAll(selector) {
      return selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : [];
    },
    querySelector(selector) {
      return STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null;
    },
  };
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    sleep: async () => {
      tick += 1;
      if (tick === 1) {
        // Assistant node appears with one token already in it, and the
        // stop control hasn't rendered yet on this same frame.
        assistantNodes = [{ innerText: 'F' }];
        stopVisible = false;
      } else if (tick === 2) {
        // The recheck tick: streaming was actually still in progress —
        // more text landed, and the stop control has now mounted.
        assistantNodes = [{ innerText: 'FALCON-9-ORCHID (partial' }];
        stopVisible = true;
      } else if (tick === 3) {
        assistantNodes = [{ innerText: 'FALCON-9-ORCHID' }];
        stopVisible = false;
      }
    },
  });
  assert.equal(text, 'FALCON-9-ORCHID');
});

test('waitForReply does not return while the stop control is still visible, even with non-empty text (mid-stream)', async () => {
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? [{ innerText: 'partial text' }] : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) ? fakeElement() : null),
  };
  await assert.rejects(
    () => waitForReply(doc, { responseTimeoutMs: 20 }, 0, { sleep: async () => {} }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
});

test('waitForReply only reads the newest assistant message, ignoring ones that existed before the baseline', async () => {
  const preExisting = [{ innerText: 'old reply 1' }, { innerText: 'old reply 2' }];
  let assistantNodes = preExisting;
  let stopVisible = true;
  let tick = 0;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, preExisting.length, {
    sleep: async () => {
      tick += 1;
      if (tick === 1) assistantNodes = [...preExisting, { innerText: 'new reply' }];
      if (tick === 2) stopVisible = false;
    },
  });
  assert.equal(text, 'new reply');
});

test('waitForReply throws RESPONSE_EMPTY when no assistant message ever appears', async () => {
  const doc = { querySelectorAll: () => [], querySelector: () => null };
  await assert.rejects(
    () => waitForReply(doc, { responseTimeoutMs: 10 }, 0, { sleep: async () => {} }),
    (err) => err.code === 'RESPONSE_EMPTY'
  );
});
