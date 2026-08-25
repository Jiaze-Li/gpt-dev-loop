import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureLoggedInWithRecovery } from '../src/bridge/chatgptWeb.js';

const COMPOSER_SELECTOR = '#prompt-textarea';

// Fake Playwright `page` whose composer only becomes visible once `unlock()`
// is called, simulating a human clearing a login/Cloudflare/passkey prompt
// after the window is shown.
function createFakePage({ url = 'https://chatgpt.com/', title = 'ChatGPT' } = {}) {
  let composerVisible = false;
  return {
    locator(selector) {
      if (selector === COMPOSER_SELECTOR) {
        return { first: () => ({ isVisible: async () => composerVisible }) };
      }
      return { first: () => ({ isVisible: async () => false }) };
    },
    async waitForTimeout() {},
    url: () => url,
    title: async () => title,
    unlock() {
      composerVisible = true;
    },
  };
}

test('ensureLoggedInWithRecovery shows the window, waits for manual completion, then hides it again', async () => {
  const page = createFakePage();
  const calls = [];
  const controls = {
    showWindow: async () => {
      calls.push('show');
      page.unlock();
    },
    hideWindow: async () => calls.push('hide'),
  };

  const composer = await ensureLoggedInWithRecovery(page, { loginTimeoutMs: 50 }, controls);

  assert.ok(composer, 'expected a composer locator once manual recovery completes');
  assert.deepEqual(calls, ['show', 'hide']);
});

test('ensureLoggedInWithRecovery does not touch window controls when login succeeds immediately', async () => {
  const page = createFakePage();
  page.unlock();
  const calls = [];
  const controls = {
    showWindow: async () => calls.push('show'),
    hideWindow: async () => calls.push('hide'),
  };

  const composer = await ensureLoggedInWithRecovery(page, { loginTimeoutMs: 3000 }, controls);

  assert.ok(composer);
  assert.deepEqual(calls, []);
});

test('ensureLoggedInWithRecovery still hides the window and rethrows if recovery never completes', async () => {
  const page = createFakePage();
  const calls = [];
  const controls = {
    showWindow: async () => calls.push('show'),
    hideWindow: async () => calls.push('hide'),
  };

  await assert.rejects(() => ensureLoggedInWithRecovery(page, { loginTimeoutMs: 50 }, controls));
  assert.deepEqual(calls, ['show', 'hide']);
});
