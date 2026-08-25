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
