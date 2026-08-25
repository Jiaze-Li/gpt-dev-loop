import {
  TransportError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
  RequestTimeoutError,
} from './errors.js';
import { classifyComposerTimeout, describePageState } from './diagnostics.js';
import { getChromeRuntime, withTimeout } from './chromeRuntime.js';

const COMPOSER_SELECTORS = ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'];

const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button#composer-submit-button'];

const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming response"]',
  'button[aria-label="Stop generating"]',
];

export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

const RESPONSE_STABLE_WINDOW_MS = 1200;
const STATUS_LOG_INTERVAL_MS = 10000;

function log(message) {
  console.error(`gpt-loop: ${message}`);
}

async function locateFirstVisible(page, selectors, timeoutMs, { onPoll } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 250 })) {
          return locator;
        }
      } catch {
        // try next selector / next poll
      }
    }
    if (onPoll) await onPoll();
    await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return null;
}

async function getPageDiagnostics(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  return { url, title };
}

async function isAnyVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 150 })) {
        return true;
      }
    } catch {
      // ignore and try next selector
    }
  }
  return false;
}

export async function ensureLoggedIn(page, config) {
  let hasWarned = false;
  let lastStatusLogAt = 0;
  const startedAt = Date.now();

  const composer = await locateFirstVisible(page, COMPOSER_SELECTORS, config.loginTimeoutMs, {
    onPoll: async () => {
      if (!hasWarned) {
        hasWarned = true;
        console.error(
          'gpt-loop: ChatGPT composer not visible yet. Complete any login, Cloudflare/bot check, or ' +
            `cookie consent in the opened browser window; waiting up to ${config.loginTimeoutMs}ms...`
        );
      }
      const now = Date.now();
      if (now - lastStatusLogAt < STATUS_LOG_INTERVAL_MS) return;
      lastStatusLogAt = now;
      const diagnostics = await getPageDiagnostics(page);
      console.error(`gpt-loop: still waiting (${describePageState(diagnostics)}, elapsed=${now - startedAt}ms)`);
    },
  });
  if (composer) return composer;

  const diagnostics = await getPageDiagnostics(page);
  const outcome = classifyComposerTimeout(diagnostics, config.loginTimeoutMs);
  if (outcome.kind === 'cloudflare') {
    throw new LoginRequiredError(outcome.message);
  }
  throw new SelectorMismatchError(outcome.message);
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

// Bounds `config[field]` by whatever's left of the caller's overall deadline
// (if any), so two sequential waits (e.g. the two ensureLoggedIn attempts
// below) share one budget instead of each getting a full allowance.
function withBoundedTimeout(config, field, deadlineAt) {
  if (deadlineAt === undefined) return config;
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) {
    throw new RequestTimeoutError(`ChatGPT request exceeded its time budget before ${field} could run.`);
  }
  return { ...config, [field]: Math.min(config[field], remaining) };
}

// The runtime keeps the Chrome window hidden by default. When the composer
// can't be reached (expired login, Cloudflare/bot check, cookie consent,
// passkey prompt), this shows the window so a human can clear it, then
// retries and hides the window again once the composer is reachable. This
// only ever runs before a prompt has been sent, so there's no risk of
// double-submitting. `deadlineAt`, if given, bounds both attempts combined
// so manual recovery can't run past the caller's overall request timeout.
export async function ensureLoggedInWithRecovery(page, config, controls, deadlineAt) {
  try {
    return await ensureLoggedIn(page, withBoundedTimeout(config, 'loginTimeoutMs', deadlineAt));
  } catch (err) {
    if (!(err instanceof LoginRequiredError || err instanceof SelectorMismatchError)) throw err;
    log(`ChatGPT needs manual attention (${err.message}). Showing the Chrome window for you to complete it.`);
    await controls.showWindow().catch((showErr) => {
      log(`could not show the Chrome window for manual recovery: ${showErr.message}`);
    });
    try {
      const composer = await ensureLoggedIn(page, withBoundedTimeout(config, 'loginTimeoutMs', deadlineAt));
      log('Manual step complete; hiding the Chrome window again.');
      return composer;
    } finally {
      await controls.hideWindow().catch(() => {});
    }
  }
}

async function sendPrompt(page, composer, prompt) {
  await composer.click();
  await page.keyboard.insertText(prompt);

  const sendButton = await locateFirstVisible(page, SEND_BUTTON_SELECTORS, 3000);
  if (sendButton) {
    await sendButton.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

export async function waitForReply(page, config, baselineCount) {
  const deadline = Date.now() + config.responseTimeoutMs;

  while (Date.now() < deadline) {
    const count = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    if (count > baselineCount) break;
    await page.waitForTimeout(300);
  }

  if ((await page.locator(ASSISTANT_MESSAGE_SELECTOR).count()) <= baselineCount) {
    throw new ResponseTimeoutError(`No assistant response appeared within ${config.responseTimeoutMs}ms.`);
  }

  const lastMessage = page.locator(ASSISTANT_MESSAGE_SELECTOR).last();
  let lastText = null;
  let stableSince = null;

  while (Date.now() < deadline) {
    const stopVisible = await isAnyVisible(page, STOP_BUTTON_SELECTORS);
    const currentText = (await lastMessage.innerText().catch(() => '')).trim();

    if (!stopVisible && currentText.length > 0 && currentText === lastText) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= RESPONSE_STABLE_WINDOW_MS) {
        return currentText;
      }
    } else {
      stableSince = null;
    }

    lastText = currentText;
    await page.waitForTimeout(300);
  }

  const finalText = (await lastMessage.innerText().catch(() => '')).trim();
  if (!finalText) {
    throw new ResponseExtractionError('ChatGPT response timed out and no text could be extracted.');
  }
  throw new ResponseTimeoutError(`ChatGPT response did not finish within ${config.responseTimeoutMs}ms.`);
}

async function runSessionOnPage(page, controls, prompt, config, deadlineAt) {
  if (remainingMs(deadlineAt) <= 0) {
    throw new RequestTimeoutError(`ChatGPT request did not start within ${config.requestTimeoutMs}ms (queue wait).`);
  }

  await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
    throw new TransportError(`Could not reach ${config.chatgptUrl}: ${err.message}`);
  });

  try {
    const composer = await ensureLoggedInWithRecovery(page, config, controls, deadlineAt);
    const baselineCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    await sendPrompt(page, composer, prompt);
    const replyConfig = withBoundedTimeout(config, 'responseTimeoutMs', deadlineAt);
    const reply = await waitForReply(page, replyConfig, baselineCount);

    if (!reply) {
      throw new ResponseExtractionError('ChatGPT returned an empty response.');
    }
    return reply;
  } catch (err) {
    if (err instanceof TransportError) throw err;
    throw new TransportError(`Unexpected transport failure: ${err.message}`);
  }
}

export async function askGpt(prompt, config) {
  const runtime = getChromeRuntime(config);
  const deadlineAt = Date.now() + config.requestTimeoutMs;
  const run = runtime.run((page, controls) => runSessionOnPage(page, controls, prompt, config, deadlineAt));
  return withTimeout(
    run,
    config.requestTimeoutMs,
    `ChatGPT request did not complete within ${config.requestTimeoutMs}ms.`,
    () => runtime.poison()
  );
}
