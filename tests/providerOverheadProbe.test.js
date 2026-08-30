import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_OVERHEAD_PROMPT,
  runProviderOverheadProbe,
} from '../src/orchestrator/providerOverheadProbe.js';

test('provider overhead probe uses a fixed prompt and only provider-native usage', async () => {
  const calls = [];
  const report = await runProviderOverheadProbe({
    env: { AGY_SUPERVISOR_MODEL: 'gemini-test', SUPERGPT_AGY_SUPERVISOR_AGENT: 'minimal-supervisor' },
    callAgyFn: async (options) => {
      calls.push(options);
      return {
        model: options.model,
        durationMs: 123,
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 },
      };
    },
    runCodexFn: async ({ name }) => ({
      name, status: 'MEASURED', provider: 'codex', latencyMs: 20,
      usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: null }, usageSource: 'native',
    }),
  });

  assert.equal(report.schema, 'supergpt.provider-overhead/v1');
  assert.equal(report.prompt, PROVIDER_OVERHEAD_PROMPT);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.prompt === PROVIDER_OVERHEAD_PROMPT));
  assert.ok(calls.every((call) => call.disableSlashCommands === true));
  assert.deepEqual(report.variants[0].usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 });
  assert.equal(report.variants[2].agent, 'minimal-supervisor');
  assert.equal(report.variants[3].usage.inputTokens, 7);
  assert.equal(report.variants[4].name, 'codex_minimal');
});

test('provider overhead probe leaves a missing dedicated agent explicitly unavailable', async () => {
  const report = await runProviderOverheadProbe({
    env: {},
    callAgyFn: async () => ({ model: 'm', durationMs: 1, usage: null }),
    runCodexFn: async ({ name }) => ({ name, status: 'USAGE_UNAVAILABLE' }),
  });
  assert.equal(report.variants[2].status, 'UNAVAILABLE');
  assert.match(report.variants[2].reason, /SUPERGPT_AGY_SUPERVISOR_AGENT/);
  assert.equal(report.variants[0].usage, null);
});
