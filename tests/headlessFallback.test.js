import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runAskGpt, shouldFallbackToVisible } from '../src/bridge/chatgptWeb.js';
import {
  LoginRequiredError,
  SelectorMismatchError,
  ChromeUnavailableError,
  ResponseTimeoutError,
} from '../src/bridge/errors.js';

const FAKE_PROFILE_DIR = path.join(os.tmpdir(), 'gpt-loop-test-profile');

test('shouldFallbackToVisible is true for login/Cloudflare/selector failures', () => {
  assert.equal(shouldFallbackToVisible(new LoginRequiredError('x')), true);
  assert.equal(shouldFallbackToVisible(new SelectorMismatchError('x')), true);
});

test('shouldFallbackToVisible is false for failures after a prompt may have been sent', () => {
  assert.equal(shouldFallbackToVisible(new ResponseTimeoutError('x')), false);
  assert.equal(shouldFallbackToVisible(new ChromeUnavailableError('x')), false);
});

test('runAskGpt runs fully headless when headless succeeds, with no fallback', async () => {
  const calls = [];
  const run = async (prompt, config, headless) => {
    calls.push({ prompt, headless });
    return 'HANDSHAKE_OK';
  };

  const reply = await runAskGpt('ping', { headless: true, profileDir: FAKE_PROFILE_DIR }, { runSession: run });

  assert.equal(reply, 'HANDSHAKE_OK');
  assert.deepEqual(calls, [{ prompt: 'ping', headless: true }]);
});

test('runAskGpt falls back to a visible window when headless cannot find the composer', async () => {
  const calls = [];
  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (line) => loggedLines.push(line);

  try {
    const run = async (prompt, config, headless) => {
      calls.push({ prompt, headless });
      if (headless) throw new LoginRequiredError('Cloudflare challenge stuck');
      return 'HANDSHAKE_OK';
    };

    const reply = await runAskGpt('ping', { headless: true, profileDir: FAKE_PROFILE_DIR }, { runSession: run });

    assert.equal(reply, 'HANDSHAKE_OK');
    assert.deepEqual(calls, [
      { prompt: 'ping', headless: true },
      { prompt: 'ping', headless: false },
    ]);
    assert.ok(
      loggedLines.some((line) => /falling back to a visible chrome window/i.test(line)),
      'expected an explicit fallback notice on stderr'
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('runAskGpt does not retry visible when the headless failure is unrelated to login/composer', async () => {
  const calls = [];
  const run = async (prompt, config, headless) => {
    calls.push({ prompt, headless });
    throw new ResponseTimeoutError('response never finished');
  };

  await assert.rejects(
    () => runAskGpt('ping', { headless: true, profileDir: FAKE_PROFILE_DIR }, { runSession: run }),
    ResponseTimeoutError
  );
  assert.deepEqual(calls, [{ prompt: 'ping', headless: true }]);
});

test('runAskGpt skips headless entirely when config.headless is false', async () => {
  const calls = [];
  const run = async (prompt, config, headless) => {
    calls.push({ prompt, headless });
    return 'HANDSHAKE_OK';
  };

  const reply = await runAskGpt('ping', { headless: false, profileDir: FAKE_PROFILE_DIR }, { runSession: run });

  assert.equal(reply, 'HANDSHAKE_OK');
  assert.deepEqual(calls, [{ prompt: 'ping', headless: false }]);
});
