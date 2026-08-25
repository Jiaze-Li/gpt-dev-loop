import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULTS, workflowProfileDir } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('loadConfig falls back to defaults with an empty environment', () => {
  const config = loadConfig({});
  assert.equal(config.chatgptUrl, DEFAULTS.chatgptUrl);
  assert.equal(config.profileDir, DEFAULTS.profileDir);
  assert.equal(config.loginTimeoutMs, DEFAULTS.loginTimeoutMs);
  assert.equal(config.responseTimeoutMs, DEFAULTS.responseTimeoutMs);
  assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs);
  assert.equal(config.backgroundWindow, DEFAULTS.backgroundWindow);
});

test('loadConfig honors explicit overrides', () => {
  const config = loadConfig({
    GPT_LOOP_CHATGPT_URL: 'https://chatgpt.com/custom',
    GPT_LOOP_PROFILE_DIR: '/tmp/custom-profile',
    GPT_LOOP_LOGIN_TIMEOUT_MS: '1000',
    GPT_LOOP_RESPONSE_TIMEOUT_MS: '2000',
    GPT_LOOP_REQUEST_TIMEOUT_MS: '3000',
    GPT_LOOP_BACKGROUND_WINDOW: 'false',
  });
  assert.equal(config.chatgptUrl, 'https://chatgpt.com/custom');
  assert.equal(config.profileDir, '/tmp/custom-profile');
  assert.equal(config.loginTimeoutMs, 1000);
  assert.equal(config.responseTimeoutMs, 2000);
  assert.equal(config.requestTimeoutMs, 3000);
  assert.equal(config.backgroundWindow, false);
});

test('browserMode defaults to "launch" (Playwright owns a dedicated profile)', () => {
  assert.equal(DEFAULTS.browserMode, 'launch');
  assert.equal(loadConfig({}).browserMode, 'launch');
});

test('GPT_BROWSER_MODE=cdp switches to attaching over CDP', () => {
  const config = loadConfig({ GPT_BROWSER_MODE: 'cdp' });
  assert.equal(config.browserMode, 'cdp');
});

test('cdpUrl defaults to localhost:9222 and can be overridden', () => {
  assert.equal(DEFAULTS.cdpUrl, 'http://localhost:9222');
  assert.equal(loadConfig({}).cdpUrl, 'http://localhost:9222');
  assert.equal(
    loadConfig({ GPT_LOOP_CDP_URL: 'http://localhost:9333' }).cdpUrl,
    'http://localhost:9333'
  );
});

test('loadConfig warns and falls back to "launch" on an unrecognized GPT_BROWSER_MODE', () => {
  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (line) => loggedLines.push(line);
  try {
    const config = loadConfig({ GPT_BROWSER_MODE: 'headless-ws' });
    assert.equal(config.browserMode, 'launch');
    assert.ok(loggedLines.some((line) => /unrecognized GPT_BROWSER_MODE/.test(line)));
  } finally {
    console.error = originalConsoleError;
  }
});

test('loadConfig treats "0" and "false" as backgroundWindow=false', () => {
  assert.equal(loadConfig({ GPT_LOOP_BACKGROUND_WINDOW: '0' }).backgroundWindow, false);
  assert.equal(loadConfig({ GPT_LOOP_BACKGROUND_WINDOW: 'false' }).backgroundWindow, false);
});

test('backgroundWindow defaults to true so gpt-loop does not disturb the desktop', () => {
  assert.equal(DEFAULTS.backgroundWindow, true);
  assert.equal(loadConfig({}).backgroundWindow, true);
});

test('loadConfig ignores invalid numeric overrides and keeps defaults', () => {
  const config = loadConfig({
    GPT_LOOP_LOGIN_TIMEOUT_MS: 'not-a-number',
    GPT_LOOP_RESPONSE_TIMEOUT_MS: '-5',
  });
  assert.equal(config.loginTimeoutMs, DEFAULTS.loginTimeoutMs);
  assert.equal(config.responseTimeoutMs, DEFAULTS.responseTimeoutMs);
});

test('loadConfig warns on stderr and ignores the retired GPT_LOOP_HEADLESS env var', () => {
  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (line) => loggedLines.push(line);
  try {
    const config = loadConfig({ GPT_LOOP_HEADLESS: 'true' });
    assert.equal('headless' in config, false);
    assert.ok(loggedLines.some((line) => /GPT_LOOP_HEADLESS is no longer supported/.test(line)));
  } finally {
    console.error = originalConsoleError;
  }
});

test('workflowProfileDir nests a workflow-scoped Chrome profile under the base profile dir, not the shared default', () => {
  const dir = workflowProfileDir('wf-abc123');
  assert.match(dir, /\.gpt-dev-loop[\\/]workflows[\\/]wf-abc123[\\/]chrome-profile$/);
  assert.notEqual(dir, DEFAULTS.profileDir);
  assert.ok(dir.startsWith(os.homedir()));
});

test('workflowProfileDir gives two different workflows non-conflicting profile paths', () => {
  const first = workflowProfileDir('wf-111');
  const second = workflowProfileDir('wf-222');
  assert.notEqual(first, second);
  assert.match(first, /wf-111/);
  assert.match(second, /wf-222/);
});

test('workflowProfileDir honors a custom base profile dir (e.g. GPT_LOOP_PROFILE_DIR override)', () => {
  const dir = workflowProfileDir('wf-abc123', '/tmp/custom-profile');
  assert.equal(dir, path.join('/tmp', 'workflows', 'wf-abc123', 'chrome-profile'));
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
