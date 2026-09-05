// § Global New Information Policy / Wiring Card 2 — production integration
// tests for the exactly-two migrated call sites:
//
//   1. Full Path initial Planner  (src/orchestrator/supergpt.js)
//   2. Fast Path first Executor   (src/orchestrator/automatedLoop.js, via
//      providerSelection.js#selectProviders's createExecutorSessionManager)
//
// Every test drives the REAL defaultPipeline (via runSuperGPT) with a fake
// `_selectProviders` that is REAL for the pieces this card added — a REAL
// NewInformationLedger, a REAL ModelSpendAuthority (with the SAME
// evidence-aware enforcement gate providerSelection.js#selectProviders wires
// in production), and a REAL createProductionRoleRuntime — and fakes ONLY the
// physical provider transport (planner/executor adapter functions), exactly
// like tests/plannerAuthorizationTerminalization.test.js already does for the
// Phase 0A regression. This proves the wiring inside supergpt.js itself
// (registration point, evidenceIds threading, ordering, terminalization)
// against the SAME enforcement mechanism production uses, without any real
// model/provider call and without ever starting SuperGPT itself.
//
// REAL MODEL CALLS = 0. SUPERGPT MCP TOOLS = 0. SUPERGPT WORKFLOWS STARTED = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSuperGPT } from '../src/orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { readLiveWorkflowState } from '../src/orchestrator/workflowState.js';
import { nullWindowSession } from '../src/orchestrator/agyProviderSessions.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { ReservationLedger, ReservationStore } from '../src/orchestrator/modelSpendReservation.js';
import { NewInformationLedger, InformationStore } from '../src/orchestrator/newInformation.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry, ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { AUTHORIZATION_ERROR_CODES } from '../src/orchestrator/errors.js';

function setupSourceRepo(tmpRoot) {
  const sourceRepo = path.join(tmpRoot, 'source-repo');
  fs.mkdirSync(sourceRepo, { recursive: true });
  execSync('git init -b main', { cwd: sourceRepo, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: sourceRepo, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: sourceRepo, stdio: 'ignore' });
  fs.writeFileSync(path.join(sourceRepo, 'file.txt'), 'hello\n');
  fs.mkdirSync(path.join(sourceRepo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sourceRepo, 'src', 'pagination.js'), 'module.exports = {};\n');
  execSync('git add . && git commit -m "initial"', { cwd: sourceRepo, stdio: 'ignore' });
  return sourceRepo;
}

function cleanupWorkflow(workflowId) {
  if (!fs.existsSync(SUPERGPT_WORKTREE_ROOT)) return;
  for (const name of fs.readdirSync(SUPERGPT_WORKTREE_ROOT)) {
    if (name === workflowId || name.startsWith(`${workflowId}.`) || name === `repo-${workflowId}`) {
      fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, name), { recursive: true, force: true });
    }
  }
}

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

// Builds a `_selectProviders`-compatible fake that is REAL for the pieces
// this card touches (ModelSpendAuthority + NewInformationLedger +
// createProductionRoleRuntime, identical wiring to
// providerSelection.js#selectProviders) and fakes only the physical
// planner/executor transport. `informationStore` defaults to in-memory; pass
// a `Persistence`-backed `InformationStore` (or a failing store double) to
// exercise durability / persistence-failure behavior.
function buildRealAuthorityFakeSelection({
  plannerImpl, executorImpl, informationStore = null, counters,
}) {
  const informationLedger = new NewInformationLedger({ store: informationStore });
  // `recordSafetyEvent` is wired lazily from the actual `_selectProviders(...)`
  // call arguments below — exactly like providerSelection.js#selectProviders
  // forwards supergpt.js's own `recordSafetyEvent` onto the ReservationLedger
  // / ModelSpendAuthority it constructs — so a genuine authorize()-time
  // New Information denial reaches the SAME workflowStateManager.recordSafetyEvent
  // sink the real production wiring uses, and therefore the SAME
  // result.blockingSafetyEvent projection tests assert against.
  let recordSafetyEventSink = null;
  const reservationLedger = new ReservationLedger({ recordSafetyEvent: (event) => recordSafetyEventSink?.(event) });
  const spendAuthority = new ModelSpendAuthority({
    informationLedger, reservationLedger, recordSafetyEvent: (event) => recordSafetyEventSink?.(event),
  });
  const runtime = createProductionRoleRuntime({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
    spendAuthority,
    adapters: {
      planner: {
        'agy:gemini': async ({ resolve }) => {
          let transportInvoked = false;
          const trackedCall = async (...args) => {
            transportInvoked = true;
            counters.plannerInvoked += 1;
            const defaultJson = {
              status: 'READY',
              summary: 'do the thing',
              plan_text: '# Plan\n\ndo the thing',
              tasks: [{
                task_id: 't1', goal: 'do the thing', allowed_files: ['file.txt'], verification_commands: ['true'],
              }],
            };
            return plannerImpl?.(...args) ?? {
              text: JSON.stringify(defaultJson),
              json: defaultJson,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          };
          const resolved = await resolve(trackedCall);
          if (!transportInvoked && resolved && typeof resolved === 'object' && resolved.usage == null) {
            resolved.usage = { input_tokens: 0, output_tokens: 0 };
          } else if (transportInvoked && resolved && typeof resolved === 'object' && resolved.usage == null) {
            // The REAL resolveWorkflowPlan() reshapes the call's return value
            // and does not always forward `.usage` verbatim onto its own
            // result — this fake transport DID physically run, so fall back
            // to the tracked call's own usage rather than leaving it
            // unknown (which would make dispatch() treat it as UNRESOLVED
            // and mask what this test is actually proving).
            resolved.usage = { input_tokens: 1, output_tokens: 1 };
          }
          return resolved;
        },
      },
      executor: {
        'claude:sonnet': async (payload) => {
          counters.executorInvoked += 1;
          return executorImpl?.(payload) ?? { status: 'DONE', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    },
  });
  return ({ recordSafetyEvent } = {}) => {
    recordSafetyEventSink = recordSafetyEvent ?? null;
    return {
      runtime,
      informationLedger,
    supervisorSession: {
      create: async () => ({}),
      decide: async () => { counters.supervisorInvoked += 1; return { action: 'WORKFLOW_DONE', summary: 'x' }; },
      close: async () => {},
    },
    createReviewerSession: () => ({
      create: async () => ({}),
      review: async () => { counters.reviewerInvoked += 1; return { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }; },
      close: async () => {},
    }),
    createExecutorSessionManager: ({ taskId, workflowId }) => ({
      async execute(taskCard, { signal: executionSignal, evidenceIds } = {}) {
        if (executionSignal?.aborted) throw new Error('executor cancelled');
        const result = await runtime.invoke('executor', { taskId, taskCard }, {
          operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds,
        });
        return result.value;
      },
    }),
      windowSession: nullWindowSession,
      sessionStore: { snapshot: () => ({}) },
    };
  };
}

// ── 1. Initial Planner allowed once (Full Path) ─────────────────────────

test('Wiring Card 2 / 1: fresh NEW_USER_INPUT authorizes exactly one Planner physical call', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-planner-once-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-planner-once-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const _selectProviders = buildRealAuthorityFakeSelection({ counters });
  try {
    const result = await runSuperGPT({
      workflowId, goal: 'implement thing A', cwd: sourceRepo, isResume: false, explicitFullPath: true, externalReadRoots: [], _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.plannerInvoked, 1, 'the Planner physically ran exactly once');
    assert.notEqual(result.status, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 3. Planner denial -> durable HUMAN_REQUIRED, zero later role calls ──

test('Wiring Card 2 / 3: Planner evidence already consumed -> durable HUMAN_REQUIRED, zero Supervisor/Executor/Reviewer calls', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-planner-denied-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-planner-denied-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const persistence = new Persistence(tmpdir());
  const store = new InformationStore(persistence);
  // Pre-consume the SAME evidence this workflow's initial Planner call would
  // register (identical goal text -> identical deterministic evidenceId), so
  // the real authorize() call inside supergpt.js's Planner invoke() finds it
  // already claimed and denies — proving the denial path, not merely that a
  // registration never happened.
  const preLedger = new NewInformationLedger({ store });
  const goal = 'implement thing B';
  const { registerUserInputEvidence } = await import('../src/orchestrator/newInformation.js');
  const evidence = await registerUserInputEvidence(preLedger, { workflowId, interactionId: 'planner-initial-input', text: goal });
  await preLedger.consume({
    workflowId, role: 'planner', operationId: workflowId, evidenceId: evidence.evidenceId,
  });

  const _selectProviders = buildRealAuthorityFakeSelection({ counters, informationStore: store });
  try {
    const result = await runSuperGPT({
      workflowId, goal, cwd: sourceRepo, isResume: false, explicitFullPath: true, externalReadRoots: [], _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.plannerInvoked, 0, 'the Planner never physically ran');
    assert.equal(counters.supervisorInvoked, 0);
    assert.equal(counters.executorInvoked, 0);
    assert.equal(counters.reviewerInvoked, 0);
    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.deepEqual(result.deliveredFiles, []);

    const live = readLiveWorkflowState({ workflowId, root: SUPERGPT_WORKTREE_ROOT });
    assert.equal(live?.workflowStatus, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 4. Planner information-store failure -> zero transport, HUMAN_REQUIRED ─

test('Wiring Card 2 / 4: an information-store registration failure at the Planner boundary halts with zero physical transport', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-planner-store-fail-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-planner-store-fail-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const failingStore = {
    load: async () => { throw new Error('EIO: cannot read information state'); },
    save: async () => {},
  };
  const _selectProviders = buildRealAuthorityFakeSelection({ counters, informationStore: failingStore });
  try {
    const result = await runSuperGPT({
      workflowId, goal: 'implement thing C', cwd: sourceRepo, isResume: false, explicitFullPath: true, externalReadRoots: [], _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.plannerInvoked, 0, 'the Planner never physically ran — registration failed BEFORE invoke()');
    assert.equal(result.status, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 5. Planner local zero-token resolution stays zero-token ─────────────

test('Wiring Card 2 / 5: a deterministic local Planner resolution (transport never invoked) remains zero-token even with New Information enforcement wired', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-planner-zero-token-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-planner-zero-token-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  // `_resolveWorkflowPlan` never calls its `call` argument at all — the
  // documented zero-token Planner happy path (an already-complete plan
  // resolved purely locally).
  const _resolveWorkflowPlan = async () => ({
    status: 'READY', plan: 'local plan', tasks: [], closeoutVerificationCommands: ['true'],
  });
  const _selectProviders = buildRealAuthorityFakeSelection({ counters });
  try {
    const result = await runSuperGPT({
      workflowId, goal: 'implement thing D', cwd: sourceRepo, isResume: false, explicitFullPath: true, externalReadRoots: [], _selectProviders, _resolveWorkflowPlan,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.plannerInvoked, 0, 'the local resolution never invoked the physical transport');
    assert.notEqual(result.status, 'HUMAN_REQUIRED', 'a genuinely zero-token call must not be treated as an unresolved/blocked spend');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 6. Fast Path first Executor allowed once ─────────────────────────────

const SAFE_BOUNDED_TASK = Object.freeze({
  goal: 'Fix the off-by-one in the pagination offset calculation',
  allowed_files: ['src/pagination.js'],
  verification_commands: ['true'],
});

test('Wiring Card 2 / 6: frozen Fast Path task card authorizes exactly one physical Executor call', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-executor-once-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-executor-once-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const _selectProviders = buildRealAuthorityFakeSelection({ counters });
  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'fix the pagination bug',
      boundedTask: SAFE_BOUNDED_TASK,
      cwd: sourceRepo,
      isResume: false,
      externalReadRoots: [],
      _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.plannerInvoked, 0, 'Fast Path bypasses the Planner');
    assert.equal(counters.executorInvoked, 1, 'the Executor physically ran exactly once');
    assert.notEqual(result.status, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 8. Fast Path denial is user-visible (NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED) ─

test('Wiring Card 2 / 8: Fast Path task-card evidence already consumed -> BLOCKING NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED, HUMAN_REQUIRED, zero Executor calls', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-executor-denied-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-executor-denied-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const persistence = new Persistence(tmpdir());
  const store = new InformationStore(persistence);
  // Deterministically reproduce the SAME frozen task-card fingerprint
  // supergpt.js will register, and consume it in advance so the real
  // authorize() call inside the Executor invoke() denies.
  const { selectWorkflowPath } = await import('../src/orchestrator/pathSelection.js');
  const decision = selectWorkflowPath({ goal: 'fix the pagination bug', boundedTask: SAFE_BOUNDED_TASK, cwd: sourceRepo });
  assert.equal(decision.path, 'FAST');
  const preLedger = new NewInformationLedger({ store });
  const { registerTaskCardEvidence } = await import('../src/orchestrator/newInformation.js');
  const evidence = await registerTaskCardEvidence(preLedger, { workflowId, taskId: decision.taskContract.task_id, taskCard: decision.taskContract });
  await preLedger.consume({
    workflowId, role: 'executor', operationId: `${workflowId}:${decision.taskContract.task_id}`, evidenceId: evidence.evidenceId,
  });

  const _selectProviders = buildRealAuthorityFakeSelection({ counters, informationStore: store });
  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'fix the pagination bug',
      boundedTask: SAFE_BOUNDED_TASK,
      cwd: sourceRepo,
      isResume: false,
      externalReadRoots: [],
      _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.executorInvoked, 0, 'the Executor never physically ran');
    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(result.blockingSafetyEvent?.code, 'NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED');
    assert.equal(result.blockingSafetyEvent?.severity, 'BLOCKING');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── 9. Fast Path information-ledger persistence failure ─────────────────

test('Wiring Card 2 / 9: an information-store registration failure at the Fast Path Executor boundary halts with zero physical Executor calls', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2-executor-store-fail-'));
  const sourceRepo = setupSourceRepo(tmpRoot);
  const workflowId = `wf-wc2-executor-store-fail-${Date.now()}`;
  const counters = {
    plannerInvoked: 0, supervisorInvoked: 0, executorInvoked: 0, reviewerInvoked: 0,
  };
  const failingStore = {
    load: async () => { throw new Error('EIO: cannot read information state'); },
    save: async () => {},
  };
  const _selectProviders = buildRealAuthorityFakeSelection({ counters, informationStore: failingStore });
  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'fix the pagination bug',
      boundedTask: SAFE_BOUNDED_TASK,
      cwd: sourceRepo,
      isResume: false,
      externalReadRoots: [],
      _selectProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });
    assert.equal(counters.executorInvoked, 0, 'the Executor never physically ran — registration failed before runAutomatedWorkflow');
    assert.equal(result.status, 'HUMAN_REQUIRED');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
