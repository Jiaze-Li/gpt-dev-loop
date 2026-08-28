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
import { buildSupervisorPrompt, parseSupervisorDecision } from '../orchestrator/supervisorProtocol.js';

const NOT_CREATED_MESSAGE = 'SupervisorSession.create() has not been called (or did not succeed) — there is no tab to address.';
const ALREADY_CREATED_MESSAGE =
  'SupervisorSession.create() was already called for this session. Call close() before creating a new one.';

async function runSupervisorCreate(server, config, requestId, windowId) {
  try {
    return await server.supervisorCreate({
      requestId,
      chatgptUrl: config.chatgptUrl,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
      windowId,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorAttach(server, config, requestId, conversationId) {
  try {
    return await server.supervisorAttach(conversationId, {
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
  // `windowId` is an optional diagnostic override (undefined by default, so
  // chrome.tabs.create's own "current window" default governs) — added only
  // for scripts/test-background-automation-window-live.js, which creates
  // the tab inside a dedicated, deliberately unfocused window. No production
  // caller passes `windowId` today.
  async create({ windowId } = {}) {
    if (this._tabId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorCreate(server, this.config, requestId, windowId),
      this.config.requestTimeoutMs,
      `Supervisor create request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._tabId = result.tabId;
    return this.getIdentity();
  }

  // Re-attaches this session to an EXISTING conversation by its exact
  // ChatGPT conversationId — never creates a new conversation (that's what
  // create() is for). Opens a fresh worker tab navigated directly to
  // /c/<conversationId>, and only resolves once the extension has verified
  // — from real DOM/URL evidence, not a guess — that the tab actually ended
  // up showing that exact conversation
  // (extension/domActions.js's verifyAttachedConversationId). Any
  // divergence (a redirect, the conversation not existing/being
  // inaccessible, a login wall, or the tab never settling at all) rejects
  // with SupervisorAttachMismatchError and leaves this session exactly as
  // if attach() had never been called (this._tabId stays null) — it never
  // silently falls back to creating a fresh conversation. Once attach()
  // succeeds, ask()/decide() work exactly as they do after create().
  async attach(conversationId) {
    if (!conversationId) throw new Error('SupervisorSession.attach(conversationId) requires a non-empty conversationId.');
    if (this._tabId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorAttach(server, this.config, requestId, conversationId),
      this.config.requestTimeoutMs,
      `Supervisor attach request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._tabId = result.tabId;
    this._conversationId = result.conversationId;
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

  // Thin structured-decision wrapper around ask(): builds the Supervisor
  // prompt from `context` (supervisorProtocol.js's buildSupervisorPrompt),
  // sends it into this same persistent conversation, and returns the
  // parsed decision (parseSupervisorDecision) instead of the raw reply
  // text. Throws AdapterError(SUPERVISOR_INVALID_OUTPUT) exactly as
  // parseSupervisorDecision does if the reply isn't a valid decision — this
  // wrapper adds no further validation of its own.
  async decide(context) {
    const reply = await this.ask(buildSupervisorPrompt(context));
    return parseSupervisorDecision(reply);
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
