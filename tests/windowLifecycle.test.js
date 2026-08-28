import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationWindow, activateTabWithoutFocus, closeAutomationWindow, listAutomationWindowTabs, classifyUrlState } from '../extension/windowLifecycle.js';

// The exact set of fields chrome.windows.create() accepts as createData —
// `populate` is NOT one of them (it only exists on the window-query APIs,
// chrome.windows.get/getAll) and passing it throws "Unexpected property:
// 'populate'" in a real browser (live evidence, 2026-08-27). This is the
// regression test for that: it fails if createAutomationWindow ever again
// sends a field real Chrome would reject.
const VALID_WINDOWS_CREATE_FIELDS = new Set([
  'url',
  'tabId',
  'left',
  'top',
  'width',
  'height',
  'focused',
  'incognito',
  'type',
  'state',
  'setSelfAsOpener',
]);

function assertValidCreateData(opts) {
  for (const key of Object.keys(opts)) {
    assert.ok(VALID_WINDOWS_CREATE_FIELDS.has(key), `chrome.windows.create() createData sent an unsupported field: "${key}"`);
  }
}

test('createAutomationWindow creates a window with focused:false and returns its windowId', async () => {
  const calls = [];
  const { windowId } = await createAutomationWindow(
    {},
    {
      createWindow: async (opts) => {
        calls.push(opts);
        return { id: 42, focused: opts.focused };
      },
      queryTabs: async () => [],
    }
  );
  assert.equal(windowId, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].focused, false);
  assertValidCreateData(calls[0]);
});

test('createAutomationWindow never sends an unsupported createData field (e.g. populate) to chrome.windows.create', async () => {
  let seenOpts;
  await createAutomationWindow(
    { url: 'https://chatgpt.com/' },
    {
      createWindow: async (opts) => {
        seenOpts = opts;
        return { id: 42 };
      },
      queryTabs: async () => [],
    }
  );
  assertValidCreateData(seenOpts);
  assert.equal('populate' in seenOpts, false);
});

test('createAutomationWindow defaults to about:blank when no url is given', async () => {
  let seenUrl;
  await createAutomationWindow(
    {},
    {
      createWindow: async (opts) => {
        seenUrl = opts.url;
        return { id: 1 };
      },
      queryTabs: async () => [],
    }
  );
  assert.equal(seenUrl, 'about:blank');
});

test('createAutomationWindow obtains initialTabId via a separate chrome.tabs.query({ windowId }) call, never from the create() response', async () => {
  const queriedWindowIds = [];
  const { windowId, initialTabId } = await createAutomationWindow(
    { url: 'https://chatgpt.com/' },
    {
      // Deliberately does NOT return a `tabs` array — a real
      // chrome.windows.create() response (without the invalid `populate`
      // field) carries no tabs, so this proves initialTabId cannot be
      // coming from here.
      createWindow: async () => ({ id: 42 }),
      queryTabs: async (windowId) => {
        queriedWindowIds.push(windowId);
        return [{ id: 777, active: true, url: 'https://chatgpt.com/' }];
      },
    }
  );
  assert.deepEqual(queriedWindowIds, [42]);
  assert.equal(windowId, 42);
  assert.equal(initialTabId, 777);
});

test('createAutomationWindow picks the active tab as the initial tab when the query returns more than one', async () => {
  const { initialTabId } = await createAutomationWindow(
    {},
    {
      createWindow: async () => ({ id: 42 }),
      queryTabs: async () => [
        { id: 501, active: false },
        { id: 777, active: true },
      ],
    }
  );
  assert.equal(initialTabId, 777);
});

test('createAutomationWindow reports initialTabId null when the tab query returns no tabs', async () => {
  const { initialTabId } = await createAutomationWindow(
    {},
    { createWindow: async () => ({ id: 1 }), queryTabs: async () => [] }
  );
  assert.equal(initialTabId, null);
});

test('classifyUrlState buckets URLs without ever needing to expose the URL itself', () => {
  assert.equal(classifyUrlState('https://chatgpt.com/c/abc'), 'chatgpt');
  assert.equal(classifyUrlState('https://chat.openai.com/'), 'chatgpt');
  assert.equal(classifyUrlState('about:blank'), 'blank');
  assert.equal(classifyUrlState('chrome://extensions'), 'chrome-internal');
  assert.equal(classifyUrlState('chrome-extension://abc/page.html'), 'chrome-internal');
  assert.equal(classifyUrlState('https://example.com/'), 'other');
  assert.equal(classifyUrlState(undefined), 'other');
});

test('listAutomationWindowTabs returns only safe metadata, never url/title', async () => {
  const { tabs } = await listAutomationWindowTabs(42, {
    queryTabs: async (windowId) => {
      assert.equal(windowId, 42);
      return [
        { id: 501, active: true, status: 'complete', url: 'https://chatgpt.com/c/abc', title: 'Secret conversation title', openerTabId: 900 },
        { id: 502, active: false, status: 'loading', url: 'about:blank', title: 'New Tab' },
      ];
    },
  });
  assert.deepEqual(tabs, [
    { windowId: 42, tabId: 501, active: true, status: 'complete', urlState: 'chatgpt', openerTabId: 900 },
    { windowId: 42, tabId: 502, active: false, status: 'loading', urlState: 'blank', openerTabId: null },
  ]);
  for (const tab of tabs) {
    assert.equal('url' in tab, false);
    assert.equal('title' in tab, false);
  }
});

test('activateTabWithoutFocus makes the tab active without touching the window focus call', async () => {
  const updateCalls = [];
  const result = await activateTabWithoutFocus(7, {
    updateTab: async (tabId, opts) => {
      updateCalls.push({ tabId, opts });
      return { id: tabId, active: true, windowId: 99 };
    },
    getWindow: async (windowId) => ({ id: windowId, focused: false }),
  });
  assert.deepEqual(updateCalls, [{ tabId: 7, opts: { active: true } }]);
  assert.deepEqual(result, { tabId: 7, active: true, windowId: 99, windowFocused: false });
});

test('activateTabWithoutFocus reports the real observed windowFocused state, even if true', async () => {
  const result = await activateTabWithoutFocus(7, {
    updateTab: async (tabId) => ({ id: tabId, active: true, windowId: 99 }),
    getWindow: async (windowId) => ({ id: windowId, focused: true }),
  });
  assert.equal(result.windowFocused, true);
});

test('closeAutomationWindow removes an existing window', async () => {
  const removed = [];
  await closeAutomationWindow(42, {
    windowExists: async () => true,
    removeWindow: async (windowId) => removed.push(windowId),
  });
  assert.deepEqual(removed, [42]);
});

test('closeAutomationWindow is a no-op when the window is already gone', async () => {
  const removed = [];
  await closeAutomationWindow(42, {
    windowExists: async () => false,
    removeWindow: async (windowId) => removed.push(windowId),
  });
  assert.deepEqual(removed, []);
});
