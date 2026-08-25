import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULTS } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('loadConfig falls back to defaults with an empty environment', () => {
  const config = loadConfig({});
  assert.equal(config.chatgptUrl, DEFAULTS.chatgptUrl);
  assert.equal(config.profileDir, DEFAULTS.profileDir);
  assert.equal(config.headless, DEFAULTS.headless);
  assert.equal(config.loginTimeoutMs, DEFAULTS.loginTimeoutMs);
  assert.equal(config.responseTimeoutMs, DEFAULTS.responseTimeoutMs);
});

test('loadConfig honors explicit overrides', () => {
  const config = loadConfig({
    GPT_LOOP_CHATGPT_URL: 'https://chatgpt.com/custom',
    GPT_LOOP_PROFILE_DIR: '/tmp/custom-profile',
    GPT_LOOP_HEADLESS: 'true',
    GPT_LOOP_LOGIN_TIMEOUT_MS: '1000',
    GPT_LOOP_RESPONSE_TIMEOUT_MS: '2000',
  });
  assert.equal(config.chatgptUrl, 'https://chatgpt.com/custom');
  assert.equal(config.profileDir, '/tmp/custom-profile');
  assert.equal(config.headless, true);
  assert.equal(config.loginTimeoutMs, 1000);
  assert.equal(config.responseTimeoutMs, 2000);
});

test('loadConfig treats "0" and "false" as headless=false', () => {
  assert.equal(loadConfig({ GPT_LOOP_HEADLESS: '0' }).headless, false);
  assert.equal(loadConfig({ GPT_LOOP_HEADLESS: 'false' }).headless, false);
});

test('headless defaults to true so gpt-loop runs without a visible window', () => {
  assert.equal(DEFAULTS.headless, true);
  assert.equal(loadConfig({}).headless, true);
});

test('GPT_LOOP_HEADLESS=false overrides the headless default', () => {
  assert.equal(loadConfig({ GPT_LOOP_HEADLESS: 'false' }).headless, false);
});

test('loadConfig ignores invalid numeric overrides and keeps defaults', () => {
  const config = loadConfig({
    GPT_LOOP_LOGIN_TIMEOUT_MS: 'not-a-number',
    GPT_LOOP_RESPONSE_TIMEOUT_MS: '-5',
  });
  assert.equal(config.loginTimeoutMs, DEFAULTS.loginTimeoutMs);
  assert.equal(config.responseTimeoutMs, DEFAULTS.responseTimeoutMs);
});

test('default profile dir lives under the home directory, not inside this repo', () => {
  assert.match(DEFAULTS.profileDir, /\.gpt-dev-loop[\\/]chrome-profile$/);
  assert.ok(
    DEFAULTS.profileDir.startsWith(os.homedir()),
    'account-equivalent cookies must not default into a Git work tree'
  );
  assert.ok(
    !DEFAULTS.profileDir.startsWith(REPO_ROOT),
    'default profile dir must not resolve inside the gpt-dev-loop repository'
  );
});
