// § Global New Information Policy — the Authority IS the security boundary.
//
// modelSpendAuthority.js used to gate enforcement on whether the RAW
// CallIntent happened to carry an `evidenceIds` property. That let a
// production call site silently bypass the global policy merely by
// forgetting to thread evidence through. This file proves the corrected
// invariant directly against the REAL production factory
// (providerSelection.js#selectProviders()) — the exact function supergpt.js
// calls in production — with ZERO fakes standing in for ModelSpendAuthority
// itself:
//
//   production ModelSpendAuthority HAS an informationLedger
//   + CallIntent carries no eligible New Information
//   -> DENY, zero physical provider calls, zero provider-health mutation,
//      zero failover
//
// REAL MODEL CALLS = 0. SUPERGPT MCP TOOLS = 0. SUPERGPT WORKFLOWS STARTED = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { registerUserInputEvidence } from '../src/orchestrator/newInformation.js';
import { AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';

const PLANNER_ONLY_POLICY = { planner: [{ family: 'agy:gemini' }] };

function productionSelection(workflowId) {
  let calls = 0;
  const callAgy = async () => { calls += 1; return { model: 'gemini', exitCode: 0, text: JSON.stringify({ status: 'READY', summary: 's', tasks: [] }), usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 }; };
  const selection = selectProviders({
    env: {}, callAgy, workflowId, rolePolicy: PLANNER_ONLY_POLICY,
  });
  return { selection, getCalls: () => calls };
}

async function assertDenied(selection, evidenceIds, workflowId) {
  await assert.rejects(
    selection.runtime.invoke('planner', {
      resolve: async (call) => call({ prompt: 'x' }),
    }, { operationId: workflowId, workflowId, evidenceIds }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
}

test('1. production authority + missing evidenceIds -> DENY, zero physical calls, zero health mutation', async () => {
  const workflowId = 'wf-default-deny-1';
  const { selection, getCalls } = productionSelection(workflowId);
  await assertDenied(selection, undefined, workflowId);
  assert.equal(getCalls(), 0, 'the physical agy transport never ran');
  assert.equal(selection.runtime.providerHealth.get('agy:gemini').status, 'UNKNOWN', 'a denial before dispatch never mutates provider health');
  assert.equal(selection.runtime.providerHealth.get('agy-gemini').status, 'UNKNOWN');
});

test('2. production authority + null evidenceIds -> DENY', async () => {
  const workflowId = 'wf-default-deny-2';
  const { selection, getCalls } = productionSelection(workflowId);
  await assertDenied(selection, null, workflowId);
  assert.equal(getCalls(), 0);
});

test('3. production authority + [] evidenceIds -> DENY', async () => {
  const workflowId = 'wf-default-deny-3';
  const { selection, getCalls } = productionSelection(workflowId);
  await assertDenied(selection, [], workflowId);
  assert.equal(getCalls(), 0);
});

test('4. production authority + entirely unregistered evidenceIds -> DENY', async () => {
  const workflowId = 'wf-default-deny-4';
  const { selection, getCalls } = productionSelection(workflowId);
  await assertDenied(selection, ['never-registered-evidence-id'], workflowId);
  assert.equal(getCalls(), 0);
});

test('5. production authority + already-consumed evidenceIds -> DENY (replay)', async () => {
  const workflowId = 'wf-default-deny-5';
  const { selection, getCalls } = productionSelection(workflowId);
  const evidence = await registerUserInputEvidence(selection.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: 'goal',
  });
  const value = (await selection.runtime.invoke('planner', {
    resolve: async (call) => call({ prompt: 'x' }),
  }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] })).value;
  assert.ok(value);
  assert.equal(getCalls(), 1, 'exactly one physical call on fresh, eligible evidence');

  await assertDenied(selection, [evidence.evidenceId], workflowId);
  assert.equal(getCalls(), 1, 'no additional physical call on replay of the SAME consumed evidence');
});

test('6. valid fresh evidence authorizes exactly one physical call', async () => {
  const workflowId = 'wf-default-deny-6';
  const { selection, getCalls } = productionSelection(workflowId);
  const evidence = await registerUserInputEvidence(selection.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: 'ship the thing',
  });
  const value = (await selection.runtime.invoke('planner', {
    resolve: async (call) => call({ prompt: 'x' }),
  }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] })).value;
  assert.ok(value);
  assert.equal(getCalls(), 1);
});

test('7. provider A consumes evidence then fails; provider B failover on the SAME evidence is denied (B=0 calls)', async () => {
  const workflowId = 'wf-default-deny-7';
  let agyCalls = 0;
  let codexCalls = 0;
  const selection = selectProviders({
    env: {},
    workflowId,
    rolePolicy: { planner: [{ family: 'agy:gemini' }, { family: 'codex:default' }] },
    callAgy: async () => { agyCalls += 1; throw Object.assign(new Error('agy transport unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); },
    codexCall: async () => { codexCalls += 1; return { text: JSON.stringify({ status: 'READY' }), usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 }; },
  });
  const evidence = await registerUserInputEvidence(selection.informationLedger, {
    workflowId, interactionId: 'planner-initial-input', text: 'goal for failover test',
  });
  await assert.rejects(
    selection.runtime.invoke('planner', {
      resolve: async (call) => call({ prompt: 'x' }),
    }, { operationId: workflowId, workflowId, evidenceIds: [evidence.evidenceId] }),
  );
  assert.equal(agyCalls, 1, 'provider A physically attempted exactly once and consumed the evidence');
  assert.equal(codexCalls, 0, 'provider B never physically ran — failover on the SAME already-consumed evidence is denied before dispatch');
});

test('8. a CallIntent that never even declares evidenceIds as a property is denied identically to one declaring it undefined', async () => {
  const workflowId = 'wf-default-deny-8';
  const { selection, getCalls } = productionSelection(workflowId);
  // Deliberately omit `evidenceIds` from the invoke() options object entirely
  // (as opposed to passing it explicitly as undefined/null/[]) — the exact
  // shape an unmigrated/forgetful production call site would produce.
  await assert.rejects(
    selection.runtime.invoke('planner', {
      resolve: async (call) => call({ prompt: 'x' }),
    }, { operationId: workflowId, workflowId }),
    (err) => isAuthorizationFailure(err) && err.code === AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED,
  );
  assert.equal(getCalls(), 0);
});
