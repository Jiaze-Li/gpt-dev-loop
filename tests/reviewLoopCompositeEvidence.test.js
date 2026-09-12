// Phase 2 #3 — one logical (diff + gate) review state authorizes exactly one
// physical Reviewer dispatch SEQUENCE. Multiple evidenceIds no longer multiply
// dispatch eligibility; bounded failover retries reuse the one claim; a re-call
// on identical evidence (crash/resume) gets no new dispatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopSpend } from '../src/reviewloop/reviewSpend.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { NewInformationLedger } from '../src/orchestrator/newInformation.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

test('the same composite review-state evidence across a restart -> exactly ONE physical dispatch', async () => {
  const persistence = new MemoryPersistence();
  const composite = 'DIFFHASH::GATEFP';

  const spend1 = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev1 = await spend1.registerEvidence({ kind: 'reviewstate', taskId: 'L:r1:c0', diffHash: composite });
  let calls = 0;
  await spend1.meteredCall({
    role: 'reviewer', operationId: 'L:r1:c0', attempt: 1, evidenceIds: [ev1.evidenceId],
    call: async () => { calls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  assert.equal(calls, 1);

  // "restart": brand-new spend surface over the same durable store, same
  // logical review state re-registered (idempotent -> same evidenceId).
  const spend2 = createReviewLoopSpend({ loopId: 'L', persistence });
  const ev2 = await spend2.registerEvidence({ kind: 'reviewstate', taskId: 'L:r1:c0', diffHash: composite });
  assert.equal(ev2.evidenceId, ev1.evidenceId);
  await assert.rejects(
    () => spend2.meteredCall({
      role: 'reviewer', operationId: 'L:r1:c0', attempt: 1, evidenceIds: [ev2.evidenceId],
      call: async () => { calls += 1; return { value: {}, usage: { input_tokens: 1, output_tokens: 1 } }; },
    }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1, 'no second physical dispatch on the identical logical state');
});

test('bounded failover retries of the SAME operation are authorized by the one prior claim', async () => {
  const ledger = new NewInformationLedger();
  const authority = new ModelSpendAuthority({ informationLedger: ledger });
  const ev = await ledger.registerEvidence({
    workflowId: 'W', type: 'CHANGED_TASK_DIFF', subject: 'op', fingerprint: 'X',
  });
  const intent = (attempt) => ({ role: 'reviewer', family: 'agy:gpt-oss', provider: 'agy', operationId: 'op', workflowId: 'W', attempt, evidenceIds: [ev.evidenceId] });

  const p1 = await authority.authorize(intent(1)); // fresh claim
  assert.ok(p1);
  const p2 = await authority.authorize(intent(2)); // failover retry -> reuse
  assert.ok(p2);
  const p3 = await authority.authorize(intent(3));
  assert.ok(p3);

  // The whole failover sequence recorded exactly ONE consumption of the
  // logical state — attempts 2 and 3 did not each spend a fresh unit.
  const { consumptions } = await ledger.list('W');
  assert.equal(consumptions.length, 1);
});

test('a repeat attempt-1 on the SAME operation + already-consumed evidence is denied (retry never CREATES eligibility)', async () => {
  const ledger = new NewInformationLedger();
  const authority = new ModelSpendAuthority({ informationLedger: ledger });
  const ev = await ledger.registerEvidence({ workflowId: 'W', type: 'CHANGED_TASK_DIFF', subject: 'op', fingerprint: 'X' });
  const base = { role: 'reviewer', family: 'f', provider: 'p', operationId: 'op', workflowId: 'W', evidenceIds: [ev.evidenceId] };
  await authority.authorize({ ...base, attempt: 1 });
  // a re-call of attempt 1 (e.g. a stale caller / crash-resume double fire) is
  // not a failover retry and has no fresh evidence -> denied.
  await assert.rejects(
    () => authority.authorize({ ...base, attempt: 1 }),
    (err) => err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
});
