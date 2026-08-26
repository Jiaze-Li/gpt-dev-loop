import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// extension/content.js relies on chrome.* globals and dynamically imports
// extension/domActions.js via chrome.runtime.getURL() — both stubbed here so
// the real content.js file can be exercised under plain Node, the same way
// extension/domActions.js already is in tests/extensionDomActions.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentScriptUrl = pathToFileURL(path.join(__dirname, '..', 'extension', 'content.js')).href;
const fakeDomActionsUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'fakeDeleteDomActions.mjs')).href;

test('content.js registers exactly one onMessage listener, and runs deleteConversation exactly once, even when injected twice', async () => {
  const listeners = [];
  globalThis.document = {};
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: () => fakeDomActionsUrl,
    },
  };

  // Simulates manifest.json's declarative content_scripts injection racing
  // against background.js's manual chrome.scripting.executeScript retry
  // (sendToContentScriptWithRetry) — both re-run this same script in the
  // same page. Cache-busting query strings force Node to actually
  // re-evaluate content.js a second time (rather than reusing its cached
  // module), matching what a real second injection does.
  await import(`${contentScriptUrl}?run=1`);
  await import(`${contentScriptUrl}?run=2`);

  assert.equal(listeners.length, 1, 'a second script execution must not register a duplicate onMessage listener');

  const fakeDomActions = await import(fakeDomActionsUrl);
  const responses = [];
  let resolveResponse;
  const responseReceived = new Promise((resolve) => {
    resolveResponse = resolve;
  });

  const message = { type: 'performDelete', requestId: 'req-1', conversationId: 'conv-1' };
  const keptChannelOpen = listeners[0](message, {}, (response) => {
    responses.push(response);
    resolveResponse();
  });
  assert.equal(keptChannelOpen, true, 'performDelete must keep the async response channel open');

  await responseReceived;

  assert.equal(fakeDomActions.deleteCallCount, 1, 'deleteConversation must run exactly once per request, never once per registered listener');
  assert.deepEqual(responses, [{ ok: true }]);
});
