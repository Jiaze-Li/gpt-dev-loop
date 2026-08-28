import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupervisorTab, attachSupervisorTab, buildConversationUrl, askSupervisorTab, closeSupervisorTab } from '../extension/supervisorLifecycle.js';

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
    // Defaults matching a real, healthy tab: a content script listener is
    // reachable on the first try, and the page becomes ready immediately —
    // the same "everything just works" baseline waitForTabComplete already
    // models, extended to the two new readiness-handshake stages
    // createSupervisorTab now performs after "tab complete".
    ensureContentScriptReady: async () => {},
    waitForChatGptReady: async () => {},
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

test('createSupervisorTab honors an explicit active:true diagnostic override', async () => {
  const chromeTabs = makeFakeChromeTabs();
  await createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/', active: true }, chromeTabs);
  assert.equal(chromeTabs.created[0].active, true);
});

test('createSupervisorTab omits windowId from createTab by default', async () => {
  const chromeTabs = makeFakeChromeTabs();
  await createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs);
  assert.equal('windowId' in chromeTabs.created[0], false, 'production callers must not send windowId at all');
});

test('createSupervisorTab honors an explicit windowId diagnostic override', async () => {
  const chromeTabs = makeFakeChromeTabs();
  await createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/', windowId: 99 }, chromeTabs);
  assert.equal(chromeTabs.created[0].windowId, 99);
});

test('createSupervisorTab cleans up the orphaned tab if it never finishes loading', async () => {
  const chromeTabs = makeFakeChromeTabs();
  chromeTabs.waitForTabComplete = async () => {
    throw new Error('tab never reached complete');
  };
  await assert.rejects(() => createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs), /never reached complete/);
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id]);
});

// --- ChatGPT page-readiness handshake (2026-08-27) --------------------
//
// chrome.tabs "complete" alone was proven live to be insufficient evidence
// the tab is actually usable — a real second ChatGPT tab reached "complete"
// while still showing a blank page. createSupervisorTab now performs two
// more real-evidence gates after "complete", both injected here so this
// stays runnable under plain Node: confirming a content script listener
// exists (injecting it if needed), then confirming ChatGPT's own UI has
// hydrated. Every dependency below is a fake standing in for
// background.js's real chrome.tabs/chrome.scripting-backed implementation.

test('createSupervisorTab succeeds once content script + ChatGPT UI are both confirmed ready, in the correct order', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const stages = [];
  chromeTabs.ensureContentScriptReady = async () => {
    stages.push('content script ready');
  };
  chromeTabs.waitForChatGptReady = async () => {
    stages.push('ChatGPT page ready');
  };
  const logs = [];

  const { tabId } = await createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, { ...chromeTabs, log: (s) => logs.push(s) });

  assert.equal(tabId, chromeTabs.created[0].id);
  assert.deepEqual(chromeTabs.removed, [], 'a fully-ready tab must never be closed by create()');
  assert.deepEqual(stages, ['content script ready', 'ChatGPT page ready'], 'content script readiness must be confirmed before waiting for the ChatGPT UI');
  assert.ok(logs.some((l) => l.includes('content script ready')));
  assert.ok(logs.some((l) => l.includes('ChatGPT page ready')));
});

test('createSupervisorTab cleans up the tab and propagates CHATGPT_PAGE_NOT_READY when the ChatGPT UI never becomes ready', async () => {
  const chromeTabs = makeFakeChromeTabs();
  chromeTabs.waitForChatGptReady = async () => {
    const err = new Error('ChatGPT page did not become ready within 15000ms. url=https://chatgpt.com/ composerFound=false');
    err.code = 'CHATGPT_PAGE_NOT_READY';
    err.diagnostics = { url: 'https://chatgpt.com/', composerFound: false };
    throw err;
  };

  await assert.rejects(
    () => createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs),
    (err) => {
      assert.equal(err.code, 'CHATGPT_PAGE_NOT_READY');
      assert.match(err.message, /composerFound=false/);
      return true;
    }
  );
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id], 'a tab that never became usable must not be left dangling for the caller');
});

test('createSupervisorTab cleans up the tab if a content script listener never becomes reachable', async () => {
  const chromeTabs = makeFakeChromeTabs();
  let chatGptReadyCalled = false;
  chromeTabs.ensureContentScriptReady = async () => {
    throw new Error('content script did not respond in tab (even after injecting)');
  };
  chromeTabs.waitForChatGptReady = async () => {
    chatGptReadyCalled = true;
  };

  await assert.rejects(
    () => createSupervisorTab({ chatgptUrl: 'https://chatgpt.com/' }, chromeTabs),
    /content script did not respond/
  );
  assert.deepEqual(chromeTabs.removed, [chromeTabs.created[0].id]);
  assert.equal(chatGptReadyCalled, false, 'must never wait for page readiness in a tab whose content script was never confirmed reachable');
});

test('createSupervisorTab still succeeds when ensureContentScriptReady needed its own inject-and-retry internally', async () => {
  // Mirrors what background.js's real ensureContentScriptReady does
  // (reusing the existing, proven sendToContentScriptWithRetry: a first
  // "Receiving end does not exist" failure triggers chrome.scripting.
  // executeScript injection, then a retry) — modeled here as an injected
  // fake so this stays runnable without real chrome.* APIs. The point
  // under test is that createSupervisorTab's own contract doesn't care HOW
  // ensureContentScriptReady got there, only that it eventually resolved.
  const chromeTabs = makeFakeChromeTabs();
  let attempts = 0;
  chromeTabs.ensureContentScriptReady = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    // second attempt: "injected content.js and retried" succeeded
  };
  // A real ensureContentScriptReady swallows its own first-attempt error
  // internally and only resolves/rejects once after its retry — model
  // that exact contract here too, rather than leaking the first attempt's
  // rejection out to createSupervisorTab.
  const resilientEnsureContentScriptReady = async (tabId) => {
    try {
      await chromeTabs.ensureContentScriptReady(tabId);
    } catch {
      await chromeTabs.ensureContentScriptReady(tabId);
    }
  };

  const { tabId } = await createSupervisorTab(
    { chatgptUrl: 'https://chatgpt.com/' },
    { ...chromeTabs, ensureContentScriptReady: resilientEnsureContentScriptReady }
  );

  assert.equal(tabId, chromeTabs.created[0].id);
  assert.equal(attempts, 2, 'must have retried exactly once after the first "no listener yet" failure');
  assert.deepEqual(chromeTabs.removed, [], 'a tab that became ready after one retry must be kept, not closed');
});

test('buildConversationUrl points directly at the exact conversation, regardless of trailing slash on chatgptUrl', () => {
  assert.equal(buildConversationUrl('https://chatgpt.com/', 'conv-abc-123'), 'https://chatgpt.com/c/conv-abc-123');
  assert.equal(buildConversationUrl('https://chatgpt.com', 'conv-abc-123'), 'https://chatgpt.com/c/conv-abc-123');
});

test('buildConversationUrl percent-encodes the conversationId segment', () => {
  assert.equal(buildConversationUrl('https://chatgpt.com/', 'conv/weird?id'), 'https://chatgpt.com/c/conv%2Fweird%3Fid');
});

test('attachSupervisorTab navigates a fresh tab straight to /c/<conversationId>, not a blank chat', async () => {
  const chromeTabs = makeFakeChromeTabs();
  const logs = [];
  const { tabId } = await attachSupervisorTab(
    { chatgptUrl: 'https://chatgpt.com/', conversationId: 'conv-xyz' },
    { ...chromeTabs, log: (s) => logs.push(s) }
  );

  assert.equal(chromeTabs.created.length, 1);
  assert.equal(chromeTabs.created[0].url, 'https://chatgpt.com/c/conv-xyz');
  assert.equal(chromeTabs.created[0].active, false, "must not steal the user's foreground tab");
  assert.equal(tabId, chromeTabs.created[0].id);
  assert.deepEqual(chromeTabs.removed, [], 'a successful attach must never close the tab it just opened');
  assert.ok(logs.includes('attach requested url=https://chatgpt.com/c/conv-xyz'));
  assert.ok(logs.includes(`attach tab created tabId=${tabId}`));
});

test('attachSupervisorTab cleans up the orphaned tab if it never finishes loading', async () => {
  const chromeTabs = makeFakeChromeTabs();
  chromeTabs.waitForTabComplete = async () => {
    throw new Error('tab never reached complete');
  };
  await assert.rejects(
    () => attachSupervisorTab({ chatgptUrl: 'https://chatgpt.com/', conversationId: 'conv-xyz' }, chromeTabs),
    /never reached complete/
  );
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
