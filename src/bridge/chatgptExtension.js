// Extension transport's askGpt(prompt, config) -> Promise<string> —
// same signature/contract as chatgptWeb.js's askGpt, so it's a drop-in
// replacement behind gptReviewerAdapter.js (see transport.js). Talks to the
// Chrome extension through the local bridge server (extensionServer.js)
// instead of driving Chrome directly.

import { randomUUID } from 'node:crypto';
import { getExtensionServer } from './extensionServer.js';
import { withTimeout } from './chromeRuntime.js';
import {
  TransportError,
  ChromeUnavailableError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
} from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';

// docs/handoff/2026-08-25-chrome-extension-bridge.md "错误映射" table.
const ERROR_CODE_MAP = {
  NO_CHATGPT_TAB: ChromeUnavailableError,
  LOGIN_REQUIRED: LoginRequiredError,
  COMPOSER_NOT_FOUND: SelectorMismatchError,
  SEND_BUTTON_NOT_FOUND: SelectorMismatchError,
  RESPONSE_TIMEOUT: ResponseTimeoutError,
  RESPONSE_EMPTY: ResponseExtractionError,
  INTERNAL_ERROR: ChromeUnavailableError,
};

function mapProtocolError(err) {
  const ErrorClass = ERROR_CODE_MAP[err.code] ?? ChromeUnavailableError;
  return new ErrorClass(err.message || err.code);
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

export async function askGpt(prompt, config) {
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
