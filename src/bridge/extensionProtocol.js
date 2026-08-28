// Wire protocol between the local extension bridge server
// (extensionServer.js) and the Chrome extension's background service
// worker. Pure functions only — no WebSocket/Chrome API here, so both this
// file's logic and its test can run in plain Node.
//
// Envelope shape (JSON text frames):
//   { protocol, type, requestId, payload?, error? }
//
// type: 'hello' | 'hello_ack' | 'request' | 'response' | 'error'

export const PROTOCOL_ID = 'gpt-loop-extension/v1';

export const MESSAGE_TYPES = Object.freeze(['hello', 'hello_ack', 'request', 'response', 'error']);

// Error codes the extension side is allowed to report. Any other code
// received from the extension is treated as INTERNAL_ERROR by the server —
// see extensionServer.js.
export const RESULT_ERROR_CODES = Object.freeze([
  'NO_CHATGPT_TAB',
  'LOGIN_REQUIRED',
  'COMPOSER_NOT_FOUND',
  'SEND_BUTTON_NOT_FOUND',
  'RESPONSE_TIMEOUT',
  'RESPONSE_EMPTY',
  'SEND_FAILED',
  'PROMPT_INSERTION_TIMEOUT',
  'PROMPT_INSERTION_FAILED',
  'RATE_LIMITED',
  'CONVERSATION_NOT_FOUND',
  'DELETE_MENU_NOT_FOUND',
  'DELETE_NOT_CONFIRMED',
  'CONVERSATION_IDENTITY_NOT_FOUND',
  'SUPERVISOR_TAB_LOST',
  'SUPERVISOR_IDENTITY_MISMATCH',
  'SUPERVISOR_ATTACH_MISMATCH',
  'INTERNAL_ERROR',
]);

// Carries whatever error code the extension reported (one of
// RESULT_ERROR_CODES). Not a bridge/errors.js TransportError subclass —
// mapping this to one is chatgptExtension.js's job (see the handoff's
// "错误映射" table), keeping this module transport/error-taxonomy-agnostic.
export class ExtensionProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionProtocolError';
    this.code = code;
  }
}

export function buildHelloAck(requestId, serverVersion) {
  return { protocol: PROTOCOL_ID, type: 'hello_ack', requestId, payload: { serverVersion } };
}

// `action`: 'ask' (default, one-shot Reviewer flow, needs `prompt`, gets a
// fresh tab), 'delete' (needs `conversationId`, no prompt), or the
// Supervisor set — 'supervisorCreate' (opens a fresh, blank tab and leaves
// it open, no prompt), 'supervisorAttach' (needs `conversationId`, opens a
// tab navigated directly to that EXISTING conversation and never creates a
// new one), 'supervisorAsk' (needs `tabId` + `prompt`, addresses that exact
// tab rather than creating one, and carries `expectedConversationId` so the
// content script can refuse to silently continue in the wrong
// conversation), 'supervisorClose' (needs `tabId`, closes just that tab),
// and 'reviewerPreflight' (needs `tabId`, a zero-GPT-request local read of
// that tab's current chrome-tab/content-script/composer state — never sends
// a prompt, never reloads/retries/creates a tab). All share one envelope
// shape — only what happens inside the tab differs, dispatched on
// `payload.action` by background.js/content.js.
//
// 'diagnosticStage' (needs `originalRequestId`) is a zero-chrome-API local
// read of background.js's in-memory stage store (extension/
// stageDiagnostics.js) for a PREVIOUSLY issued requestId — always sent with
// a brand-new requestId of its own, so a caller can look this up AFTER the
// original request already timed out/was cancelled without depending on
// that original request (or its tab/connection) still being alive. Never
// touches a tab; resolves with `stageRecord` (null if unknown/expired).
//
// The window-lifecycle quartet — 'windowCreate' (opens a dedicated,
// deliberately unfocused window, returns windowId and initialTabId),
// 'windowActivateTab' (needs `tabId`; makes that tab active inside its own
// window WITHOUT focusing the window, returns the observed active/focused
// state), 'windowClose' (needs `windowId`), and 'windowListTabs' (needs
// `windowId`; zero-GPT-request diagnostic, returns safe per-tab metadata
// only — see windowLifecycle.js's listAutomationWindowTabs doc comment) —
// see windowLifecycle.js's header comment for why this exists.
// src/orchestrator/automatedLoop.js (via src/bridge/windowSession.js) is a
// production caller of windowCreate/windowActivateTab/windowClose;
// windowListTabs is diagnostics-only.
export function buildRequestMessage(
  requestId,
  {
    prompt,
    chatgptUrl,
    responseTimeoutMs,
    action = 'ask',
    conversationId,
    tabId,
    expectedConversationId,
    active,
    windowId,
    originalRequestId,
  } = {}
) {
  let payload;
  if (action === 'delete') {
    payload = { action, chatgptUrl, responseTimeoutMs, conversationId };
  } else if (action === 'reviewerPreflight') {
    payload = { action, tabId, responseTimeoutMs };
  } else if (action === 'diagnosticStage') {
    payload = { action, originalRequestId, responseTimeoutMs };
  } else if (action === 'windowCreate') {
    payload = { action, chatgptUrl, responseTimeoutMs };
  } else if (action === 'windowActivateTab') {
    payload = { action, tabId, responseTimeoutMs };
  } else if (action === 'windowClose') {
    payload = { action, windowId, responseTimeoutMs };
  } else if (action === 'windowListTabs') {
    payload = { action, windowId, responseTimeoutMs };
  } else if (action === 'supervisorCreate') {
    // `active` is only ever set by the tab-activation-readiness live
    // diagnostic (scripts/test-tab-activation-readiness-live.js) — omitted
    // entirely for every other caller so background.js's own default
    // (active: false) governs, unchanged. `windowId` is likewise only ever
    // set by scripts/test-background-automation-window-live.js.
    payload = {
      action,
      chatgptUrl,
      responseTimeoutMs,
      ...(active !== undefined ? { active } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
    };
  } else if (action === 'supervisorAttach') {
    payload = { action, chatgptUrl, responseTimeoutMs, conversationId };
  } else if (action === 'supervisorAsk') {
    payload = { action, prompt, responseTimeoutMs, tabId, expectedConversationId: expectedConversationId ?? null };
  } else if (action === 'supervisorClose') {
    payload = { action, tabId, responseTimeoutMs };
  } else {
    payload = { action, prompt, chatgptUrl, responseTimeoutMs };
  }
  return { protocol: PROTOCOL_ID, type: 'request', requestId, payload };
}

// Parses and validates one incoming text frame. Throws a plain Error (not
// one of bridge/errors.js's TransportError subclasses — this module doesn't
// know about transport-level failure semantics, only message shape) when
// the frame is structurally invalid.
export function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  if (!msg || typeof msg !== 'object') {
    throw new Error('message is not an object');
  }
  if (msg.protocol !== PROTOCOL_ID) {
    throw new Error(`unsupported protocol "${msg.protocol}"`);
  }
  if (!MESSAGE_TYPES.includes(msg.type)) {
    throw new Error(`unknown message type "${msg.type}"`);
  }
  if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) {
    throw new Error('missing requestId');
  }
  if (msg.type === 'response' && (typeof msg.payload?.text !== 'string')) {
    throw new Error('response message missing payload.text');
  }
  if (msg.type === 'error' && typeof msg.error?.code !== 'string') {
    throw new Error('error message missing error.code');
  }
  return msg;
}
