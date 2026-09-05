// § Global New Information Policy / Wiring Card 2 — production static proof.
//
// Exercises the REAL providerSelection.js#selectProviders() factory directly
// (the exact function supergpt.js calls in production) to prove the
// informationLedger it constructs is genuinely wired onto the SAME
// ModelSpendAuthority that enforces every physical Planner call — not merely
// constructed and ignored. Only the physical agy transport is faked
// (makeFakeCallAgy) — no real model/provider call is ever made.
//
// REAL MODEL CALLS = 0. SUPERGPT MCP TOOLS = 0. SUPERGPT WORKFLOWS STARTED = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { NewInformationLedger } from '../src/orchestrator/newInformation.js';
import {
  registerUserInputEvidence, registerTaskCardEvidence, computeEvidenceId, NEW_INFORMATION_EVENT_TYPES, sha256,
} from '../src/orchestrator/newInformation.js';
import { AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { makeFakeCallAgy } from './fixtures/fakeAgy.mjs';

const PLANNER_ONLY_POLICY = { planner: [{ family: 'agy:gemini' }] };

function tmpPersistence() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wc2-production-wiring-'));
  return new Persistence(dir);
}

// ── Production static proof: the REAL factory's informationLedger genuinely
//    gates the REAL factory's runtime, for the Planner role ──────────────

test('Wiring Card 2 / production proof: selectProviders() wires ONE informationLedger that the SAME runtime genuinely enforces for planner', async () => {
  const persistence = tmpPersistence();
  const workflowId = 'wf-production-wiring-1';
  const callAgy = makeFakeCallAgy([() => ({
    model: 'gemini', exitCode: 0, text: JSON.stringify({ status: 'READY', summary: 's', tasks: [] }), usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1,
  })]);
  const selection = selectProviders({
    env: {}, callAgy, persistence, workflowId, rolePolicy: PLANNER_ONLY_POLICY,
  });
  assert.ok(selection.informationLedger, 'selectProviders() exposes the informationLedger it constructed');

  const evidence = await registerUserInputEvidence(selection.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: 'implement the thing',
  });

  let calls = 0;
  const value = (await selection.runtime.invoke('planner', {
    resolve: async (call) => { calls += 1; return call({ prompt: 'x' }); },
  }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] })).value;
  assert.ok(value);
  assert.equal(calls, 1, 'the Planner physically ran exactly once');

  // ── 2. Same evidence cannot authorize the same Planner action twice ────
  await assert.rejects(
    selection.runtime.invoke('planner', {
      resolve: async (call) => { calls += 1; return call({ prompt: 'x' }); },
    }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(calls, 1, 'no second physical Planner call on the same evidence');
});

// ── 10. Consumption survives a fresh runtime/authority backed by the same
//         durable persistence (simulates a process restart) ─────────────

test('Wiring Card 2 / 10: Planner evidence consumption via selectProviders() survives a fresh selectProviders() instance backed by the same persistence', async () => {
  const persistence = tmpPersistence();
  const workflowId = 'wf-production-wiring-10';
  const goalText = 'implement the durable thing';

  const callAgyBefore = makeFakeCallAgy([() => ({
    model: 'gemini', exitCode: 0, text: JSON.stringify({ status: 'READY', summary: 's', tasks: [] }), usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1,
  })]);
  const before = selectProviders({
    env: {}, callAgy: callAgyBefore, persistence, workflowId, rolePolicy: PLANNER_ONLY_POLICY,
  });
  const evidenceBefore = await registerUserInputEvidence(before.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: goalText,
  });
  let callsBefore = 0;
  await before.runtime.invoke('planner', {
    resolve: async (call) => { callsBefore += 1; return call({ prompt: 'x' }); },
  }, { operationId: workflowId, workflowId, evidenceIds: [evidenceBefore.evidenceId] });
  assert.equal(callsBefore, 1);

  // "Restart": a brand-new selectProviders() call — fresh in-memory ledger
  // cache, fresh ModelSpendAuthority, fresh runtime — backed by the SAME
  // Persistence instance/root.
  const callAgyAfter = makeFakeCallAgy([{ status: 'READY', summary: 's', tasks: [] }]);
  const after = selectProviders({
    env: {}, callAgy: callAgyAfter, persistence, workflowId, rolePolicy: PLANNER_ONLY_POLICY,
  });
  const evidenceAfter = await registerUserInputEvidence(after.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: goalText,
  });
  assert.equal(evidenceAfter.evidenceId, evidenceBefore.evidenceId, 'identical semantic input resolves to the identical evidenceId after restart');

  let callsAfter = 0;
  await assert.rejects(
    after.runtime.invoke('planner', {
      resolve: async (call) => { callsAfter += 1; return call({ prompt: 'x' }); },
    }, { operationId: workflowId, workflowId, evidenceIds: [evidenceAfter.evidenceId] }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(callsAfter, 0, 'the restart does not manufacture fresh Planner permission');
});

// ── 11. Evidence identities via the production convenience wrappers ─────

test('Wiring Card 2 / 11: registerUserInputEvidence / registerTaskCardEvidence are deterministic and distinguish genuinely different input', async () => {
  const ledger = new NewInformationLedger();

  const a1 = await registerUserInputEvidence(ledger, { workflowId: 'wf-11', interactionId: 'planner-initial-input', text: 'goal text A' });
  const a2 = await registerUserInputEvidence(ledger, { workflowId: 'wf-11', interactionId: 'planner-initial-input', text: 'goal text A' });
  assert.equal(a1.evidenceId, a2.evidenceId, 'the SAME initial Planner input resolves to the SAME NEW_USER_INPUT evidenceId');
  assert.equal(a1.evidenceId, computeEvidenceId({
    type: NEW_INFORMATION_EVENT_TYPES.NEW_USER_INPUT, workflowId: 'wf-11', subject: 'planner-initial-input', fingerprint: sha256('goal text A'),
  }));

  const b = await registerUserInputEvidence(ledger, { workflowId: 'wf-11', interactionId: 'clarification-1', text: 'a genuinely different clarification' });
  assert.notEqual(a1.evidenceId, b.evidenceId, 'a genuine clarification produces a DISTINCT evidenceId');

  const cardA1 = await registerTaskCardEvidence(ledger, { workflowId: 'wf-11', taskId: 't1', taskCard: { goal: 'x', allowed_files: ['a.js'] } });
  const cardA2 = await registerTaskCardEvidence(ledger, { workflowId: 'wf-11', taskId: 't1', taskCard: { goal: 'x', allowed_files: ['a.js'] } });
  assert.equal(cardA1.evidenceId, cardA2.evidenceId, 'the SAME frozen Fast Path task contract resolves to the SAME NEW_TASK_CARD evidenceId');

  const cardB = await registerTaskCardEvidence(ledger, { workflowId: 'wf-11', taskId: 't1', taskCard: { goal: 'x', allowed_files: ['a.js', 'b.js'] } });
  assert.notEqual(cardA1.evidenceId, cardB.evidenceId, 'a genuinely changed task contract produces a DISTINCT evidenceId');
});
