import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findComposer,
  startNewChat,
  insertPromptText,
  waitForSendReady,
  sendPromptReliably,
  waitForReply,
  extractConversationId,
  readConversationId,
  waitForConversationIdentity,
  isValidConversationId,
  isRateLimited,
  deleteConversation,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  ASSISTANT_MESSAGE_SELECTOR,
  USER_MESSAGE_SELECTOR,
  NEW_CHAT_BUTTON_SELECTORS,
  CONVERSATION_MENU_BUTTON_SELECTORS,
  DELETE_MENU_ITEM_SELECTORS,
  DELETE_CONFIRM_BUTTON_SELECTORS,
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

// --- Conversation identity -------------------------------------------

test('extractConversationId reads the /c/<id> segment and only that', () => {
  assert.equal(extractConversationId('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(extractConversationId('https://chatgpt.com/'), null);
  assert.equal(extractConversationId('https://chatgpt.com/c/'), null);
  assert.equal(extractConversationId(undefined), null);
});

// Regression: a stray non-conversation anchor/URL segment starting with
// "/c/" (e.g. a nav/mode link, not a chat row) can satisfy the loose
// /c/<alnum-or-hyphen> pattern with a bare word like "WEB" — this must
// never be accepted as a real conversation id. Real ChatGPT ids are always
// hyphen-segmented (UUIDs).
test('extractConversationId rejects a bare word that is not shaped like a real conversation id', () => {
  assert.equal(extractConversationId('https://chatgpt.com/c/WEB'), null);
  assert.equal(extractConversationId('https://chatgpt.com/c/new'), null);
});

test('isValidConversationId accepts hyphen-segmented ids and rejects bare words', () => {
  assert.equal(isValidConversationId('abc-123'), true);
  assert.equal(isValidConversationId('WEB'), false);
  assert.equal(isValidConversationId(''), false);
  assert.equal(isValidConversationId(null), false);
});

test('readConversationId reads the id off doc.location.href', () => {
  const doc = { location: { href: 'https://chatgpt.com/c/xyz-789' } };
  assert.equal(readConversationId(doc), 'xyz-789');
  assert.equal(readConversationId({ location: { href: 'https://chatgpt.com/' } }), null);
});

// --- waitForConversationIdentity ----------------------------------------
//
// Fake doc: a mutable location.href plus a mutable list of sidebar anchors
// (each `{ href, ariaCurrent }`), mirroring the two independent identity
// sources waitForConversationIdentity checks. sleep also drives
// createMutationWaiter's fallback path (no MutationObserver in Node).
function createIdentityScenarioDoc({ href = 'https://chatgpt.com/', anchors = [] } = {}) {
  return {
    location: { href },
    querySelectorAll(selector) {
      if (selector !== 'a[href^="/c/"]') return [];
      return anchors
        .filter((a) => a.href.startsWith('/c/'))
        .map((a) => ({
          getAttribute: (name) => (name === 'href' ? a.href : name === 'aria-current' ? (a.ariaCurrent ?? null) : null),
        }));
    },
  };
}

test('waitForConversationIdentity returns immediately when the URL already has a fresh /c/<id>', async () => {
  const doc = createIdentityScenarioDoc({ href: 'https://chatgpt.com/c/new-1' });
  const stages = [];
  const id = await waitForConversationIdentity(doc, { sleep: instantSleep, onStage: (s) => stages.push(s) });
  assert.equal(id, 'new-1');
  assert.deepEqual(stages, ['waiting for conversation identity', 'identity captured (new-1)']);
});

test('waitForConversationIdentity waits (event/poll-driven) for the URL to pick up /c/<id> later', async () => {
  const doc = createIdentityScenarioDoc({ href: 'https://chatgpt.com/' });
  let ticks = 0;
  const id = await waitForConversationIdentity(doc, {
    timeoutMs: 10000,
    sleep: async () => {
      ticks += 1;
      if (ticks === 2) doc.location.href = 'https://chatgpt.com/c/new-2';
    },
  });
  assert.equal(id, 'new-2');
});

test('waitForConversationIdentity accepts the active sidebar anchor when the URL never updates', async () => {
  const doc = createIdentityScenarioDoc({
    href: 'https://chatgpt.com/',
    anchors: [
      { href: '/c/old-1', ariaCurrent: null },
      { href: '/c/new-3', ariaCurrent: 'page' },
    ],
  });
  const id = await waitForConversationIdentity(doc, { sleep: instantSleep });
  assert.equal(id, 'new-3');
});

test('waitForConversationIdentity throws CONVERSATION_IDENTITY_NOT_FOUND rather than guessing when identity never appears', async () => {
  const doc = createIdentityScenarioDoc({ href: 'https://chatgpt.com/' });
  const stages = [];
  let now = 0;
  await assert.rejects(
    () =>
      waitForConversationIdentity(doc, {
        timeoutMs: 5,
        sleep: async () => {
          now += 10;
        },
        onStage: (s) => stages.push(s),
      }),
    (err) => err.code === 'CONVERSATION_IDENTITY_NOT_FOUND'
  );
  assert.ok(stages.includes('identity timeout'));
});

test('waitForConversationIdentity never accepts a bare-word decoy anchor as identity — from either the URL or the sidebar', async () => {
  // Regression for the live "identity captured (WEB)" bug: a decoy anchor
  // (not a real conversation row) with aria-current="page" and an href
  // shaped like /c/WEB must be skipped in favor of the real, later
  // hyphen-segmented id — never captured/logged as identity itself.
  const doc = createIdentityScenarioDoc({
    href: 'https://chatgpt.com/c/WEB',
    anchors: [{ href: '/c/WEB', ariaCurrent: 'page' }],
  });
  let ticks = 0;
  const stages = [];
  const id = await waitForConversationIdentity(doc, {
    timeoutMs: 10000,
    sleep: async () => {
      ticks += 1;
      if (ticks === 2) {
        doc.location.href = 'https://chatgpt.com/c/real-42';
        doc.querySelectorAll = (selector) =>
          selector === 'a[href^="/c/"]' ? [{ getAttribute: (n) => (n === 'href' ? '/c/real-42' : 'page') }] : [];
      }
    },
    onStage: (s) => stages.push(s),
  });
  assert.equal(id, 'real-42');
  assert.ok(!stages.some((s) => s.includes('WEB')), 'must never log the decoy as a captured identity');
});

test('waitForConversationIdentity never returns a stale/baseline id — from either the URL or the sidebar', async () => {
  // Simulates re-entering the same page still showing the previous
  // conversation's id/active anchor: neither source should be accepted
  // until it actually differs from the baseline captured before send.
  const doc = createIdentityScenarioDoc({
    href: 'https://chatgpt.com/c/old-1',
    anchors: [{ href: '/c/old-1', ariaCurrent: 'page' }],
  });
  let ticks = 0;
  const id = await waitForConversationIdentity(doc, {
    baselineId: 'old-1',
    timeoutMs: 10000,
    sleep: async () => {
      ticks += 1;
      if (ticks === 2) {
        doc.location.href = 'https://chatgpt.com/c/new-4';
        doc.querySelectorAll = (selector) =>
          selector === 'a[href^="/c/"]' ? [{ getAttribute: (n) => (n === 'href' ? '/c/new-4' : 'page') }] : [];
      }
    },
  });
  assert.equal(id, 'new-4');
});

// --- Rate-limit detection ----------------------------------------------

test('isRateLimited recognizes ChatGPT\'s own throttling banner text', () => {
  const doc = { body: { innerText: "You're making requests too quickly. We've temporarily limited access to your conversations to protect your data." } };
  assert.equal(isRateLimited(doc), true);
  assert.equal(isRateLimited({ body: { innerText: 'ordinary page text' } }), false);
});

test('findComposer throws RATE_LIMITED as soon as the throttling banner appears, instead of waiting out the full timeout', async () => {
  const doc = { body: { innerText: "You're making requests too quickly." }, querySelector: () => null };
  await assert.rejects(
    () => findComposer(doc, COMPOSER_SELECTORS, { timeoutMs: 10000, sleep: async () => {} }),
    (err) => err.code === 'RATE_LIMITED'
  );
});

test('waitForReply throws RATE_LIMITED if the throttling banner appears mid-wait', async () => {
  const doc = { body: { innerText: '' }, querySelectorAll: () => [], querySelector: () => null };
  let tick = 0;
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
        sleep: async () => {
          tick += 1;
          if (tick === 1) doc.body.innerText = "You're making requests too quickly.";
        },
      }),
    (err) => err.code === 'RATE_LIMITED'
  );
});

// --- Conversation deletion -----------------------------------------------
//
// Fake sidebar: an anchor identified only by its href (never by title),
// whose `.closest('li')` returns a row exposing the options button; the
// options button "opens" a global menu (querySelectorAll'd off `doc`,
// mirroring a real Radix portal), whose Delete item "opens" a confirm
// dialog, whose own Delete button removes the anchor — the real DOM
// postcondition deleteConversation checks for.
function createDeleteScenarioDoc(conversationId, { confirmActuallyDeletes = true, linkHydratesAfterQueries = 0 } = {}) {
  let hydrated = linkHydratesAfterQueries === 0;
  let hydrationQueries = 0;
  let linkPresent = true;
  let deleteMenuItemPresent = false;
  let confirmDialogPresent = false;

  const menuButton = {
    isVisible: true,
    click() {
      deleteMenuItemPresent = true;
    },
  };
  const row = {
    querySelector(selector) {
      return CONVERSATION_MENU_BUTTON_SELECTORS.includes(selector) ? menuButton : null;
    },
  };
  const anchor = {
    isVisible: true,
    closest(selector) {
      return selector === 'li' ? row : null;
    },
  };
  const deleteMenuItem = {
    innerText: 'Delete',
    click() {
      deleteMenuItemPresent = false;
      confirmDialogPresent = true;
    },
  };
  const confirmButton = {
    innerText: 'Delete',
    click() {
      confirmDialogPresent = false;
      if (confirmActuallyDeletes) linkPresent = false;
    },
  };

  return {
    querySelector(selector) {
      if (selector !== `a[href="/c/${conversationId}"]`) return null;
      if (!hydrated) {
        hydrationQueries += 1;
        if (hydrationQueries >= linkHydratesAfterQueries) hydrated = true;
        return null;
      }
      return linkPresent ? anchor : null;
    },
    querySelectorAll(selector) {
      if (DELETE_MENU_ITEM_SELECTORS.includes(selector)) return deleteMenuItemPresent ? [deleteMenuItem] : [];
      if (DELETE_CONFIRM_BUTTON_SELECTORS.includes(selector)) return confirmDialogPresent ? [confirmButton] : [];
      return [];
    },
  };
}

test('deleteConversation locates the row by href, drives menu -> delete -> confirm, and confirms via the row actually disappearing', async () => {
  const doc = createDeleteScenarioDoc('conv-1');
  const stages = [];
  const result = await deleteConversation(doc, 'conv-1', { sleep: instantSleep, onStage: (s) => stages.push(s) });
  assert.deepEqual(result, { deleted: true });
  assert.deepEqual(stages, [
    'conversation row located',
    'conversation menu opened',
    'delete menu item found',
    'delete clicked',
    'delete confirmation dialog found',
    'delete triggered',
    'delete confirmed',
  ]);
});

test('deleteConversation throws CONVERSATION_NOT_FOUND rather than falling back to a title match when the id is not in the sidebar', async () => {
  const doc = { querySelector: () => null, querySelectorAll: () => [] };
  await assert.rejects(
    () => deleteConversation(doc, 'missing-id', { sleep: instantSleep, rowLookupTimeoutMs: 5 }),
    (err) => err.code === 'CONVERSATION_NOT_FOUND'
  );
});

test('deleteConversation waits out a delayed sidebar hydration and still succeeds once the row appears', async () => {
  // A freshly navigated tab reaches "complete" before its sidebar's
  // conversation list (populated by an async fetch) has necessarily
  // hydrated; the row must not be missed just because it wasn't there on
  // the very first synchronous check.
  const doc = createDeleteScenarioDoc('conv-1', { linkHydratesAfterQueries: 3 });
  const stages = [];
  const result = await deleteConversation(doc, 'conv-1', { sleep: instantSleep, onStage: (s) => stages.push(s) });
  assert.deepEqual(result, { deleted: true });
  assert.equal(stages[0], 'conversation row located');
  assert.deepEqual(stages.slice(-1), ['delete confirmed']);
});

test('deleteConversation fails safely with CONVERSATION_NOT_FOUND (not a hang) if the sidebar never hydrates the row', async () => {
  const doc = createDeleteScenarioDoc('conv-1', { linkHydratesAfterQueries: Number.POSITIVE_INFINITY });
  const stages = [];
  await assert.rejects(
    () => deleteConversation(doc, 'conv-1', { sleep: instantSleep, rowLookupTimeoutMs: 5, onStage: (s) => stages.push(s) }),
    (err) => err.code === 'CONVERSATION_NOT_FOUND'
  );
  assert.deepEqual(stages, [], 'must fail before ever reaching "conversation row located"');
});

test('deleteConversation rejects a missing conversation id outright rather than guessing', async () => {
  await assert.rejects(
    () => deleteConversation({ querySelector: () => null, querySelectorAll: () => [] }, '', { sleep: instantSleep }),
    (err) => err.code === 'CONVERSATION_NOT_FOUND'
  );
});

// Regression: a live run once captured the bare word "WEB" (from a stray
// non-conversation anchor/URL segment, not an actual chat row) as if it
// were a real conversation id, logged "identity captured (WEB)", and then
// failed deletion with a confusing "not visible in the sidebar" error. A
// real ChatGPT conversation id is always hyphen-segmented (a UUID); a bare
// word must never reach the row-lookup/click flow at all.
test('deleteConversation rejects a bare-word conversation id (not a real /c/<id> shape) before touching the DOM', async () => {
  let queried = false;
  const doc = {
    querySelector: () => {
      queried = true;
      return null;
    },
    querySelectorAll: () => {
      queried = true;
      return [];
    },
  };
  await assert.rejects(
    () => deleteConversation(doc, 'WEB', { sleep: instantSleep }),
    (err) => err.code === 'CONVERSATION_NOT_FOUND'
  );
  assert.equal(queried, false, 'must reject before ever looking for the row in the DOM');
});

test('deleteConversation throws DELETE_MENU_NOT_FOUND when the row has no matching options control', async () => {
  const anchor = { isVisible: true, closest: () => ({ querySelector: () => null }) };
  const doc = {
    querySelector: (selector) => (selector === 'a[href="/c/conv-1"]' ? anchor : null),
    querySelectorAll: () => [],
  };
  await assert.rejects(
    () => deleteConversation(doc, 'conv-1', { sleep: instantSleep }),
    (err) => err.code === 'DELETE_MENU_NOT_FOUND'
  );
});

test('deleteConversation throws DELETE_NOT_CONFIRMED instead of assuming success if the row never disappears', async () => {
  const doc = createDeleteScenarioDoc('conv-1', { confirmActuallyDeletes: false });
  await assert.rejects(
    () => deleteConversation(doc, 'conv-1', { sleep: instantSleep, postconditionTimeoutMs: 5 }),
    (err) => err.code === 'DELETE_NOT_CONFIRMED'
  );
});

test('deleteConversation throws RATE_LIMITED if the throttling banner appears while the menu is still opening', async () => {
  const menuButton = { isVisible: true, click() {} }; // clicked, but the menu item never actually shows up below
  const anchor = { isVisible: true, closest: () => ({ querySelector: (selector) => (CONVERSATION_MENU_BUTTON_SELECTORS.includes(selector) ? menuButton : null) }) };
  const doc = {
    body: { innerText: '' },
    querySelector: (selector) => (selector === 'a[href="/c/conv-1"]' ? anchor : null),
    querySelectorAll: () => [],
  };
  let tick = 0;
  await assert.rejects(
    () =>
      deleteConversation(doc, 'conv-1', {
        menuOpenTimeoutMs: 10000,
        sleep: async () => {
          tick += 1;
          if (tick === 1) doc.body.innerText = "You're making requests too quickly.";
        },
      }),
    (err) => err.code === 'RATE_LIMITED'
  );
});
