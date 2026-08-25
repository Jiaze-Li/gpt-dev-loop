import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReply, ASSISTANT_MESSAGE_SELECTOR } from '../src/bridge/chatgptWeb.js';

// Fake Playwright `page` that reports a growing assistant-message count and
// a stable reply, without touching a real browser.
function createFakePage({ preexistingCount, appearsAfterPolls, replyText }) {
  let assistantCount = preexistingCount;
  let polls = 0;

  return {
    locator(selector) {
      if (selector === ASSISTANT_MESSAGE_SELECTOR) {
        return {
          count: async () => assistantCount,
          last: () => ({
            innerText: async () => replyText,
          }),
        };
      }
      // Any other selector (e.g. stop-generating buttons) is never visible.
      return {
        first: () => ({ isVisible: async () => false }),
      };
    },
    async waitForTimeout() {
      polls += 1;
      if (polls >= appearsAfterPolls) {
        assistantCount = preexistingCount + 1;
      }
    },
  };
}

test('waitForReply waits for a count increase past the caller-supplied baseline', async () => {
  // Baseline is captured before send, when 5 assistant messages already
  // exist from earlier turns. A 6th appears after a couple of polls.
  const page = createFakePage({ preexistingCount: 5, appearsAfterPolls: 2, replyText: 'HANDSHAKE_OK' });
  const reply = await waitForReply(page, { responseTimeoutMs: 5000 }, 5);
  assert.equal(reply, 'HANDSHAKE_OK');
});

test('waitForReply times out if the count never exceeds the baseline', async () => {
  // Baseline already equals the current count and never grows: this is the
  // pre-fix bug shape, where a stale/late baseline would never see a new
  // message and the call should fail clearly instead of hanging.
  const page = createFakePage({ preexistingCount: 3, appearsAfterPolls: Infinity, replyText: 'HANDSHAKE_OK' });
  await assert.rejects(() => waitForReply(page, { responseTimeoutMs: 200 }, 3));
});
