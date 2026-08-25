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

const COMPOSER_SELECTORS = ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'];

const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button#composer-submit-button'];

const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming response"]',
  'button[aria-label="Stop generating"]',
];

const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

const LOGIN_HINT_SELECTORS = ['text=Log in', '[data-testid="login-button"]'];

const RESPONSE_STABLE_WINDOW_MS = 1200;

async function locateFirstVisible(page, selectors, timeoutMs) {
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
    await page.waitForTimeout(300);
  } while (Date.now() < deadline);
  return null;
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

async function ensureLoggedIn(page, config) {
  const composer = await locateFirstVisible(page, COMPOSER_SELECTORS, 8000);
  if (composer) return composer;

  const loginHint = await locateFirstVisible(page, LOGIN_HINT_SELECTORS, 3000);
  if (!loginHint) {
    throw new SelectorMismatchError(
      'Could not find the ChatGPT composer or a login prompt. The page layout may have changed.'
    );
  }

  console.error(
    'gpt-loop: no active ChatGPT session detected. Please log in in the opened browser window; ' +
      'the command will continue automatically once the chat composer appears.'
  );

  const loggedInComposer = await locateFirstVisible(page, COMPOSER_SELECTORS, config.loginTimeoutMs);
  if (!loggedInComposer) {
    throw new LoginRequiredError(
      `Timed out after ${config.loginTimeoutMs}ms waiting for ChatGPT login to complete.`
    );
  }
  return loggedInComposer;
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

async function waitForReply(page, config) {
  const baselineCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
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

export async function askGpt(prompt, config) {
  fs.mkdirSync(config.profileDir, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      channel: 'chrome',
      headless: config.headless,
      viewport: { width: 1280, height: 900 },
    });
  } catch (err) {
    throw new ChromeUnavailableError(`Could not launch system Chrome: ${err.message}`);
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const composer = await ensureLoggedIn(page, config);
    await sendPrompt(page, composer, prompt);
    const reply = await waitForReply(page, config);

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
