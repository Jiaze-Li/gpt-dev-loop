import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findComposer,
  sendPrompt,
  waitForReply,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  ASSISTANT_MESSAGE_SELECTOR,
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

test('sendPrompt clicks the send button when one is visible', async () => {
  const execCommandCalls = [];
  let clicked = false;
  const doc = {
    querySelector(selector) {
      if (selector === SEND_BUTTON_SELECTORS[0]) return fakeElement({ click: () => (clicked = true) });
      return null;
    },
    execCommand(...args) {
      execCommandCalls.push(args);
    },
  };
  const composer = fakeElement();
  await sendPrompt(doc, composer, 'hello world', SEND_BUTTON_SELECTORS);
  assert.equal(clicked, true);
  assert.deepEqual(execCommandCalls[0], ['insertText', false, 'hello world']);
});

test('sendPrompt falls back to pressing Enter when no send button is found', async () => {
  const doc = { querySelector: () => null, execCommand: () => {} };
  const composer = fakeElement();
  let pressed = false;
  await sendPrompt(doc, composer, 'hello', SEND_BUTTON_SELECTORS, { pressEnter: () => (pressed = true) });
  assert.equal(pressed, true);
});

test('waitForReply resolves once a new assistant message appears and its text stabilizes', async () => {
  let assistantNodes = [];
  let elapsed = 0;
  const doc = {
    querySelectorAll(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistantNodes;
      return []; // stop-button selectors: never visible
    },
    querySelector: () => null,
  };
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      sleep: async () => {
        elapsed += 300;
        if (elapsed === 300) {
          assistantNodes = [{ innerText: 'partial' }];
        } else if (elapsed >= 600) {
          assistantNodes = [{ innerText: 'final reply' }];
        }
      },
    }
  );
  assert.equal(text, 'final reply');
});

test('waitForReply throws RESPONSE_EMPTY when no assistant message ever appears', async () => {
  const doc = { querySelectorAll: () => [], querySelector: () => null };
  await assert.rejects(
    () => waitForReply(doc, { responseTimeoutMs: 10 }, 0, { sleep: async () => {} }),
    (err) => err.code === 'RESPONSE_EMPTY'
  );
});

test('waitForReply throws RESPONSE_TIMEOUT when text appears but never stabilizes before the deadline', async () => {
  let counter = 0;
  const doc = {
    querySelectorAll: () => [{ innerText: `chunk-${counter}` }],
    querySelector: () => null,
  };
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 20 }, -1, {
        sleep: async () => {
          counter += 1;
        },
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
});
