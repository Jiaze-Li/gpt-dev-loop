// Phase 1 — the production Reviewer / Supervisor invoke path parses the MODEL
// reply (callAgy's `res.text`), not the agy TRANSPORT envelope (`res.json`,
// which is { result, usage, conversation_id, ... }). Tests use the real
// callAgy-shaped resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionReviewLoopProviders } from '../src/reviewloop/providerWiring.js';

// Exactly what src/agy/agyClient.js#callAgy resolves to.
function callAgyShaped({ replyText, usage = { input_tokens: 40, output_tokens: 12 } }) {
  return async () => ({
    model: 'gpt-oss-mock',
    exitCode: 0,
    text: replyText,
    json: { result: replyText, usage, conversation_id: 'conv-abc' },
    stdout: JSON.stringify({ result: replyText, usage }),
    durationMs: 5,
    conversationId: 'conv-abc',
    usage,
  });
}

const objective = { goal: 'do the thing', constraints: [] };

test('a fenced {"findings":[...]} model reply is parsed into a real reviewer verdict + usage', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({ replyText: '```json\n{"findings":[{"severity":"P1","file":"a.js","line":3,"title":"npe"}]}\n```' }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'diff --git a a', changedFiles: ['a.js'], gate: { verdict: 'PASS' } });
  assert.equal(out.value.malformed, undefined, 'not treated as malformed');
  assert.equal(out.value.findings.length, 1);
  assert.equal(out.value.findings[0].severity, 'P1');
  assert.deepEqual(out.usage, { input_tokens: 40, output_tokens: 12 });
});

test('a clean model reply parses to an empty findings list, still not malformed', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({ replyText: '{"findings": []}' }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'd', changedFiles: [], gate: {} });
  assert.deepEqual(out.value, { findings: [] });
});

test('a supervisor {"guidance","recommendation"} reply parses correctly', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({ replyText: '{"guidance":"split the change","recommendation":"REWORK"}' }),
  });
  const out = await providers.supervisorFn({ objective, blockingFindings: [{ severity: 'P1', title: 'x' }] });
  assert.equal(out.value.recommendation, 'REWORK');
  assert.equal(out.value.guidance, 'split the change');
});

test('a genuinely unparseable model reply is surfaced as malformed (fail closed), not silently empty', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({ replyText: 'I could not complete the review.' }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'd', changedFiles: [], gate: {} });
  assert.equal(out.value.malformed, true);
});

test('prose wrapped around a fenced JSON block is still parsed', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({
      replyText: 'I reviewed the diff against the objective.\n\n```json\n{"findings":[{"severity":"P2","file":"x.js","title":"missing null check"}]}\n```\n\nOverall the change looks reasonable.',
    }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'd', changedFiles: ['x.js'], gate: {} });
  assert.equal(out.value.malformed, undefined);
  assert.equal(out.value.findings[0].severity, 'P2');
});

test('prose wrapped around a bare JSON object (no fence) is still parsed', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: callAgyShaped({
      replyText: 'Here is my assessment: {"findings": []} — nothing blocking.',
    }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'd', changedFiles: [], gate: {} });
  assert.deepEqual(out.value, { findings: [] });
});

test('json-schema mode: the payload arrives as the envelope object itself', async () => {
  const providers = createProductionReviewLoopProviders({
    callAgy: async () => ({
      model: 'm', exitCode: 0, text: '', durationMs: 1, conversationId: null,
      json: { findings: [{ severity: 'P2', file: 'b', title: 'race' }], usage: { input_tokens: 1, output_tokens: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const out = await providers.reviewerFn({ objective, diff: 'd', changedFiles: ['b'], gate: {} });
  assert.equal(out.value.findings[0].severity, 'P2');
});
