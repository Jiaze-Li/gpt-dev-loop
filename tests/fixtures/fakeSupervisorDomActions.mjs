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

export async function findComposer() {
  return composerFound ? { fake: true } : null;
}

export async function sendPromptReliably(_doc, _composer, prompt) {
  sentPrompts.push(prompt);
}

export async function waitForConversationIdentity() {
  return nextConversationId;
}

export async function waitForReply() {
  return nextReplyText;
}
