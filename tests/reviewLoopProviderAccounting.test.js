// Provider/family-aware token accounting — cached tokens must never be
// double-counted into the usageVolume safety ceiling, UNKNOWN != ZERO is
// preserved, and every derived volume carries provenance.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usageAccountingOf,
  usageVolumeOf,
  usageBreakdownOf,
  accountingClassOf,
  accountingProvenanceOf,
  usagePresentButUnresolved,
  createReviewLoopSpend,
} from '../src/reviewloop/reviewSpend.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('accountingClassOf resolves from family, then provider, never a model name', () => {
  assert.equal(accountingClassOf({ family: 'codex:default' }), 'openai');
  assert.equal(accountingClassOf({ family: 'claude:opus' }), 'anthropic');
  assert.equal(accountingClassOf({ family: 'agy:gemini-supervisor' }), 'agy');
  assert.equal(accountingClassOf({ family: 'agy:gpt-oss' }), 'agy');
  assert.equal(accountingClassOf({ family: 'agy:opus' }), 'agy');
  assert.equal(accountingClassOf({ provider: 'codex' }), 'openai');
  assert.equal(accountingClassOf({ provider: 'agy-gemini' }), 'agy');
  assert.equal(accountingClassOf({ family: 'gpt-5-codex-high' }), 'unknown');
  assert.equal(accountingClassOf({}), 'unknown');
});

test('Codex/OpenAI: cache_read is a subset of input and is NOT added again', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 },
    family: 'codex:default', provider: 'codex',
  });
  assert.equal(a.usageVolume, 16931); // input + output, not 27555
  assert.notEqual(a.usageVolume, 27555);
  assert.equal(a.usageAccountingMethod, 'openai_input_plus_output');
  assert.equal(a.semanticsKnown, true);
  // raw cache telemetry is still preserved
  assert.equal(a.breakdown.cacheReadTokens, 10624);
  assert.equal(usageBreakdownOf({ input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 }).cacheReadTokens, 10624);
});

test('Codex supervisor live numbers -> input + output', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 15588, cache_read_input_tokens: 10624, output_tokens: 50 },
    family: 'codex:default', provider: 'codex',
  });
  assert.equal(a.usageVolume, 15638);
});

test('Codex authoritative total wins when the envelope carries one', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9, total_tokens: 17000 },
    family: 'codex:default', provider: 'codex',
  });
  assert.equal(a.usageVolume, 17000);
  assert.equal(a.usageAccountingMethod, 'provider_total');
});

test('AGY Gemini: provider-reported total is authoritative (7252, never 15380)', () => {
  const usage = {
    input_tokens: 6713, output_tokens: 539, thinking_tokens: 506,
    cache_read_input_tokens: 8128, cache_creation_input_tokens: null, total_tokens: 7252,
  };
  const a = usageAccountingOf({ usage, family: 'agy:gemini-supervisor', provider: 'agy-gemini' });
  assert.equal(a.usageVolume, 7252);
  assert.notEqual(a.usageVolume, 15380);
  assert.ok(a.usageVolume < 6713 + 8128); // never reconstructed larger than the provider total
  assert.equal(a.usageAccountingMethod, 'provider_total');
  assert.equal(a.semanticsKnown, true);
  // cache telemetry retained verbatim even though it was not added to volume
  assert.equal(a.breakdown.cacheReadTokens, 8128);
  assert.equal(a.reportedTotalTokens, 7252);
});

test('AGY without an authoritative total -> conservative additive, flagged UNKNOWN', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 100, output_tokens: 100 },
    family: 'agy:gpt-oss', provider: 'agy-claude-gpt',
  });
  assert.equal(a.usageVolume, 200);
  assert.equal(a.usageAccountingMethod, 'conservative_additive_unknown');
  assert.equal(a.semanticsKnown, false);
});

test('agy:gpt-oss authoritative total is used when present', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 12089, output_tokens: 196, cache_read_input_tokens: 0, total_tokens: 12285 },
    family: 'agy:gpt-oss', provider: 'agy-claude-gpt',
  });
  assert.equal(a.usageVolume, 12285);
  assert.equal(a.usageAccountingMethod, 'provider_total');
  assert.equal(a.semanticsKnown, true);
});

test('Claude/Anthropic: cache creation + cache read are separate categories, still counted', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 2, output_tokens: 1549, cache_read_input_tokens: 2168, cache_creation_input_tokens: 1285 },
    family: 'claude:opus', provider: 'claude',
  });
  assert.equal(a.usageVolume, 5004); // 2 + 1549 + 2168 + 1285
  assert.notEqual(a.usageVolume, 1551); // cache tokens are NOT dropped
  assert.equal(a.usageAccountingMethod, 'anthropic_cache_additive');
  assert.equal(a.semanticsKnown, true);
});

test('Claude reviewer live numbers keep cache-creation in the volume', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 2, output_tokens: 29, cache_creation_input_tokens: 3490, cache_read_input_tokens: 0 },
    family: 'claude:opus', provider: 'claude',
  });
  assert.equal(a.usageVolume, 3521);
});

test('Unknown provider with cache fields is never presented as a precise provider total', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 9000 },
    family: null, provider: 'some-new-provider',
  });
  assert.equal(a.semanticsKnown, false);
  assert.equal(a.usageAccountingMethod, 'conservative_additive_unknown');
  assert.equal(a.reportedTotalTokens, null);
  assert.equal(a.usageVolume, 9540); // conservative sum, never faked as a total
});

test('UNKNOWN != ZERO: no usage object -> volume 0, semantics unknown, total null', () => {
  const a = usageAccountingOf({ usage: null, family: 'codex:default', provider: 'codex' });
  assert.equal(a.usageVolume, 0);
  assert.equal(a.usageAccountingMethod, 'no_usage_reported');
  assert.equal(a.semanticsKnown, false);
  assert.equal(a.reportedTotalTokens, null);
  assert.equal(usageVolumeOf(null), 0);
});

test('accountingProvenanceOf is compact and prompt-free', () => {
  const p = accountingProvenanceOf(usageAccountingOf({
    usage: { input_tokens: 6713, output_tokens: 539, total_tokens: 7252 },
    family: 'agy:gemini-supervisor', provider: 'agy-gemini',
  }));
  assert.deepEqual(p, {
    method: 'provider_total', semanticsKnown: true, volumeResolved: true,
    accountingClass: 'agy', reportedTotalTokens: 7252,
  });
});

test('corrected Codex volume flows into the durable MAX_USAGE_VOLUME budget and survives restart', async () => {
  const persistence = new MemoryPersistence();
  const env = { REVIEWLOOP_MAX_USAGE_VOLUME: '40000' };
  const mk = () => createReviewLoopSpend({ loopId: 'ACC', persistence, env });

  async function codexReviewer(spend, hash, usage) {
    const ev = await spend.registerEvidence({ kind: 'diff', taskId: `t-${hash}`, diffHash: hash });
    return spend.meteredCall({
      role: 'reviewer', family: 'codex:default', provider: 'codex',
      operationId: `op-${hash}`, evidenceIds: [ev.evidenceId],
      call: async () => ({ value: {}, usage }),
    });
  }

  // Two Codex calls: naive additive would be 2 * 27555 = 55110 (over the ceiling
  // and double-counting the cached prefix). Correct volume is 2 * 16931 = 33862.
  await codexReviewer(mk(), 'a', { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 });
  await codexReviewer(mk(), 'b', { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 });

  const t = await mk().telemetry();
  assert.equal(t.usageVolume, 33862);
  const rec = (await persistence.readWorkflowState('ACC')).reviewLoopSpend.records.at(-1);
  assert.equal(rec.usageVolume, 16931);
  assert.equal(rec.usageAccounting.method, 'openai_input_plus_output');
  assert.equal(rec.usageAccounting.semanticsKnown, true);

  // a third call is still allowed (33862 < 40000); a fourth would exceed it.
  await codexReviewer(mk(), 'c', { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 });
  await assert.rejects(
    () => codexReviewer(mk(), 'd', { input_tokens: 16922, cache_read_input_tokens: 10624, output_tokens: 9 }),
    /usage-volume ceiling/,
  );
});

test('conservative-semantics AGY call is surfaced in telemetry', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'SEM', persistence });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 't', diffHash: 'h' });
  await spend.meteredCall({
    role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy-claude-gpt',
    operationId: 'op', evidenceIds: [ev.evidenceId],
    call: async () => ({ value: {}, usage: { input_tokens: 50, output_tokens: 5 } }),
  });
  const t = await spend.telemetry();
  assert.equal(t.usageVolume, 55);
  assert.equal(t.unknownSemanticsCalls, 1);
  assert.equal(t.unknownUsageCalls, 0);
});

// ---- edge case 1: partial usage is never precise known spend ----------------

test('Codex partial usage (missing output_tokens) -> volumeResolved:false, not known', () => {
  const a = usageAccountingOf({ usage: { input_tokens: 10000 }, family: 'codex:default', provider: 'codex' });
  assert.equal(a.usageAccountingMethod, 'openai_input_plus_output');
  assert.equal(a.volumeResolved, false);
  assert.equal(a.semanticsKnown, false);
  assert.equal(usagePresentButUnresolved({ usage: { input_tokens: 10000 }, family: 'codex:default', provider: 'codex' }), true);
});

test('Claude partial usage (missing output_tokens) -> volumeResolved:false, not known', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 2, cache_read_input_tokens: 2168, cache_creation_input_tokens: 1285 },
    family: 'claude:opus', provider: 'claude',
  });
  assert.equal(a.usageAccountingMethod, 'anthropic_cache_additive');
  assert.equal(a.volumeResolved, false);
  assert.equal(usagePresentButUnresolved({
    usage: { input_tokens: 2, cache_read_input_tokens: 2168 }, family: 'claude:opus', provider: 'claude',
  }), true);
});

test('Claude with input+output but no cache fields -> resolved (absence == schema 0)', () => {
  const a = usageAccountingOf({ usage: { input_tokens: 2, output_tokens: 29 }, family: 'claude:opus', provider: 'claude' });
  assert.equal(a.volumeResolved, true);
  assert.equal(a.semanticsKnown, true);
  assert.equal(a.usageVolume, 31);
});

test('full envelopes still resolve to the corrected volumes', () => {
  assert.equal(usageAccountingOf({
    usage: { input_tokens: 16922, output_tokens: 9, cache_read_input_tokens: 10624 },
    family: 'codex:default', provider: 'codex',
  }).usageVolume, 16931);
  assert.equal(usageAccountingOf({
    usage: { input_tokens: 6713, output_tokens: 539, total_tokens: 7252 },
    family: 'agy:gemini-supervisor', provider: 'agy-gemini',
  }).usageVolume, 7252);
  assert.equal(usageAccountingOf({
    usage: { input_tokens: 2, output_tokens: 1549, cache_read_input_tokens: 2168, cache_creation_input_tokens: 1285 },
    family: 'claude:opus', provider: 'claude',
  }).usageVolume, 5004);
});

test('AGY conservative path stays resolved even when only some fields are present', () => {
  // agy has no confirmed schema; a conservative sum of whatever is present is
  // the accepted floor-safe posture and does NOT fail closed.
  const a = usageAccountingOf({ usage: { input_tokens: 100 }, family: 'agy:gpt-oss', provider: 'agy-gpt-oss' });
  assert.equal(a.volumeResolved, true);
  assert.equal(a.semanticsKnown, false);
  assert.equal(a.usageVolume, 100);
});

test('meteredCall: Codex partial usage settles UNRESOLVED and blocks the next spend', async () => {
  const persistence = new MemoryPersistence();
  const mk = () => createReviewLoopSpend({ loopId: 'PU', persistence });
  const spend = mk();
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 't', diffHash: 'h' });
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', family: 'codex:default', provider: 'codex',
      operationId: 'op', evidenceIds: [ev.evidenceId],
      call: async () => ({ value: { findings: [] }, usage: { input_tokens: 10000 } }),
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  // a brand-new spend surface over the same store: the UNRESOLVED reservation
  // blocks every further metered call.
  const ev2 = await mk().registerEvidence({ kind: 'diff', taskId: 't2', diffHash: 'h2' });
  await assert.rejects(
    () => mk().meteredCall({
      role: 'reviewer', family: 'codex:default', provider: 'codex',
      operationId: 'op2', evidenceIds: [ev2.evidenceId],
      call: async () => ({ value: {}, usage: { input_tokens: 5, output_tokens: 5 } }),
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
});

test('meteredCall: a thrown provider error carrying partial usage also settles UNRESOLVED', async () => {
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'PUF', persistence });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 't', diffHash: 'h' });
  await assert.rejects(
    () => spend.meteredCall({
      role: 'reviewer', family: 'codex:default', provider: 'codex',
      operationId: 'op', evidenceIds: [ev.evidenceId],
      call: async () => {
        const e = new Error('post-send guard fired');
        e.code = 'PROVIDER_PROTOCOL_ERROR';
        e.details = { usage: { input_tokens: 500 } }; // missing output
        throw e;
      },
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
  // the UNRESOLVED reservation blocks any further metered spend
  const after = createReviewLoopSpend({ loopId: 'PUF', persistence });
  const ev2 = await after.registerEvidence({ kind: 'diff', taskId: 't2', diffHash: 'h2' });
  await assert.rejects(
    () => after.meteredCall({
      role: 'reviewer', family: 'codex:default', provider: 'codex',
      operationId: 'op2', evidenceIds: [ev2.evidenceId],
      call: async () => ({ value: {}, usage: { input_tokens: 5, output_tokens: 5 } }),
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.MODEL_SPEND_USAGE_UNRESOLVED,
  );
});

// ---- edge case 2: unknown provider bare `total` is not authoritative --------

test('unknown provider: a bare `total` is NOT trusted as an authoritative token total', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 100, output_tokens: 20, total: 7 },
    family: null, provider: 'future-provider',
  });
  assert.notEqual(a.usageAccountingMethod, 'provider_total');
  assert.equal(a.usageAccountingMethod, 'conservative_additive_unknown');
  assert.equal(a.semanticsKnown, false);
  assert.equal(a.reportedTotalTokens, null); // nothing authoritative was trusted
  assert.equal(a.usageVolume, 120); // conservative sum, never the bare 7
});

test('OpenAI: a bare `total` is not an authoritative alias; `total_tokens` is', () => {
  assert.equal(usageAccountingOf({
    usage: { input_tokens: 100, output_tokens: 20, total: 7 }, family: 'codex:default', provider: 'codex',
  }).usageAccountingMethod, 'openai_input_plus_output');
  assert.equal(usageAccountingOf({
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 130 }, family: 'codex:default', provider: 'codex',
  }).usageVolume, 130);
});

test('Anthropic has no authoritative token-total alias -> always cache-additive', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 999 },
    family: 'claude:opus', provider: 'claude',
  });
  assert.equal(a.usageAccountingMethod, 'anthropic_cache_additive');
  assert.equal(a.usageVolume, 15);
});

test('AGY accepts the Gemini-native totalTokenCount alias', () => {
  const a = usageAccountingOf({
    usage: { input_tokens: 6713, output_tokens: 539, totalTokenCount: 7252 },
    family: 'agy:gemini-supervisor', provider: 'agy-gemini',
  });
  assert.equal(a.usageAccountingMethod, 'provider_total');
  assert.equal(a.usageVolume, 7252);
});

test('provider {0,0} usage for a precise class still settles KNOWN (not partial)', async () => {
  // 0 is a reported value, not an absent field: volumeResolved stays true.
  assert.equal(usagePresentButUnresolved({
    usage: { input_tokens: 0, output_tokens: 0 }, family: 'codex:default', provider: 'codex',
  }), false);
  const persistence = new MemoryPersistence();
  const spend = createReviewLoopSpend({ loopId: 'ZZ', persistence });
  const ev = await spend.registerEvidence({ kind: 'diff', taskId: 't', diffHash: 'h' });
  const out = await spend.meteredCall({
    role: 'reviewer', family: 'codex:default', provider: 'codex',
    operationId: 'op', evidenceIds: [ev.evidenceId],
    call: async () => ({ value: { findings: [] }, usage: { input_tokens: 0, output_tokens: 0 } }),
  });
  assert.deepEqual(out, { findings: [] });
  const t = await createReviewLoopSpend({ loopId: 'ZZ', persistence }).telemetry();
  assert.equal(t.usageVolume, 0);
  assert.equal(t.unknownUsageCalls, 0);
});
