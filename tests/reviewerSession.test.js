import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { getExtensionServer, closeExtensionServer } from '../src/bridge/extensionServer.js';
import {
  ReviewerTaskMismatchError,
  ReviewerTabLostError,
  ReviewerIdentityMismatchError,
} from '../src/bridge/errors.js';

const EXTENSION_ID = 'test-extension-id';
const PROTOCOL_ID = 'gpt-loop-extension/v1';

let port = 20500;
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

// Same fake-extension harness as tests/supervisorSession.test.js — each
// bridge test file is self-contained per that file's own convention.
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

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'task-1',
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'https://github.com/example/gpt-dev-loop', branch: 'main', commit_sha: 'abc123' },
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['some test value must be verified'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function demoExecutionReport(overrides = {}) {
  return {
    task_id: 'task-1',
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: 'https://github.com/example/gpt-dev-loop', branch: 'main', commit_sha: 'def456' },
    status: 'DONE',
    changed_files: ['src/foo.js'],
    tests_run: ['npm test'],
    test_results: ['npm test: pass'],
    issues: 'none',
    next_recommendation: 'proceed',
    ...overrides,
  };
}

function demoEvidence(overrides = {}) {
  return { pass: true, results: [{ command: 'npm test', pass: true, output: 'verified' }], ...overrides };
}

function reviewResultText({ taskId = 'task-1', decision = 'PASS' } = {}) {
  return `## task_id
${taskId}

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: main
commit_sha: def456

## decision
${decision}

## findings
- looks correct

## required_changes
${decision === 'PASS' ? 'none' : '- fix the thing'}

## rationale
meets acceptance_criteria`;
}

afterEach(async () => {
  await closeExtensionServer();
});

test('first review() saves tabId and conversationId', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 501 } }));
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: reviewResultText({ decision: 'REWORK' }), conversationId: 'conv-1' },
      })
    );
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  const result = await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence({ pass: false }));

  assert.equal(result.decision, 'REWORK');
  assert.deepEqual(session.getIdentity(), { taskId: 'task-1', tabId: 501, conversationId: 'conv-1' });
  client.close();
});

test('second review() for the same task reuses the exact same tabId and conversationId', async () => {
  const config = nextConfig();
  const seenAsks = [];
  let askCount = 0;
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 77 } }));
      return;
    }
    seenAsks.push(msg.payload);
    askCount += 1;
    const decision = askCount === 1 ? 'REWORK' : 'PASS';
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: reviewResultText({ decision }), conversationId: 'conv-shared' },
      })
    );
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  const first = await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence({ pass: false }));
  const firstIdentity = session.getIdentity();
  const second = await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence({ pass: true }));
  const secondIdentity = session.getIdentity();

  assert.equal(first.decision, 'REWORK');
  assert.equal(second.decision, 'PASS');
  assert.equal(seenAsks.length, 2);
  assert.equal(seenAsks[0].tabId, secondIdentity.tabId);
  assert.equal(seenAsks[1].tabId, firstIdentity.tabId);
  assert.equal(seenAsks[1].expectedConversationId, 'conv-shared', 'second review must carry the conversation id captured by the first');
  assert.equal(firstIdentity.tabId, secondIdentity.tabId);
  assert.equal(firstIdentity.conversationId, secondIdentity.conversationId);
  client.close();
});

test('second review() still sends the full current evidence, not just an incremental delta', async () => {
  const config = nextConfig();
  const seenPrompts = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 5 } }));
      return;
    }
    seenPrompts.push(msg.payload.prompt);
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: reviewResultText({ decision: 'PASS' }), conversationId: 'conv-x' },
      })
    );
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence({ pass: false, results: [{ command: 'npm test', pass: false, output: 'pending' }] }));
  await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence({ pass: true, results: [{ command: 'npm test', pass: true, output: 'verified' }] }));

  assert.equal(seenPrompts.length, 2);
  for (const prompt of seenPrompts) {
    assert.match(prompt, /# Task Card/);
    assert.match(prompt, /# Execution Report/);
    assert.match(prompt, /# Evidence/);
  }
  assert.match(seenPrompts[1], /verified/, 'the second prompt must contain the second call\'s current evidence');
  assert.match(seenPrompts[1], /ONLY the Task Card, Execution Report, and Evidence given below/, 'must instruct the reviewer to judge only the current turn');
  client.close();
});

test('review() with a different taskId than create() rejects with ReviewerTaskMismatchError, without contacting the extension', async () => {
  const config = nextConfig();
  let askSent = false;
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 9 } }));
      return;
    }
    askSent = true;
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-y' } }));
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await assert.rejects(
    () => session.review('task-2', demoTaskCard({ task_id: 'task-2' }), demoExecutionReport({ task_id: 'task-2' }), demoEvidence()),
    ReviewerTaskMismatchError
  );
  assert.equal(askSent, false, 'a task mismatch must fail before any extension request is sent');
  client.close();
});

test('review() rejects with ReviewerTabLostError when the extension reports the tab is gone', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 12 } }));
      return;
    }
    ws.send(
      JSON.stringify({ protocol: PROTOCOL_ID, type: 'error', requestId: msg.requestId, error: { code: 'SUPERVISOR_TAB_LOST', message: 'gone' } })
    );
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()), ReviewerTabLostError);
  client.close();
});

test('review() rejects with ReviewerIdentityMismatchError when the tab is showing a different conversation', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 15 } }));
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

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()), ReviewerIdentityMismatchError);
  client.close();
});

test('close() sends supervisorClose for the saved Reviewer tab only, and resets identity', async () => {
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

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await session.close();

  const closeRequests = seenRequests.filter((p) => p.action === 'supervisorClose');
  assert.equal(closeRequests.length, 1);
  assert.equal(closeRequests[0].tabId, 21);
  assert.deepEqual(session.getIdentity(), { taskId: null, tabId: null, conversationId: null });
  client.close();
});

test('close() never sends a delete action — the ChatGPT conversation is not touched', async () => {
  const config = nextConfig();
  const seenActions = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenActions.push(msg.payload.action);
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 33 } }));
      return;
    }
    if (msg.payload.action === 'supervisorAsk') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-z' } }));
      return;
    }
    if (msg.payload.action === 'supervisorClose') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '' } }));
    }
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());
  await session.close();

  assert.deepEqual(seenActions, ['supervisorCreate', 'supervisorAsk', 'supervisorClose']);
  assert.ok(!seenActions.includes('delete'), 'close() must never trigger conversation deletion');
  client.close();
});

test('close() before create() is a no-op — no request is sent', async () => {
  const config = nextConfig();
  const session = new ReviewerSession(config);
  await session.close();
  assert.deepEqual(session.getIdentity(), { taskId: null, tabId: null, conversationId: null });
});

test('review() before create() throws immediately, without contacting the extension', async () => {
  const config = nextConfig();
  const session = new ReviewerSession(config);
  await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()), /create\(/);
});

test('create() called twice without an intervening close() throws', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 3 } }));
  });

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await assert.rejects(() => session.create('task-1'), /already called/);
  client.close();
});
