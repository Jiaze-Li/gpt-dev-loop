import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercises extension/content.js's supervisorAsk handling under plain Node,
// the same way tests/contentScriptInjection.test.js does for
// performDelete — chrome.* and the dynamic domActions.js import are stubbed
// so the real content.js file runs unmodified.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentScriptUrl = pathToFileURL(path.join(__dirname, '..', 'extension', 'content.js')).href;
const fakeDomActionsUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'fakeSupervisorDomActions.mjs')).href;

let runCounter = 0;

// Simulates a fresh page: resets the "already installed" guard content.js
// itself relies on (which is meant to survive repeat injections of the SAME
// page, not to leak state between unrelated test "pages"), then imports
// content.js fresh so it registers exactly one new onMessage listener.
async function loadListener() {
  runCounter += 1;
  globalThis.__gptLoopContentScriptInstalled = false;
  const listeners = [];
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: () => fakeDomActionsUrl,
    },
  };
  await import(`${contentScriptUrl}?supervisor-run=${runCounter}`);
  return listeners[0];
}

function invoke(listener, message) {
  return new Promise((resolve) => {
    const keptOpen = listener(message, {}, resolve);
    assert.equal(keptOpen, true, 'supervisorAsk must keep the async response channel open');
  });
}

test('supervisorAsk (no expected id yet) sends the prompt, captures whatever conversation id is present, and returns it with the reply', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setNextConversationId('conv-first');
  fakeDomActions.setNextReplyText('ACK');

  const response = await invoke(listener, {
    type: 'supervisorAsk',
    requestId: 'req-1',
    prompt: 'Remember this code: 731. Reply only ACK.',
    expectedConversationId: null,
    responseTimeoutMs: 1000,
  });

  assert.deepEqual(response, { ok: true, text: 'ACK', conversationId: 'conv-first' });
  assert.deepEqual(fakeDomActions.sentPrompts.slice(-1), ['Remember this code: 731. Reply only ACK.']);
});

test('supervisorAsk succeeds when the captured id matches the caller-supplied expected id (same-conversation continuation)', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setNextConversationId('conv-continuing');
  fakeDomActions.setNextReplyText('731');

  const response = await invoke(listener, {
    type: 'supervisorAsk',
    requestId: 'req-2',
    prompt: 'What code did I ask you to remember?',
    expectedConversationId: 'conv-continuing',
    responseTimeoutMs: 1000,
  });

  assert.deepEqual(response, { ok: true, text: '731', conversationId: 'conv-continuing' });
});

test('supervisorAsk fails safe with SUPERVISOR_IDENTITY_MISMATCH instead of silently continuing in a different conversation', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setNextConversationId('conv-actually-loaded');
  fakeDomActions.setNextReplyText('should never be returned');

  const response = await invoke(listener, {
    type: 'supervisorAsk',
    requestId: 'req-3',
    prompt: 'continue',
    expectedConversationId: 'conv-expected',
    responseTimeoutMs: 1000,
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'SUPERVISOR_IDENTITY_MISMATCH');
  assert.ok(response.message.includes('conv-expected'));
  assert.ok(response.message.includes('conv-actually-loaded'));
});

test('supervisorAsk reports LOGIN_REQUIRED (not a crash) when the composer cannot be found', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setComposerFound(false);

  const response = await invoke(listener, {
    type: 'supervisorAsk',
    requestId: 'req-4',
    prompt: 'hi',
    expectedConversationId: null,
    responseTimeoutMs: 1000,
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'LOGIN_REQUIRED');
  fakeDomActions.setComposerFound(true);
});
