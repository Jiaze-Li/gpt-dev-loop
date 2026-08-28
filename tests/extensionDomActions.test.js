import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findComposer,
  waitForChatGptReady,
  snapshotReviewerPreflight,
  startNewChat,
  insertPromptText,
  insertPromptReliably,
  waitForSendReady,
  sendPromptReliably,
  waitForReply,
  extractConversationId,
  readConversationId,
  waitForConversationIdentity,
  observeReplyAndIdentity,
  verifyAttachedConversationId,
  isValidConversationId,
  isRateLimited,
  deleteConversation,
  COMPOSER_SELECTORS,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTORS,
  ASSISTANT_MESSAGE_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  ASSISTANT_COMPLETED_ACTION_SELECTORS,
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

// Builds a fake assistant message node exposing the completed-message
// footer signal (ASSISTANT_COMPLETED_ACTION_SELECTORS) alongside its own
// text — models a real ChatGPT turn once it has actually finished
// rendering. `completed: false` (the default) models mid-stream, where the
// footer has not mounted yet. Most waitForReply tests below only care about
// the FINAL node's completed state (the gate is checked on whichever tick
// happens to be current when the quiet threshold is reached, not on when the
// footer specifically appeared), so callers pass `completed: true` on
// whichever node is the reply's true final state.
function assistantNode(text, { completed = false } = {}) {
  return {
    innerText: text,
    querySelector(selector) {
      if (completed && ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector)) return fakeElement();
      return null;
    },
  };
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
  assert.deepEqual(stages, [
    'prompt insertion started',
    'payload metrics: length=11 newlines=0 paragraphs=1',
    'insertion target resolved',
    'insertion target focused',
    'content write started',
    'content write finished',
    'input/change events dispatched',
    'inserted-content verification started',
    'inserted-content verification succeeded',
    'prompt insertion completed',
    'send ready',
    'send triggered',
    'new user message observed',
    'send confirmed',
  ]);
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

test('sendPromptReliably throws PROMPT_INSERTION_FAILED immediately if the prompt can never be inserted, and never attempts to send', async () => {
  let sendButtonQueried = false;
  const doc = {
    execCommand: () => true,
    querySelector: (selector) => {
      if (selector === SEND_BUTTON_SELECTORS[0]) sendButtonQueried = true;
      return null;
    },
    querySelectorAll: () => [],
  };
  const composer = Object.freeze({ isVisible: true, isConnected: true, innerText: '', focus() {}, dispatchEvent() {} });
  await assert.rejects(
    () => sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, { sleep: instantSleep }),
    (err) => err.code === 'PROMPT_INSERTION_FAILED'
  );
  assert.equal(sendButtonQueried, false);
});

// --- insertPromptReliably: bounded, diagnosable insertion pipeline --------

test('insertPromptReliably succeeds and emits every insertion sub-stage in order', async () => {
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: '' };
  const doc = {
    execCommand: (_cmd, _ui, text) => {
      composer.innerText = text;
      return true;
    },
  };
  const stages = [];
  const result = await insertPromptReliably(doc, composer, 'hello world', {
    sleep: instantSleep,
    onStage: (s) => stages.push(s),
  });
  assert.equal(result, composer);
  assert.deepEqual(stages, [
    'insertion target resolved',
    'insertion target focused',
    'content write started',
    'content write finished',
    'input/change events dispatched',
    'inserted-content verification started',
    'inserted-content verification succeeded',
  ]);
});

test('insertPromptReliably throws PROMPT_INSERTION_TIMEOUT when the composer never verifies as holding the prompt', async () => {
  // execCommand "succeeds" but never actually mutates the composer's text —
  // the same silent-no-op failure mode insertPromptText already guards
  // against, except here the DOM fallback also never takes (composer stays
  // non-empty but wrong), so verification never converges.
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: 'stale' };
  const doc = { execCommand: () => true };
  let time = 0;
  const sleep = async (ms) => {
    time += ms;
  };
  const now = () => time;
  await assert.rejects(
    () => insertPromptReliably(doc, composer, 'hello world', { timeoutMs: 500, pollMs: 100, sleep, now }),
    (err) => err.code === 'PROMPT_INSERTION_TIMEOUT' && err.diagnostics.expectedLength === 'hello world'.length && err.diagnostics.observedLength === 'stale'.length
  );
});

test('insertPromptReliably re-resolves once and retries when the composer is replaced mid-verification', async () => {
  const newComposer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: '' };
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: 'stale' };
  let queryCalls = 0;
  const doc = {
    querySelector: (selector) => {
      if (selector !== COMPOSER_SELECTORS[0]) return null;
      queryCalls += 1;
      return newComposer;
    },
    // Only the fresh (post-replace) composer actually receives a write —
    // models ChatGPT swapping in a new ProseMirror node mid-flight.
    execCommand: (_cmd, _ui, text) => {
      newComposer.innerText = text;
      return true;
    },
  };
  let ticks = 0;
  const sleep = async () => {
    ticks += 1;
    if (ticks === 1) composer.isConnected = false; // simulate replacement after the first verification check
  };
  const stages = [];
  const result = await insertPromptReliably(doc, composer, 'hello world', {
    timeoutMs: 5000,
    pollMs: 10,
    sleep,
    onStage: (s) => stages.push(s),
  });
  assert.equal(result, newComposer);
  assert.equal(queryCalls, 1);
  assert.ok(stages.includes('insertion target re-resolved'));
});

test('insertPromptReliably fails explicitly (never loops forever) once the composer has already been replaced once', async () => {
  let queryCalls = 0;
  const doc = {
    querySelector: (selector) => {
      if (selector !== COMPOSER_SELECTORS[0]) return null;
      queryCalls += 1;
      return { isConnected: false, focus() {}, dispatchEvent() {} };
    },
    execCommand: () => true,
  };
  const composer = { isConnected: false, focus() {}, dispatchEvent() {} };
  await assert.rejects(
    () => insertPromptReliably(doc, composer, 'hello world', { sleep: instantSleep }),
    (err) => err.code === 'PROMPT_INSERTION_FAILED'
  );
  assert.equal(queryCalls, 1);
});

test('insertPromptReliably succeeds when the composer readback inflates blank-line runs and adds NBSP/zero-width chars (editor rendering artifacts)', async () => {
  // Models the 2026-08-27 live finding: the composer visibly held the
  // correct prompt but readComposerText()'s innerText path came back longer
  // than the source string, because ChatGPT's paragraph-per-line composer
  // structure inserts an extra line break at every blank-line boundary, and
  // some paragraph edges get an NBSP/zero-width char instead of nothing.
  const prompt = 'line one\n\nline two\nline three';
  // Blank-line run inflated 1 -> 2 newlines, NBSP substituted for a space,
  // and a zero-width space inserted at a paragraph boundary — none of these
  // change the semantic content.
  const inflatedObserved = 'line one\n\n\nline two\nline ​three';
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: '' };
  const doc = {
    execCommand: () => {
      composer.innerText = inflatedObserved;
      return true;
    },
  };
  const result = await insertPromptReliably(doc, composer, prompt, { sleep: instantSleep });
  assert.equal(result, composer);
});

test('insertPromptReliably still rejects genuinely truncated or altered content despite normalization', async () => {
  const prompt = 'line one\n\nline two\nline three';
  // Missing "line three" entirely — a real truncation, not a rendering
  // artifact — must still fail even after normalization.
  const truncatedObserved = 'line one\n\nline two';
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: 'stale' };
  const doc = {
    execCommand: () => {
      composer.innerText = truncatedObserved;
      return true;
    },
  };
  let time = 0;
  const sleep = async (ms) => {
    time += ms;
  };
  const now = () => time;
  await assert.rejects(
    () => insertPromptReliably(doc, composer, prompt, { timeoutMs: 500, pollMs: 100, sleep, now }),
    (err) => err.code === 'PROMPT_INSERTION_TIMEOUT'
  );
});

// --- Large Reviewer-shaped payloads (2026-08-27 hang investigation) -------
//
// A Reviewer prompt bundles a full Task Card + Execution Report + Evidence —
// much larger and more multi-paragraph than a typical Supervisor prompt.
// These prove insertPromptText/insertPromptReliably route such payloads
// through the direct-DOM write path (never execCommand, the primitive
// implicated in the live hang) and still succeed/verify correctly.

function buildReviewerShapedPrompt() {
  const section = (title, lines) => `## ${title}\n\n${lines.join('\n')}`;
  const bulletLines = (n, label) => Array.from({ length: n }, (_, i) => `- ${label} item ${i}: some representative detail text here.`);
  return [
    section('Task Card', bulletLines(20, 'task')),
    section('Execution Report', bulletLines(30, 'change')),
    section('Evidence', bulletLines(25, 'evidence')),
  ].join('\n\n');
}

test('insertPromptText routes a large multi-paragraph (Reviewer-shaped) prompt straight to the direct-DOM write path, never execCommand', () => {
  const prompt = buildReviewerShapedPrompt();
  assert.ok(prompt.length > 2000, 'fixture must actually exceed the large-prompt threshold');
  let execCommandCalled = false;
  const doc = { execCommand: () => { execCommandCalled = true; return true; } };
  const composer = fakeElement({ innerText: '' });
  const ok = insertPromptText(doc, composer, prompt);
  assert.equal(ok, true);
  assert.equal(execCommandCalled, false);
  assert.equal(composer.value ?? composer.textContent, prompt);
});

test('insertPromptReliably succeeds end-to-end on a large multi-paragraph (Reviewer-shaped) prompt', async () => {
  const prompt = buildReviewerShapedPrompt();
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: '' };
  // No execCommand at all on this fake doc — proves the large-prompt path
  // never reaches for it (a real execCommand call is exactly the risky
  // primitive implicated in the live 130s hang on a Reviewer-sized payload).
  const doc = {};
  const stages = [];
  const result = await insertPromptReliably(doc, composer, prompt, {
    sleep: instantSleep,
    onStage: (s) => stages.push(s),
  });
  assert.equal(result, composer);
  assert.ok(stages.includes('inserted-content verification succeeded'));
});

test('sendPromptReliably inserts and sends a large multi-paragraph (Reviewer-shaped) prompt normally', async () => {
  const prompt = buildReviewerShapedPrompt();
  const { doc, composer } = createSendScenarioDoc({ confirmAfterClicks: 1 });
  await sendPromptReliably(doc, composer, prompt, SEND_BUTTON_SELECTORS, { sleep: instantSleep });
  assert.equal(composer.innerText, '');
});

// --- Outer hard-timeout defense-in-depth ----------------------------------

test('sendPromptReliably fails with PROMPT_INSERTION_TIMEOUT via the outer hard timeout well before insertPromptReliably\'s own (much longer) internal deadline', async () => {
  // Models the outer bound catching a stuck insertion faster than the
  // internal one would on its own — proven by timing, not by making the
  // internal loop truly infinite (a genuinely never-ending internal loop
  // would keep scheduling real timers forever even after this promise
  // rejects, hanging the test process). `scheduleHardTimeout` is
  // deliberately real wall-clock (setTimeout), independent of the `sleep`
  // insertPromptReliably uses internally, which is what lets it fire even
  // if that internal `sleep`/deadline math were the thing that broke.
  const doc = { execCommand: () => true };
  // Text never verifies as matching (readComposerText always returns the
  // same non-empty stale string, so insertPromptText's own "did we write
  // anything" check passes but verification digest never converges) —
  // finite internal deadline (200ms) still bounds the test's worst case.
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: 'stale' };
  const realTinySleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      sendPromptReliably(doc, composer, 'hello world', SEND_BUTTON_SELECTORS, {
        promptInsertionTimeoutMs: 200, // finite — the test's worst case if the outer bound fails to fire
        pollMs: 5,
        sleep: realTinySleep,
        scheduleHardTimeout: (_budgetMs) => new Promise((resolve) => setTimeout(resolve, 15)),
      }),
    (err) => err.code === 'PROMPT_INSERTION_TIMEOUT'
  );
  assert.ok(Date.now() - startedAt < 100, 'the outer 15ms hard timeout should have fired, not the 200ms internal deadline');
});

test('insertPromptReliably never includes the prompt text in its stage log, error message, or diagnostics', async () => {
  const prompt = 'super-secret-prompt-content-marker-XYZ';
  const composer = { isConnected: true, focus() {}, dispatchEvent() {}, innerText: 'stale' };
  const doc = { execCommand: () => true };
  let time = 0;
  const sleep = async (ms) => {
    time += ms;
  };
  const now = () => time;
  const stages = [];
  let caughtErr;
  try {
    await insertPromptReliably(doc, composer, prompt, {
      timeoutMs: 300,
      pollMs: 100,
      sleep,
      now,
      onStage: (s) => stages.push(s),
    });
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr);
  assert.equal(caughtErr.code, 'PROMPT_INSERTION_TIMEOUT');
  const everythingLogged = stages.join(' ') + ' ' + caughtErr.message + ' ' + JSON.stringify(caughtErr.diagnostics ?? {});
  assert.ok(!everythingLogged.includes(prompt));
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

// A deterministic fake wall clock paired with the fake `sleep` passed to
// waitForReply's `now` option: every sleep(ms) call advances it by exactly
// `ms`, so completion's real-elapsed-quiet-time gate (see domActions.js's
// waitForReply header comment, 3rd-pass explanation) can be exercised
// without an actual wall-clock wait. `script(tick, ms)` runs after the time
// advance, on every call, 1-indexed by tick number — the same shape the
// pre-existing tests already used for `sleep`.
function createFakeClock() {
  let time = 0;
  return {
    now: () => time,
    scriptedSleep(script) {
      let tick = 0;
      return async (ms) => {
        time += ms;
        tick += 1;
        script(tick, ms);
      };
    },
  };
}

test('waitForReply resolves once the stop control disappears and assistant text is present (no fixed stability wait)', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistantNodes;
      return [];
    },
    querySelector(selector) {
      return STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null;
    },
  };
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) assistantNodes = [{ innerText: 'streaming...' }];
        if (tick === 2) assistantNodes = [{ innerText: 'still streaming' }];
        if (tick === 3) {
          stopVisible = false;
          assistantNodes = [assistantNode('final reply', { completed: true })];
        }
      }),
    }
  );
  assert.equal(text, 'final reply');
});

test('waitForReply does not return on a single-frame false-finish (stop control not yet mounted) if text keeps growing', async () => {
  // Reproduces a real race observed live (2026-08-26): the stop control
  // hasn't mounted yet even though the first token already rendered, which
  // briefly looks identical to "finished". waitForReply must not return
  // the 1-character text this produces.
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll(selector) {
      return selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : [];
    },
    querySelector(selector) {
      return STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null;
    },
  };
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) {
          // Assistant node appears with one token already in it, and the
          // stop control hasn't rendered yet on this same frame.
          assistantNodes = [{ innerText: 'F' }];
          stopVisible = false;
        } else if (tick === 2) {
          // Streaming was actually still in progress — more text landed,
          // and the stop control has now mounted.
          assistantNodes = [{ innerText: 'FALCON-9-ORCHID (partial' }];
          stopVisible = true;
        } else if (tick === 3) {
          assistantNodes = [assistantNode('FALCON-9-ORCHID', { completed: true })];
          stopVisible = false;
        }
      }),
    }
  );
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
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    preExisting.length,
    {
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) assistantNodes = [...preExisting, assistantNode('new reply', { completed: true })];
        if (tick === 2) stopVisible = false;
      }),
    }
  );
  assert.equal(text, 'new reply');
});

test('waitForReply throws RESPONSE_EMPTY when no assistant message ever appears', async () => {
  const doc = { querySelectorAll: () => [], querySelector: () => null };
  await assert.rejects(
    () => waitForReply(doc, { responseTimeoutMs: 10 }, 0, { sleep: async () => {} }),
    (err) => err.code === 'RESPONSE_EMPTY'
  );
});

// --- Assistant text extraction (message-card UI chrome) ----------------
//
// Regression for a live bug (2026-08-26): the real ChatGPT DOM's assistant
// message card includes toolbar controls (Edit/Copy/Like/Dislike/Download)
// alongside the reply body, and reading the whole card's innerText picks up
// that UI text — a real reply came back as "Edit\n\nPING-731\n\nCopy"
// instead of "PING-731". Fixed by reading only the ASSISTANT_CONTENT_SELECTOR
// child node, a DOM boundary — not a string filter — so these fakes model
// the card's innerText as containing toolbar text the content node itself
// never had, proving extraction never inspects the card's own text at all.
function cardWithContent(contentText, { completed = false } = {}) {
  const contentNode = { innerText: contentText };
  return {
    // Modeled after the live bug: the whole card's innerText concatenates
    // toolbar chrome around the actual reply body.
    innerText: `Edit\n\n${contentText}\n\nCopy`,
    querySelector: (selector) => {
      if (selector === ASSISTANT_CONTENT_SELECTOR) return contentNode;
      if (completed && ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector)) return fakeElement();
      return null;
    },
  };
}

test('waitForReply extracts only the assistant content node, excluding toolbar UI chrome like the "Edit" button', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) assistantNodes = [cardWithContent('PING-731', { completed: true })];
      if (tick === 2) stopVisible = false;
    }),
  });
  assert.equal(text, 'PING-731');
});

test('waitForReply preserves a full multi-paragraph assistant reply, with newlines intact and no UI chrome mixed in', async () => {
  const body = 'Line one.\n\nLine two, still going.\n\nLine three, the end.';
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) assistantNodes = [cardWithContent(body, { completed: true })];
      if (tick === 2) stopVisible = false;
    }),
  });
  assert.equal(text, body);
});

test('waitForReply keeps assistant text that genuinely begins with the word "Edit" — proves this is a DOM boundary, not a string filter', async () => {
  // If extraction were implemented as text.replace(/^Edit/, '') or a UI-text
  // blacklist, this legitimate reply would be corrupted too. It must not be.
  const body = 'Edit the config file at line 12 to enable verbose logging.';
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) assistantNodes = [cardWithContent(body, { completed: true })];
      if (tick === 2) stopVisible = false;
    }),
  });
  assert.equal(text, body);
  assert.ok(text.startsWith('Edit'), 'legitimate body text starting with "Edit" must be preserved verbatim');
});

test('waitForReply falls back to the whole card text when no content node is found (selector drift degrades gracefully)', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1)
        assistantNodes = [
          {
            innerText: 'plain fallback text',
            querySelector: (selector) => (ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? fakeElement() : null),
          },
        ];
      if (tick === 2) stopVisible = false;
    }),
  });
  assert.equal(text, 'plain fallback text');
});

// --- Generation-completion race regressions ---------------------------
//
// History of this bug (see waitForReply's own header comment for the full
// account): a 1st pass trusted "stop invisible + text present" instantly; a
// 2nd pass added a fixed tick-count recheck, which still failed live because
// the recheck ticks were driven by whole-document mutations unrelated to the
// reply, so a burst of unrelated churn could exhaust the tick count in
// milliseconds of real time. This 3rd pass gates completion on real elapsed
// quiet time via an injectable clock (`now`), using a mutation observer
// scoped to only the assistant reply node — these tests exercise that
// directly via createFakeClock, which advances in lockstep with the fake
// `sleep`/tick calls actually made, so the elapsed-time gate is exercised
// deterministically without a real wall-clock wait.

test('waitForReply does not return early when the stop indicator briefly disappears mid-stream then reappears', async () => {
  // Stop control flickers invisible for a tick (a real DOM re-render, not
  // the end of streaming) while text stays static, then becomes visible
  // again with more text landing later.
  let assistantNodes = [{ innerText: 'partial' }];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      onStage: (s) => stages.push(s),
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) stopVisible = false; // flicker: stop control momentarily gone
        if (tick === 2) stopVisible = true; // reappears — generation was never actually done
        if (tick === 3) assistantNodes = [{ innerText: 'partial and more' }];
        if (tick === 4) stopVisible = false; // real end
        if (tick === 5) assistantNodes = [assistantNode('partial and more, final', { completed: true })];
      }),
    }
  );
  assert.equal(text, 'partial and more, final');
  assert.ok(stages.includes('generation active'));
});

// Exact regression for the live failure this whole 4th-pass fix addresses:
// stop control visible, text goes 8 -> 0 -> 26 (a React re-render pass, not
// a finished reply), stop control goes absent — must NOT be trusted as
// "confirmed ended" at 26 characters; the real reply keeps growing after a
// pause and that final text is what must be returned.
test('waitForReply treats an 8 -> 0 -> 26 text sequence as ongoing activity, never as evidence of completion, even once stop goes absent', async () => {
  let assistantNodes = [{ innerText: '12345678' }]; // 8 chars
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const finalText = 'a'.repeat(40);
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 30000 },
    0,
    {
      onStage: (s) => stages.push(s),
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) assistantNodes = [{ innerText: '' }]; // drop to 0
        if (tick === 2) assistantNodes = [{ innerText: 'a'.repeat(26) }]; // regrow to 26
        if (tick === 3) stopVisible = false; // looks done at 26 — must not be trusted
        // Several quiet ticks pass (well under CONFIRM_QUIET_MS = 2500ms)
        // before more real generation lands, proving the 26-char state was
        // never confirmed complete along the way.
        if (tick === 8) assistantNodes = [assistantNode(finalText, { completed: true })]; // generation actually continues
      }),
    }
  );
  assert.equal(text, finalText);
  assert.notEqual(text.length, 26);
  assert.ok(
    !stages.some((s) => s.startsWith('generation confirmed ended') && s.includes('textLen=26')),
    'must never have confirmed completion at the transient 26-char state'
  );
  assert.ok(stages.includes('assistant text length changed: 8 -> 0'));
  assert.ok(stages.includes('assistant text length changed: 0 -> 26'));
  // Every reset before the real final growth must have logged a candidate
  // reset (never a silent/free pass) — proves the quiet timer restarted
  // from scratch on the 8->0->26 sequence rather than merely never having
  // started one yet.
  assert.ok(stages.some((s) => s.startsWith('terminal quiet candidate reset')));
});

// Multiple independent stop-control flickers, each with real (but
// sub-threshold) quiet time in between — completion must only be trusted
// once the FINAL absent interval has held continuously for the full
// required quiet window, never merely because some earlier gap looked long
// enough in isolation.
test('waitForReply only completes after the final sustained stop-absent interval, across multiple flickers', async () => {
  let assistantNodes = [{ innerText: 'partial' }];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 30000 },
    0,
    {
      onStage: (s) => stages.push(s),
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        // Flicker 1: absent for a few ticks, then reappears.
        if (tick === 1) stopVisible = false;
        if (tick === 4) stopVisible = true; // reappears before quiet window elapses — must reset
        if (tick === 5) assistantNodes = [{ innerText: 'partial more' }];
        // Flicker 2: absent again for a few ticks, then reappears.
        if (tick === 6) stopVisible = false;
        if (tick === 9) stopVisible = true; // reappears again — must reset again
        if (tick === 10) assistantNodes = [assistantNode('partial more, still going', { completed: true })];
        // Final, real, sustained absence — this is the only one that should
        // ever be allowed to reach confirmation.
        if (tick === 11) stopVisible = false;
      }),
    }
  );
  assert.equal(text, 'partial more, still going');
  const resetCount = stages.filter((s) => s.startsWith('terminal quiet candidate reset')).length;
  assert.ok(resetCount >= 2, `expected at least 2 candidate resets from the two flickers, got ${resetCount}`);
  const confirmedIdx = stages.findIndex((s) => s.startsWith('terminal quiet candidate confirmed'));
  const lastVisibleIdx = stages.lastIndexOf('stop control became visible');
  assert.ok(confirmedIdx > lastVisibleIdx, 'completion must come strictly after the last time stop reappeared');
});

test('waitForReply does not return while only a few characters have appeared and generation is still active', async () => {
  let assistantNodes = [{ innerText: 'H' }];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick <= 5) assistantNodes = [assistantNode('H'.repeat(tick + 1), { completed: tick === 5 })]; // still growing
        if (tick === 6) stopVisible = false; // now actually done
      }),
    }
  );
  assert.equal(text, 'H'.repeat(6));
});

test('waitForReply requires a longer stable elapsed-time window before trusting completion when generation was never observed active (selector drift / no indicator)', async () => {
  // The stop control never once reports visible (selector drift, or it was
  // never found at all) — text simply appears fully formed on the very
  // first read. Must not be trusted after only the shorter active-case
  // quiet window; must hold stable for the full no-signal window (real
  // elapsed time, not a tick count) before returning.
  const assistantNodes = [{ innerText: 'a complete looking reply' }];
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: () => null, // stop control never matches any selector
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep(() => {}),
  });
  assert.equal(text, 'a complete looking reply');
  assert.ok(!stages.includes('generation active'), 'no activity signal was ever observed in this scenario');
  // The no-signal quiet window (CONFIRM_QUIET_MS_NO_SIGNAL = 1800ms) must
  // have actually elapsed on the fake clock before completion was trusted —
  // this scenario never observes the stop control, so it can only ever take
  // the no-signal branch/window, regardless of the (larger, as of the
  // 2026-08-27 fix) active-case window.
  assert.ok(clock.now() >= 1800, `expected at least 1800ms of simulated quiet time to elapse, got ${clock.now()}ms`);
  const confirmedStage = stages.find((s) => s.startsWith('generation confirmed ended'));
  assert.ok(confirmedStage?.includes('branch=no-signal-confirmed'), `expected the no-signal branch, got: ${confirmedStage}`);
});

test('waitForReply logs the full stage progression: assistant started -> generation active -> generation maybe ended -> generation confirmed ended', async () => {
  let assistantNodes = [];
  let stopVisible = false;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      onStage: (s) => stages.push(s),
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) {
          assistantNodes = [{ innerText: 'st' }];
          stopVisible = true;
        }
        if (tick === 2) {
          assistantNodes = [assistantNode('streaming reply', { completed: true })];
          stopVisible = false;
        }
      }),
    }
  );
  assert.equal(text, 'streaming reply');
  assert.equal(stages[0], 'assistant started');
  assert.ok(stages[1].startsWith('assistant response first observed'), stages[1]);
  assert.ok(stages.includes('generation active'));
  assert.ok(stages.some((s) => s.startsWith('generation maybe ended')));
  assert.ok(stages.some((s) => s.startsWith('generation confirmed ended')));
  assert.ok(stages.some((s) => s.startsWith('assistant body extracted')));
  // Order must still hold: activity observed before "maybe ended", which
  // must precede the final confirmation and extraction.
  const activeIdx = stages.indexOf('generation active');
  const maybeEndedIdx = stages.findIndex((s) => s.startsWith('generation maybe ended'));
  const confirmedIdx = stages.findIndex((s) => s.startsWith('generation confirmed ended'));
  const extractedIdx = stages.findIndex((s) => s.startsWith('assistant body extracted'));
  assert.ok(activeIdx < maybeEndedIdx && maybeEndedIdx < confirmedIdx && confirmedIdx < extractedIdx);
});

test('waitForReply logs completion-provenance diagnostics: initial text length, which activity signal fired, and why completion was trusted', async () => {
  let assistantNodes = [];
  let stopVisible = false;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(
    doc,
    { responseTimeoutMs: 10000 },
    0,
    {
      onStage: (s) => stages.push(s),
      now: clock.now,
      sleep: clock.scriptedSleep((tick) => {
        if (tick === 1) {
          assistantNodes = [{ innerText: 'st' }];
          stopVisible = true;
        }
        if (tick === 2) {
          assistantNodes = [assistantNode('streaming reply', { completed: true })];
          stopVisible = false;
        }
      }),
    }
  );
  assert.equal(text, 'streaming reply');

  const firstObserved = stages.find((s) => s.startsWith('assistant response first observed'));
  assert.ok(firstObserved?.includes('initialTextLen='), firstObserved);

  assert.ok(stages.includes('stop control became visible'));
  assert.ok(stages.includes('stop control became absent'));

  const signalStage = stages.find((s) => s.startsWith('generation-active signal observed'));
  assert.equal(signalStage, 'generation-active signal observed (source=stop-control)');

  const lengthChangeStage = stages.find((s) => s.startsWith('assistant text length changed'));
  assert.equal(lengthChangeStage, 'assistant text length changed: 2 -> 15');

  const completionPathStage = stages.find((s) => s.startsWith('completion path chosen'));
  assert.ok(completionPathStage?.includes('completion path chosen: generation-signal-ended'), completionPathStage);
  assert.ok(completionPathStage.includes('finalTextLen=15'), completionPathStage);
  assert.ok(completionPathStage.includes('msSinceLastChange='), completionPathStage);
  assert.ok(completionPathStage.includes('totalMs='), completionPathStage);
});

test('waitForReply chooses the no-generation-signal-fallback completion path when the stop control was never observed', async () => {
  const assistantNodes = [{ innerText: 'a complete looking reply' }];
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: () => null,
  };
  const stages = [];
  const clock = createFakeClock();
  await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep(() => {}),
  });
  const completionPathStage = stages.find((s) => s.startsWith('completion path chosen'));
  assert.ok(completionPathStage?.includes('completion path chosen: no-generation-signal-fallback'), completionPathStage);
  assert.ok(!stages.some((s) => s.startsWith('generation-active signal observed')));
});

test('waitForReply logs a timeout-specific completion-path diagnostic (never fabricating success) when generation never confirms done', async () => {
  const assistantNodes = [{ innerText: 'still going' }];
  let stopVisible = true; // stop control never goes away — generation truly never finishes
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  await assert.rejects(
    () => waitForReply(doc, { responseTimeoutMs: 20 }, 0, { sleep: async () => {}, onStage: (s) => stages.push(s) }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
  const timeoutStage = stages.find((s) => s.includes('timeout-no-completion-signal'));
  assert.ok(timeoutStage, JSON.stringify(stages));
  assert.ok(timeoutStage.includes('everActive=true'), timeoutStage);
});

// Exact regression requested live: a first paragraph appears and generation
// is confirmed still active (stop visible), then a handful of DOM mutations
// occur on OTHER parts of the page (not the assistant message node itself)
// while the assistant text is briefly unchanged, then — after a real pause —
// a second paragraph actually lands. The unrelated mutations must not be
// usable as evidence the reply is stable/done: this exercises exactly the
// failure mode reported live (elapsed-time gate + node-scoped observation).
test('unrelated document mutations occurring while assistant text is briefly unchanged do not cause an early return before the second paragraph lands', async () => {
  // This is the precise mechanism flagged live: the OLD algorithm's
  // confirmation was a TICK COUNT, and its ticks came from a whole-document
  // MutationObserver — so a burst of mutations having nothing to do with the
  // reply (sidebar/timestamps/etc) could resolve every confirmation tick in
  // a few milliseconds of real time, long before the real pause between
  // paragraphs actually elapsed. This reproduces that burst directly (many
  // wake events firing with the fake clock deliberately NOT advanced, i.e.
  // representing them resolving near-instantly in real wall-clock terms) and
  // proves waitForReply is still pending afterward — completion is gated on
  // real elapsed time via `now()`, not on how many wakes occurred — then
  // shows the second paragraph landing is what actually lets it finish.
  const previousMutationObserver = globalThis.MutationObserver;
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {
      observerCallback = null;
    }
  }
  globalThis.MutationObserver = FakeMutationObserver;

  try {
    let assistantNodes = [{ innerText: '第一段' }];
    let stopVisible = true;
    let fakeTime = 0;
    const doc = {
      body: {},
      querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
      querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
    };

    const resultPromise = waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
      sleep: () => new Promise(() => {}), // never resolves on its own — only mutation wakes and `now` matter
      now: () => fakeTime,
    });
    let resolved = false;
    resultPromise.then(() => {
      resolved = true;
    });

    // 第一段 already rendered when the assistant node first appeared; now the
    // stop control goes away (looks like it might be done).
    await Promise.resolve();
    stopVisible = false;
    observerCallback?.();

    // A burst of unrelated wake events: assistant text does NOT change, and
    // the clock does NOT advance (modeling them resolving in ~0 real ms) —
    // this must not be usable as evidence of a stable/finished reply.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      observerCallback?.();
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resolved, false, 'must still be pending — the burst of unrelated wakes must not count as proof the reply is stable/done');

    // The second paragraph actually lands (a little simulated time has
    // passed, but nowhere near the quiet window yet).
    fakeTime += 500;
    assistantNodes = [assistantNode('第一段第二段', { completed: true })];
    observerCallback?.();
    // Let waitForReply register the new text and reset its quiet-time clock
    // BEFORE advancing fakeTime any further, so the clock advance below
    // measures real quiet time after 第二段 landed, not before.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resolved, false, 'must not resolve immediately when 第二段 lands — it still needs to hold quiet');

    // More (simulated) real time passes with the stop control still away and
    // no further text change — now completion is legitimately confirmed.
    // (2600ms comfortably clears CONFIRM_QUIET_MS = 2500ms.)
    fakeTime += 2600;
    observerCallback?.();
    await Promise.resolve();
    await Promise.resolve();

    const text = await resultPromise;
    assert.equal(text, '第一段第二段');
    assert.notEqual(text, '第一段');
  } finally {
    globalThis.MutationObserver = previousMutationObserver;
  }
});

// --- Background-tab MutationObserver path -----------------------------
//
// The tests above exercise createMutationWaiter/createNodeMutationWaiter's
// plain-sleep fallback (no doc.body/no MutationObserver global — the shape
// of the fake docs used throughout this file). This exercises the real
// MutationObserver branch directly (both the whole-document waiter used
// before the assistant node exists, and the node-scoped waiter used for
// completion confirmation after), simulating a backgrounded tab where
// setTimeout/setInterval are throttled but MutationObserver callbacks still
// fire immediately off real DOM mutations. The completion gate's elapsed
// time is driven by an explicit fake clock (not tied to sleep, which never
// resolves here) since the whole point is proving mutation wakeups — never
// the timer — drive the loop.
test('waitForReply resolves via MutationObserver-driven wakeups, not just the timer, in a simulated backgrounded tab', async () => {
  const previousMutationObserver = globalThis.MutationObserver;
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {
      observerCallback = null;
    }
  }
  globalThis.MutationObserver = FakeMutationObserver;

  try {
    let assistantNodes = [];
    let stopVisible = false;
    let fakeTime = 0;
    const doc = {
      body: {}, // presence of doc.body is what makes createMutationWaiter use the observer branch
      querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
      querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
    };

    // A "throttled background tab" sleep: deliberately never resolves on its
    // own within the test's window — only the observer's own mutation wakeup
    // should let the loop proceed. `now` is driven explicitly by the test,
    // independent of sleep, standing in for real elapsed wall-clock time.
    const throttledSleep = () => new Promise(() => {});

    const resultPromise = waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
      sleep: throttledSleep,
      now: () => fakeTime,
    });

    // Assistant message node appears — wakes the whole-document waiter used
    // before the node exists.
    await Promise.resolve();
    assistantNodes = [{ innerText: 'g' }];
    stopVisible = true;
    observerCallback?.();

    // More text lands — wakes the node-scoped waiter used for completion.
    await Promise.resolve();
    assistantNodes = [assistantNode('generated reply text', { completed: true })];
    observerCallback?.();

    // Stop control goes away — generation looks done, but the elapsed-time
    // quiet gate hasn't been satisfied yet.
    await Promise.resolve();
    stopVisible = false;
    observerCallback?.();

    // Advance the fake clock past the active-case quiet window, then a
    // final mutation-driven wakeup (never the timer) lets waitForReply
    // re-evaluate and confirm completion. (2600ms comfortably clears
    // CONFIRM_QUIET_MS = 2500ms.)
    fakeTime += 2600;
    await Promise.resolve();
    observerCallback?.();

    const text = await resultPromise;
    assert.equal(text, 'generated reply text');
  } finally {
    globalThis.MutationObserver = previousMutationObserver;
  }
});

// --- Completed-message DOM signal (2026-08-27, 5th pass) ---------------
//
// Live evidence proved quiet-elapsed-time alone (stop absent + text
// unchanged) is not sufficient: a genuine mid-generation pause was observed
// to exceed CONFIRM_QUIET_MS on its own. These tests exercise the added
// gate — completion (once generation has been observed active) now also
// requires the current assistant message's own completed-message footer
// signal (ASSISTANT_COMPLETED_ACTION_SELECTORS), scoped to whichever node is
// CURRENT.

test('a 3+ second text pause with stop absent but no completed-message signal must not complete the reply', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 5000 }, 0, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [assistantNode('a stable-looking reply', { completed: false })];
            stopVisible = true;
          }
          // Stop goes away and nothing about the node ever changes again —
          // no footer ever mounts in this scenario.
          if (tick === 2) stopVisible = false;
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
  assert.ok(
    stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')),
    JSON.stringify(stages)
  );
  assert.ok(
    !stages.some((s) => s.startsWith('generation confirmed ended')),
    'must never have confirmed completion without the completed-message footer signal'
  );
});

// --- Metadata-only completed-signal diagnostics on RESPONSE_TIMEOUT
// (2026-08-27, live-timeout follow-up) -----------------------------------
//
// A live run hit RESPONSE_TIMEOUT with no way to tell whether
// ASSISTANT_COMPLETED_ACTION_SELECTORS is simply wrong for the real
// ChatGPT DOM. These exercise the two probes waitForReply logs right
// before throwing RESPONSE_TIMEOUT: per-candidate match metadata, and a
// structural dump of likely interactive footer descendants — both scoped
// to the CURRENT assistant message and never carrying reply/prompt text.

function attrElement(tag, attrs = {}, { connected = true } = {}) {
  return {
    tagName: tag,
    isConnected: connected,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
  };
}

test('waitForReply logs metadata-only completed-signal candidate and footer probes on RESPONSE_TIMEOUT, never leaking reply content', async () => {
  const copyBtn = attrElement('BUTTON', { 'aria-label': 'Copy', 'data-testid': 'copy-turn-action-button' });
  const goodBtn = attrElement('BUTTON', { 'aria-label': 'Good response' });
  const SECRET_TEXT = 'the actual reply content — must never appear in any probe log';
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const currentNode = {
    innerText: SECRET_TEXT,
    querySelectorAll: (selector) => {
      if (selector === '[data-testid="copy-turn-action-button"]') return [copyBtn];
      if (selector === 'button[aria-label="Good response"]') return [goodBtn];
      if (selector === 'button, [role="button"], [data-testid], [aria-label], [title]') return [copyBtn, goodBtn];
      return [];
    },
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 5000 }, 0, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [currentNode];
            stopVisible = true;
          }
          if (tick === 2) stopVisible = false; // never gets its footer — RESPONSE_TIMEOUT
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );

  const candidateProbe = stages.find((s) => s.startsWith('completed-message candidate probe'));
  const footerProbe = stages.find((s) => s.startsWith('completed-message footer descendant probe'));
  assert.ok(candidateProbe, JSON.stringify(stages));
  assert.ok(footerProbe, JSON.stringify(stages));

  // No stage line — not just these two — ever carries the reply's own text.
  assert.ok(!stages.some((s) => s.includes(SECRET_TEXT)), JSON.stringify(stages));

  const parsedCandidates = JSON.parse(candidateProbe.slice(candidateProbe.indexOf(': ') + 2));
  const copyCandidate = parsedCandidates.find((c) => c.selector === '[data-testid="copy-turn-action-button"]');
  assert.equal(copyCandidate.matchedCount, 1);
  assert.equal(copyCandidate.connected, true);
  assert.equal(copyCandidate.ariaLabel, 'Copy');
  assert.equal(copyCandidate.dataTestid, 'copy-turn-action-button');

  const missingCandidate = parsedCandidates.find((c) => c.selector === 'button[aria-label="Copy"]');
  assert.equal(missingCandidate.matchedCount, 0);
  assert.equal(missingCandidate.connected, false);

  const parsedFooter = JSON.parse(footerProbe.slice(footerProbe.indexOf(': ') + 2));
  assert.equal(parsedFooter.length, 2);
  assert.ok(parsedFooter.every((el) => el.tag === 'button'));
  assert.ok(parsedFooter.every((el) => !('innerText' in el) && !('textContent' in el)));
});

test('the timeout probes only inspect the CURRENT assistant message, never a replaced/old node', async () => {
  const oldCopyBtn = attrElement('BUTTON', { 'aria-label': 'Copy', 'data-testid': 'copy-turn-action-button' });
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  // Old node already carries a matching footer — must never leak into a
  // probe of whichever node ends up CURRENT when RESPONSE_TIMEOUT fires.
  const oldNode = {
    innerText: 'old finished reply',
    querySelectorAll: (selector) => (selector === '[data-testid="copy-turn-action-button"]' ? [oldCopyBtn] : []),
  };
  const newNode = {
    innerText: 'new reply that never finishes',
    querySelectorAll: () => [],
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 5000 }, 0, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [oldNode];
            stopVisible = true;
          }
          if (tick === 2) stopVisible = false;
          if (tick === 3) assistantNodes = [newNode]; // React remount before the quiet threshold hits
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );

  const candidateProbe = stages.find((s) => s.startsWith('completed-message candidate probe'));
  assert.ok(candidateProbe, JSON.stringify(stages));
  const parsedCandidates = JSON.parse(candidateProbe.slice(candidateProbe.indexOf(': ') + 2));
  const copyCandidate = parsedCandidates.find((c) => c.selector === '[data-testid="copy-turn-action-button"]');
  assert.equal(copyCandidate.matchedCount, 0, "must reflect the NEW node, never the old node's own footer match");
});

test('waitForReply keeps tracking (does not complete) when text resumes after being blocked on a missing completed-message signal', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        assistantNodes = [assistantNode('first draft', { completed: false })];
        stopVisible = true;
      }
      // Looks done (stop gone, text quiet) but no footer yet — the gate
      // must hold through several quiet ticks (well past CONFIRM_QUIET_MS)
      // before the real continuation lands.
      if (tick === 2) stopVisible = false;
      if (tick === 12) {
        assistantNodes = [assistantNode('first draft, continued', { completed: true })];
      }
    }),
  });
  assert.equal(text, 'first draft, continued');
  assert.ok(stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')));
  assert.ok(stages.some((s) => s.startsWith('terminal quiet candidate reset')));
});

test('waitForReply completes once the completed-message signal appears while text has already been stable', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  // A single, stable node identity throughout — only its own footer state
  // changes (a live DOM mutation adding the toolbar, not a node swap).
  const nodeState = { completed: false };
  const node = {
    innerText: 'a reply that renders fully formed',
    querySelector: (selector) => (nodeState.completed && ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        assistantNodes = [node];
        stopVisible = true;
      }
      if (tick === 2) stopVisible = false;
      if (tick === 12) nodeState.completed = true; // footer mounts; text never changed
    }),
  });
  assert.equal(text, 'a reply that renders fully formed');
  const awaitingIdx = stages.findIndex((s) => s.startsWith('quiet threshold reached but completed-message signal absent'));
  const presentIdx = stages.findIndex((s) => s.startsWith('completed-message signal present'));
  const confirmedIdx = stages.findIndex((s) => s.startsWith('terminal quiet candidate confirmed'));
  assert.ok(awaitingIdx !== -1 && presentIdx !== -1 && confirmedIdx !== -1, JSON.stringify(stages));
  assert.ok(awaitingIdx < presentIdx && presentIdx < confirmedIdx);
});

test('waitForReply does not trust a completed-message signal seen on an old, now-replaced assistant node', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const newNodeState = { completed: false };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        // Old node: its own footer already present — must never count
        // toward whatever node replaces it.
        assistantNodes = [assistantNode('old completed reply', { completed: true })];
        stopVisible = true;
      }
      if (tick === 2) stopVisible = false;
      if (tick === 4) {
        // A fresh assistant node — a real React remount, e.g. a new turn —
        // its own footer not mounted yet.
        assistantNodes = [
          {
            innerText: 'brand new reply',
            querySelector: (selector) =>
              newNodeState.completed && ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? fakeElement() : null,
          },
        ];
      }
      if (tick === 20) newNodeState.completed = true; // the NEW node's own footer finally mounts
    }),
  });
  assert.equal(text, 'brand new reply');
  assert.ok(stages.includes('assistant body node replaced'));
  assert.ok(
    stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')),
    'must have been gated on the new node lacking its own signal, not completed instantly off the old node\'s'
  );
});

test('a stop-control flicker remains non-terminal even when a completed-message signal is already present', async () => {
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        assistantNodes = [assistantNode('partial', { completed: true })];
        stopVisible = true;
      }
      if (tick === 2) stopVisible = false; // flicker: momentarily gone
      if (tick === 3) stopVisible = true; // reappears — generation still going
      if (tick === 4) assistantNodes = [assistantNode('partial and more', { completed: true })];
      if (tick === 5) stopVisible = false; // real end this time
    }),
  });
  assert.equal(text, 'partial and more');
  assert.ok(stages.some((s) => s.startsWith('terminal quiet candidate reset')));
});

// --- Completed-message signal: turn-root anchoring (2026-08-27) ----------
//
// Live evidence: a real completed ChatGPT reply visibly showed its
// Copy/feedback/retry footer, but a lookup scoped to only the assistant
// body node matched nothing — the footer is a SIBLING under a larger
// per-turn container (an `<article data-testid="conversation-turn-N">`),
// not a descendant of the body node itself. These fakes model that real
// shape: a `turnRoot` node (matches ASSISTANT_TURN_ROOT_SELECTORS' shape via
// getAttribute) whose OWN querySelector exposes the completed-action footer,
// with the assistant body node reachable from it only via `parentElement`.

function fakeTurnRoot({ turnId = 'conversation-turn-1', completed = false } = {}) {
  const footerButton = fakeElement();
  return {
    getAttribute: (name) => (name === 'data-testid' ? turnId : null),
    querySelector: (selector) => (completed && ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? footerButton : null),
    parentElement: null,
  };
}

function fakeAssistantBody(text, turnRoot) {
  return {
    innerText: text,
    getAttribute: () => null,
    querySelector: () => null,
    parentElement: turnRoot,
  };
}

test('(a) completed-message footer as a sibling under the same turn root -> completes', async () => {
  const turnRoot = fakeTurnRoot({ completed: true });
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 10000 }, 0, {
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) assistantNodes = [fakeAssistantBody('streaming...', turnRoot)];
      if (tick === 2) {
        stopVisible = false;
        assistantNodes = [fakeAssistantBody('final reply', turnRoot)];
      }
    }),
  });
  assert.equal(text, 'final reply');
});

test('(b) a footer that exists only on an OLDER turn must never satisfy the current turn', async () => {
  const oldTurnRoot = fakeTurnRoot({ turnId: 'conversation-turn-1', completed: true });
  const currentTurnRoot = fakeTurnRoot({ turnId: 'conversation-turn-2', completed: false });
  let assistantNodes = [fakeAssistantBody('old reply', oldTurnRoot)];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 30000 }, 1, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [fakeAssistantBody('old reply', oldTurnRoot), fakeAssistantBody('new reply', currentTurnRoot)];
            stopVisible = true;
          }
          if (tick === 2) stopVisible = false;
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
  assert.ok(
    stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')),
    'the older turn\'s own completed footer must never be read as the current turn\'s signal'
  );
});

test('(c) current turn has no footer yet -> waits rather than completing', async () => {
  const turnRoot = fakeTurnRoot({ completed: false });
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [fakeAssistantBody('a stable-looking reply', turnRoot)];
            stopVisible = true;
          }
          // Stop control observed then goes away — generation-active WAS
          // seen, so the footer gate below actually applies (the no-signal
          // fallback path relies on quiet time alone and would complete
          // without ever checking the footer).
          if (tick === 2) stopVisible = false;
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
  assert.ok(stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')));
});

test('(d) current turn footer appears later -> completes once it does', async () => {
  const turnRoot = fakeTurnRoot({ completed: false });
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        assistantNodes = [fakeAssistantBody('a stable reply', turnRoot)];
        stopVisible = true;
      }
      if (tick === 2) stopVisible = false;
      // Footer mounts onto the SAME turn root a while after text/stop went
      // quiet — no new node, no text change, just the footer showing up.
      if (tick === 12) turnRoot.querySelector = (selector) => (ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? fakeElement() : null);
    }),
  });
  assert.equal(text, 'a stable reply');
  const awaitingIdx = stages.findIndex((s) => s.startsWith('quiet threshold reached but completed-message signal absent'));
  const presentIdx = stages.findIndex((s) => s.startsWith('completed-message signal present'));
  assert.ok(awaitingIdx !== -1 && presentIdx !== -1 && awaitingIdx < presentIdx);
});

test('(e) assistant node replacement rebinds to the new node\'s own turn root', async () => {
  const oldTurnRoot = fakeTurnRoot({ turnId: 'conversation-turn-1', completed: true });
  const newTurnRoot = fakeTurnRoot({ turnId: 'conversation-turn-2', completed: false });
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null),
  };
  const stages = [];
  const clock = createFakeClock();
  const text = await waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
    onStage: (s) => stages.push(s),
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) {
        // Old node first: its own footer already present — must never
        // count toward whatever node replaces it.
        assistantNodes = [fakeAssistantBody('old completed reply', oldTurnRoot)];
        stopVisible = true;
      }
      if (tick === 2) stopVisible = false;
      if (tick === 4) {
        // A real React remount — a genuinely new turn, own footer not
        // mounted yet.
        assistantNodes = [fakeAssistantBody('new reply', newTurnRoot)];
      }
      if (tick === 20) {
        newTurnRoot.querySelector = (selector) => (ASSISTANT_COMPLETED_ACTION_SELECTORS.includes(selector) ? fakeElement() : null);
      }
    }),
  });
  assert.equal(text, 'new reply');
  assert.ok(stages.some((s) => s.startsWith('assistant body node replaced')));
  assert.ok(
    stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')),
    'must not have inherited the OLD node\'s already-completed signal'
  );
});

test('(f) a page-wide unrelated Copy button (outside the current turn root) cannot satisfy the gate', async () => {
  const currentTurnRoot = fakeTurnRoot({ turnId: 'conversation-turn-2', completed: false });
  // An unrelated control mounted elsewhere in the page (e.g. near <body>,
  // outside this turn's own ancestor chain entirely) that happens to match
  // one of ASSISTANT_COMPLETED_ACTION_SELECTORS.
  const pageWideCopyButton = fakeElement();
  let assistantNodes = [];
  let stopVisible = true;
  const doc = {
    querySelectorAll: (selector) => (selector === ASSISTANT_MESSAGE_SELECTOR ? assistantNodes : []),
    querySelector: (selector) => {
      if (STOP_BUTTON_SELECTORS.includes(selector) && stopVisible) return fakeElement();
      // Page-wide lookup (not scoped to the turn root) would find this —
      // waitForReply must never issue a page-wide query for this signal.
      if (selector === 'button[aria-label="Copy"]') return pageWideCopyButton;
      return null;
    },
  };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      waitForReply(doc, { responseTimeoutMs: 30000 }, 0, {
        onStage: (s) => stages.push(s),
        now: clock.now,
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            assistantNodes = [fakeAssistantBody('a reply', currentTurnRoot)];
            stopVisible = true;
          }
          if (tick === 2) stopVisible = false;
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
  assert.ok(stages.some((s) => s.startsWith('quiet threshold reached but completed-message signal absent')));
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

// --- observeReplyAndIdentity (reply/identity decoupling, 2026-08-27) ----
//
// Fake doc serving BOTH observations at once: mutable assistant-node list +
// stop-control visibility (for waitForReply) and mutable location.href +
// sidebar anchors (for waitForConversationIdentity). MutationObserver is
// undefined under Node, so both waits fall back to the injected fake
// `sleep`, whose scripted callback advances the shared fake clock and
// mutates page state per tick.
function createReplyIdentityDoc({ href = 'https://chatgpt.com/', anchors = [] } = {}) {
  let assistantNodes = [];
  let stopVisible = false;
  const doc = {
    location: { href },
    body: {},
    querySelector(selector) {
      return STOP_BUTTON_SELECTORS.includes(selector) && stopVisible ? fakeElement() : null;
    },
    querySelectorAll(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) return assistantNodes;
      if (selector === 'a[href^="/c/"]') {
        return anchors
          .filter((a) => a.href.startsWith('/c/'))
          .map((a) => ({
            getAttribute: (n) => (n === 'href' ? a.href : n === 'aria-current' ? (a.ariaCurrent ?? null) : null),
          }));
      }
      return [];
    },
    setAssistant(nodes) {
      assistantNodes = nodes;
    },
    setStop(v) {
      stopVisible = v;
    },
    setHref(v) {
      doc.location.href = v;
    },
    setAnchors(a) {
      anchors = a;
    },
  };
  return doc;
}

test('observeReplyAndIdentity: identity already present -> captured with no post-reply identity wait', async () => {
  const doc = createReplyIdentityDoc({ href: 'https://chatgpt.com/c/early-3' });
  const clock = createFakeClock();
  const stages = [];
  const result = await observeReplyAndIdentity(doc, {
    baselineCount: 0,
    baselineId: null,
    responseTimeoutMs: 60000,
    now: clock.now,
    onStage: (s) => stages.push(s),
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.setAssistant([assistantNode('done', { completed: true })]);
    }),
  });
  assert.equal(result.text, 'done');
  assert.equal(result.conversationId, 'early-3');
  assert.ok(stages.includes('assistant response completed'));
  assert.ok(stages.includes('conversation identity observed (early-3)'));
  assert.ok(!stages.includes('waiting for identity after reply completion'), 'must not wait for an identity it already has');
});

test('observeReplyAndIdentity: reply completes first, identity appears later within the grace budget -> success', async () => {
  const doc = createReplyIdentityDoc();
  const clock = createFakeClock();
  const stages = [];
  let replyDone = false;
  const result = await observeReplyAndIdentity(doc, {
    baselineCount: 0,
    baselineId: null,
    responseTimeoutMs: 60000,
    identityGraceMs: 60000,
    now: clock.now,
    onStage: (s) => {
      stages.push(s);
      if (s === 'waiting for identity after reply completion') replyDone = true;
    },
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.setAssistant([assistantNode('the answer', { completed: true })]);
      if (replyDone) doc.setHref('https://chatgpt.com/c/late-id-7');
    }),
  });
  assert.equal(result.text, 'the answer');
  assert.equal(result.conversationId, 'late-id-7');
  assert.ok(
    stages.indexOf('assistant response completed') < stages.indexOf('waiting for identity after reply completion'),
    'reply completion must be observed before the identity wait begins'
  );
  assert.ok(stages.includes('conversation identity observed (late-id-7)'));
});

test('observeReplyAndIdentity: a slow identity never blocks reply observation (reply text is fully parsed before identity work)', async () => {
  const doc = createReplyIdentityDoc();
  const clock = createFakeClock();
  let sawReplyStagesBeforeAnyIdentityStage = true;
  let identityStageSeen = false;
  let replyDone = false;
  const result = await observeReplyAndIdentity(doc, {
    baselineCount: 0,
    baselineId: null,
    responseTimeoutMs: 60000,
    identityGraceMs: 60000,
    now: clock.now,
    onStage: (s) => {
      if (/identity/.test(s) || /conversation identity/.test(s)) identityStageSeen = true;
      if (s === 'assistant response completed' && identityStageSeen) sawReplyStagesBeforeAnyIdentityStage = false;
      if (s === 'waiting for identity after reply completion') replyDone = true;
    },
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.setAssistant([assistantNode('parsed body', { completed: true })]);
      if (replyDone) doc.setHref('https://chatgpt.com/c/slow-id-1');
    }),
  });
  assert.equal(result.text, 'parsed body');
  assert.ok(sawReplyStagesBeforeAnyIdentityStage, 'reply must be observed/completed before any identity acquisition work');
});

test('observeReplyAndIdentity: identity never appears -> fails closed (CONVERSATION_IDENTITY_NOT_FOUND), reply discarded', async () => {
  const doc = createReplyIdentityDoc();
  const clock = createFakeClock();
  const stages = [];
  await assert.rejects(
    () =>
      observeReplyAndIdentity(doc, {
        baselineCount: 0,
        baselineId: null,
        responseTimeoutMs: 60000,
        identityGraceMs: 5000,
        now: clock.now,
        onStage: (s) => stages.push(s),
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) doc.setAssistant([assistantNode('an answer nobody gets', { completed: true })]);
        }),
      }),
    (err) => err.code === 'CONVERSATION_IDENTITY_NOT_FOUND'
  );
  assert.ok(stages.includes('assistant response completed'), 'the reply must still have been observed before failing closed');
  assert.ok(stages.includes('waiting for identity after reply completion'));
});

test('observeReplyAndIdentity: assistant never completes but identity exists -> RESPONSE_TIMEOUT (never a successful return)', async () => {
  const doc = createReplyIdentityDoc({ href: 'https://chatgpt.com/c/valid-id-2' });
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      observeReplyAndIdentity(doc, {
        baselineCount: 0,
        baselineId: null,
        responseTimeoutMs: 4000,
        now: clock.now,
        onStage: () => {},
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) {
            doc.setStop(true);
            doc.setAssistant([{ innerText: 'still going...' }]);
          }
        }),
      }),
    (err) => err.code === 'RESPONSE_TIMEOUT'
  );
});

test('observeReplyAndIdentity: a resolved id that does not match expectedConversationId is rejected (SUPERVISOR_IDENTITY_MISMATCH)', async () => {
  const doc = createReplyIdentityDoc({ href: 'https://chatgpt.com/c/actually-here-9' });
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      observeReplyAndIdentity(doc, {
        baselineCount: 0,
        baselineId: null,
        responseTimeoutMs: 60000,
        expectedConversationId: 'expected-elsewhere-1',
        now: clock.now,
        onStage: () => {},
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) doc.setAssistant([assistantNode('leaked?', { completed: true })]);
        }),
      }),
    (err) => err.code === 'SUPERVISOR_IDENTITY_MISMATCH' && err.message.includes('expected-elsewhere-1') && err.message.includes('actually-here-9')
  );
});

test('observeReplyAndIdentity: another tab / non-active sidebar anchor is never accepted as this tab\'s identity', async () => {
  // The only /c/<id> anchor present belongs to a different conversation and
  // is NOT aria-current="page" (i.e. not THIS tab's active conversation).
  // It must never be borrowed as identity — fail closed instead.
  const doc = createReplyIdentityDoc({
    href: 'https://chatgpt.com/',
    anchors: [{ href: '/c/some-other-tab-42', ariaCurrent: null }],
  });
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      observeReplyAndIdentity(doc, {
        baselineCount: 0,
        baselineId: null,
        responseTimeoutMs: 60000,
        identityGraceMs: 5000,
        now: clock.now,
        onStage: () => {},
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) doc.setAssistant([assistantNode('nope', { completed: true })]);
        }),
      }),
    (err) => err.code === 'CONVERSATION_IDENTITY_NOT_FOUND'
  );
});

test('observeReplyAndIdentity: a malformed /c/<path> is never accepted as identity', async () => {
  const doc = createReplyIdentityDoc({ href: 'https://chatgpt.com/c/WEB' });
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      observeReplyAndIdentity(doc, {
        baselineCount: 0,
        baselineId: null,
        responseTimeoutMs: 60000,
        identityGraceMs: 5000,
        now: clock.now,
        onStage: () => {},
        sleep: clock.scriptedSleep((tick) => {
          if (tick === 1) doc.setAssistant([assistantNode('malformed', { completed: true })]);
        }),
      }),
    (err) => err.code === 'CONVERSATION_IDENTITY_NOT_FOUND'
  );
});

test('observeReplyAndIdentity: normal Supervisor continuation (baselineId null, URL already holds the id) succeeds with no post-reply identity wait', async () => {
  const doc = createReplyIdentityDoc({ href: 'https://chatgpt.com/c/continuing-2' });
  const clock = createFakeClock();
  const stages = [];
  const result = await observeReplyAndIdentity(doc, {
    baselineCount: 0,
    baselineId: null,
    responseTimeoutMs: 60000,
    expectedConversationId: 'continuing-2',
    now: clock.now,
    onStage: (s) => stages.push(s),
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.setAssistant([assistantNode('731', { completed: true })]);
    }),
  });
  assert.equal(result.text, '731');
  assert.equal(result.conversationId, 'continuing-2');
  assert.ok(!stages.includes('waiting for identity after reply completion'));
  assert.ok(stages.includes('returning response'));
});

test('observeReplyAndIdentity: identityRequired:false returns the reply with a null id + diagnostics instead of failing', async () => {
  const doc = createReplyIdentityDoc();
  const clock = createFakeClock();
  const result = await observeReplyAndIdentity(doc, {
    baselineCount: 0,
    baselineId: null,
    responseTimeoutMs: 60000,
    identityGraceMs: 5000,
    identityRequired: false,
    now: clock.now,
    onStage: () => {},
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.setAssistant([assistantNode('one-shot reply', { completed: true })]);
    }),
  });
  assert.equal(result.text, 'one-shot reply');
  assert.equal(result.conversationId, null);
  assert.ok(result.identityDiagnostics && typeof result.identityDiagnostics === 'object');
});

// --- verifyAttachedConversationId (SupervisorSession.attach primitive) --

test('verifyAttachedConversationId resolves with the exact id once the URL holds it stable', async () => {
  const doc = { location: { href: 'https://chatgpt.com/c/exact-1' } };
  const clock = createFakeClock();
  const id = await verifyAttachedConversationId(doc, 'exact-1', {
    timeoutMs: 10000,
    now: clock.now,
    sleep: clock.scriptedSleep(() => {}),
  });
  assert.equal(id, 'exact-1');
  assert.ok(clock.now() >= 1200, `expected at least 1200ms of simulated quiet time to elapse, got ${clock.now()}ms`);
});

test('verifyAttachedConversationId throws SUPERVISOR_ATTACH_MISMATCH when the tab settles on a DIFFERENT conversation', async () => {
  // Models a client-side redirect: the URL briefly looks right, then the
  // router bounces it to a different conversation than requested.
  const doc = { location: { href: 'https://chatgpt.com/c/exact-1' } };
  const clock = createFakeClock();
  const promise = verifyAttachedConversationId(doc, 'exact-1', {
    timeoutMs: 10000,
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.location.href = 'https://chatgpt.com/c/some-other-conversation';
    }),
  });
  await assert.rejects(() => promise, (err) => err.code === 'SUPERVISOR_ATTACH_MISMATCH');
});

test('verifyAttachedConversationId throws SUPERVISOR_ATTACH_MISMATCH when no conversation ever loads (redirected to blank/login)', async () => {
  const doc = { location: { href: 'https://chatgpt.com/' } };
  const clock = createFakeClock();
  await assert.rejects(
    () =>
      verifyAttachedConversationId(doc, 'exact-1', {
        timeoutMs: 2000,
        now: clock.now,
        sleep: clock.scriptedSleep(() => {}),
      }),
    (err) => err.code === 'SUPERVISOR_ATTACH_MISMATCH' && /No conversation is loaded/.test(err.message)
  );
});

test('verifyAttachedConversationId throws SUPERVISOR_ATTACH_MISMATCH when a brief correct URL is redirected to the ChatGPT home page', async () => {
  // Exact live failure mode reported 2026-08-26: the freshly attached tab
  // shows /c/<id> for a moment, then ChatGPT's own router bounces it back to
  // the bare chatgpt.com/ home page (not another conversation, and not
  // still the requested one) before the quiet window elapses.
  const doc = { location: { href: 'https://chatgpt.com/c/exact-1' } };
  const clock = createFakeClock();
  const promise = verifyAttachedConversationId(doc, 'exact-1', {
    timeoutMs: 10000,
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.location.href = 'https://chatgpt.com/';
    }),
  });
  await assert.rejects(() => promise, (err) => err.code === 'SUPERVISOR_ATTACH_MISMATCH');
});

test('verifyAttachedConversationId reports the exact diagnostic stages requested for the live attach-mismatch investigation', async () => {
  const doc = { location: { href: 'https://chatgpt.com/' } };
  const stages = [];
  const clock = createFakeClock();
  await assert.rejects(() =>
    verifyAttachedConversationId(doc, 'exact-1', {
      timeoutMs: 2000,
      now: clock.now,
      sleep: clock.scriptedSleep(() => {}),
      onStage: (s) => stages.push(s),
    })
  );
  assert.ok(stages.includes('attach expected conversationId=exact-1'));
  assert.ok(stages.includes('attach observed url=https://chatgpt.com/'));
  assert.ok(stages.includes('attach observed conversationId=null'));
  assert.ok(stages.includes('attach identity mismatch'));
  assert.ok(!stages.includes('attach identity confirmed'), 'must never claim confirmed on a mismatch');
});

test('verifyAttachedConversationId never accepts a momentarily-correct id that changes again before settling', async () => {
  // exact-1 shows first, then flips to exact-1-decoy before the quiet
  // window elapses — must not have returned during that brief window.
  const doc = { location: { href: 'https://chatgpt.com/c/exact-1' } };
  const clock = createFakeClock();
  const promise = verifyAttachedConversationId(doc, 'exact-1', {
    timeoutMs: 10000,
    now: clock.now,
    sleep: clock.scriptedSleep((tick) => {
      if (tick === 1) doc.location.href = 'https://chatgpt.com/c/exact-1-decoy';
      if (tick === 3) doc.location.href = 'https://chatgpt.com/c/exact-1'; // settles back to the correct one
    }),
  });
  const id = await promise;
  assert.equal(id, 'exact-1');
});

// --- ChatGPT page readiness handshake -----------------------------------
//
// chrome.tabs "complete" only means the outer document finished loading —
// live evidence (2026-08-27) showed a second Reviewer tab reach "complete"
// while ChatGPT's own SPA was still a blank page, and the ask sent right
// after it hung for the full response timeout. waitForChatGptReady is the
// gate that must catch that BEFORE the tab is ever handed back for use.

function fakeComposer(overrides = {}) {
  return { isConnected: true, disabled: false, getAttribute: () => null, ...overrides };
}

// Fake `document` with only what waitForChatGptReady needs: a mutable
// `location.href` and a `getComposer` callback invoked fresh on every
// querySelector() call — never a cached reference — so tests can express
// "the composer is usable right now" changing over time (appears later,
// becomes stale/disconnected) exactly the way a real page would.
function createReadyDoc({ href = 'https://chatgpt.com/', getComposer = () => null } = {}) {
  return {
    location: { get href() { return href; }, set href(v) { href = v; } },
    querySelector(selector) {
      if (!COMPOSER_SELECTORS.includes(selector)) return null;
      return getComposer();
    },
  };
}

test('waitForChatGptReady resolves immediately when a real, usable composer is already present', async () => {
  const composer = fakeComposer();
  const doc = createReadyDoc({ href: 'https://chatgpt.com/', getComposer: () => composer });
  const stages = [];
  const result = await waitForChatGptReady(doc, { timeoutMs: 1000, sleep: instantSleep, onStage: (s) => stages.push(s) });
  assert.deepEqual(result, { ready: true, url: 'https://chatgpt.com/' });
  assert.ok(stages.includes('waiting for ChatGPT UI'));
  assert.ok(stages.includes('composer detected'));
  assert.ok(stages.includes('ChatGPT page ready'));
});

test('waitForChatGptReady throws CHATGPT_PAGE_NOT_READY (with observed URL/readiness diagnostics) when no composer ever matches', async () => {
  const doc = createReadyDoc({ href: 'https://chatgpt.com/', getComposer: () => null });
  await assert.rejects(
    () => waitForChatGptReady(doc, { timeoutMs: 20, sleep: instantSleep }),
    (err) => {
      assert.equal(err.code, 'CHATGPT_PAGE_NOT_READY');
      assert.equal(err.diagnostics.composerFound, false);
      assert.equal(err.diagnostics.url, 'https://chatgpt.com/');
      return true;
    }
  );
});

test('waitForChatGptReady does not treat a composer matched by selector alone (disconnected or disabled) as ready', async () => {
  const disconnected = fakeComposer({ isConnected: false });
  const doc = createReadyDoc({ getComposer: () => disconnected });
  await assert.rejects(
    () => waitForChatGptReady(doc, { timeoutMs: 20, sleep: instantSleep }),
    (err) => {
      assert.equal(err.code, 'CHATGPT_PAGE_NOT_READY');
      // A composer selector DID match — this is the distinction from the
      // "no composer at all" case above: composerFound reflects that a
      // node existed, even though it was never actually usable.
      assert.equal(err.diagnostics.composerFound, true);
      return true;
    }
  );
});

test('waitForChatGptReady succeeds once the composer appears later, not just if present at the very first check', async () => {
  let calls = 0;
  const composer = fakeComposer();
  const doc = createReadyDoc({
    getComposer: () => {
      calls += 1;
      return calls < 3 ? null : composer;
    },
  });
  const result = await waitForChatGptReady(doc, { timeoutMs: 1000, sleep: instantSleep });
  assert.equal(result.ready, true);
  assert.ok(calls >= 3, 'must have kept polling rather than giving up after the first miss');
});

test('waitForChatGptReady fails closed (times out, never falsely resolves) if the tab navigates away before any composer becomes usable, and reports the observed URL', async () => {
  const doc = createReadyDoc({ href: 'https://chatgpt.com/', getComposer: () => null });
  let ticks = 0;
  await assert.rejects(
    () =>
      waitForChatGptReady(doc, {
        timeoutMs: 20,
        sleep: async () => {
          ticks += 1;
          if (ticks === 1) doc.location.href = 'https://chatgpt.com/auth/login';
        },
      }),
    (err) => {
      assert.equal(err.code, 'CHATGPT_PAGE_NOT_READY');
      assert.match(err.message, /auth\/login/);
      assert.equal(err.diagnostics.url, 'https://chatgpt.com/auth/login');
      assert.equal(err.diagnostics.composerFound, false);
      return true;
    }
  );
});

test('waitForChatGptReady never latches onto a composer that existed on an earlier poll but is disconnected now (mid-wait SPA navigation) — fails closed via timeout', async () => {
  let calls = 0;
  const doc = createReadyDoc({
    getComposer: () => {
      calls += 1;
      // No composer at all for the first couple of polls, then one shows up
      // but disconnected on every poll after (as if the SPA navigated and
      // tore down/replaced the node without ever mounting a usable one) —
      // must never treat "a node was found at some point" as readiness.
      return calls < 2 ? null : fakeComposer({ isConnected: false });
    },
  });
  await assert.rejects(
    () => waitForChatGptReady(doc, { timeoutMs: 20, sleep: instantSleep }),
    (err) => {
      assert.equal(err.code, 'CHATGPT_PAGE_NOT_READY');
      assert.equal(err.diagnostics.composerFound, true);
      return true;
    }
  );
  assert.ok(calls > 2, 'must have kept re-checking rather than stopping after the first miss');
});

test('waitForChatGptReady throws RATE_LIMITED if the throttling banner appears while waiting for the page to become ready', async () => {
  const doc = {
    location: { href: 'https://chatgpt.com/' },
    body: { innerText: "You're making requests too quickly." },
    querySelector: () => null,
  };
  await assert.rejects(
    () => waitForChatGptReady(doc, { timeoutMs: 10000, sleep: instantSleep }),
    (err) => err.code === 'RATE_LIMITED'
  );
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

// --- snapshotReviewerPreflight (zero-GPT-request local diagnostic) --------
//
// Live evidence (2026-08-27): reproducing the intermittent blank second
// Reviewer tab live risks tripping ChatGPT's own rate limiting, so instead
// the next naturally-occurring failure should be fully diagnosable from a
// single, non-waiting, non-polling read of the tab's current DOM state.
// Unlike waitForChatGptReady above (which polls up to a timeout and can
// itself delay the caller), this is a single point-in-time snapshot — never
// sends a prompt, never waits — used both as a pre-send gate and as the
// failure-snapshot capture in src/bridge/reviewerSession.js.

test('snapshotReviewerPreflight reports a fully ready page', () => {
  const composer = fakeComposer();
  const doc = createReadyDoc({ href: 'https://chatgpt.com/c/abc', getComposer: () => composer });
  assert.deepEqual(snapshotReviewerPreflight(doc), {
    url: 'https://chatgpt.com/c/abc',
    pageReady: true,
    composerExists: true,
    composerConnected: true,
    composerInteractive: true,
  });
});

test('snapshotReviewerPreflight reports composerExists:false when no composer selector matches at all', () => {
  const doc = createReadyDoc({ href: 'https://chatgpt.com/', getComposer: () => null });
  assert.deepEqual(snapshotReviewerPreflight(doc), {
    url: 'https://chatgpt.com/',
    pageReady: false,
    composerExists: false,
    composerConnected: false,
    composerInteractive: false,
  });
});

test('snapshotReviewerPreflight distinguishes a disconnected composer (exists but not connected) from missing entirely', () => {
  const disconnected = fakeComposer({ isConnected: false });
  const doc = createReadyDoc({ getComposer: () => disconnected });
  const snapshot = snapshotReviewerPreflight(doc);
  assert.equal(snapshot.composerExists, true);
  assert.equal(snapshot.composerConnected, false);
  assert.equal(snapshot.composerInteractive, false);
  assert.equal(snapshot.pageReady, false);
});

test('snapshotReviewerPreflight distinguishes a connected-but-disabled composer (exists+connected but not interactive)', () => {
  const disabled = fakeComposer({ disabled: true });
  const doc = createReadyDoc({ getComposer: () => disabled });
  const snapshot = snapshotReviewerPreflight(doc);
  assert.equal(snapshot.composerExists, true);
  assert.equal(snapshot.composerConnected, true);
  assert.equal(snapshot.composerInteractive, false);
  assert.equal(snapshot.pageReady, false);
});

test('snapshotReviewerPreflight never waits/polls — each selector is read at most once, with no retry loop', () => {
  let calls = 0;
  const doc = createReadyDoc({
    getComposer: () => {
      calls += 1;
      return null; // never becomes ready
    },
  });
  snapshotReviewerPreflight(doc);
  assert.equal(calls, COMPOSER_SELECTORS.length, 'exactly one querySelector per known selector, never a retry loop');
});
