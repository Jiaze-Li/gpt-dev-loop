// Deterministic tests for the `agy models` catalog probe's isolation
// boundary: a caller-supplied `geminiDir` must be passed as a leading
// `--gemini_dir=<dir>` arg, never invoked ambiently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeAgyModelCatalog, _resetAgyModelCatalogCache } from '../src/agy/agyModelCatalog.js';

function fakeExec(calls, out = '') {
  return (...args) => { calls.push(args); return out; };
}

test('probeAgyModelCatalog: with a geminiDir, invokes agy with --gemini_dir before models', () => {
  _resetAgyModelCatalogCache();
  const calls = [];
  probeAgyModelCatalog({ geminiDir: '/isolated/reviewloop-agy-home', exec: fakeExec(calls) });
  assert.equal(calls.length, 1);
  const [bin, args] = calls[0];
  assert.equal(bin, 'agy');
  assert.deepEqual(args, ['--gemini_dir=/isolated/reviewloop-agy-home', 'models']);
});

test('probeAgyModelCatalog: without a geminiDir, invokes ambient agy models (legacy default)', () => {
  _resetAgyModelCatalogCache();
  const calls = [];
  probeAgyModelCatalog({ exec: fakeExec(calls) });
  assert.equal(calls.length, 1);
  const [, args] = calls[0];
  assert.deepEqual(args, ['models']);
});

test('probeAgyModelCatalog: blank/whitespace geminiDir is treated as absent, not passed as a flag', () => {
  _resetAgyModelCatalogCache();
  const calls = [];
  probeAgyModelCatalog({ geminiDir: '   ', exec: fakeExec(calls) });
  const [, args] = calls[0];
  assert.deepEqual(args, ['models']);
});

test('probeAgyModelCatalog: on failure with a geminiDir set, still returns null (never throws)', () => {
  _resetAgyModelCatalogCache();
  const result = probeAgyModelCatalog({
    geminiDir: '/isolated/reviewloop-agy-home',
    exec: () => { throw new Error('boom'); },
  });
  assert.equal(result, null);
});
