// SupervisorSession: one persistent ChatGPT conversation held open across
// many ask() calls, addressed by an explicit Chrome tabId — never "whichever
// ChatGPT tab is active". This is the first small step of Issue #2
// (Supervisor conversation and reviewer lifecycle orchestration): only the
// persistent-conversation primitive itself. It is not wired into any
// Task-Card/PASS-REWORK policy, not wired to Claude, and not wired to the
// Reviewer — those are later steps.
//
// Deliberately the mirror image of chatgptExtension.js's Reviewer lifecycle:
//
//   Reviewer (askGptWithIdentity + deleteConversation):
//     fresh conversation -> one review -> delete conversation -> close tab
//
//   Supervisor (this file):
//     create() once -> preserve conversation & tab across many ask() calls
//     -> never delete/close between calls -> close() only when requested
//
// Built on the same extensionServer.js queue/protocol infrastructure as
// chatgptExtension.js (supervisorCreate/supervisorAsk/supervisorClose
// actions — see extensionServer.js and extensionProtocol.js's
// buildRequestMessage), and reuses chatgptExtension.js's mapProtocolError so
// both callers of the extension bridge map wire error codes identically.
// The actual DOM work happens through extension/domActions.js's existing,
// already-verified findComposer/sendPromptReliably/waitForConversationIdentity
// /waitForReply primitives (see extension/content.js's handleSupervisorAsk)
// — no new send/reply/identity logic was written for this.

import { randomUUID } from 'node:crypto';
import { getExtensionServer } from './extensionServer.js';
import { withTimeout } from './chromeRuntime.js';
import { mapProtocolError } from './chatgptExtension.js';
import { TransportError, ChromeUnavailableError } from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';

const NOT_CREATED_MESSAGE = 'SupervisorSession.create() has not been called (or did not succeed) — there is no tab to address.';
const ALREADY_CREATED_MESSAGE =
  'SupervisorSession.create() was already called for this session. Call close() before creating a new one.';

async function runSupervisorCreate(server, config, requestId) {
  try {
    return await server.supervisorCreate({
      requestId,
      chatgptUrl: config.chatgptUrl,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorAsk(server, config, requestId, tabId, prompt, expectedConversationId) {
  try {
    return await server.supervisorAsk(prompt, {
      requestId,
      tabId,
      expectedConversationId,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorClose(server, config, requestId, tabId) {
  try {
    return await server.supervisorClose({
      requestId,
      tabId,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

export class SupervisorSession {
  constructor(config) {
    this.config = config;
    this._tabId = null;
    this._conversationId = null;
  }

  // { tabId, conversationId } — conversationId is null until the first
  // ask() has actually landed a reply (ChatGPT does not assign a
  // conversation id until the first message is sent; see
  // extension/domActions.js's identity doc comments). Never derived from
  // the tab's title.
  getIdentity() {
    return { tabId: this._tabId, conversationId: this._conversationId };
  }

  // Opens exactly one fresh ChatGPT tab and leaves it open. Does not send
  // any prompt and does not (cannot yet) capture a conversation id.
  async create() {
    if (this._tabId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorCreate(server, this.config, requestId),
      this.config.requestTimeoutMs,
      `Supervisor create request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._tabId = result.tabId;
    return this.getIdentity();
  }

  // Sends one prompt into the SAME tab/conversation create() (or the
  // previous ask()) established, and waits for the reply. Always addresses
  // this._tabId explicitly — never "the most recently used ChatGPT tab".
  //
  // If this is the first ask(), whatever id the extension captures becomes
  // this session's conversation identity going forward. On every later
  // ask(), the already-known id is sent along as `expectedConversationId`;
  // the extension refuses (SUPERVISOR_IDENTITY_MISMATCH) rather than
  // silently continuing if the tab's actual conversation no longer matches
  // — e.g. someone manually navigated it elsewhere.
  async ask(prompt) {
    if (this._tabId === null) throw new Error(NOT_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorAsk(server, this.config, requestId, this._tabId, prompt, this._conversationId),
      this.config.requestTimeoutMs,
      `Supervisor ask request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._conversationId = result.conversationId;
    return result.text;
  }

  // Closes just this session's own tab (a plain chrome.tabs.remove — never
  // the ChatGPT in-page delete flow; conversation deletion is out of scope
  // for the Supervisor primitive in this step). A no-op if create() was
  // never called or already failed. background.js's handleSupervisorClose
  // is itself idempotent — an already-gone tab (the user closed it
  // themselves) is treated as already-closed there, not reported as an
  // error here.
  async close() {
    if (this._tabId === null) return;
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const tabId = this._tabId;
    this._tabId = null;
    this._conversationId = null;
    await withTimeout(
      runSupervisorClose(server, this.config, requestId, tabId),
      this.config.requestTimeoutMs,
      `Supervisor close request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
  }
}
