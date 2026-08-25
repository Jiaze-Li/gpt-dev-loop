import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAskGpt } from '../src/bridge/transport.js';
import { askGpt as askGptPlaywright } from '../src/bridge/chatgptWeb.js';
import { askGpt as askGptExtension } from '../src/bridge/chatgptExtension.js';

test('resolveAskGpt picks the extension transport when browserMode is "extension"', () => {
  assert.equal(resolveAskGpt({ browserMode: 'extension' }), askGptExtension);
});

test('resolveAskGpt picks the Playwright transport for "launch"', () => {
  assert.equal(resolveAskGpt({ browserMode: 'launch' }), askGptPlaywright);
});

test('resolveAskGpt picks the Playwright transport for "cdp"', () => {
  assert.equal(resolveAskGpt({ browserMode: 'cdp' }), askGptPlaywright);
});
