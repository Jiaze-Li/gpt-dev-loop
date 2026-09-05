// The PR-closeout repair Executor is an INTERNAL physical model call. When it
// runs on the fallback path (no role runtime), it must still obtain and
// consume a PhysicalCallPermit from the shared ModelSpendAuthority before the
// provider is dispatched.
//
// All mock / deterministic. REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRealGithubPrCloseoutAdapters } from '../src/orchestrator/supergpt.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';

function repairCard() {
  return {
    task_id: 'pr-closeout-repair',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'def' },
    allowed_files: ['x'],
    verification_commands: ['true'],
  };
}

function execReport(overrides = {}) {
  return {
    task_id: 'pr-closeout-repair',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'def' },
    status: 'COMPLETE', changed_files: [], tests_run: [], test_results: [], issues: 'none', next_recommendation: 'proceed',
    // Reliable usage evidence — without it, dispatch() correctly settles
    // UNRESOLVED and this becomes an immediate Token Safety block instead of
    // an ordinary successful repair (see modelSpendAuthority.js §Failure 1
    // and the final Reservation rework). Tests that specifically exercise
    // that block (unresolved/settlement-failure cases) override this field.
    usage: { input_tokens: 10, output_tokens: 5, callId: 'repair-call-1' },
    ...overrides,
  };
}

const fakeGateRunner = () => () => ({ run: async () => ({ pass: true, results: [] }) });

// A fallback selection: no createExecutorSessionManager, but it exposes the
// shared authority through selection.runtime.spendAuthority.
function fallbackSelection(spendAuthority) {
  return { runtime: { spendAuthority } };
}

function buildAdapters({ spendAuthority, executeImpl, onManager, usageTracker, workflowStateManager }) {
  const managers = [];
  const _createClaudeSessionManager = ({ taskId }) => {
    const m = {
      taskId,
      executeCalls: 0,
      async execute(card) {
        m.executeCalls += 1;
        managers.push(m);
        onManager?.(m);
        return executeImpl(card);
      },
    };
    return m;
  };
  const adapters = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    prNumber: 123,
    selection: fallbackSelection(spendAuthority),
    createGateRunner: fakeGateRunner(),
    baseline: null,
    signal: null,
    workflowId: 'wf-internal-test-repair-permit',
    workflowStateManager,
    usageTracker,
    _createClaudeSessionManager,
  });
  return { adapters, managers };
}

// A. valid authorization -> physical call = 1
test('A: fallback repair executor obtains a permit and dispatches exactly once', async () => {
  const spendAuthority = new ModelSpendAuthority();
  let dispatched = 0;
  const { adapters } = buildAdapters({
    spendAuthority,
    executeImpl: async () => { dispatched += 1; return execReport(); },
  });
  const out = await adapters.runRepairTask(repairCard());
  assert.equal(out.status, 'COMPLETE');
  assert.equal(dispatched, 1);
  assert.deepEqual(spendAuthority.stats(), { issued: 1, consumed: 1, outstanding: 0 });
});

// B. authorize deny -> physical call = 0
test('B: an authority that denies the intent prevents any provider dispatch', async () => {
  const spendAuthority = new ModelSpendAuthority({ policy: () => ({ allow: false, reason: 'token safety: repair blocked' }) });
  let dispatched = 0;
  const { adapters } = buildAdapters({
    spendAuthority,
    executeImpl: async () => { dispatched += 1; return execReport(); },
  });
  const out = await adapters.runRepairTask(repairCard());
  assert.equal(dispatched, 0);
  assert.equal(out.status, 'FAILED');
  assert.equal(out.authorizationFailure, true);
  assert.equal(out.authorizationCode, AUTHORIZATION_ERROR_CODES.SPEND_DENIED);
  assert.deepEqual(spendAuthority.stats(), { issued: 0, consumed: 0, outstanding: 0 });
});

// C. dispatch authorization error -> not a provider failure, no failover
test('C: a dispatch-time permit failure is an authorization failure, not a provider failure', async () => {
  // A tampering authority whose issued permit will not match on dispatch:
  // issue against the real authority but hand back a foreign permit.
  const real = new ModelSpendAuthority();
  const foreign = new ModelSpendAuthority();
  const tampering = {
    authorize: (intent) => foreign.authorize(intent), // permit not known to `real`
    dispatch: (permit, intent, fn) => real.dispatch(permit, intent, fn),
    stats: () => real.stats(),
  };
  let dispatched = 0;
  const { adapters } = buildAdapters({
    spendAuthority: tampering,
    executeImpl: async () => { dispatched += 1; return execReport(); },
  });
  const out = await adapters.runRepairTask(repairCard());
  assert.equal(dispatched, 0);
  assert.equal(out.status, 'FAILED');
  assert.equal(out.authorizationFailure, true);
  assert.equal(out.authorizationCode, AUTHORIZATION_ERROR_CODES.PERMIT_UNKNOWN);
  // no safetyCode classification, no usage recorded, no failover attempt
  assert.equal(out.safetyCode, undefined);
  assert.equal(out.usage, undefined);
});

// D. original success behavior unchanged
test('D: successful fallback repair returns the same shape as before', async () => {
  const spendAuthority = new ModelSpendAuthority();
  const { adapters } = buildAdapters({
    spendAuthority,
    executeImpl: async () => execReport({ status: 'COMPLETE' }),
  });
  const out = await adapters.runRepairTask(repairCard());
  assert.equal(out.status, 'COMPLETE');
  assert.equal(out.gateResult, 'PASS');
  assert.ok(out.executionReport);
  assert.ok(out.gateEvidence);
});

// E. usage / workflow token guard behavior not regressed
test('E: repair executor usage is still recorded once, and pre-call token ceiling still halts before dispatch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repair-permit-'));
  // E1: usage recorded exactly once on success
  {
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-repair-permit', kind: 'INTERNAL_TEST', root });
    const spendAuthority = new ModelSpendAuthority();
    const { adapters } = buildAdapters({
      spendAuthority,
      usageTracker,
      workflowStateManager,
      executeImpl: async () => {
        const r = execReport();
        Object.defineProperty(r, 'usage', { value: { input_tokens: 1200, output_tokens: 300, num_turns: 5, callId: 'call-claude-exe-repair-1' }, enumerable: false });
        Object.defineProperty(r, 'callId', { value: 'call-claude-exe-repair-1', enumerable: false });
        r.costUsd = 0.07;
        r.model = 'sonnet';
        return r;
      },
    });
    const out = await adapters.runRepairTask(repairCard());
    assert.equal(out.status, 'COMPLETE');
    const summary = usageTracker.summary();
    assert.equal(summary.executor.calls, 1);
  }
  // E2: an already-exceeded cost ceiling halts before authorize/dispatch
  {
    const usageTracker = new UsageTracker();
    usageTracker.record({
      workflowId: 'wf-internal-test-repair-permit', role: 'executor', callId: 'c-prior', taskId: 'prior',
      provider: 'claude', model: 'sonnet',
      usage: { input_tokens: 10, output_tokens: 10, num_turns: 1 }, costUsd: 999,
    });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-repair-permit', kind: 'INTERNAL_TEST', root });
    const spendAuthority = new ModelSpendAuthority();
    let dispatched = 0;
    const adaptersObj = createRealGithubPrCloseoutAdapters({
      repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 123,
      selection: fallbackSelection(spendAuthority),
      createGateRunner: fakeGateRunner(), baseline: null, signal: null,
      workflowId: 'wf-internal-test-repair-permit', workflowStateManager, usageTracker,
      workflowCostCeilingUsd: 5,
      _createClaudeSessionManager: () => ({ execute: async () => { dispatched += 1; return execReport(); } }),
    });
    const out = await adaptersObj.runRepairTask(repairCard());
    assert.equal(dispatched, 0);
    assert.equal(out.status, 'FAILED');
    assert.equal(out.safetyBlocking, true);
    assert.deepEqual(spendAuthority.stats(), { issued: 0, consumed: 0, outstanding: 0 });
  }
});
