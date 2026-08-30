import test from 'node:test';
import assert from 'node:assert/strict';

import { createCodexSupervisorProvider } from '../src/orchestrator/adapters/codexSupervisorProvider.js';

test('Codex Supervisor uses the shared decision validator and preserves native usage', async () => {
  const provider = createCodexSupervisorProvider({
    model: 'configured-model',
    call: async () => ({
      text: JSON.stringify({ action: 'WORKFLOW_DONE', summary: 'all tasks passed' }),
      usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 4 },
      durationMs: 9,
    }),
  });
  const decision = await provider.decide({ workflowGoal: 'finish', history: [] });
  assert.equal(decision.action, 'WORKFLOW_DONE');
  assert.equal(decision.summary, 'all tasks passed');
  assert.match(decision.callId, /^call-codex-sup-/);
  assert.equal(decision.usage.input_tokens, 12);
  assert.equal(decision.durationMs, 9);
});

test('Codex Supervisor forwards and returns a physical thread id for bounded session reuse', async () => {
  let opts;
  const provider = createCodexSupervisorProvider({ call: async (value) => {
    opts = value;
    return { text: JSON.stringify({ action: 'WORKFLOW_DONE', summary: 'done' }), conversationId: 'thread-2' };
  } });
  const decision = await provider.decide({}, { conversationId: 'thread-1', effort: 'low' });
  assert.equal(opts.conversationId, 'thread-1');
  assert.equal(opts.effort, 'low');
  assert.equal(decision.conversationId, 'thread-2');
});

test('Codex Supervisor fails closed on non-JSON output', async () => {
  const provider = createCodexSupervisorProvider({ call: async () => ({ text: 'not JSON' }) });
  await assert.rejects(() => provider.decide({}), { code: 'SUPERVISOR_INVALID_OUTPUT' });
});
