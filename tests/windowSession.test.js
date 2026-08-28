import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { createAutomationWindow, activateTabWithoutFocusingWindow, closeAutomationWindow, closeTab, listTabs } from '../src/bridge/windowSession.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { getExtensionServer, closeExtensionServer } from '../src/bridge/extensionServer.js';

const EXTENSION_ID = 'test-extension-id';
const PROTOCOL_ID = 'gpt-loop-extension/v1';

let port = 19700;
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

// Same fake-extension harness as tests/extensionBridge.test.js / supervisorSession.test.js.
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

test('createAutomationWindow round-trips a windowCreate request and returns the extension-reported windowId and initialTabId', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'windowCreate');
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', windowId: 501, initialTabId: 601 } })
    );
  });

  const { windowId, initialTabId } = await createAutomationWindow(config);
  assert.equal(windowId, 501);
  assert.equal(initialTabId, 601);
  client.close();
});

test('createAutomationWindow reports initialTabId null when the extension response omits it', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', windowId: 501 } }));
  });

  const { initialTabId } = await createAutomationWindow(config);
  assert.equal(initialTabId, null);
  client.close();
});

test('closeTab round-trips a supervisorClose request carrying the given tabId (reuses the generic tab-close wire action)', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'supervisorClose');
    assert.equal(msg.payload.tabId, 601);
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '' } }));
  });

  await closeTab(config, 601);
  client.close();
});

test('listTabs round-trips a windowListTabs request and returns the extension-reported safe tab metadata', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'windowListTabs');
    assert.equal(msg.payload.windowId, 501);
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: {
          text: '',
          tabs: [{ windowId: 501, tabId: 601, active: true, status: 'complete', urlState: 'chatgpt', openerTabId: null }],
        },
      })
    );
  });

  const tabs = await listTabs(config, 501);
  assert.deepEqual(tabs, [{ windowId: 501, tabId: 601, active: true, status: 'complete', urlState: 'chatgpt', openerTabId: null }]);
  client.close();
});

test('activateTabWithoutFocusingWindow round-trips a windowActivateTab request and returns the observed diagnostics', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'windowActivateTab');
    assert.equal(msg.payload.tabId, 77);
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: '', windowActivation: { tabId: 77, active: true, windowId: 501, windowFocused: false } },
      })
    );
  });

  const activation = await activateTabWithoutFocusingWindow(config, 77);
  assert.deepEqual(activation, { tabId: 77, active: true, windowId: 501, windowFocused: false });
  client.close();
});

test('closeAutomationWindow round-trips a windowClose request carrying the windowId', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'windowClose');
    assert.equal(msg.payload.windowId, 501);
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '' } }));
  });

  await closeAutomationWindow(config, 501);
  client.close();
});

test('SupervisorSession.create() omits windowId from the wire request by default (production path unchanged)', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'supervisorCreate');
    assert.equal('windowId' in msg.payload, false, 'production callers must not send windowId at all');
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 501 } }));
  });

  const session = new SupervisorSession(config);
  await session.create();
  client.close();
});

test('SupervisorSession.create({ windowId }) carries the explicit windowId through to the wire request', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'supervisorCreate');
    assert.equal(msg.payload.windowId, 7);
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 501 } }));
  });

  const session = new SupervisorSession(config);
  await session.create({ windowId: 7 });
  client.close();
});
