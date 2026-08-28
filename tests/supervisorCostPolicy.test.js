import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgySupervisorSession } from '../src/orchestrator/agyProviderSessions.js';
import { SUPERVISOR_SESSION_STRATEGIES, supervisorDecisionEffort, supervisorSessionStrategy } from '../src/orchestrator/supervisorCostPolicy.js';
import { TokenAwareSessionPolicy } from '../src/orchestrator/tokenAwareSessionPolicy.js';
import { createFailoverSupervisorSession } from '../src/orchestrator/supervisorFailover.js';

const base = { workflowGoal: 'ship', history: [{ task_id: 'one', decision: 'PASS', attempts: 1 }], latestReviewResult: { decision: 'PASS' } };
function provider(calls, { failOnce = false } = {}) {
  let failed = false;
  return { model: 'test', async decide(context, opts) {
    calls.push({ context, opts });
    if (failOnce && !failed) { failed = true; throw Object.assign(new Error('bad protocol'), { details: { providerFailure: 'PROVIDER_PROTOCOL_ERROR' } }); }
    return { action: 'WORKFLOW_DONE', summary: 'done', conversationId: `physical-${calls.length}`, usage: { input_tokens: 14000, output_tokens: 5, cache_read_tokens: 0 } };
  } };
}

test('Gemini CHECKPOINT_FRESH uses a distinct physical session for every semantic decision while checkpoint preserves continuity', async () => {
  const calls = []; const session = createAgySupervisorSession(provider(calls), { requestedFamily: 'agy:gemini', strategy: SUPERVISOR_SESSION_STRATEGIES.CHECKPOINT_FRESH });
  await session.decide(base); await session.decide({ ...base, history: [...base.history, { task_id: 'two', decision: 'PASS', attempts: 1 }] }); await session.decide(base);
  assert.equal(calls.length, 3); assert.deepEqual(calls.map((x) => x.opts.conversationId), [undefined, undefined, undefined]);
  assert.ok(calls.every((x) => x.context.checkpoint?.schema === 'supergpt.supervisor-checkpoint/v1'));
  assert.equal(calls[1].context.checkpoint.completed_tasks.length, 2); assert.equal(session.conversationId, null);
});

test('Codex and Claude select BOUNDED_STICKY; Codex reuses when cache economics are good', async () => {
  assert.equal(supervisorSessionStrategy('codex:default'), SUPERVISOR_SESSION_STRATEGIES.BOUNDED_STICKY);
  assert.equal(supervisorSessionStrategy('claude:opus'), SUPERVISOR_SESSION_STRATEGIES.BOUNDED_STICKY);
  const calls = []; const p = provider(calls); const s = createAgySupervisorSession(p, { requestedFamily: 'codex:default', strategy: supervisorSessionStrategy('codex:default') });
  await s.decide(base); await s.decide(base);
  assert.equal(calls[1].opts.conversationId, 'physical-1');
});

test('bounded sticky rotates on excessive input growth', async () => {
  const calls = []; let n = 0;
  const p = { async decide(context, opts) { calls.push({ context, opts }); n += 1; return { action: 'WORKFLOW_DONE', summary: 'd', conversationId: `c${n}`, usage: { input_tokens: n === 1 ? 100 : 250, output_tokens: 1 } }; } };
  const s = createAgySupervisorSession(p, { strategy: SUPERVISOR_SESSION_STRATEGIES.BOUNDED_STICKY, sessionPolicy: new TokenAwareSessionPolicy({ maxConsecutiveGrowth: 1, maxInputGrowthRatio: 1.5 }) });
  await s.decide(base); await s.decide(base); await s.decide(base);
  assert.equal(calls[2].opts.conversationId, undefined); assert.ok(calls[2].context.checkpoint);
});

test('Supervisor effort classification covers routine, rework, and hard decisions', () => {
  assert.equal(supervisorDecisionEffort(base), 'low');
  assert.equal(supervisorDecisionEffort({ latestReviewResult: { decision: 'REWORK' } }), 'medium');
  assert.equal(supervisorDecisionEffort({ latestReviewResult: { decision: 'REWORK' }, reworkCycles: 2 }), 'high');
  assert.equal(supervisorDecisionEffort({ likelyHumanRequired: true }), 'high');
});

test('semantic protocol failure escalates low to medium, then high while unsupported effort remains safe', async () => {
  const calls = []; let failures = 0;
  const p = { async decide(context, opts) { calls.push({ context, opts }); if (failures++ < 2) throw Object.assign(new Error('bad protocol'), { details: { providerFailure: 'PROVIDER_PROTOCOL_ERROR' } }); return { action: 'WORKFLOW_DONE', summary: 'done' }; } };
  const s = createAgySupervisorSession(p, { strategy: SUPERVISOR_SESSION_STRATEGIES.CHECKPOINT_FRESH });
  await assert.rejects(() => s.decide(base)); await assert.rejects(() => s.decide(base)); await s.decide(base);
  assert.deepEqual(calls.map((x) => x.opts.effort), ['low', 'medium', 'high']);
});

test('quota/auth/unavailable failures fail over instead of becoming effort retries', async () => {
  let first = 0; let second = 0;
  const session = createFailoverSupervisorSession({ providers: [
    { name: 'a', session: { async decide() { first += 1; throw Object.assign(new Error('quota'), { details: { providerFailure: 'PROVIDER_QUOTA_EXHAUSTED' } }); } } },
    { name: 'b', session: { async decide() { second += 1; return { action: 'WORKFLOW_DONE', summary: 'done' }; } } },
  ] });
  await session.decide(base); assert.equal(first, 1); assert.equal(second, 1);
});
