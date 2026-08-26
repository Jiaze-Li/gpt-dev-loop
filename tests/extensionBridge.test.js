import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { askGpt } from '../src/bridge/chatgptExtension.js';
import { getExtensionServer, closeExtensionServer } from '../src/bridge/extensionServer.js';
import {
  ChromeUnavailableError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
  RequestTimeoutError,
  SendFailedError,
} from '../src/bridge/errors.js';

const EXTENSION_ID = 'test-extension-id';
const PROTOCOL_ID = 'gpt-loop-extension/v1';

let port = 18900;
function nextConfig(overrides = {}) {
  port += 1;
  return {
    extensionHost: '127.0.0.1',
    extensionPort: port,
    extensionId: EXTENSION_ID,
    extensionConnectTimeoutMs: 2000,
    responseTimeoutMs: 2000,
    requestTimeoutMs: 5000,
    chatgptUrl: 'https://chatgpt.com/',
    ...overrides,
  };
}

// Fake extension client: connects, hellos, and calls `onRequest(ws, msg)`
// for each `request` it receives. Resolves once the handshake (hello_ack)
// completes, so the caller can rely on the server already being `ready`.
//
// Starts the bridge server first (production code only does this lazily,
// on the first askGpt() call — the real extension's background worker
// retries its connection every 2s until the server exists; a single test
// connection attempt needs the listener up-front instead).
function connectFakeExtension(config, onRequest) {
  getExtensionServer(config).start();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${config.extensionHost}:${config.extensionPort}`, {
      origin: `chrome-extension://${EXTENSION_ID}`,
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'hello', requestId: 'conn-1', payload: {} }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello_ack') {
        resolve(ws);
        return;
      }
      if (msg.type === 'request') {
        onRequest(ws, msg);
      }
    });
    ws.on('error', reject);
  });
}

afterEach(async () => {
  await closeExtensionServer();
});

test('askGpt resolves with the reply text on a successful round trip', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: 'mock reply' } })
    );
  });
  const reply = await askGpt('review this', config);
  assert.equal(reply, 'mock reply');
  client.close();
});

test('askGpt rejects with ChromeUnavailableError when no extension ever connects', async () => {
  const config = nextConfig({ extensionConnectTimeoutMs: 50 });
  await assert.rejects(() => askGpt('review this', config), ChromeUnavailableError);
});

test('askGpt rejects with ChromeUnavailableError if the extension disconnects mid-request', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws) => {
    ws.close();
  });
  await assert.rejects(() => askGpt('review this', config), ChromeUnavailableError);
  client.close();
});

const ERROR_CASES = [
  ['NO_CHATGPT_TAB', ChromeUnavailableError],
  ['LOGIN_REQUIRED', LoginRequiredError],
  ['COMPOSER_NOT_FOUND', SelectorMismatchError],
  ['SEND_BUTTON_NOT_FOUND', SelectorMismatchError],
  ['RESPONSE_TIMEOUT', ResponseTimeoutError],
  ['RESPONSE_EMPTY', ResponseExtractionError],
  ['SEND_FAILED', SendFailedError],
  ['INTERNAL_ERROR', ChromeUnavailableError],
];

for (const [code, ErrorClass] of ERROR_CASES) {
  test(`askGpt maps protocol error code ${code} to ${ErrorClass.name}`, async () => {
    const config = nextConfig();
    const client = await connectFakeExtension(config, (ws, msg) => {
      ws.send(
        JSON.stringify({ protocol: PROTOCOL_ID, type: 'error', requestId: msg.requestId, error: { code, message: code } })
      );
    });
    await assert.rejects(() => askGpt('review this', config), ErrorClass);
    client.close();
  });
}

test('a new extension connection replaces the previous one', async () => {
  const config = nextConfig();
  const first = await connectFakeExtension(config, () => {});
  const firstClosed = new Promise((resolve) => first.on('close', (code) => resolve(code)));

  const second = await connectFakeExtension(config, (ws, msg) => {
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: 'from second' } })
    );
  });

  assert.equal(await firstClosed, 4000);
  const reply = await askGpt('review this', config);
  assert.equal(reply, 'from second');
  second.close();
});

test('onLifecycle fires "connected" on hello and "disconnected" on close, and unsubscribe stops further events', async () => {
  const config = nextConfig();
  const events = [];
  const unsubscribe = getExtensionServer(config).onLifecycle((event) => events.push(event));

  const client = await connectFakeExtension(config, () => {});
  assert.deepEqual(events, [{ type: 'connected', extensionVersion: 'unknown', capabilities: [] }]);

  const closed = new Promise((resolve) => client.on('close', resolve));
  client.close();
  await closed;
  // The client's own 'close' event fires before the server side has
  // necessarily processed its matching 'close' event (two separate TCP
  // endpoints) — poll briefly instead of assuming one tick is enough.
  const deadline = Date.now() + 2000;
  while (events.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(events, [
    { type: 'connected', extensionVersion: 'unknown', capabilities: [] },
    { type: 'disconnected' },
  ]);

  unsubscribe();
  await connectFakeExtension(config, () => {});
  assert.equal(events.length, 2, 'no further events after unsubscribe');
});

test('a socket that connects but never sends hello does not interrupt an already active connection', async () => {
  const config = nextConfig();
  const active = await connectFakeExtension(config, (ws, msg) => {
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: 'from active' } })
    );
  });

  const intruder = new WebSocket(`ws://${config.extensionHost}:${config.extensionPort}`, {
    origin: `chrome-extension://${EXTENSION_ID}`,
  });
  await new Promise((resolve, reject) => {
    intruder.on('open', resolve);
    intruder.on('error', reject);
  });

  const reply = await askGpt('review this', config);
  assert.equal(reply, 'from active');

  active.close();
  intruder.close();
});

test('closing the connection immediately rejects both the in-flight request and any queued behind it', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, () => {
    // never responds — keeps every request queued/in flight
  });

  const first = askGpt('first', config);
  // Give the server a tick to actually dispatch `first` (moving it from
  // queued to in-flight) before enqueuing a second request behind it.
  await new Promise((resolve) => setImmediate(resolve));
  const second = askGpt('second', config);

  client.close();

  await assert.rejects(() => first, ChromeUnavailableError);
  await assert.rejects(() => second, ChromeUnavailableError);
});

test('the overall requestTimeoutMs frees the in-flight slot for the next queued request', async () => {
  const config = nextConfig({ requestTimeoutMs: 100, responseTimeoutMs: 5000 });
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.prompt === 'second') {
      ws.send(
        JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: 'second reply' } })
      );
    }
    // never respond to 'first' — it must time out via requestTimeoutMs, not
    // by getting an actual response or by its own responseTimeoutMs (5000ms).
  });

  const first = askGpt('first', config);
  await new Promise((resolve) => setImmediate(resolve));
  const second = askGpt('second', { ...config, requestTimeoutMs: 5000 });

  await assert.rejects(() => first, RequestTimeoutError);

  const secondResult = await Promise.race([
    second.then((text) => ({ settled: true, text })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 500)),
  ]);
  assert.equal(
    secondResult.settled,
    true,
    "second request should have been pumped once the first was cancelled, not after the first's full 5000ms response timer"
  );
  assert.equal(secondResult.text, 'second reply');

  client.close();
});
