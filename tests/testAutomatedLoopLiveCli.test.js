import test from 'node:test';
import assert from 'node:assert/strict';

// scripts/test-automated-loop-live.js is a live E2E entry point (hits real
// ChatGPT), but its CLI flag parsing is pure and deterministic — imported
// directly here rather than exercised through main(), which this test
// suite never calls.
import { parseCliFlags } from '../scripts/test-automated-loop-live.js';

test('parseCliFlags defaults both flags to false when neither is passed', () => {
  assert.deepEqual(parseCliFlags([]), { keepOpenOnFailure: false, keepOpen: false });
});

test('parseCliFlags detects --keep-open-on-failure', () => {
  assert.deepEqual(parseCliFlags(['--keep-open-on-failure']), { keepOpenOnFailure: true, keepOpen: false });
});

test('parseCliFlags detects --keep-open', () => {
  assert.deepEqual(parseCliFlags(['--keep-open']), { keepOpenOnFailure: false, keepOpen: true });
});

test('parseCliFlags detects both flags together, in either order', () => {
  assert.deepEqual(parseCliFlags(['--keep-open-on-failure', '--keep-open']), { keepOpenOnFailure: true, keepOpen: true });
  assert.deepEqual(parseCliFlags(['--keep-open', '--keep-open-on-failure']), { keepOpenOnFailure: true, keepOpen: true });
});

test('parseCliFlags ignores unrelated argv entries', () => {
  assert.deepEqual(parseCliFlags(['--some-other-flag', 'positional-arg']), { keepOpenOnFailure: false, keepOpen: false });
});
