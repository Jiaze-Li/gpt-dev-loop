#!/usr/bin/env node
// Live smoke test for GPT_BROWSER_MODE=cdp (src/bridge/chromeRuntime.js).
// Not part of `npm test` — this needs a real Chrome you already have
// running with --remote-debugging-port=9222, and talks to the real
// chatgpt.com, so it's a manual/CI-optional tool, not a unit test.
//
// Verifies the CDP-attach path end-to-end against your live browser: finds
// the CDP endpoint, attaches to it, opens (or reuses) a chatgpt.com tab,
// sends one fixed prompt, and checks the reply. Does not modify the
// orchestrator, MCP transport, workflow logic, or any production code —
// it only calls the existing bridge functions (loadConfig, askGpt,
// closeChromeRuntime) exactly as any other caller would.
//
// Usage: node scripts/test-cdp-live.js
// (see README.md's "Live CDP smoke test" section for the full walkthrough)

import { loadConfig } from '../src/config.js';
import { askGpt } from '../src/bridge/chatgptWeb.js';
import { closeChromeRuntime } from '../src/bridge/chromeRuntime.js';

const TEST_PROMPT = 'Reply exactly CDP_LIVE_TEST_OK';
const EXPECTED_REPLY = 'CDP_LIVE_TEST_OK';
const CDP_PROBE_TIMEOUT_MS = 5000;

function pass(detail) {
  console.log(`PASS: ${detail}`);
  process.exitCode = 0;
}

function fail(reason) {
  console.log(`FAIL: ${reason}`);
  process.exitCode = 1;
}

// Requirement 1: confirm a CDP service is actually listening before handing
// things to Playwright, so a closed port gets a clear "no Chrome" reason
// instead of a generic connection-error stack.
async function probeCdpEndpoint(cdpUrl) {
  const versionUrl = new URL('/json/version', cdpUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDP_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(versionUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`unexpected HTTP status ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    throw new Error(
      `no Chrome DevTools Protocol service found at ${cdpUrl} (${err.message}). ` +
        'Start Chrome with --remote-debugging-port=9222 and try again.'
    );
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'cdp' };

  let versionInfo;
  try {
    versionInfo = await probeCdpEndpoint(config.cdpUrl);
  } catch (err) {
    fail(err.message);
    return;
  }
  console.error(`gpt-loop: found ${versionInfo.Browser ?? 'a Chrome instance'} at ${config.cdpUrl}`);

  let reply;
  try {
    // Requirements 2-5: askGpt (src/bridge/chatgptWeb.js) already does
    // "attach -> find/open a chatgpt.com tab -> send prompt -> wait for
    // reply" for any caller; browserMode: 'cdp' above is what routes it
    // through connectOverCDP instead of launching a dedicated profile.
    reply = await askGpt(TEST_PROMPT, config);
  } catch (err) {
    fail(err.message);
    await closeChromeRuntime().catch(() => {});
    return;
  }

  await closeChromeRuntime().catch(() => {});

  const trimmed = reply.trim();
  if (trimmed === EXPECTED_REPLY) {
    pass(EXPECTED_REPLY);
  } else {
    fail(`expected exactly "${EXPECTED_REPLY}", got: ${JSON.stringify(trimmed)}`);
  }
}

main().catch(async (err) => {
  fail(`unexpected error: ${err.message}`);
  await closeChromeRuntime().catch(() => {});
});
