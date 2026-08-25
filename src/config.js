import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  chatgptUrl: 'https://chatgpt.com/',
  // Account-equivalent cookies/session state must live outside any Git work
  // tree, not merely be gitignored inside one.
  profileDir: path.join(os.homedir(), '.gpt-dev-loop', 'chrome-profile'),
  loginTimeoutMs: 300000,
  responseTimeoutMs: 120000,
  // Covers the whole call (queueing + navigation + manual recovery + send +
  // reply), so it's set above loginTimeoutMs + responseTimeoutMs.
  requestTimeoutMs: 450000,
  backgroundWindow: true,
});

function parseIntEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseBoolEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function loadConfig(env = process.env) {
  if (env.GPT_LOOP_HEADLESS !== undefined) {
    console.error(
      'gpt-loop: GPT_LOOP_HEADLESS is no longer supported (Chrome always runs headful now) and is being ignored.'
    );
  }

  return {
    chatgptUrl: env.GPT_LOOP_CHATGPT_URL || DEFAULTS.chatgptUrl,
    profileDir: env.GPT_LOOP_PROFILE_DIR || DEFAULTS.profileDir,
    loginTimeoutMs: parseIntEnv(env, 'GPT_LOOP_LOGIN_TIMEOUT_MS', DEFAULTS.loginTimeoutMs),
    responseTimeoutMs: parseIntEnv(env, 'GPT_LOOP_RESPONSE_TIMEOUT_MS', DEFAULTS.responseTimeoutMs),
    requestTimeoutMs: parseIntEnv(env, 'GPT_LOOP_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs),
    backgroundWindow: parseBoolEnv(env, 'GPT_LOOP_BACKGROUND_WINDOW', DEFAULTS.backgroundWindow),
  };
}
