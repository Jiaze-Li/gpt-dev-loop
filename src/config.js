import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  chatgptUrl: 'https://chatgpt.com/',
  // Account-equivalent cookies/session state must live outside any Git work
  // tree, not merely be gitignored inside one.
  profileDir: path.join(os.homedir(), '.gpt-dev-loop', 'chrome-profile'),
  headless: false,
  loginTimeoutMs: 300000,
  responseTimeoutMs: 120000,
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
  return {
    chatgptUrl: env.GPT_LOOP_CHATGPT_URL || DEFAULTS.chatgptUrl,
    profileDir: env.GPT_LOOP_PROFILE_DIR || DEFAULTS.profileDir,
    headless: parseBoolEnv(env, 'GPT_LOOP_HEADLESS', DEFAULTS.headless),
    loginTimeoutMs: parseIntEnv(env, 'GPT_LOOP_LOGIN_TIMEOUT_MS', DEFAULTS.loginTimeoutMs),
    responseTimeoutMs: parseIntEnv(env, 'GPT_LOOP_RESPONSE_TIMEOUT_MS', DEFAULTS.responseTimeoutMs),
  };
}
