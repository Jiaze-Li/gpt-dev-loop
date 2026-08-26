// Extension transport's askGpt(prompt, config) -> Promise<string> —
// same signature/contract as chatgptWeb.js's askGpt, so it's a drop-in
// replacement behind gptReviewerAdapter.js (see transport.js). Talks to the
// Chrome extension through the local bridge server (extensionServer.js)
// instead of driving Chrome directly.

import { randomUUID } from 'node:crypto';
import { getExtensionServer } from './extensionServer.js';
import { withTimeout } from './chromeRuntime.js';
import { isValidConversationId } from '../../extension/domActions.js';
import {
  TransportError,
  ChromeUnavailableError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
  SendFailedError,
  RateLimitedError,
  CleanupFailedError,
  ConversationIdentityError,
  SupervisorTabLostError,
  SupervisorIdentityMismatchError,
} from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';

// docs/handoff/2026-08-25-chrome-extension-bridge.md "错误映射" table.
// Shared with supervisorSession.js (imports mapProtocolError below) so both
// callers of extensionServer.js map the same wire error codes the same way.
const ERROR_CODE_MAP = {
  NO_CHATGPT_TAB: ChromeUnavailableError,
  LOGIN_REQUIRED: LoginRequiredError,
  COMPOSER_NOT_FOUND: SelectorMismatchError,
  SEND_BUTTON_NOT_FOUND: SelectorMismatchError,
  RESPONSE_TIMEOUT: ResponseTimeoutError,
  RESPONSE_EMPTY: ResponseExtractionError,
  SEND_FAILED: SendFailedError,
  RATE_LIMITED: RateLimitedError,
  CONVERSATION_IDENTITY_NOT_FOUND: ConversationIdentityError,
  CONVERSATION_NOT_FOUND: CleanupFailedError,
  DELETE_MENU_NOT_FOUND: CleanupFailedError,
  DELETE_NOT_CONFIRMED: CleanupFailedError,
  SUPERVISOR_TAB_LOST: SupervisorTabLostError,
  SUPERVISOR_IDENTITY_MISMATCH: SupervisorIdentityMismatchError,
  INTERNAL_ERROR: ChromeUnavailableError,
};

export function mapProtocolError(err) {
  const ErrorClass = ERROR_CODE_MAP[err.code] ?? ChromeUnavailableError;
  return new ErrorClass(err.message || err.code);
}

const DEFAULT_RATE_LIMIT_MAX_RETRIES = 2;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 90000;
const DEFAULT_RATE_LIMIT_JITTER_MS = 30000;

function rateLimitBackoffDelay(config) {
  const base = config.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const jitter = config.rateLimitJitterMs ?? DEFAULT_RATE_LIMIT_JITTER_MS;
  return base + Math.floor(Math.random() * jitter);
}

// ChatGPT's own "You're making requests too quickly" banner means the
// account itself is being throttled — retrying immediately (or worse, in a
// tight loop) only makes that worse. Each retry here is a brand-new attempt
// (fresh requestId, fresh tab) after a randomized multi-minute backoff,
// bounded so a persistently rate-limited session still fails rather than
// retrying forever.
async function withRateLimitRetry(attempt, config, label) {
  const maxRetries = config.rateLimitMaxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof RateLimitedError) || retry >= maxRetries) throw err;
      const delay = rateLimitBackoffDelay(config);
      console.error(`gpt-loop: ${label} hit ChatGPT's rate limit; waiting ${delay}ms before retry ${retry + 1}/${maxRetries}.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function runAsk(prompt, config, requestId) {
  const server = getExtensionServer(config);
  try {
    return await server.ask(prompt, {
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

async function attemptAskWithIdentity(prompt, config) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  return withTimeout(
    runAsk(prompt, config, requestId),
    config.requestTimeoutMs,
    `ChatGPT extension request did not complete within ${config.requestTimeoutMs}ms.`,
    // Frees the queue/in-flight slot this request was holding — without
    // this, an abandoned request (the caller already got RequestTimeoutError)
    // would keep blocking the single in-flight slot until its own
    // connect/response timer eventually fired, delaying every request
    // behind it in the queue.
    () => server.cancel(requestId)
  );
}

// Same transport as askGpt, but also returns the conversation identity
// (`/c/<id>`) the request landed in — needed by any caller that must later
// address this exact conversation again, e.g. to delete it (see
// deleteConversation below). Returns `{ text, conversationId }`;
// conversationId is null if the page's URL never picked up a `/c/<id>`
// segment (should not normally happen once send is confirmed and a reply
// starts, but is not treated as fatal here — the caller decides whether it
// needed the identity).
export async function askGptWithIdentity(prompt, config) {
  return withRateLimitRetry(() => attemptAskWithIdentity(prompt, config), config, 'askGptWithIdentity');
}

export async function askGpt(prompt, config) {
  const { text } = await askGptWithIdentity(prompt, config);
  return text;
}

async function runDelete(conversationId, config, requestId) {
  const server = getExtensionServer(config);
  try {
    await server.deleteConversation(conversationId, {
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

async function attemptDeleteConversation(conversationId, config) {
  const requestId = randomUUID();
  const server = getExtensionServer(config);
  return withTimeout(
    runDelete(conversationId, config, requestId),
    config.requestTimeoutMs,
    `ChatGPT extension delete request did not complete within ${config.requestTimeoutMs}ms.`,
    () => server.cancel(requestId)
  );
}

// deleteConversation(conversationIdentity, config) -> Promise<void>.
// Resolves once the extension confirms (real DOM postcondition, see
// extension/domActions.js's deleteConversation) that the conversation is
// gone from the sidebar. Rejects with a bridge/errors.js TransportError —
// most notably CleanupFailedError for CONVERSATION_NOT_FOUND /
// DELETE_MENU_NOT_FOUND / DELETE_NOT_CONFIRMED — never silently treats
// "we clicked delete" as success.
export async function deleteConversation(conversationId, config) {
  if (!conversationId) throw new CleanupFailedError('deleteConversation requires a non-empty conversation id.');
  if (!isValidConversationId(conversationId)) {
    throw new CleanupFailedError(
      `"${conversationId}" is not shaped like a real ChatGPT conversation id (/c/<id>); refusing to attempt deletion.`
    );
  }
  return withRateLimitRetry(() => attemptDeleteConversation(conversationId, config), config, 'deleteConversation');
}
