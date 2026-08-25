import fs from 'node:fs';
import { chromium } from 'playwright';
import {
  TransportError,
  ChromeUnavailableError,
  LoginRequiredError,
  SelectorMismatchError,
  ResponseTimeoutError,
  ResponseExtractionError,
} from './errors.js';
import { classifyComposerTimeout, describePageState } from './diagnostics.js';

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

async function launchContext(config, headless) {
  try {
    const context = await chromium.launchPersistentContext(config.profileDir, {
      channel: 'chrome',
      headless,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  } catch (err) {
    throw new ChromeUnavailableError(`Could not launch system Chrome: ${err.message}`);
  }
}

// Fallback from headless to a visible window is only safe before a prompt
// has been sent (no risk of double-submitting). These are exactly the
// failures ensureLoggedIn raises when the composer never becomes reachable:
// an expired login, a Cloudflare/bot challenge, or an unexpected layout that
// a human may be able to clear manually in a visible window.
export function shouldFallbackToVisible(err) {
  return err instanceof LoginRequiredError || err instanceof SelectorMismatchError;
}

export async function runSession(prompt, config, headless) {
  const context = await launchContext(config, headless);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      throw new TransportError(`Could not reach ${config.chatgptUrl}: ${err.message}`);
    });

    const composer = await ensureLoggedIn(page, config);
    const baselineCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    await sendPrompt(page, composer, prompt);
    const reply = await waitForReply(page, config, baselineCount);

    if (!reply) {
      throw new ResponseExtractionError('ChatGPT returned an empty response.');
    }
    return reply;
  } catch (err) {
    if (err instanceof TransportError) throw err;
    throw new TransportError(`Unexpected transport failure: ${err.message}`);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function runAskGpt(prompt, config, { runSession: run = runSession } = {}) {
  fs.mkdirSync(config.profileDir, { recursive: true });

  if (config.headless) {
    try {
      return await run(prompt, config, true);
    } catch (err) {
      if (!shouldFallbackToVisible(err)) throw err;
      console.error(
        `gpt-loop: headless mode could not reach the ChatGPT composer (${err.message}) ` +
          'Falling back to a visible Chrome window so you can complete login/verification manually.'
      );
    }
  }

  return run(prompt, config, false);
}

export async function askGpt(prompt, config) {
  return runAskGpt(prompt, config);
}
