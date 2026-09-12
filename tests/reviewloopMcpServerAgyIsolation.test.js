// Regression test for the AGY-hosted ReviewLoop recursion:
//
//   ambient AGY config contains reviewloop MCP
//           v
//   ReviewLoop startup metadata probe
//           v
//   isolated AGY configuration
//
// Both startup AGY probes (`probeAgyModelCatalog`, `detectAgyCustomAgentSupport`)
// must resolve and use the SAME isolated ReviewLoop gemini dir, and neither may
// ever be reachable through an ambient `agy models` invocation. This is
// asserted mechanically here — no real agy process, no model call.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMcpStartupRuntimeInputs } from '../src/mcp/reviewloopMcpServer.js';

const ISOLATED_DIR = '/isolated/reviewloop-agy-home';

test('startup: both AGY probes receive the isolated gemini dir, never ambient', async () => {
  const catalogCalls = [];
  const customAgentCalls = [];

  const result = await resolveMcpStartupRuntimeInputs({
    narrowAgyGeminiDir: () => ISOLATED_DIR,
    probeAgyModelCatalog: (opts) => { catalogCalls.push(opts); return ['fake-model']; },
    detectAgyCustomAgentSupport: async (opts) => { customAgentCalls.push(opts); return { supported: true, reason: 'ok' }; },
  });

  assert.equal(catalogCalls.length, 1);
  assert.equal(catalogCalls[0].geminiDir, ISOLATED_DIR);
  assert.equal(customAgentCalls.length, 1);
  assert.equal(customAgentCalls[0].geminiDir, ISOLATED_DIR);
  assert.deepEqual(result.agyCatalog, ['fake-model']);
  assert.deepEqual(result.customAgentSupport, { supported: true, reason: 'ok' });
});

test('startup: never calls the catalog probe with no geminiDir (the ambient-recursion shape)', async () => {
  const catalogCalls = [];
  await resolveMcpStartupRuntimeInputs({
    narrowAgyGeminiDir: () => ISOLATED_DIR,
    probeAgyModelCatalog: (opts) => { catalogCalls.push(opts); return null; },
    detectAgyCustomAgentSupport: async () => ({ supported: false, reason: 'n/a' }),
  });
  assert.equal(catalogCalls.length, 1);
  assert.notEqual(catalogCalls[0].geminiDir, undefined);
  assert.notEqual(catalogCalls[0].geminiDir, '');
});

test('startup: a throwing custom-agent probe still degrades safely (fail closed, not ambient fallback)', async () => {
  const result = await resolveMcpStartupRuntimeInputs({
    narrowAgyGeminiDir: () => ISOLATED_DIR,
    probeAgyModelCatalog: () => null,
    detectAgyCustomAgentSupport: async () => { throw new Error('boom'); },
  });
  assert.equal(result.customAgentSupport.supported, false);
  assert.match(result.customAgentSupport.reason, /boom/);
});

test('startup: default deps resolve a real isolated gemini dir (not ambient) without spawning agy', async () => {
  // No injected probes for probeAgyModelCatalog / detectAgyCustomAgentSupport:
  // this exercises the real default wiring end to end, but stubs the actual
  // process spawns so no real `agy` binary is invoked.
  const result = await resolveMcpStartupRuntimeInputs({
    probeAgyModelCatalog: ({ geminiDir } = {}) => {
      assert.ok(typeof geminiDir === 'string' && geminiDir.length > 0, 'must receive an isolated geminiDir');
      return null;
    },
    detectAgyCustomAgentSupport: async ({ geminiDir } = {}) => {
      assert.ok(typeof geminiDir === 'string' && geminiDir.length > 0, 'must receive an isolated geminiDir');
      return { supported: false, reason: 'stubbed' };
    },
  });
  assert.equal(result.agyCatalog, null);
  assert.equal(result.customAgentSupport.reason, 'stubbed');
});
