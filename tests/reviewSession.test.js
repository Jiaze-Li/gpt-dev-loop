import test from 'node:test';
import assert from 'node:assert/strict';

import { runReviewInFreshTab } from '../extension/reviewSession.js';

function makeFakeChromeTabs({ tabIdStart = 1 } = {}) {
  let nextId = tabIdStart;
  const created = [];
  const removed = [];
  return {
    created,
    removed,
    createTab: async (opts) => {
      const tab = { id: nextId, ...opts };
      nextId += 1;
      created.push(tab);
      return tab;
    },
    waitForTabComplete: async () => {},
    removeTab: async (tabId) => {
      removed.push(tabId);
    },
  };
}

test('runReviewInFreshTab creates a new, inactive tab for the review and performs the request in it', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const performed = [];
  const result = await runReviewInFreshTab(
    {
      chatgptUrl: 'https://chatgpt.com/',
      perform: async (tabId) => {
        performed.push(tabId);
        return { ok: true, text: 'reply' };
      },
    },
    chromeTabs
  );

  assert.equal(result.text, 'reply');
  assert.equal(chromeTabs.created.length, 1);
  assert.equal(chromeTabs.created[0].url, 'https://chatgpt.com/');
  assert.equal(chromeTabs.created[0].active, false, 'must not steal the user\'s foreground tab');
  assert.deepEqual(performed, [chromeTabs.created[0].id]);
});

test('runReviewInFreshTab closes the tab after a successful review', async () => {
  const chromeTabs = makeFakeChromeTabs();
  await runReviewInFreshTab(
    { chatgptUrl: 'https://chatgpt.com/', perform: async () => ({ ok: true, text: 'reply' }) },
    chromeTabs
  );
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id]);
});

test('runReviewInFreshTab closes the tab even when perform rejects', async () => {
  const chromeTabs = makeFakeChromeTabs();
  await assert.rejects(
    () =>
      runReviewInFreshTab(
        {
          chatgptUrl: 'https://chatgpt.com/',
          perform: async () => {
            throw new Error('boom');
          },
        },
        chromeTabs
      ),
    /boom/
  );
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id]);
});

test('runReviewInFreshTab still closes the tab if removeTab itself rejects (best effort, does not mask the real result)', async () => {
  const chromeTabs = makeFakeChromeTabs();
  chromeTabs.removeTab = async () => {
    throw new Error('tab already closed by the user');
  };
  const result = await runReviewInFreshTab(
    { chatgptUrl: 'https://chatgpt.com/', perform: async () => ({ ok: true, text: 'reply' }) },
    chromeTabs
  );
  assert.equal(result.text, 'reply');
});

test('two consecutive review calls each get their own tab — never a shared conversation', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const performedTabIds = [];

  await runReviewInFreshTab(
    {
      chatgptUrl: 'https://chatgpt.com/',
      perform: async (tabId) => {
        performedTabIds.push(tabId);
        return { ok: true, text: 'first reply' };
      },
    },
    chromeTabs
  );
  await runReviewInFreshTab(
    {
      chatgptUrl: 'https://chatgpt.com/',
      perform: async (tabId) => {
        performedTabIds.push(tabId);
        return { ok: true, text: 'second reply' };
      },
    },
    chromeTabs
  );

  assert.equal(chromeTabs.created.length, 2);
  assert.notEqual(performedTabIds[0], performedTabIds[1], 'each review must run in a distinct tab/conversation');
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id, chromeTabs.created[1].id]);
});

test('runReviewInFreshTab waits for the tab to finish loading before performing the request', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const order = [];
  chromeTabs.waitForTabComplete = async () => {
    order.push('loaded');
  };
  await runReviewInFreshTab(
    {
      chatgptUrl: 'https://chatgpt.com/',
      perform: async () => {
        order.push('performed');
        return { ok: true, text: 'reply' };
      },
    },
    chromeTabs
  );
  assert.deepEqual(order, ['loaded', 'performed']);
});
