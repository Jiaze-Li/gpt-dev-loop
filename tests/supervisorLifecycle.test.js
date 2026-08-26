import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupervisorTab, askSupervisorTab, closeSupervisorTab } from '../extension/supervisorLifecycle.js';

function makeFakeChromeTabs({ tabIdStart = 1, existingTabIds = [] } = {}) {
  let nextId = tabIdStart;
  const created = [];
  const removed = [];
  const sent = [];
  const existing = new Set(existingTabIds);
  return {
    created,
    removed,
    sent,
    existing,
    createTab: async (opts) => {
      const tab = { id: nextId, ...opts };
      nextId += 1;
      created.push(tab);
      existing.add(tab.id);
      return tab;
    },
    waitForTabComplete: async () => {},
    removeTab: async (tabId) => {
      removed.push(tabId);
      existing.delete(tabId);
    },
    tabExists: async (tabId) => existing.has(tabId),
    sendToContentScript: async (tabId, message) => {
      sent.push({ tabId, message });
      return { ok: true, text: 'reply', conversationId: 'conv-1' };
    },
  };
}

test('createSupervisorTab creates one inactive tab and leaves it open (never closes it)', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const { tabId } = await createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs);

  assert.equal(chromeTabs.created.length, 1);
  assert.equal(chromeTabs.created[0].url, 'https://chatgpt.com/');
  assert.equal(chromeTabs.created[0].active, false, "must not steal the user's foreground tab");
  assert.equal(tabId, chromeTabs.created[0].id);
  assert.deepEqual(chromeTabs.removed, [], 'create must never close the tab it just opened');
});

test('createSupervisorTab cleans up the orphaned tab if it never finishes loading', async () => {
  const chromeTabs = makeFakeChromeTabs();
  chromeTabs.waitForTabComplete = async () => {
    throw new Error('tab never reached complete');
  };
  await assert.rejects(() => createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs), /never reached complete/);
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id]);
});

test('askSupervisorTab addresses exactly the given tabId, never a different one', async () => {
  // Two "tabs" exist (simulating the user having other ChatGPT tabs open
  // too) — askSupervisorTab must relay to the one tabId it was given, not
  // "whichever ChatGPT tab" or the most recently created one.
  const chromeTabs = makeFakeChromeTabs({ existingTabIds: [7, 8] });
  const result = await askSupervisorTab(7, { type: 'supervisorAsk', prompt: 'hi' }, chromeTabs);

  assert.deepEqual(result, { ok: true, text: 'reply', conversationId: 'conv-1' });
  assert.equal(chromeTabs.sent.length, 1);
  assert.equal(chromeTabs.sent[0].tabId, 7, 'must address exactly the requested tab, not tab 8 or any other');
});

test('askSupervisorTab returns SUPERVISOR_TAB_LOST (without sending anything) when the tab no longer exists', async () => {
  const chromeTabs = makeFakeChromeTabs({ existingTabIds: [] });
  const result = await askSupervisorTab(99, { type: 'supervisorAsk', prompt: 'hi' }, chromeTabs);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUPERVISOR_TAB_LOST');
  assert.equal(chromeTabs.sent.length, 0, 'must never guess/substitute another tab when the target is gone');
});

test('closeSupervisorTab removes exactly the given tabId and leaves every other tab untouched', async () => {
  const chromeTabs = makeFakeChromeTabs({ existingTabIds: [3, 4, 5] });
  await closeSupervisorTab(4, chromeTabs);

  assert.deepEqual(chromeTabs.removed, [4]);
  assert.ok(chromeTabs.existing.has(3), 'tab 3 (not the Supervisor tab) must survive close()');
  assert.ok(chromeTabs.existing.has(5), 'tab 5 (not the Supervisor tab) must survive close()');
});

test('closeSupervisorTab is a no-op, not an error, when the tab is already gone', async () => {
  const chromeTabs = makeFakeChromeTabs({ existingTabIds: [] });
  await closeSupervisorTab(42, chromeTabs);
  assert.deepEqual(chromeTabs.removed, [], 'nothing to remove — must not call removeTab for a tab that is not there');
});
