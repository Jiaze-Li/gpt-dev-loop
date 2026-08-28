import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_ID, buildHelloAck, buildRequestMessage, parseMessage } from '../src/bridge/extensionProtocol.js';

test('buildHelloAck produces a parseable hello_ack message', () => {
  const msg = buildHelloAck('conn-1', '1');
  const parsed = parseMessage(JSON.stringify(msg));
  assert.equal(parsed.type, 'hello_ack');
  assert.equal(parsed.requestId, 'conn-1');
  assert.equal(parsed.payload.serverVersion, '1');
});

test('buildRequestMessage produces a parseable request message', () => {
  const msg = buildRequestMessage('req-1', {
    prompt: 'hello',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 1000,
  });
  const parsed = parseMessage(JSON.stringify(msg));
  assert.equal(parsed.type, 'request');
  assert.equal(parsed.payload.prompt, 'hello');
  assert.equal(parsed.protocol, PROTOCOL_ID);
});

test('buildRequestMessage builds a supervisorAttach request carrying the conversationId, never a prompt', () => {
  const msg = buildRequestMessage('req-attach', {
    action: 'supervisorAttach',
    conversationId: 'conv-exact-1',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'supervisorAttach');
  assert.equal(msg.payload.conversationId, 'conv-exact-1');
  assert.equal(msg.payload.prompt, undefined, 'attach must never carry a prompt to send');
});

test('buildRequestMessage omits active for a supervisorCreate request by default', () => {
  const msg = buildRequestMessage('req-create', {
    action: 'supervisorCreate',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'supervisorCreate');
  assert.equal('active' in msg.payload, false, 'production callers must not send active at all');
});

test('buildRequestMessage carries an explicit active:true diagnostic override for supervisorCreate', () => {
  const msg = buildRequestMessage('req-create-active', {
    action: 'supervisorCreate',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
    active: true,
  });
  assert.equal(msg.payload.active, true);
});

test('buildRequestMessage omits windowId for a supervisorCreate request by default', () => {
  const msg = buildRequestMessage('req-create-nowin', {
    action: 'supervisorCreate',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
  });
  assert.equal('windowId' in msg.payload, false, 'production callers must not send windowId at all');
});

test('buildRequestMessage carries an explicit windowId diagnostic override for supervisorCreate', () => {
  const msg = buildRequestMessage('req-create-win', {
    action: 'supervisorCreate',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
    windowId: 7,
  });
  assert.equal(msg.payload.windowId, 7);
});

test('buildRequestMessage builds a windowCreate request carrying chatgptUrl, never a prompt or tabId', () => {
  const msg = buildRequestMessage('req-win-create', {
    action: 'windowCreate',
    chatgptUrl: 'https://chatgpt.com/',
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'windowCreate');
  assert.equal(msg.payload.chatgptUrl, 'https://chatgpt.com/');
  assert.equal(msg.payload.prompt, undefined);
  assert.equal(msg.payload.tabId, undefined);
});

test('buildRequestMessage builds a windowActivateTab request carrying only tabId', () => {
  const msg = buildRequestMessage('req-win-activate', {
    action: 'windowActivateTab',
    tabId: 13,
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'windowActivateTab');
  assert.equal(msg.payload.tabId, 13);
  assert.equal(msg.payload.prompt, undefined);
  assert.equal(msg.payload.chatgptUrl, undefined);
});

test('buildRequestMessage builds a windowClose request carrying only windowId', () => {
  const msg = buildRequestMessage('req-win-close', {
    action: 'windowClose',
    windowId: 42,
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'windowClose');
  assert.equal(msg.payload.windowId, 42);
  assert.equal(msg.payload.tabId, undefined);
  assert.equal(msg.payload.prompt, undefined);
});

test('buildRequestMessage builds a windowListTabs request carrying only windowId', () => {
  const msg = buildRequestMessage('req-win-list-tabs', {
    action: 'windowListTabs',
    windowId: 42,
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'windowListTabs');
  assert.equal(msg.payload.windowId, 42);
  assert.equal(msg.payload.tabId, undefined);
  assert.equal(msg.payload.prompt, undefined);
  assert.equal(msg.payload.chatgptUrl, undefined);
});

test('buildRequestMessage builds a reviewerPreflight request carrying only tabId, never a prompt or chatgptUrl', () => {
  const msg = buildRequestMessage('req-preflight', {
    action: 'reviewerPreflight',
    tabId: 42,
    responseTimeoutMs: 8000,
  });
  assert.equal(msg.payload.action, 'reviewerPreflight');
  assert.equal(msg.payload.tabId, 42);
  assert.equal(msg.payload.responseTimeoutMs, 8000);
  assert.equal(msg.payload.prompt, undefined, 'reviewerPreflight must never carry a prompt to send');
  assert.equal(msg.payload.chatgptUrl, undefined, 'reviewerPreflight addresses an EXISTING tab, never a fresh navigation');
});

test('buildRequestMessage builds a diagnosticStage request carrying only originalRequestId, never a prompt/tabId/chatgptUrl', () => {
  const msg = buildRequestMessage('req-diag-1', {
    action: 'diagnosticStage',
    originalRequestId: 'req-timed-out-1',
    responseTimeoutMs: 5000,
  });
  assert.equal(msg.payload.action, 'diagnosticStage');
  assert.equal(msg.payload.originalRequestId, 'req-timed-out-1');
  assert.equal(msg.payload.responseTimeoutMs, 5000);
  assert.equal(msg.payload.prompt, undefined, 'diagnosticStage must never carry a prompt to send');
  assert.equal(msg.payload.tabId, undefined, 'diagnosticStage addresses a requestId, not a tab');
  assert.equal(msg.payload.chatgptUrl, undefined, 'diagnosticStage never navigates a tab');
});

test('parseMessage accepts a well-formed response message', () => {
  const parsed = parseMessage(
    JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: 'req-1', payload: { text: 'reply' } })
  );
  assert.equal(parsed.payload.text, 'reply');
});

test('parseMessage accepts a well-formed error message', () => {
  const parsed = parseMessage(
    JSON.stringify({
      protocol: PROTOCOL_ID,
      type: 'error',
      requestId: 'req-1',
      error: { code: 'LOGIN_REQUIRED', message: 'log in' },
    })
  );
  assert.equal(parsed.error.code, 'LOGIN_REQUIRED');
});

test('parseMessage rejects invalid JSON', () => {
  assert.throws(() => parseMessage('not json'));
});

test('parseMessage rejects an unsupported protocol version', () => {
  assert.throws(() =>
    parseMessage(JSON.stringify({ protocol: 'something-else/v9', type: 'hello', requestId: 'x' }))
  );
});

test('parseMessage rejects an unknown message type', () => {
  assert.throws(() => parseMessage(JSON.stringify({ protocol: PROTOCOL_ID, type: 'ping', requestId: 'x' })));
});

test('parseMessage rejects a missing requestId', () => {
  assert.throws(() => parseMessage(JSON.stringify({ protocol: PROTOCOL_ID, type: 'hello' })));
});

test('parseMessage rejects a response message with no payload.text', () => {
  assert.throws(() =>
    parseMessage(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: 'req-1', payload: {} }))
  );
});

test('parseMessage rejects an error message with no error.code', () => {
  assert.throws(() =>
    parseMessage(JSON.stringify({ protocol: PROTOCOL_ID, type: 'error', requestId: 'req-1', error: {} }))
  );
});
