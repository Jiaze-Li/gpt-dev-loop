import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { getExtensionServer, closeExtensionServer } from '../src/bridge/extensionServer.js';
import { SupervisorTabLostError, SupervisorIdentityMismatchError } from '../src/bridge/errors.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

const EXTENSION_ID = 'test-extension-id';
const PROTOCOL_ID = 'gpt-loop-extension/v1';

let port = 19500;
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

// Same fake-extension harness as tests/extensionBridge.test.js (duplicated
// per that file's own convention — each bridge test file is self-contained).
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

test('create() saves tabId and getIdentity() reflects it, with conversationId still null (not assigned until the first ask)', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    assert.equal(msg.payload.action, 'supervisorCreate');
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 501 } }));
  });

  const session = new SupervisorSession(config);
  const identity = await session.create();

  assert.deepEqual(identity, { tabId: 501, conversationId: null });
  assert.deepEqual(session.getIdentity(), { tabId: 501, conversationId: null });
  client.close();
});

test('ask() addresses the exact saved tabId on every call, and the second ask carries the id the first one captured', async () => {
  const config = nextConfig();
  const seenRequests = [];
  let askCount = 0;
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenRequests.push(msg.payload);
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 77 } }));
      return;
    }
    askCount += 1;
    const text = askCount === 1 ? 'ACK' : 'SUPERVISOR-CONTEXT-731';
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text, conversationId: 'conv-shared' },
      })
    );
  });

  const session = new SupervisorSession(config);
  await session.create();
  const first = await session.ask('Remember this code: SUPERVISOR-CONTEXT-731. Reply only ACK.');
  const second = await session.ask('What code did I ask you to remember? Reply only with the code.');

  assert.equal(first, 'ACK');
  assert.equal(second, 'SUPERVISOR-CONTEXT-731');

  const askRequests = seenRequests.filter((p) => p.action === 'supervisorAsk');
  assert.equal(askRequests.length, 2);
  assert.equal(askRequests[0].tabId, 77);
  assert.equal(askRequests[1].tabId, 77, 'second ask must address the exact same tab as the first');
  assert.equal(askRequests[0].expectedConversationId, null, 'first ask has no prior identity to expect yet');
  assert.equal(
    askRequests[1].expectedConversationId,
    'conv-shared',
    'second ask must carry the conversation id captured by the first ask, proving it is not a fresh conversation'
  );
  assert.equal(
    seenRequests.filter((p) => p.action === 'supervisorCreate').length,
    1,
    'must never create a second tab/conversation between the two asks'
  );
  assert.deepEqual(session.getIdentity(), { tabId: 77, conversationId: 'conv-shared' });
  client.close();
});

test('ask() rejects with SupervisorTabLostError when the extension reports the tab is gone', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 9 } }));
      return;
    }
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'error', requestId: msg.requestId, error: { code: 'SUPERVISOR_TAB_LOST', message: 'gone' } })
    );
  });

  const session = new SupervisorSession(config);
  await session.create();
  await assert.rejects(() => session.ask('hi'), SupervisorTabLostError);
  client.close();
});

test('ask() rejects with SupervisorIdentityMismatchError and does not update the stored identity on mismatch', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 12 } }));
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'error',
        requestId: msg.requestId,
        error: { code: 'SUPERVISOR_IDENTITY_MISMATCH', message: 'identity changed' },
      })
    );
  });

  const session = new SupervisorSession(config);
  await session.create();
  await assert.rejects(() => session.ask('hi'), SupervisorIdentityMismatchError);
  assert.deepEqual(session.getIdentity(), { tabId: 12, conversationId: null }, 'a failed ask must not silently adopt a different conversation');
  client.close();
});

test('close() sends supervisorClose for the saved tabId and resets identity to null', async () => {
  const config = nextConfig();
  const seenRequests = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenRequests.push(msg.payload);
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 21 } }));
      return;
    }
    if (msg.payload.action === 'supervisorClose') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '' } }));
    }
  });

  const session = new SupervisorSession(config);
  await session.create();
  await session.close();

  const closeRequests = seenRequests.filter((p) => p.action === 'supervisorClose');
  assert.equal(closeRequests.length, 1);
  assert.equal(closeRequests[0].tabId, 21);
  assert.deepEqual(session.getIdentity(), { tabId: null, conversationId: null });
  client.close();
});

test('close() before create() is a no-op — no request is sent', async () => {
  const config = nextConfig();
  const session = new SupervisorSession(config);
  await session.close();
  assert.deepEqual(session.getIdentity(), { tabId: null, conversationId: null });
});

test('ask() before create() throws immediately, without contacting the extension', async () => {
  const config = nextConfig();
  const session = new SupervisorSession(config);
  await assert.rejects(() => session.ask('hi'), /create\(\)/);
});

test('create() called twice without an intervening close() throws', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 3 } }));
  });

  const session = new SupervisorSession(config);
  await session.create();
  await assert.rejects(() => session.create(), /already called/);
  client.close();
});

test('decide() sends the built Supervisor prompt and returns the parsed decision', async () => {
  const config = nextConfig();
  const seenPrompts = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 601 } }));
      return;
    }
    seenPrompts.push(msg.payload.prompt);
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: 'WORKFLOW_DONE\n\n## summary\ndone', conversationId: 'conv-decide' },
      })
    );
  });

  const session = new SupervisorSession(config);
  await session.create();
  const decision = await session.decide({ workflowGoal: 'ship it' });

  assert.deepEqual(decision, { action: 'WORKFLOW_DONE', summary: 'done' });
  assert.equal(seenPrompts.length, 1);
  assert.match(seenPrompts[0], /ship it/);
  assert.match(seenPrompts[0], /## summary/);
  client.close();
});

test('decide() rejects with AdapterError(SUPERVISOR_INVALID_OUTPUT) when the reply is not a valid decision', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 602 } }));
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: 'Sure, moving on to the next task.', conversationId: 'conv-invalid' },
      })
    );
  });

  const session = new SupervisorSession(config);
  await session.create();
  await assert.rejects(() => session.decide({}), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
    return true;
  });
  client.close();
});
