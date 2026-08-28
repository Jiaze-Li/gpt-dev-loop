// Stand-in for extension/domActions.js's send/reply/identity primitives,
// used only by tests/supervisorContentScript.test.js to drive content.js's
// handleSupervisorAsk without any real DOM — decoupled from the real DOM
// behavior of findComposer/sendPromptReliably/waitForConversationIdentity/
// waitForReply, which is covered separately in tests/extensionDomActions.test.js.

export const COMPOSER_SELECTORS = ['#composer'];
export const SEND_BUTTON_SELECTORS = ['#send'];
export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

let composerFound = true;
let nextConversationId = 'conv-fake';
let nextReplyText = 'fake reply';
export const sentPrompts = [];

export function setComposerFound(value) {
  composerFound = value;
}

export function setNextConversationId(id) {
  nextConversationId = id;
}

export function setNextReplyText(text) {
  nextReplyText = text;
}

// Stand-in for verifyAttachedConversationId — either resolves with an id
// (verifyAttachResult, default: whatever expectedConversationId was
// called with, simulating a clean match) or rejects with verifyAttachError
// (simulating a real SUPERVISOR_ATTACH_MISMATCH).
let verifyAttachResult;
let verifyAttachError = null;

export function setVerifyAttachResult(id) {
  verifyAttachResult = id;
  verifyAttachError = null;
}

export function setVerifyAttachError(code, message) {
  const err = new Error(message);
  err.code = code;
  verifyAttachError = err;
}

export async function verifyAttachedConversationId(_doc, expectedConversationId) {
  if (verifyAttachError) throw verifyAttachError;
  return verifyAttachResult !== undefined ? verifyAttachResult : expectedConversationId;
}

export async function findComposer() {
  return composerFound ? { fake: true } : null;
}

// When set, sendPromptReliably replays these onStage() strings (in order)
// before resolving — lets tests assert content.js forwards domActions.js's
// real granular insertion sub-stages into stageDiagnostics via reportStage.
let stagesToEmit = [];

export function setStagesToEmit(stages) {
  stagesToEmit = stages;
}

export async function sendPromptReliably(_doc, _composer, prompt, _sendSelectors, { onStage } = {}) {
  for (const stage of stagesToEmit) {
    onStage?.(stage);
  }
  sentPrompts.push(prompt);
}

export async function waitForConversationIdentity() {
  return nextConversationId;
}

export async function waitForReply() {
  return nextReplyText;
}

export function readConversationId() {
  return nextConversationId;
}

// Stand-in for the real observeReplyAndIdentity orchestration: reply
// observation first (never gated on identity), then identity capture +
// exact-match validation, then a successful { text, conversationId }.
export async function observeReplyAndIdentity(
  _doc,
  { expectedConversationId = null, identityRequired = true, onStage, onMismatch } = {}
) {
  onStage?.('assistant response completed');
  const conversationId = nextConversationId;
  if (conversationId) {
    onStage?.(`conversation identity observed (${conversationId})`);
  } else if (!identityRequired) {
    onStage?.('returning response');
    return { text: nextReplyText, conversationId: null, identityDiagnostics: { finalUrl: null } };
  }
  if (expectedConversationId && conversationId !== expectedConversationId) {
    if (onMismatch) throw onMismatch(expectedConversationId, conversationId);
    const err = new Error(
      `Conversation identity changed: expected "${expectedConversationId}" but the tab is now showing "${conversationId}".`
    );
    err.code = 'SUPERVISOR_IDENTITY_MISMATCH';
    throw err;
  }
  onStage?.('returning response');
  return { text: nextReplyText, conversationId };
}

// Stand-in for waitForChatGptReady — either resolves with a readiness
// result (default: ready at a fixed url) or rejects with a
// CHATGPT_PAGE_NOT_READY-shaped error, simulating a real not-ready page.
let chatGptReadyResult = { ready: true, url: 'https://chatgpt.com/' };
let chatGptReadyError = null;

export function setChatGptReadyResult(result) {
  chatGptReadyResult = result;
  chatGptReadyError = null;
}

export function setChatGptReadyError(code, message, diagnostics) {
  const err = new Error(message);
  err.code = code;
  err.diagnostics = diagnostics;
  chatGptReadyError = err;
}

export async function waitForChatGptReady() {
  if (chatGptReadyError) throw chatGptReadyError;
  return chatGptReadyResult;
}

// Stand-in for snapshotReviewerPreflight — a fixed diagnostics object by
// default (a fully healthy page), settable per test.
let reviewerPreflightSnapshot = {
  url: 'https://chatgpt.com/c/fake',
  pageReady: true,
  composerExists: true,
  composerConnected: true,
  composerInteractive: true,
};

export function setReviewerPreflightSnapshot(snapshot) {
  reviewerPreflightSnapshot = snapshot;
}

export function snapshotReviewerPreflight() {
  return reviewerPreflightSnapshot;
}
