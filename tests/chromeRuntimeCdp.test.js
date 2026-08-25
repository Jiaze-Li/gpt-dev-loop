import test from 'node:test';
import assert from 'node:assert/strict';

import { ChromeRuntime } from '../src/bridge/chromeRuntime.js';
import { ChromeUnavailableError } from '../src/bridge/errors.js';
import { ensureLoggedIn, waitForReply, ASSISTANT_MESSAGE_SELECTOR } from '../src/bridge/chatgptWeb.js';

const COMPOSER_SELECTOR = '#prompt-textarea';

// A fake Playwright BrowserContext/Browser pair standing in for a Chrome
// the user already has running (GPT_BROWSER_MODE=cdp attaches to this
// instead of launching a dedicated profile). `pages` tracks every page this
// runtime opens so tests can assert only *those* pages get closed, never
// the shared context (the user's other tabs).
function makeFakeCdpContext() {
  const openedPages = [];
  let contextClosed = false;
  const context = {
    isClosed: () => contextClosed,
    pages: () => openedPages,
    newPage: async () => {
      const page = createFakeChatGptPage();
      openedPages.push(page);
      return page;
    },
    close: async () => {
      contextClosed = true;
    },
  };
  return { context, openedPages };
}

function makeFakeCdpConnector({ context }) {
  const calls = [];
  let browserClosed = false;
  const connectOverCdp = async (cdpUrl) => {
    calls.push(cdpUrl);
    const browser = {
      contexts: () => [context],
      newContext: async () => context,
      isClosed: () => browserClosed,
      close: async () => {
        browserClosed = true;
      },
    };
    return { browser, context };
  };
  return { connectOverCdp, calls, isBrowserClosed: () => browserClosed };
}

// A fake ChatGPT tab: composer is visible immediately (no login flow to
// simulate here — that's covered by ensureLoggedIn.test.js), a send falls
// through to Enter (no send button), and one assistant reply appears after
// a couple of polls, mirroring waitForReply.test.js's fake page.
function createFakeChatGptPage() {
  let assistantCount = 0;
  let polls = 0;
  let closed = false;
  const insertedText = [];
  const keysPressed = [];

  return {
    isClosed: () => closed,
    async goto() {},
    url: () => 'https://chatgpt.com/',
    title: async () => 'ChatGPT',
    locator(selector) {
      if (selector === COMPOSER_SELECTOR) {
        return { first: () => ({ isVisible: async () => true, click: async () => {} }) };
      }
      if (selector === ASSISTANT_MESSAGE_SELECTOR) {
        return {
          count: async () => assistantCount,
          last: () => ({ innerText: async () => 'CDP_HANDSHAKE_OK' }),
        };
      }
      return { first: () => ({ isVisible: async () => false }) };
    },
    keyboard: {
      async insertText(text) {
        insertedText.push(text);
      },
      async press(key) {
        keysPressed.push(key);
        // Sending "Enter" is what triggers the assistant's reply to show up
        // in this fake, same as a real send would eventually populate one.
        if (key === 'Enter') assistantCount = 1;
      },
    },
    async waitForTimeout() {
      polls += 1;
    },
    async close() {
      closed = true;
    },
    _insertedText: insertedText,
    _keysPressed: keysPressed,
  };
}

test('ChromeRuntime (cdp mode) attaches over CDP, sends a prompt, and reads the reply back', async () => {
  const { context, openedPages } = makeFakeCdpContext();
  const { connectOverCdp, calls } = makeFakeCdpConnector({ context });

  const runtime = new ChromeRuntime(
    { browserMode: 'cdp', cdpUrl: 'http://localhost:9222', backgroundWindow: false },
    { connectOverCdp, hideWindow: async () => {}, showWindow: async () => {} }
  );

  const reply = await runtime.run(async (page) => {
    await page.goto('https://chatgpt.com/');
    const composer = await ensureLoggedIn(page, { loginTimeoutMs: 1000 });
    const baselineCount = await page.locator(ASSISTANT_MESSAGE_SELECTOR).count();
    await composer.click();
    await page.keyboard.insertText('hello from the dev loop');
    await page.keyboard.press('Enter');
    return waitForReply(page, { responseTimeoutMs: 2000 }, baselineCount);
  });

  assert.equal(reply, 'CDP_HANDSHAKE_OK');
  assert.deepEqual(calls, ['http://localhost:9222']);
  assert.equal(openedPages.length, 1);
  assert.deepEqual(openedPages[0]._insertedText, ['hello from the dev loop']);
  assert.deepEqual(openedPages[0]._keysPressed, ['Enter']);
  assert.equal(context.isClosed(), false, 'the users existing browser context must never be closed');

  await runtime.close();
});

test('ChromeRuntime (cdp mode) reuses the same CDP connection across multiple calls', async () => {
  const { context } = makeFakeCdpContext();
  const { connectOverCdp, calls } = makeFakeCdpConnector({ context });

  const runtime = new ChromeRuntime(
    { browserMode: 'cdp', cdpUrl: 'http://localhost:9222', backgroundWindow: false },
    { connectOverCdp }
  );

  await runtime.run(async (page) => page);
  await runtime.run(async (page) => page);

  assert.equal(calls.length, 1, 'a second call should reuse the existing CDP connection, not reconnect');
  await runtime.close();
});

test('ChromeRuntime (cdp mode) closing/rebuilding only closes its own page, never the shared context', async () => {
  const { context, openedPages } = makeFakeCdpContext();
  const { connectOverCdp, isBrowserClosed } = makeFakeCdpConnector({ context });

  const runtime = new ChromeRuntime(
    { browserMode: 'cdp', cdpUrl: 'http://localhost:9222', backgroundWindow: false },
    { connectOverCdp }
  );

  await assert.rejects(() =>
    runtime.run(async () => {
      throw new Error('boom');
    })
  );

  assert.equal(openedPages[0].isClosed(), true, 'the page opened for the failed task should be closed');
  assert.equal(context.isClosed(), false, 'the shared browser context must survive a task failure');

  await runtime.run(async (page) => page);
  await runtime.close();

  assert.equal(isBrowserClosed(), true, 'close() should disconnect the CDP session');
  assert.equal(context.isClosed(), false, 'close() must never close the users shared browser context');
});

test('ChromeRuntime falls back to launch mode when browserMode is anything other than "cdp"', async () => {
  const launchCalls = [];
  const launchPersistentContext = async (profileDir) => {
    launchCalls.push(profileDir);
    return { newPage: async () => createFakeChatGptPage(), close: async () => {} };
  };
  const connectOverCdp = async () => {
    throw new Error('should not be called in launch mode');
  };

  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext, connectOverCdp }
  );

  await runtime.run(async (page) => page);
  assert.deepEqual(launchCalls, ['/tmp/fake-profile']);
  await runtime.close();
});

test('ChromeRuntime (cdp mode) surfaces a connection failure to the caller instead of hanging', async () => {
  const connectOverCdp = async () => {
    throw new ChromeUnavailableError('Could not attach to Chrome over CDP at http://localhost:9222: ECONNREFUSED');
  };
  const runtime = new ChromeRuntime(
    { browserMode: 'cdp', cdpUrl: 'http://localhost:9222', backgroundWindow: false },
    { connectOverCdp }
  );

  await assert.rejects(() => runtime.run(async (page) => page), ChromeUnavailableError);
  await runtime.close();
});
