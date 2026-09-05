// § Global New Information Policy / Wiring Card 3 — production integration
// tests for the final two migrated call sites:
//
//   1. Model Supervisor escalation      (automatedLoop.js's escalation branch
//                                        + providerSelection.js#supervisorSession.decide)
//   2. PR-closeout repair Executor      (prCloseoutLoop.js#runRepairAndPush
//                                        + supergpt.js#createRealGithubPrCloseoutAdapters.runRepairTask)
//
// Every Supervisor test drives the REAL runAutomatedWorkflow() (src/orchestrator/
// automatedLoop.js) with a REAL NewInformationLedger + REAL ModelSpendAuthority
// + REAL createProductionRoleRuntime, exactly like
// tests/newInformationExecutorReviewerWiring.test.js already does for
// Executor/Reviewer. Only the physical Supervisor transport is faked. The
// PR-repair tests drive the REAL createRealGithubPrCloseoutAdapters()
// (supergpt.js) directly — its `runRepairTask` never touches `gh`/git itself
// (only its sibling `getPrHead`/`pushRepair` adapters do) — with a REAL
// NewInformationLedger + REAL ModelSpendAuthority.
//
// SUPERGPT WORKFLOWS STARTED = 0. SUPERGPT_* TOOL CALLS = 0. REAL PROVIDER CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { NewInformationLedger, InformationStore } from '../src/orchestrator/newInformation.js';
import { DEFAULT_ROLE_POLICY, QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { AUTHORIZATION_ERROR_CODES, isAuthorizationFailure } from '../src/orchestrator/errors.js';
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import {
  runPrCloseoutLoop,
} from '../src/orchestrator/prCloseoutLoop.js';
import { createRealGithubPrCloseoutAdapters } from '../src/orchestrator/supergpt.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';

function tmpPersistence() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wc3-supervisor-prrepair-'));
  return new Persistence(dir);
}

function gatePass({ changedFiles = ['a.js'], diff = 'diff --git a/a.js b/a.js\n+ok' } = {}) {
  return {
    pass: true,
    results: [{ command: 'npm test', pass: true, output: 'ok' }],
    changed_files: changedFiles,
    git_diff: diff,
  };
}

function makeQueuedGateRunner(queue) {
  const remaining = [...queue];
  return { async run() { return remaining.length > 0 ? remaining.shift() : gatePass(); } };
}

// ── Section 1 — Model Supervisor escalation ──────────────────────────────
//
// Forces decideDeterministically() into its 'no_structured_task_queue'
// escalation (no plannedTasks passed at all — a legacy hand-written plan) so
// the VERY FIRST decision of the run escalates to a real Supervisor call.
// Mirrors providerSelection.js#supervisorSession.decide()'s production
// behavior of forwarding `context.evidenceIds` verbatim into
// productionRoleRuntime.invoke('supervisor', ...).
function makeSupervisorSession({ runtime, workflowId, queue }) {
  const decisions = [...queue];
  return {
    create: async () => ({}),
    close: async () => {},
    decide: async (context) => {
      const result = await runtime.invoke('supervisor', context, {
        operationId: workflowId, workflowId, evidenceIds: context?.evidenceIds,
      });
      return result.value;
    },
    _decisions: decisions,
  };
}

function buildSupervisorRuntime({ informationLedger, supervisorImpl, recordSafetyEvent, families = { 'agy:gemini': null } }) {
  const providerHealth = new ProviderHealthRegistry();
  const spendAuthority = new ModelSpendAuthority({ informationLedger, recordSafetyEvent });
  const supervisorAdapters = {};
  for (const family of Object.keys(families)) supervisorAdapters[family] = supervisorImpl;
  const runtime = createProductionRoleRuntime({
    rolePolicy: {
      ...DEFAULT_ROLE_POLICY,
      supervisor: Object.keys(families).map((family) => ({ family })),
    },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority,
    adapters: { supervisor: supervisorAdapters },
  });
  return { runtime, spendAuthority, providerHealth };
}

function queuedSupervisor(counter, queue) {
  const decisions = [...queue];
  return async () => {
    counter.calls += 1;
    if (decisions.length === 0) throw new Error('supervisor: no more queued decisions');
    const next = decisions.shift();
    return { ...next, usage: { input_tokens: 1, output_tokens: 1 } };
  };
}

test('S1. A fresh, eligible escalation authorizes exactly one physical Supervisor call', async () => {
  const informationLedger = new NewInformationLedger();
  const supCounter = { calls: 0 };
  const { runtime } = buildSupervisorRuntime({
    informationLedger,
    supervisorImpl: queuedSupervisor(supCounter, [
      { action: 'NEXT_TASK', task_card: { task_id: 't1', repository_context: {}, goal: 'g', context: 'c', scope: 's', allowed_files: ['a.js'], forbidden_files: [], acceptance_criteria: ['done'], verification_commands: ['npm test'], completion_signal: 'DONE' } },
      { action: 'WORKFLOW_DONE', summary: 'done' },
    ]),
  });
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-s1',
    supervisorSession: makeSupervisorSession({ runtime, workflowId: 'wf-s1', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('reviewer should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('executor should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-A',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  assert.equal(supCounter.calls, 1, 'the Supervisor physically ran exactly once for a legacy hand-written first decision');
  assert.equal(result.status, 'HUMAN_REQUIRED', undefined); // task_card path needs a real executor; irrelevant — only Supervisor call count matters here.
});

test('S2. The SAME escalation state cannot authorize a second physical Supervisor call (replay denied)', async () => {
  const informationLedger = new NewInformationLedger();
  const supCounter = { calls: 0 };
  const t1 = { task_id: 't1', repository_context: {}, goal: 'g', context: 'c', scope: 's', allowed_files: ['a.js'], forbidden_files: [], acceptance_criteria: ['done'], verification_commands: ['npm test'], completion_signal: 'DONE' };

  const { runtime: runtime1 } = buildSupervisorRuntime({
    informationLedger,
    supervisorImpl: queuedSupervisor(supCounter, [{ action: 'NEXT_TASK', task_card: t1 }]),
  });
  await runAutomatedWorkflow({
    workflowId: 'wf-s2',
    supervisorSession: makeSupervisorSession({ runtime: runtime1, workflowId: 'wf-s2', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-B',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  assert.equal(supCounter.calls, 1);

  // A second, independent run with the IDENTICAL workflowId + workflowGoal +
  // repositoryContext + no plannedTasks/history: decideDeterministically()
  // reaches the SAME 'no_structured_task_queue' escalation, and
  // supervisorEscalationEvidence() computes the IDENTICAL fingerprint
  // (same workflowGoal/repositoryContext/history) -> the SAME evidenceId,
  // already consumed.
  const { runtime: runtime2 } = buildSupervisorRuntime({
    informationLedger,
    supervisorImpl: queuedSupervisor(supCounter, []),
  });
  const second = await runAutomatedWorkflow({
    workflowId: 'wf-s2',
    supervisorSession: makeSupervisorSession({ runtime: runtime2, workflowId: 'wf-s2', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-B',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  assert.equal(supCounter.calls, 1, 'no additional physical Supervisor call on replay of the identical escalation state');
  assert.equal(second.status, 'HUMAN_REQUIRED');
});

test('S3. A genuinely changed escalation state (different workflow goal) authorizes one fresh Supervisor call', async () => {
  const informationLedger = new NewInformationLedger();
  const supCounter = { calls: 0 };
  const { runtime } = buildSupervisorRuntime({
    informationLedger,
    supervisorImpl: queuedSupervisor(supCounter, [{ action: 'WORKFLOW_DONE', summary: 'a' }, { action: 'WORKFLOW_DONE', summary: 'b' }]),
  });
  const args = (workflowId, workflowGoal) => ({
    workflowId,
    supervisorSession: makeSupervisorSession({ runtime, workflowId, queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal,
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  const r1 = await runAutomatedWorkflow(args('wf-s3a', 'goal-1'));
  const r2 = await runAutomatedWorkflow(args('wf-s3b', 'goal-2'));
  assert.equal(supCounter.calls, 2, 'two DIFFERENT workflows with different goals each authorize their own physical Supervisor call');
  assert.equal(r1.status, 'WORKFLOW_DONE');
  assert.equal(r2.status, 'WORKFLOW_DONE');
});

test('S4. Provider failover on the SAME escalation evidence: A physically attempts once, B never runs', async () => {
  const informationLedger = new NewInformationLedger();
  const primaryCalls = { calls: 0 };
  const backupCalls = { calls: 0 };
  const providerHealth = new ProviderHealthRegistry();
  // Test-only permissive eligibility — the ONLY way to exercise the generic
  // multi-provider failover mechanic in a test; production Supervisor
  // eligibility is unaffected by this (the built-in eligibility invariant in
  // modelSpendAuthority.js only constrains role === 'executor').
  const spendAuthority = new ModelSpendAuthority({ informationLedger });
  const failingPrimary = async () => { primaryCalls.calls += 1; throw Object.assign(new Error('primary down'), { code: 'PROVIDER_UNAVAILABLE' }); };
  const workingBackup = async () => { backupCalls.calls += 1; return { action: 'WORKFLOW_DONE', summary: 'done', usage: { input_tokens: 1, output_tokens: 1 } }; };
  const runtime = createProductionRoleRuntime({
    rolePolicy: { supervisor: [{ family: 'agy:gemini' }, { family: 'codex:default' }] },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority,
    adapters: { supervisor: { 'agy:gemini': failingPrimary, 'codex:default': workingBackup } },
  });
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-s4',
    supervisorSession: makeSupervisorSession({ runtime, workflowId: 'wf-s4', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-s4',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  assert.equal(primaryCalls.calls, 1, 'the primary provider physically attempted once and failed');
  assert.equal(backupCalls.calls, 0, 'the backup NEVER physically ran — same evidence, already consumed by the primary attempt');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

test('S5. supervisorEscalationEvidence never derives evidence from reason/attempt/escalationActive — only review/task-card state', async () => {
  const { supervisorEscalationEvidence } = await import('../src/orchestrator/deterministicSupervisorPolicy.js');
  const a = supervisorEscalationEvidence({ latestReviewResult: null, currentTaskCard: null, plannedTasks: [], workflowGoal: 'g', repositoryContext: { x: 1 }, history: [] });
  const b = supervisorEscalationEvidence({ latestReviewResult: null, currentTaskCard: null, plannedTasks: [], workflowGoal: 'g', repositoryContext: { x: 1 }, history: [], escalationActive: true, attempt: 99, reason: 'anything' });
  assert.equal(a.fingerprint, b.fingerprint, 'escalationActive / attempt / reason never change the fingerprint');
});

// ── Section 2 — PR-closeout repair Executor ──────────────────────────────

const REVIEWER = 'trusted-claude-reviewer';

// A minimal, offline, fully deterministic PR closeout scenario (mirrors
// tests/prCloseoutLoop.test.js's own `scenario()` helper) whose
// `runRepairTask` adapter IS the real supergpt.js
// createRealGithubPrCloseoutAdapters().runRepairTask — the actual production
// call chain: PR closeout finding -> decideCloseout -> runRepairAndPush ->
// buildRepairTaskCard (+ card.new_information) -> runRepairTask.
function buildPrScenario({ heads, findingsByHead, informationLedger, executorImpl, recordSafetyEvent }) {
  const headIndex = { i: 0 };
  const currentHead = () => heads[Math.min(headIndex.i, heads.length - 1)];
  const executorCalls = { calls: 0 };
  const providerHealth = new ProviderHealthRegistry();
  const spendAuthority = new ModelSpendAuthority({ informationLedger, recordSafetyEvent });
  const runtime = createProductionRoleRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }] },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority,
    adapters: { executor: { 'claude:sonnet': executorImpl ?? (async () => { executorCalls.calls += 1; return { status: 'DONE', usage: { input_tokens: 1, output_tokens: 1 } }; }) } },
  });
  const selection = {
    informationLedger,
    runtime,
    createExecutorSessionManager: ({ taskId }) => ({
      async execute(card, { signal, evidenceIds } = {}) {
        const result = await runtime.invoke('executor', { taskId, taskCard: card }, {
          operationId: `wf-pr:${taskId}`, workflowId: 'wf-pr', evidenceIds,
        });
        return { status: 'COMPLETE', usage: result.value?.usage ?? null, callId: result.value?.callId ?? null };
      },
    }),
  };
  const adapters = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    prNumber: 42,
    selection,
    createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }),
    baseline: null,
    signal: null,
    workflowId: 'wf-pr',
  });
  return {
    executorCalls,
    selection,
    loopAdapters: {
      getPrHead: async () => currentHead(),
      requestTrustedReview: async ({ prHead }) => ({ reviewer: REVIEWER, headSha: prHead, findings: findingsByHead[prHead] ?? [] }),
      runRepairTask: adapters.runRepairTask,
      pushRepair: async () => { headIndex.i += 1; return currentHead(); },
      escalateSupervisor: async () => null,
    },
  };
}

test('R1. A fresh external review result authorizes exactly one physical repair Executor call', async () => {
  const informationLedger = new NewInformationLedger();
  const { executorCalls, loopAdapters } = buildPrScenario({
    heads: ['sha-1', 'sha-2'],
    findingsByHead: { 'sha-1': [{ severity: 'P1', file: 'a.js', message: 'bug' }] },
    informationLedger,
  });
  const outcome = await runPrCloseoutLoop({
    init: { prNumber: 42, configuredReviewer: REVIEWER },
    adapters: loopAdapters,
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(executorCalls.calls, 1, 'the repair Executor physically ran exactly once');
  assert.equal(outcome.status, 'DONE');
});

test('R2. Replaying the SAME head + findings can never authorize a second physical repair call', async () => {
  const informationLedger = new NewInformationLedger();
  const card = { task_id: 'pr-closeout-repair-42-round', new_information: { subject: 'pr-42', headSha: 'sha-1', signatures: ['P1:a.js:bug'] } };
  const { executorCalls, loopAdapters, selection } = buildPrScenario({
    heads: ['sha-1', 'sha-2'],
    findingsByHead: { 'sha-1': [{ severity: 'P1', file: 'a.js', message: 'bug' }] },
    informationLedger,
  });
  // First repair round consumes the evidence for (head sha-1, findings F).
  const first = await runPrCloseoutLoop({
    init: { prNumber: 42, configuredReviewer: REVIEWER },
    adapters: loopAdapters,
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(executorCalls.calls, 1);
  assert.equal(first.status, 'DONE');

  // A second, independent runRepairTask call replaying the IDENTICAL
  // card.new_information (same head, same normalized findings) against the
  // SAME informationLedger + SAME production ModelSpendAuthority (reused via
  // `selection`) — this is what a duplicate/replayed repair dispatch looks
  // like (e.g. a retried closeout invocation).
  const adaptersAgain = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 42,
    selection,
    createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }),
    workflowId: 'wf-pr',
  });
  const replay = await adaptersAgain.runRepairTask({ ...card, allowed_files: ['a.js'], verification_commands: [] });
  assert.equal(executorCalls.calls, 1, 'no additional physical Executor call on replay of the identical head+findings');
  assert.equal(replay.status, 'FAILED');
  assert.equal(replay.authorizationFailure, true);
  assert.equal(replay.authorizationCode, AUTHORIZATION_ERROR_CODES.NO_NEW_INFORMATION_MODEL_SPEND_BLOCKED);
});

test('R3. A genuinely new review result (different findings on a new head) authorizes one fresh repair call', async () => {
  const informationLedger = new NewInformationLedger();
  const { executorCalls, loopAdapters } = buildPrScenario({
    heads: ['sha-1', 'sha-2', 'sha-3'],
    findingsByHead: {
      'sha-1': [{ severity: 'P1', file: 'a.js', message: 'bug A' }],
      'sha-2': [{ severity: 'P2', file: 'b.js', message: 'bug B' }],
    },
    informationLedger,
  });
  const outcome = await runPrCloseoutLoop({
    init: { prNumber: 42, configuredReviewer: REVIEWER, maxRepairRounds: 5 },
    adapters: loopAdapters,
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(executorCalls.calls, 2, 'two genuinely distinct (head, findings) repair rounds each get their own physical call');
  assert.equal(outcome.status, 'DONE');
});

test('R4. Provider failover on the SAME repair evidence: A physically attempts once, B never runs', async () => {
  const informationLedger = new NewInformationLedger();
  const primaryCalls = { calls: 0 };
  const backupCalls = { calls: 0 };
  const providerHealth = new ProviderHealthRegistry();
  const spendAuthority = new ModelSpendAuthority({ informationLedger, providerCapabilities: { isExecutorEligible: () => true } });
  const failingPrimary = async () => { primaryCalls.calls += 1; throw Object.assign(new Error('primary down'), { code: 'PROVIDER_UNAVAILABLE' }); };
  const workingBackup = async () => { backupCalls.calls += 1; return { status: 'DONE', usage: { input_tokens: 1, output_tokens: 1 } }; };
  const runtime = createProductionRoleRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'test:backup' }] },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth,
    spendAuthority,
    adapters: { executor: { 'claude:sonnet': failingPrimary, 'test:backup': workingBackup } },
  });
  const selection = {
    informationLedger,
    createExecutorSessionManager: ({ taskId }) => ({
      async execute(card, { evidenceIds } = {}) {
        const result = await runtime.invoke('executor', { taskId, taskCard: card }, { operationId: `wf-pr4:${taskId}`, workflowId: 'wf-pr4', evidenceIds });
        return { status: 'COMPLETE', usage: result.value?.usage ?? null };
      },
    }),
  };
  const adapters = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 43,
    selection, createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }), workflowId: 'wf-pr4',
  });
  const card = { task_id: 'pr-closeout-repair-43-round', allowed_files: ['a.js'], verification_commands: [], new_information: { subject: 'pr-43', headSha: 'sha-1', signatures: ['P1:a.js:bug'] } };
  const out = await adapters.runRepairTask(card);
  assert.equal(primaryCalls.calls, 1, 'the primary provider physically attempted once and failed');
  assert.equal(backupCalls.calls, 0, 'the backup NEVER physically ran — same evidence, already consumed by the primary attempt');
  assert.equal(out.status, 'FAILED');
});

test('R5. card.new_information head-binding: identical findings on a DIFFERENT head still produce a distinct fingerprint', async () => {
  const informationLedger = new NewInformationLedger();
  const { registerExternalResultEvidence, sha256 } = await import('../src/orchestrator/newInformation.js');
  const fp = (headSha, signatures) => sha256(JSON.stringify({ headSha, signatures }));
  const e1 = await registerExternalResultEvidence(informationLedger, { workflowId: 'wf-x', subject: 'pr-1', fingerprint: fp('sha-1', ['P1:a.js:bug']) });
  const e2 = await registerExternalResultEvidence(informationLedger, { workflowId: 'wf-x', subject: 'pr-1', fingerprint: fp('sha-2', ['P1:a.js:bug']) });
  assert.notEqual(e1.evidenceId, e2.evidenceId, 'moving the head with the SAME findings is still a distinct evidence state');
});

// ── Section 3 — Migration strictness / production wiring proof ──────────

test('W1. selectProviders() wires ONE informationLedger shared by the Supervisor CallIntent path', async () => {
  const persistence = tmpPersistence();
  const selection = selectProviders({
    env: { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy' },
    persistence,
    workflowId: 'wf-w1',
    callAgy: async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.ok(selection.informationLedger instanceof NewInformationLedger);
  assert.equal(selection.runtime.spendAuthority.informationLedger, selection.informationLedger, 'the ONE production ModelSpendAuthority enforces against the SAME ledger exposed to callers');
});

test('W2. Production ModelSpendAuthority is never constructed without an information ledger (constructor default is null, but selectProviders always supplies one)', async () => {
  const persistence = tmpPersistence();
  const selection = selectProviders({
    env: { SUPERVISOR_PROVIDER: 'agy', REVIEWER_PROVIDER: 'agy' },
    persistence,
    workflowId: 'wf-w2',
    callAgy: async () => ({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.notEqual(selection.runtime.spendAuthority.informationLedger, null);
  assert.notEqual(selection.runtime.spendAuthority.informationLedger, undefined);
});

test('W3. Complete production internal call-site inventory: Planner, Executor, Reviewer, Supervisor, PR-repair all forward evidenceIds', async () => {
  const fs = await import('node:fs');
  const files = {
    automatedLoop: fs.readFileSync(new URL('../src/orchestrator/automatedLoop.js', import.meta.url), 'utf8'),
    providerSelection: fs.readFileSync(new URL('../src/orchestrator/providerSelection.js', import.meta.url), 'utf8'),
    supergpt: fs.readFileSync(new URL('../src/orchestrator/supergpt.js', import.meta.url), 'utf8'),
  };
  // Structural (not merely textual) proof lives in the behavioral tests above
  // and in tests/newInformation{Policy,ProductionWiring,ExecutorReviewerWiring,
  // SupergptWiring}.test.js — this is a lightweight inventory cross-check that
  // the NAMED evidence-forwarding call sites still exist verbatim, so an
  // accidental revert of any one of them fails loudly here rather than only
  // reducing coverage silently.
  assert.match(files.providerSelection, /evidenceIds:\s*context\?\.evidenceIds/, 'Supervisor CallIntent forwards context.evidenceIds');
  assert.match(files.providerSelection, /evidenceIds:\s*opts\.evidenceIds/, 'Reviewer CallIntent forwards opts.evidenceIds');
  assert.match(files.providerSelection, /evidenceIds\s*}\s*\)\s*;\s*$/m, 'Fast/Full Path Executor CallIntent forwards evidenceIds');
  assert.match(files.automatedLoop, /decisionContext\.evidenceIds\s*=/, 'automatedLoop registers Supervisor escalation evidence into decisionContext.evidenceIds');
  assert.match(files.supergpt, /evidenceIds:\s*plannerEvidenceIds/, 'Full Path Planner CallIntent forwards plannerEvidenceIds');
  assert.match(files.supergpt, /evidenceIds:\s*repairEvidenceIds/, 'PR-closeout repair Executor forwards repairEvidenceIds');
});

// ── Section 4 — Resume / storage-failure / budget certification ─────────

test('X1. Supervisor escalation consumption survives a fresh NewInformationLedger backed by the same durable persistence', async () => {
  const persistence = tmpPersistence();
  const store = new InformationStore(persistence);
  const workflowId = 'wf-x1';
  const ledgerBefore = new NewInformationLedger({ store });
  const supCounterBefore = { calls: 0 };
  const { runtime: runtimeBefore } = buildSupervisorRuntime({
    informationLedger: ledgerBefore,
    supervisorImpl: queuedSupervisor(supCounterBefore, [{ action: 'WORKFLOW_DONE', summary: 'done' }]),
  });
  const before = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: makeSupervisorSession({ runtime: runtimeBefore, workflowId, queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-x1',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger: ledgerBefore,
  });
  assert.equal(supCounterBefore.calls, 1);
  assert.equal(before.status, 'WORKFLOW_DONE');

  const ledgerAfter = new NewInformationLedger({ store });
  const supCounterAfter = { calls: 0 };
  const { runtime: runtimeAfter } = buildSupervisorRuntime({
    informationLedger: ledgerAfter,
    supervisorImpl: queuedSupervisor(supCounterAfter, []),
  });
  const after = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: makeSupervisorSession({ runtime: runtimeAfter, workflowId, queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-x1',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger: ledgerAfter,
  });
  assert.equal(supCounterAfter.calls, 0, 'a fresh runtime backed by the same durable store does not manufacture fresh Supervisor permission');
  assert.equal(after.status, 'HUMAN_REQUIRED');
});

test('X2. An information-store failure at the Supervisor escalation boundary halts with zero physical calls', async () => {
  const failingStore = { load: async () => { throw new Error('EIO'); }, save: async () => {} };
  const informationLedger = new NewInformationLedger({ store: failingStore });
  const supCounter = { calls: 0 };
  const { runtime } = buildSupervisorRuntime({ informationLedger, supervisorImpl: queuedSupervisor(supCounter, []) });
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-x2',
    supervisorSession: makeSupervisorSession({ runtime, workflowId: 'wf-x2', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-x2',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
  });
  assert.equal(supCounter.calls, 0, 'registration failed before any physical Supervisor call');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

test('X3. An information-store failure at the PR-repair boundary halts with zero physical Executor calls', async () => {
  const failingStore = { load: async () => { throw new Error('EIO'); }, save: async () => {} };
  const informationLedger = new NewInformationLedger({ store: failingStore });
  let dispatched = 0;
  const adapters = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 44,
    selection: {
      informationLedger,
      createExecutorSessionManager: () => ({ execute: async () => { dispatched += 1; return { status: 'COMPLETE' }; } }),
    },
    createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }),
    workflowId: 'wf-x3',
  });
  const out = await adapters.runRepairTask({
    task_id: 'pr-closeout-repair-44-round', allowed_files: ['a.js'], verification_commands: [],
    new_information: { subject: 'pr-44', headSha: 'sha-1', signatures: ['P1:a.js:bug'] },
  });
  assert.equal(dispatched, 0, 'registration failed before any physical repair Executor call');
  assert.equal(out.status, 'FAILED');
  assert.equal(out.authorizationFailure, true);
  assert.equal(out.authorizationCode, AUTHORIZATION_ERROR_CODES.MODEL_SPEND_INFORMATION_STATE_UNAVAILABLE);
});

test('X4. Fresh Supervisor escalation evidence does not bypass the workflow cost ceiling', async () => {
  const informationLedger = new NewInformationLedger();
  const supCounter = { calls: 0 };
  const { runtime } = buildSupervisorRuntime({ informationLedger, supervisorImpl: queuedSupervisor(supCounter, []) });
  const usageTracker = new UsageTracker();
  usageTracker.record({
    workflowId: 'wf-x4', role: 'executor', callId: 'prior', taskId: 'prior',
    provider: 'claude', model: 'sonnet', usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 999,
  });
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-x4',
    supervisorSession: makeSupervisorSession({ runtime, workflowId: 'wf-x4', queue: [] }),
    createReviewerSession: () => ({ create: async () => ({}), close: async () => {}, review: async () => { throw new Error('should not run'); } }),
    createClaudeSessionManager: () => ({ execute: async () => { throw new Error('should not run'); } }),
    gateRunner: makeQueuedGateRunner([gatePass()]),
    workflowGoal: 'goal-x4',
    repositoryContext: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    informationLedger,
    usageTracker,
    workflowCostCeilingUsd: 5,
  });
  assert.equal(supCounter.calls, 0, 'the already-exceeded cost ceiling halts BEFORE the Supervisor is ever escalated to, regardless of fresh evidence');
  assert.equal(result.status, 'HUMAN_REQUIRED');
});

test('X5. Fresh PR-repair evidence does not bypass the workflow cost ceiling', async () => {
  const informationLedger = new NewInformationLedger();
  let dispatched = 0;
  const usageTracker = new UsageTracker();
  usageTracker.record({
    workflowId: 'wf-x5', role: 'executor', callId: 'prior', taskId: 'prior',
    provider: 'claude', model: 'sonnet', usage: { input_tokens: 10, output_tokens: 10 }, costUsd: 999,
  });
  const adapters = createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 45,
    selection: {
      informationLedger,
      createExecutorSessionManager: () => ({ execute: async () => { dispatched += 1; return { status: 'COMPLETE' }; } }),
    },
    createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }),
    workflowId: 'wf-x5',
    usageTracker,
    workflowCostCeilingUsd: 5,
  });
  const out = await adapters.runRepairTask({
    task_id: 'pr-closeout-repair-45-round', allowed_files: ['a.js'], verification_commands: [],
    new_information: { subject: 'pr-45', headSha: 'sha-1', signatures: ['P1:a.js:bug'] },
  });
  assert.equal(dispatched, 0, 'the already-exceeded cost ceiling halts BEFORE evidence is even registered / the repair Executor is dispatched');
  assert.equal(out.status, 'FAILED');
  assert.equal(out.safetyBlocking, true);
});
