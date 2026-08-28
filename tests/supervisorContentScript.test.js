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
  const stageUpdates = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: () => fakeDomActionsUrl,
      sendMessage: (message) => {
        if (message?.type === 'gptLoopStageUpdate') stageUpdates.push(message);
        return Promise.resolve();
      },
    },
  };
  await import(`${contentScriptUrl}?supervisor-run=${runCounter}`);
  const listener = listeners[0];
  listener.stageUpdates = stageUpdates;
  return listener;
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

test('supervisorAsk forwards every granular insertion sub-stage domActions.js emits into stageDiagnostics (2026-08-27 hang investigation)', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setNextConversationId('conv-granular');
  fakeDomActions.setNextReplyText('ACK');
  fakeDomActions.setStagesToEmit([
    'prompt insertion started',
    'insertion target resolved',
    'insertion target focused',
    'content write started',
    'content write finished',
    'input/change events dispatched',
    'inserted-content verification started',
    'inserted-content verification succeeded',
    'prompt insertion completed',
  ]);

  await invoke(listener, {
    type: 'supervisorAsk',
    requestId: 'req-granular-1',
    prompt: 'irrelevant for this test',
    expectedConversationId: null,
    responseTimeoutMs: 1000,
  });

  const stages = listener.stageUpdates.filter((u) => u.requestId === 'req-granular-1').map((u) => u.stage);
  assert.deepEqual(stages, [
    'composer found',
    'prompt insertion started',
    'insertion target resolved',
    'insertion target focused',
    'content write started',
    'content write finished',
    'events dispatched',
    'verification started',
    'verification succeeded',
    'prompt insertion completed',
    'assistant response completed',
    'conversation identity observed',
    'returning response',
    'reply extracted',
  ]);

  fakeDomActions.setStagesToEmit([]);
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

test('supervisorVerifyIdentity resolves the verified conversationId, never touching the composer/send path', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setVerifyAttachResult('conv-attached');
  const promptsBefore = fakeDomActions.sentPrompts.length;

  const response = await invoke(listener, {
    type: 'supervisorVerifyIdentity',
    requestId: 'req-5',
    expectedConversationId: 'conv-attached',
  });

  assert.deepEqual(response, { ok: true, text: '', conversationId: 'conv-attached' });
  assert.equal(fakeDomActions.sentPrompts.length, promptsBefore, 'attach verification must never send a prompt');
});

test('supervisorVerifyIdentity fails safe with SUPERVISOR_ATTACH_MISMATCH instead of silently succeeding on a different conversation', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setVerifyAttachError('SUPERVISOR_ATTACH_MISMATCH', 'expected "conv-expected", got "conv-wrong"');

  const response = await invoke(listener, {
    type: 'supervisorVerifyIdentity',
    requestId: 'req-6',
    expectedConversationId: 'conv-expected',
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'SUPERVISOR_ATTACH_MISMATCH');
  assert.ok(response.message.includes('conv-expected'));
});

// --- ping / waitForChatGptReady (2026-08-27 page-readiness handshake) -----

test('content.js responds ok to a ping synchronously, without touching domActions at all', async () => {
  const listener = await loadListener();
  const responses = [];
  const keptOpen = listener({ type: 'ping', requestId: 'req-ping' }, {}, (r) => responses.push(r));
  assert.equal(keptOpen, false, 'ping is answered synchronously; the async channel need not stay open');
  assert.deepEqual(responses, [{ ok: true }]);
});

test('waitForChatGptReady handler resolves ok with the observed url once the page is ready', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setChatGptReadyResult({ ready: true, url: 'https://chatgpt.com/' });

  const response = await invoke(listener, {
    type: 'waitForChatGptReady',
    requestId: 'req-ready-1',
    responseTimeoutMs: 1000,
  });

  assert.deepEqual(response, { ok: true, text: '', url: 'https://chatgpt.com/' });
});

test('waitForChatGptReady handler reports CHATGPT_PAGE_NOT_READY with diagnostics on failure, instead of hanging or crashing', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setChatGptReadyError('CHATGPT_PAGE_NOT_READY', 'page not ready', {
    url: 'https://chatgpt.com/',
    composerFound: false,
  });

  const response = await invoke(listener, {
    type: 'waitForChatGptReady',
    requestId: 'req-ready-2',
    responseTimeoutMs: 1000,
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'CHATGPT_PAGE_NOT_READY');
  assert.deepEqual(response.diagnostics, { url: 'https://chatgpt.com/', composerFound: false });
  fakeDomActions.setChatGptReadyResult({ ready: true, url: 'https://chatgpt.com/' });
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

// --- reviewerPreflight (zero-GPT-request local diagnostic, 2026-08-27) ----

test('reviewerPreflight handler returns the domActions snapshot as-is, never touching the composer/send path', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setReviewerPreflightSnapshot({
    url: 'https://chatgpt.com/c/preflight-ok',
    pageReady: true,
    composerExists: true,
    composerConnected: true,
    composerInteractive: true,
  });
  const promptsBefore = fakeDomActions.sentPrompts.length;

  const response = await invoke(listener, { type: 'reviewerPreflight', requestId: 'req-preflight-1' });

  assert.deepEqual(response, {
    ok: true,
    text: '',
    preflight: {
      url: 'https://chatgpt.com/c/preflight-ok',
      pageReady: true,
      composerExists: true,
      composerConnected: true,
      composerInteractive: true,
    },
  });
  assert.equal(fakeDomActions.sentPrompts.length, promptsBefore, 'reviewerPreflight must never send a prompt');
});

test('reviewerPreflight handler reports a not-ready snapshot without failing the request itself', async () => {
  const listener = await loadListener();
  const fakeDomActions = await import(fakeDomActionsUrl);
  fakeDomActions.setReviewerPreflightSnapshot({
    url: 'https://chatgpt.com/c/preflight-bad',
    pageReady: false,
    composerExists: false,
    composerConnected: false,
    composerInteractive: false,
  });

  const response = await invoke(listener, { type: 'reviewerPreflight', requestId: 'req-preflight-2' });

  assert.equal(response.ok, true, 'the wire request itself succeeds; pass/fail judgment is the caller\'s job');
  assert.equal(response.preflight.pageReady, false);
  assert.equal(response.preflight.composerExists, false);
  fakeDomActions.setReviewerPreflightSnapshot({
    url: 'https://chatgpt.com/c/fake',
    pageReady: true,
    composerExists: true,
    composerConnected: true,
    composerInteractive: true,
  });
});
