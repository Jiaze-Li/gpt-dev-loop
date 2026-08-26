// Loopback-only WebSocket server the Chrome extension's background service
// worker connects to. This is the "localhost bridge" half of the extension
// transport (docs/handoff/2026-08-25-chrome-extension-bridge.md); the other
// half is chatgptExtension.js, which is the only caller of `ask()` below and
// the only place protocol error codes get mapped to bridge/errors.js
// classes.
//
// One process-wide singleton (mirrors chromeRuntime.js's `activeRuntime`
// pattern), started lazily on the first `ask()` call. Accepts at most one
// active connection at a time — a new connection replaces (closes) the
// previous one, matching the "no multi-Chrome" non-goal.

import { WebSocketServer } from 'ws';
import { ChromeUnavailableError, ResponseTimeoutError } from './errors.js';
import { buildHelloAck, buildRequestMessage, parseMessage, ExtensionProtocolError } from './extensionProtocol.js';

const SERVER_VERSION = '1';

// The content script's own responseTimeoutMs clock only starts once it has
// found the composer (findComposer can itself take up to 5s) and does its
// own message-passing round trip back through background.js before this
// server sees anything — so it always needs strictly more than
// responseTimeoutMs of *our* clock to legitimately report its own, more
// specific error (RESPONSE_TIMEOUT/RESPONSE_EMPTY/LOGIN_REQUIRED/etc).
// Without this margin, our own timer here would almost always win that
// race and mask the real reason behind a generic "did not reply" message.
// Mirrors background.js's TAB_MESSAGE_TIMEOUT_MARGIN_MS.
const RESPONSE_TIMER_MARGIN_MS = 10000;

function log(message) {
  console.error(`gpt-loop: ${message}`);
}

export class ExtensionServer {
  constructor(config) {
    this.host = config.extensionHost;
    this.port = config.extensionPort;
    this.extensionId = config.extensionId;
    // "Worker window" lifecycle listeners — the ChatGPT tab this server
    // relays requests to, from the caller's point of view a WS
    // connect/disconnect *is* that worker window becoming available/going
    // away. Kept as a plain Set (not Node's EventEmitter) since this is the
    // only thing that needs it and the extension sandbox side of this
    // protocol (background.js) can't import node:events anyway — this file
    // stays a plausible model for what that side would need to mirror.
    this._lifecycleListeners = new Set();
    this.wss = null;
    this.conn = null;
    this.ready = false;
    this.queue = [];
    this.inFlight = null;
  }

  // Subscribes to "worker window" lifecycle events (`{ type: 'connected' |
  // 'disconnected', extensionVersion?, capabilities? }`), fired from the
  // same points as the console log lines just below (hello / _onClose).
  // Returns an unsubscribe function. A caller that wants these tied to a
  // specific workflow's event log (orchestratorCli.js) is expected to
  // subscribe around just its own runTask() call and unsubscribe after —
  // this server is a process-wide singleton reused across unrelated calls,
  // so listeners left attached would misattribute later connects/
  // disconnects to a workflow that already finished.
  onLifecycle(listener) {
    this._lifecycleListeners.add(listener);
    return () => this._lifecycleListeners.delete(listener);
  }

  _emitLifecycle(event) {
    for (const listener of this._lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        log(`worker window lifecycle listener threw: ${err.message}`);
      }
    }
  }

  start() {
    if (this.wss) return;
    this.wss = new WebSocketServer({
      host: this.host,
      port: this.port,
      verifyClient: ({ origin }) => this._verifyOrigin(origin),
    });
    this.wss.on('listening', () => {
      log(`bridge server listening on ${this.host}:${this.port}, waiting for the Chrome extension to connect...`);
    });
    this.wss.on('connection', (ws) => this._onConnection(ws));
    this.wss.on('error', (err) => {
      const hint =
        err.code === 'EADDRINUSE'
          ? ` — port ${this.port} is already in use, most likely by another gpt-loop process (a previous \`ask\` invocation that didn't exit cleanly). Find it with \`lsof -i :${this.port}\` and stop it, then retry.`
          : '';
      log(`bridge server error: ${err.message}${hint}`);
      // A listen failure (e.g. EADDRINUSE) means this server will never
      // reach 'listening' and can never receive a connection — waiting out
      // the full connectTimeoutMs would just produce a misleading "no
      // extension connected" message instead of the real cause above.
      this.wss = null;
      this._failAll(new ChromeUnavailableError(`Extension bridge server failed to start: ${err.message}${hint}`));
    });
  }

  _verifyOrigin(origin) {
    if (!this.extensionId) {
      log(
        'GPT_LOOP_EXTENSION_ID is not set; refusing all extension connections until it is configured (see extension/README.md).'
      );
      return false;
    }
    if (origin !== `chrome-extension://${this.extensionId}`) {
      log(
        `rejected connection from origin "${origin}" — expected "chrome-extension://${this.extensionId}" (GPT_LOOP_EXTENSION_ID). Check the extension ID matches chrome://extensions.`
      );
      return false;
    }
    return true;
  }

  // A newly opened TCP connection is not promoted to `this.conn` until it
  // actually sends `hello` (handled in _onMessage) — an unhandshaked socket
  // (e.g. something that merely passed the Origin check but never speaks
  // the protocol) must not be able to interrupt an already-working
  // connection.
  _onConnection(ws) {
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => this._onClose(ws));
    ws.on('error', (err) => log(`extension connection error: ${err.message}`));
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = parseMessage(raw.toString());
    } catch (err) {
      log(`ignoring malformed message from extension: ${err.message}`);
      return;
    }

    if (msg.type === 'hello') {
      const previous = this.conn;
      this.conn = ws;
      this.ready = true;
      log(
        `extension connected (version ${msg.payload?.extensionVersion ?? 'unknown'}, capabilities: ${
          (msg.payload?.capabilities ?? []).join(', ') || 'none'
        })`
      );
      this._emitLifecycle({
        type: 'connected',
        extensionVersion: msg.payload?.extensionVersion ?? 'unknown',
        capabilities: msg.payload?.capabilities ?? [],
      });
      if (previous && previous !== ws && previous.readyState === previous.OPEN) {
        previous.close(4000, 'replaced by newer connection');
      }
      ws.send(JSON.stringify(buildHelloAck(msg.requestId, SERVER_VERSION)));
      // A connection now exists — queued entries no longer need their
      // "no extension connected at all" guard; from here on they're just
      // waiting their FIFO turn, bounded by the caller's own
      // requestTimeoutMs (see cancel()), not extensionConnectTimeoutMs.
      for (const entry of this.queue) clearTimeout(entry.connectTimer);
      this._pump();
      return;
    }

    if (ws !== this.conn) return; // message from a non-active (old/never-hello'd) socket
    if (msg.type === 'response' || msg.type === 'error') {
      this._settle(msg);
    }
  }

  _onClose(ws) {
    if (ws !== this.conn) return; // a socket that was never promoted to active
    log('extension disconnected');
    this.conn = null;
    this.ready = false;
    this._emitLifecycle({ type: 'disconnected' });
    this._failAll(new ChromeUnavailableError('Chrome extension disconnected while a request was in flight.'));
  }

  // Rejects the in-flight request (if any) and every still-queued request
  // with `err`. Used on disconnect and on server shutdown — a queued
  // request must not be left to linger until its own timer fires, and must
  // not survive to be sent to a later, unrelated connection.
  _failAll(err) {
    if (this.inFlight) {
      const inFlight = this.inFlight;
      this.inFlight = null;
      inFlight.reject(err);
    }
    while (this.queue.length) {
      const entry = this.queue.shift();
      clearTimeout(entry.connectTimer);
      entry.reject(err);
    }
  }

  // Enqueues one review prompt. Resolves with the reply text, or rejects
  // with either a bridge/errors.js TransportError (connect timeout, no
  // reply within responseTimeoutMs, disconnect) or an ExtensionProtocolError
  // carrying whatever code the extension reported (mapped to a
  // bridge/errors.js class by chatgptExtension.js, not here).
  //
  // `requestId` is generated by the caller (chatgptExtension.js), not here,
  // so the caller can call cancel(requestId) if its own overall
  // requestTimeoutMs fires while this is still queued/in flight.
  ask(prompt, { requestId, chatgptUrl, responseTimeoutMs, connectTimeoutMs }) {
    return this._enqueue({ requestId, action: 'ask', prompt, chatgptUrl, responseTimeoutMs, connectTimeoutMs });
  }

  // Enqueues one conversation deletion. Resolves once the extension
  // confirms the conversation's sidebar row is gone (see
  // extension/domActions.js's deleteConversation postcondition), or rejects
  // the same way ask() does.
  deleteConversation(conversationId, { requestId, chatgptUrl, responseTimeoutMs, connectTimeoutMs }) {
    return this._enqueue({ requestId, action: 'delete', conversationId, chatgptUrl, responseTimeoutMs, connectTimeoutMs });
  }

  _enqueue({ requestId, action, prompt, conversationId, chatgptUrl, responseTimeoutMs, connectTimeoutMs }) {
    this.start();
    return new Promise((resolve, reject) => {
      const entry = { requestId, action, prompt, conversationId, chatgptUrl, responseTimeoutMs, resolve, reject, connectTimer: null };
      // Only guards "no extension has ever connected yet". If a connection
      // is already ready, this entry is merely waiting its FIFO turn behind
      // other queued work — that wait is bounded by the caller's own
      // requestTimeoutMs (via cancel()), not connectTimeoutMs, so no timer
      // is armed in that case.
      if (!this.ready) {
        entry.connectTimer = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx === -1) return; // already dequeued/sent
          this.queue.splice(idx, 1);
          reject(new ChromeUnavailableError(`No Chrome extension connected within ${connectTimeoutMs}ms.`));
        }, connectTimeoutMs);
      }
      this.queue.push(entry);
      this._pump();
    });
  }

  // Frees up whatever slot `requestId` occupies (queued or in-flight)
  // without waiting for its own timers. Called by chatgptExtension.js when
  // the caller's overall requestTimeoutMs fires — otherwise an abandoned
  // request would keep occupying the single in-flight slot (or sit in the
  // queue) until its own connect/response timer eventually fires,
  // needlessly delaying every request behind it.
  cancel(requestId) {
    const idx = this.queue.findIndex((entry) => entry.requestId === requestId);
    if (idx !== -1) {
      clearTimeout(this.queue[idx].connectTimer);
      this.queue.splice(idx, 1);
      return;
    }
    if (this.inFlight?.requestId === requestId) {
      this.inFlight.reject(new ChromeUnavailableError('Request cancelled after its overall timeout elapsed.'));
    }
  }

  // Single in-flight request at a time (documented FIFO queue policy — see
  // handoff "并发策略"): later askGpt() calls simply wait their turn.
  _pump() {
    if (this.inFlight || !this.ready || !this.conn || this.queue.length === 0) return;
    const entry = this.queue.shift();
    clearTimeout(entry.connectTimer);

    const responseTimer = setTimeout(() => {
      this.inFlight = null;
      entry.reject(
        new ResponseTimeoutError(
          `Extension did not reply within ${entry.responseTimeoutMs + RESPONSE_TIMER_MARGIN_MS}ms (no response/error message arrived — check the ChatGPT tab's own devtools console for [gpt-loop bridge] logs to see which stage it was stuck at).`
        )
      );
      this._pump();
    }, entry.responseTimeoutMs + RESPONSE_TIMER_MARGIN_MS);

    this.inFlight = {
      requestId: entry.requestId,
      resolve: (payload) => {
        clearTimeout(responseTimer);
        this.inFlight = null;
        entry.resolve(payload);
        this._pump();
      },
      reject: (err) => {
        clearTimeout(responseTimer);
        this.inFlight = null;
        entry.reject(err);
        this._pump();
      },
    };

    this.conn.send(
      JSON.stringify(
        buildRequestMessage(entry.requestId, {
          action: entry.action,
          prompt: entry.prompt,
          conversationId: entry.conversationId,
          chatgptUrl: entry.chatgptUrl,
          responseTimeoutMs: entry.responseTimeoutMs,
        })
      )
    );
  }

  _settle(msg) {
    if (!this.inFlight || msg.requestId !== this.inFlight.requestId) return;
    if (msg.type === 'response') {
      this.inFlight.resolve({
        text: msg.payload.text,
        conversationId: msg.payload.conversationId,
        ...(msg.payload.identityDiagnostics !== undefined ? { identityDiagnostics: msg.payload.identityDiagnostics } : {}),
      });
    } else {
      this.inFlight.reject(new ExtensionProtocolError(msg.error.code, msg.error.message ?? msg.error.code));
    }
  }

  async close() {
    if (this.conn) this.conn.close(1001, 'server shutting down');
    this.conn = null;
    this.ready = false;
    this._failAll(new ChromeUnavailableError('Extension bridge server is shutting down.'));
    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
      this.wss = null;
    }
  }
}

let activeServer = null;

export function getExtensionServer(config) {
  const identityChanged =
    activeServer &&
    (activeServer.host !== config.extensionHost ||
      activeServer.port !== config.extensionPort ||
      activeServer.extensionId !== config.extensionId);
  if (activeServer && identityChanged) {
    // Fire-and-forget close of the stale server; a brand new one is handed
    // back immediately so the caller never blocks on the old one tearing
    // down (mirrors chromeRuntime.js's identity-change handling).
    activeServer.close().catch(() => {});
    activeServer = null;
  }
  if (!activeServer) {
    activeServer = new ExtensionServer(config);
  }
  return activeServer;
}

export async function closeExtensionServer() {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = null;
  await server.close();
}
