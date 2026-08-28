import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { ReviewerSession } from '../src/bridge/reviewerSession.js';
import { getExtensionServer, closeExtensionServer } from '../src/bridge/extensionServer.js';
import {
  ReviewerTaskMismatchError,
  ReviewerTabLostError,
  ReviewerIdentityMismatchError,
  ReviewerAttachMismatchError,
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

// A tab in a fully healthy, ready-to-review state — the default response
// this harness gives to every 'reviewerPreflight' request (see
// connectFakeExtension's autoPreflight option below) so that every
// pre-existing test, which was written before ReviewerSession.review()
// started running a preflight gate, keeps exercising exactly the same
// supervisorAsk behavior it always did without having to know about
// preflight at all.
function healthyPreflight(tabId) {
  return {
    tabId,
    tabExists: true,
    url: 'https://chatgpt.com/c/existing-conversation',
    tabStatus: 'complete',
    active: false,
    discarded: false,
    contentScriptReachable: true,
    pageReady: true,
    composerExists: true,
    composerConnected: true,
    composerInteractive: true,
  };
}

// Same fake-extension harness as tests/supervisorSession.test.js — each
// bridge test file is self-contained per that file's own convention.
// autoPreflight (default true) auto-answers every 'reviewerPreflight'
// request with healthyPreflight(tabId) before it ever reaches `onRequest`,
// so tests unrelated to preflight itself don't need to handle that action.
// Pass autoPreflight: false to instead let `onRequest` see and answer
// 'reviewerPreflight' requests directly (used by the preflight-specific
// tests below).
//
// autoDiagnosticStage (default true) likewise auto-answers every
// 'diagnosticStage' request (captureFailureSnapshot's stage-lookup, run on
// every review() failure/timeout) with `stageRecord: null` before it ever
// reaches `onRequest` — this fake harness has no real stageDiagnostics.js
// store behind it, and every pre-existing test (written before that lookup
// existed) would otherwise have to answer an action it doesn't care about,
// or hang for DIAGNOSTIC_STAGE_TIMEOUT_MS waiting for a reply that never
// comes. Pass autoDiagnosticStage: false for a test that wants to control
// the diagnostic lookup's own response directly.
function connectFakeExtension(config, onRequest, { autoPreflight = true, autoDiagnosticStage = true } = {}) {
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
        if (autoPreflight && msg.payload.action === 'reviewerPreflight') {
          ws.send(
            JSON.stringify({
              protocol: PROTOCOL_ID,
              type: 'response',
              requestId: msg.requestId,
              payload: { text: '', preflight: healthyPreflight(msg.payload.tabId) },
            })
          );
          return;
        }
        if (autoDiagnosticStage && msg.payload.action === 'diagnosticStage') {
          ws.send(
            JSON.stringify({
              protocol: PROTOCOL_ID,
              type: 'response',
              requestId: msg.requestId,
              payload: { text: '', stageRecord: null },
            })
          );
          return;
        }
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

// "@@ field_name" markers (not "## field_name" Markdown headings) — see
// gptReviewerAdapter.js's parseReviewResult doc comment: ReviewerSession's
// replies cross ChatGPT's rendered assistant DOM, which strips "##"
// headings down to their bare text, so only "@@" markers survive intact.
function reviewResultText({ taskId = 'task-1', decision = 'PASS' } = {}) {
  return `@@ task_id
${taskId}

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: main
commit_sha: def456

@@ decision
${decision}

@@ findings
- looks correct

@@ required_changes
${decision === 'PASS' ? 'none' : '- fix the thing'}

@@ rationale
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

test('create() omits active by default, but forwards an explicit active:true diagnostic override onto the wire', async () => {
  const config = nextConfig();
  const seenCreates = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenCreates.push(msg.payload);
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 900 } }));
  });

  const defaultSession = new ReviewerSession(config);
  await defaultSession.create('task-1');
  await defaultSession.close();

  const activeSession = new ReviewerSession(config);
  await activeSession.create('task-1', { active: true });
  await activeSession.close();

  assert.equal('active' in seenCreates[0], false, 'default create() must not send active at all');
  assert.equal(seenCreates[2].active, true, 'explicit active:true must reach the wire request');
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

// --- attach() (conversation reattach/resume primitive) ------------------

test('attach(taskId, conversationId) to the exact conversation succeeds and review() continues in the same task context', async () => {
  const config = nextConfig();
  const seenRequests = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenRequests.push(msg.payload);
    if (msg.payload.action === 'supervisorAttach') {
      assert.equal(msg.payload.conversationId, 'conv-reviewer-1');
      ws.send(
        JSON.stringify({
          protocol: PROTOCOL_ID,
          type: 'response',
          requestId: msg.requestId,
          payload: { text: '', tabId: 950, conversationId: 'conv-reviewer-1' },
        })
      );
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: reviewResultText({ decision: 'PASS' }), conversationId: 'conv-reviewer-1' },
      })
    );
  });

  const session = new ReviewerSession(config);
  const identity = await session.attach('task-1', 'conv-reviewer-1');
  assert.deepEqual(identity, { taskId: 'task-1', tabId: 950, conversationId: 'conv-reviewer-1' });

  const result = await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());
  assert.equal(result.decision, 'PASS');

  assert.equal(seenRequests.filter((p) => p.action === 'supervisorCreate').length, 0, 'attach() must never create a new conversation');
  const askRequests = seenRequests.filter((p) => p.action === 'supervisorAsk');
  assert.equal(askRequests[0].tabId, 950);
  assert.equal(askRequests[0].expectedConversationId, 'conv-reviewer-1');
  client.close();
});

test('attach() for a different taskId than a later review() call rejects with ReviewerTaskMismatchError, without contacting the extension', async () => {
  const config = nextConfig();
  let reviewSent = false;
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorAttach') {
      ws.send(
        JSON.stringify({
          protocol: PROTOCOL_ID,
          type: 'response',
          requestId: msg.requestId,
          payload: { text: '', tabId: 951, conversationId: 'conv-reviewer-2' },
        })
      );
      return;
    }
    reviewSent = true;
    ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-reviewer-2' } }));
  });

  const session = new ReviewerSession(config);
  await session.attach('task-1', 'conv-reviewer-2');
  await assert.rejects(
    () => session.review('task-2', demoTaskCard({ task_id: 'task-2' }), demoExecutionReport({ task_id: 'task-2' }), demoEvidence()),
    ReviewerTaskMismatchError
  );
  assert.equal(reviewSent, false, 'a task mismatch must fail before any extension request is sent');
  client.close();
});

test('attach() rejects with ReviewerAttachMismatchError when the loaded conversation does not match, and never creates a new one', async () => {
  const config = nextConfig();
  const seenRequests = [];
  const client = await connectFakeExtension(config, (ws, msg) => {
    seenRequests.push(msg.payload);
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'error',
        requestId: msg.requestId,
        error: { code: 'SUPERVISOR_ATTACH_MISMATCH', message: 'expected "conv-a", got "conv-b"' },
      })
    );
  });

  const session = new ReviewerSession(config);
  await assert.rejects(() => session.attach('task-1', 'conv-a'), ReviewerAttachMismatchError);
  assert.deepEqual(session.getIdentity(), { taskId: null, tabId: null, conversationId: null }, 'a failed attach must leave the session exactly as if attach() was never called');
  assert.equal(seenRequests.filter((p) => p.action === 'supervisorCreate').length, 0, 'a failed attach must never fall back to creating a new conversation');
  client.close();
});

test('attach() throws immediately for an empty taskId or conversationId, without contacting the extension', async () => {
  const config = nextConfig();
  const session = new ReviewerSession(config);
  await assert.rejects(() => session.attach('', 'conv-a'), /taskId/);
  await assert.rejects(() => session.attach('task-1', ''), /conversationId/);
});

test('attach() cannot be called twice without an intervening close()', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: '', tabId: 952, conversationId: 'conv-reviewer-3' },
      })
    );
  });

  const session = new ReviewerSession(config);
  await session.attach('task-1', 'conv-reviewer-3');
  await assert.rejects(() => session.attach('task-1', 'conv-reviewer-4'), /already called/);
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

// Live evidence (2026-08-27): the automated loop stalled inside a real
// review() with nothing but a bare ResponseTimeoutError to go on — no
// visibility into which side of the Node/extension boundary the stall was
// on. review() now emits stage-only diagnostics (taskId/tabId/requestId,
// never prompt/reply/Task Card/Evidence content) at entry and around
// output parsing; this locks that logging in and guards against a future
// change accidentally leaking real review content into it.
test('review() logs stage-only diagnostics (taskId/tabId/requestId) and never logs Task Card/Evidence/reply content', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 909 } }));
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'response',
        requestId: msg.requestId,
        payload: { text: reviewResultText({ decision: 'PASS' }), conversationId: 'conv-diag' },
      })
    );
  });

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  assert.ok(diagLines.some((l) => l.includes('reviewer review request entered') && l.includes('taskId=task-1') && l.includes('tabId=909')));
  assert.ok(diagLines.some((l) => l.includes('reviewer output parsing started') && l.includes('taskId=task-1')));
  assert.ok(diagLines.some((l) => l.includes('reviewer output parsing completed') && l.includes('taskId=task-1')));

  const forbidden = ['looks correct', 'meets acceptance_criteria', 'some test value must be verified', 'src/foo.js'];
  for (const line of diagLines) {
    for (const needle of forbidden) {
      assert.ok(!line.includes(needle), `diagnostic log must never contain review content, found "${needle}" in: ${line}`);
    }
  }
});

// --- Zero-GPT-request reviewer preflight ----------------------------------
//
// Live evidence (2026-08-27): the automated loop occasionally hits a blank
// second Reviewer tab, and reproducing that live risks tripping ChatGPT's
// own "too many requests" limiting. These tests cover the local (no GPT
// request) preflight gate review() now runs immediately before every send,
// and the failure snapshot captured on any review() failure/timeout.

test('a healthy Reviewer preflight passes and never sends a GPT prompt to establish that', async () => {
  const config = nextConfig();
  const seenActions = [];
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      seenActions.push(msg.payload.action);
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 60 } }));
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: { text: '', preflight: healthyPreflight(msg.payload.tabId) },
          })
        );
        return;
      }
      ws.send(
        JSON.stringify({
          protocol: PROTOCOL_ID,
          type: 'response',
          requestId: msg.requestId,
          payload: { text: reviewResultText({ decision: 'PASS' }), conversationId: 'conv-preflight-ok' },
        })
      );
    },
    { autoPreflight: false }
  );

  const session = new ReviewerSession(config);
  await session.create('task-1');
  const result = await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(result.decision, 'PASS');
  assert.deepEqual(seenActions, ['supervisorCreate', 'reviewerPreflight', 'supervisorAsk'], 'preflight must run before the real review send, and must be its own request rather than piggy-backing on it');
  client.close();
});

test('review() fails immediately, without sending the review prompt, when preflight finds the tab gone', async () => {
  const config = nextConfig();
  const seenActions = [];
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      seenActions.push(msg.payload.action);
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 61 } }));
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              preflight: {
                tabId: msg.payload.tabId,
                tabExists: false,
                url: null,
                tabStatus: null,
                active: null,
                discarded: null,
                contentScriptReachable: false,
                pageReady: null,
                composerExists: null,
                composerConnected: null,
                composerInteractive: null,
              },
            },
          })
        );
        return;
      }
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-x' } }));
    },
    { autoPreflight: false }
  );

  const session = new ReviewerSession(config);
  await session.create('task-1');
  await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()), ReviewerTabLostError);

  assert.deepEqual(seenActions, ['supervisorCreate', 'reviewerPreflight'], 'a missing/dead tab must fail before the review prompt is ever sent');
  client.close();
});

test('review() fails immediately with CONTENT_SCRIPT_UNREACHABLE when the tab exists but its content script does not respond', async () => {
  const config = nextConfig();
  const seenActions = [];
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      seenActions.push(msg.payload.action);
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 62 } }));
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              preflight: {
                tabId: msg.payload.tabId,
                tabExists: true,
                url: 'https://chatgpt.com/c/existing',
                tabStatus: 'complete',
                active: false,
                discarded: false,
                contentScriptReachable: false,
                pageReady: null,
                composerExists: null,
                composerConnected: null,
                composerInteractive: null,
              },
            },
          })
        );
        return;
      }
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-x' } }));
    },
    { autoPreflight: false }
  );

  const session = new ReviewerSession(config);
  await session.create('task-1');
  let err;
  try {
    await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());
  } catch (caught) {
    err = caught;
  }
  assert.equal(err?.name, 'ReviewerPreflightError');
  assert.equal(err?.code, 'CONTENT_SCRIPT_UNREACHABLE');

  assert.deepEqual(seenActions, ['supervisorCreate', 'reviewerPreflight'], 'an unreachable content script must fail before the review prompt is ever sent');
  client.close();
});

test('review() fails immediately with CHATGPT_PAGE_NOT_READY when the content script responds but the composer is not usable', async () => {
  const config = nextConfig();
  const seenActions = [];
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      seenActions.push(msg.payload.action);
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 63 } }));
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              preflight: {
                tabId: msg.payload.tabId,
                tabExists: true,
                url: 'https://chatgpt.com/c/existing',
                tabStatus: 'complete',
                active: false,
                discarded: false,
                contentScriptReachable: true,
                pageReady: false,
                composerExists: false,
                composerConnected: false,
                composerInteractive: false,
              },
            },
          })
        );
        return;
      }
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: reviewResultText(), conversationId: 'conv-x' } }));
    },
    { autoPreflight: false }
  );

  const session = new ReviewerSession(config);
  await session.create('task-1');
  let err;
  try {
    await session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence());
  } catch (caught) {
    err = caught;
  }
  assert.equal(err?.name, 'ReviewerPreflightError');
  assert.equal(err?.code, 'CHATGPT_PAGE_NOT_READY');

  assert.deepEqual(seenActions, ['supervisorCreate', 'reviewerPreflight'], 'a not-ready page must fail before the review prompt is ever sent');
  client.close();
});

test('a supervisorAsk timeout still triggers a final failure snapshot, even though the original request never returned', async () => {
  const config = nextConfig({ responseTimeoutMs: 50, requestTimeoutMs: 300 });
  const seenActions = [];
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      seenActions.push(msg.payload.action);
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 64 } }));
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: { text: '', preflight: healthyPreflight(msg.payload.tabId) },
          })
        );
        return;
      }
      // supervisorAsk: never respond — the request's own requestTimeoutMs
      // fires client-side, exactly like a real ResponseTimeoutError/
      // RequestTimeoutError where the extension never replies at all.
    },
    { autoPreflight: false }
  );

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()));
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  assert.deepEqual(seenActions, ['supervisorCreate', 'reviewerPreflight', 'supervisorAsk', 'reviewerPreflight'], 'a timeout must still trigger a second, final preflight snapshot');

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  assert.ok(
    diagLines.some((l) => l.includes('reviewer failure snapshot') && l.includes('taskId=task-1') && l.includes('tabId=64')),
    'a timeout must produce a final failure snapshot log line'
  );
});

test("a supervisorAsk timeout looks up and logs the extension's last known stage for that EXACT requestId", async () => {
  const config = nextConfig({ responseTimeoutMs: 50, requestTimeoutMs: 300 });
  let supervisorAskRequestId = null;
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 70 } }));
        return;
      }
      if (msg.payload.action === 'supervisorAsk') {
        supervisorAskRequestId = msg.requestId;
        return; // never respond — the original request times out client-side
      }
      if (msg.payload.action === 'diagnosticStage') {
        assert.equal(
          msg.payload.originalRequestId,
          supervisorAskRequestId,
          'the diagnostic lookup must ask about the exact requestId the timed-out supervisorAsk used'
        );
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              stageRecord: { requestId: supervisorAskRequestId, tabId: 70, stage: 'assistant response observed', timestamp: Date.now() - 1234 },
            },
          })
        );
        return;
      }
    },
    { autoDiagnosticStage: false }
  );

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()));
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  assert.ok(supervisorAskRequestId, 'the fake extension must have observed a supervisorAsk request');
  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  const snapshotLine = diagLines.find(
    (l) => l.includes('reviewer failure snapshot:') && l.includes(`originalRequestId=${supervisorAskRequestId}`)
  );
  assert.ok(snapshotLine, 'must log a failure snapshot line naming the exact original requestId');
  assert.ok(snapshotLine.includes('tabId=70'));
  assert.ok(snapshotLine.includes('lastExtensionStage=assistant response observed'));
  assert.match(snapshotLine, /stageAgeMs=\d+/);
});

// The 2026-08-27 live finding this guards against: a Reviewer preflight
// immediately before supervisorAsk was fully healthy, supervisorAsk then
// timed out, and by the time the failure snapshot ran, the tab was a blank
// chrome://... page — yet the stage lookup itself failed with NO_CHATGPT_TAB
// ("Cannot access a chrome:// URL"), even though the lookup is documented to
// never touch a tab at all. These two tests prove the diagnosticStage lookup
// succeeds off the retained stage record no matter what state the ORIGINAL
// tab is in by the time the lookup runs — closed, gone, or parked on a
// chrome:// URL the follow-up preflight can't read — because the fake
// extension side below never inspects payload.tabId/chatgptUrl (there is
// none to inspect) to answer it.
test('diagnosticStage still returns the retained stage record when the original tab no longer exists', async () => {
  const config = nextConfig({ responseTimeoutMs: 50, requestTimeoutMs: 300 });
  let supervisorAskRequestId = null;
  let preflightCalls = 0;
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 80 } }));
        return;
      }
      if (msg.payload.action === 'supervisorAsk') {
        supervisorAskRequestId = msg.requestId;
        return; // never respond — times out client-side
      }
      if (msg.payload.action === 'diagnosticStage') {
        assert.equal(msg.payload.tabId, undefined, 'diagnosticStage must never carry a tabId to resolve');
        assert.equal(msg.payload.chatgptUrl, undefined, 'diagnosticStage must never carry a URL to navigate/validate');
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              stageRecord: { requestId: supervisorAskRequestId, tabId: 80, stage: 'relay started', timestamp: Date.now() - 500 },
            },
          })
        );
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        preflightCalls += 1;
        // First call is review()'s own pre-ask gate — must be healthy so the
        // flow actually reaches supervisorAsk. Only the SECOND call (the
        // post-timeout failure snapshot) finds the tab gone — this is the
        // "no tab"/"closed tab" side of the live finding, and it must not
        // affect the (separate) diagnosticStage lookup above.
        const preflight =
          preflightCalls === 1
            ? healthyPreflight(msg.payload.tabId)
            : {
                tabId: msg.payload.tabId,
                tabExists: false,
                url: null,
                tabStatus: null,
                active: null,
                discarded: null,
                contentScriptReachable: false,
                pageReady: null,
                composerExists: null,
                composerConnected: null,
                composerInteractive: null,
              };
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', preflight } }));
        return;
      }
    },
    { autoDiagnosticStage: false, autoPreflight: false }
  );

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()));
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  const snapshotLine = diagLines.find(
    (l) => l.includes('reviewer failure snapshot:') && l.includes(`originalRequestId=${supervisorAskRequestId}`)
  );
  assert.ok(snapshotLine, 'the stage lookup must succeed and log, independent of the tab being gone');
  assert.ok(snapshotLine.includes('lastExtensionStage=relay started'));
});

test('diagnosticStage still returns the retained stage record when the original tab is now a chrome:// page the content script cannot reach', async () => {
  const config = nextConfig({ responseTimeoutMs: 50, requestTimeoutMs: 300 });
  let supervisorAskRequestId = null;
  let preflightCalls = 0;
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 81 } }));
        return;
      }
      if (msg.payload.action === 'supervisorAsk') {
        supervisorAskRequestId = msg.requestId;
        return; // never respond — times out client-side
      }
      if (msg.payload.action === 'diagnosticStage') {
        assert.equal(msg.payload.tabId, undefined, 'diagnosticStage must never carry a tabId to resolve');
        assert.equal(msg.payload.chatgptUrl, undefined, 'diagnosticStage must never carry a URL to navigate/validate');
        ws.send(
          JSON.stringify({
            protocol: PROTOCOL_ID,
            type: 'response',
            requestId: msg.requestId,
            payload: {
              text: '',
              stageRecord: { requestId: supervisorAskRequestId, tabId: 81, stage: 'target tab resolved', timestamp: Date.now() - 500 },
            },
          })
        );
        return;
      }
      if (msg.payload.action === 'reviewerPreflight') {
        preflightCalls += 1;
        // First call is review()'s own pre-ask gate — must be healthy so the
        // flow actually reaches supervisorAsk. Only the SECOND call (the
        // post-timeout failure snapshot) finds the tab navigated to a blank
        // chrome:// page — the exact live symptom: a healthy preflight
        // followed by a blank chrome:// tab, with content script unreachable.
        const preflight =
          preflightCalls === 1
            ? healthyPreflight(msg.payload.tabId)
            : {
                tabId: msg.payload.tabId,
                tabExists: true,
                url: 'chrome://new-tab-page/',
                tabStatus: 'complete',
                active: false,
                discarded: false,
                contentScriptReachable: false,
                pageReady: null,
                composerExists: null,
                composerConnected: null,
                composerInteractive: null,
              };
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', preflight } }));
        return;
      }
    },
    { autoDiagnosticStage: false, autoPreflight: false }
  );

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()));
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  const snapshotLine = diagLines.find(
    (l) => l.includes('reviewer failure snapshot:') && l.includes(`originalRequestId=${supervisorAskRequestId}`)
  );
  assert.ok(snapshotLine, 'the stage lookup must succeed and log, independent of the tab being on a chrome:// URL');
  assert.ok(snapshotLine.includes('lastExtensionStage=target tab resolved'));

  // The separate preflight snapshot line (same failure) is allowed to report
  // the chrome:// page as unreachable — that is real information about the
  // tab. It must not be the reason the stage lookup itself failed.
  const preflightLine = diagLines.find((l) => l.includes('reviewer failure snapshot taskId=task-1'));
  assert.ok(preflightLine, 'the follow-up preflight snapshot must still run and log even though the page is unreachable');
  assert.ok(preflightLine.includes('contentScript=unreachable'));
});

test('a supervisorAsk timeout with no available stage record logs that plainly, without crashing the failure snapshot', async () => {
  const config = nextConfig({ responseTimeoutMs: 50, requestTimeoutMs: 300 });
  const client = await connectFakeExtension(
    config,
    (ws, msg) => {
      if (msg.payload.action === 'supervisorCreate') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 71 } }));
        return;
      }
      if (msg.payload.action === 'supervisorAsk') return; // never respond
      if (msg.payload.action === 'diagnosticStage') {
        ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', stageRecord: null } }));
        return;
      }
    },
    { autoDiagnosticStage: false }
  );

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()));
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  assert.ok(
    diagLines.some((l) => l.includes('reviewer failure snapshot:') && l.includes('lastExtensionStage=unavailable (no stage record found)')),
    'a missing stage record must be logged plainly rather than silently skipped'
  );
});

test('preflight and failure-snapshot log lines carry identifiers/state only, never review content', async () => {
  const config = nextConfig();
  const client = await connectFakeExtension(config, (ws, msg) => {
    if (msg.payload.action === 'supervisorCreate') {
      ws.send(JSON.stringify({ protocol: PROTOCOL_ID, type: 'response', requestId: msg.requestId, payload: { text: '', tabId: 65 } }));
      return;
    }
    ws.send(
      JSON.stringify({
        protocol: PROTOCOL_ID,
        type: 'error',
        requestId: msg.requestId,
        error: { code: 'SUPERVISOR_TAB_LOST', message: 'gone' },
      })
    );
  });

  const originalConsoleError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  try {
    const session = new ReviewerSession(config);
    await session.create('task-1');
    await assert.rejects(() => session.review('task-1', demoTaskCard(), demoExecutionReport(), demoEvidence()), ReviewerTabLostError);
  } finally {
    console.error = originalConsoleError;
  }
  client.close();

  const diagLines = lines.filter((l) => l.startsWith('gpt-loop: '));
  assert.ok(diagLines.some((l) => l.includes('reviewer preflight:') && l.includes('composer=ready')));
  assert.ok(diagLines.some((l) => l.includes('reviewer failure snapshot') && l.includes('composer=ready')));

  // Every preflight/snapshot line must be built only from identifiers and
  // classified state (tabId/urlState/tabStatus/active/discarded/
  // contentScript/pageReady/composer) — never the demo Task Card/Evidence
  // content, and never the full ChatGPT URL healthyPreflight() carries.
  const forbidden = ['some test value must be verified', 'src/foo.js', 'https://chatgpt.com/c/existing-conversation'];
  for (const line of diagLines) {
    for (const needle of forbidden) {
      assert.ok(!line.includes(needle), `preflight/snapshot log must never contain review content or a raw URL, found "${needle}" in: ${line}`);
    }
  }
});
