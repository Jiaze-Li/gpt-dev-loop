import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureLoggedIn } from '../src/bridge/chatgptWeb.js';
import { LoginRequiredError, SelectorMismatchError } from '../src/bridge/errors.js';

const COMPOSER_SELECTOR = '#prompt-textarea';

// Fake Playwright `page`: the composer only becomes visible after a given
// number of polls (or never), and url()/title() reflect a fixed page state.
function createFakePage({ composerAppearsAfterPolls = Infinity, url = 'https://chatgpt.com/', title = 'ChatGPT' }) {
  let polls = 0;
  let composerVisible = false;

  return {
    locator(selector) {
      if (selector === COMPOSER_SELECTOR) {
        return { first: () => ({ isVisible: async () => composerVisible }) };
      }
      return { first: () => ({ isVisible: async () => false }) };
    },
    async waitForTimeout() {
      polls += 1;
      if (polls >= composerAppearsAfterPolls) composerVisible = true;
    },
    url: () => url,
    title: async () => title,
  };
}

test('ensureLoggedIn does not require a login hint before it starts waiting for the composer', async () => {
  // No "Log in" selector is ever consulted by the fake page at all; the
  // composer simply becomes visible partway through polling, simulating a
  // real manual login/Cloudflare/cookie-consent flow completing.
  const page = createFakePage({ composerAppearsAfterPolls: 2 });
  const composer = await ensureLoggedIn(page, { loginTimeoutMs: 3000 });
  assert.ok(composer, 'expected a composer locator once it becomes visible');
});

test('ensureLoggedIn reports a Cloudflare challenge distinctly from a layout mismatch', async () => {
  const page = createFakePage({ title: 'Just a moment...' });
  await assert.rejects(
    () => ensureLoggedIn(page, { loginTimeoutMs: 200 }),
    (err) => {
      assert.ok(err instanceof LoginRequiredError);
      assert.match(err.message, /Cloudflare/);
      assert.match(err.message, /title="Just a moment\.\.\."/);
      return true;
    }
  );
});

test('ensureLoggedIn reports a plain selector mismatch when the title looks normal', async () => {
  const page = createFakePage({ title: 'ChatGPT' });
  await assert.rejects(
    () => ensureLoggedIn(page, { loginTimeoutMs: 200 }),
    (err) => {
      assert.ok(err instanceof SelectorMismatchError);
      assert.match(err.message, /layout may have changed/);
      return true;
    }
  );
});
