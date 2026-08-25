import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';
import { UsageError } from '../src/bridge/errors.js';

test('parseArgs accepts a single-word prompt', () => {
  const result = parseArgs(['ask', 'HANDSHAKE_OK']);
  assert.equal(result.command, 'ask');
  assert.equal(result.prompt, 'HANDSHAKE_OK');
});

test('parseArgs joins a multi-word prompt with spaces', () => {
  const result = parseArgs(['ask', 'Reply', 'with', 'exactly', 'HANDSHAKE_OK']);
  assert.equal(result.prompt, 'Reply with exactly HANDSHAKE_OK');
});

test('parseArgs rejects an unknown command', () => {
  assert.throws(() => parseArgs(['review', 'x']), UsageError);
});

test('parseArgs rejects a missing command', () => {
  assert.throws(() => parseArgs([]), UsageError);
});

test('parseArgs rejects a missing prompt', () => {
  assert.throws(() => parseArgs(['ask']), UsageError);
});

test('parseArgs rejects a whitespace-only prompt', () => {
  assert.throws(() => parseArgs(['ask', '   ']), UsageError);
});
