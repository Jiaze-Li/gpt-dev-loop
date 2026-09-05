// Token hardening — FINAL mechanical fuse.
//
//   1. per-Task Executor cumulative usageVolume ceiling
//   2. per-Task Executor physical-call ceiling
//   3. whole-workflow cumulative usageVolume ceiling
//   + Planner-boundary pre-check and resume continuity.
//
// The loop-level integration proofs live in tests/automatedLoop.test.js
// ("MECHANICAL TOKEN CEILINGS"). This file covers config resolution, the
// resume fail-closed broadening, the real-defaultPipeline Planner pre-check,
// the PR-closeout repair Executor, and the wf-agy-9a3583e5 incident replay.
//
// REAL MODEL CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import {
  DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME,
  DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK,
  DEFAULT_WORKFLOW_MAX_USAGE_VOLUME,
  resolveTaskExecutorUsageVolumeCeiling,
  resolveExecutorPhysicalCallCeiling,
  resolveWorkflowUsageVolumeCeiling,
  anyTokenCeilingActive,
  assertResumeCostStateReconstructable,
  executorTaskUsage,
  taskExecutorCeilingExceeded,
  workflowUsageVolumeExceeded,
  workflowCostExceeded,
  rehydrateUsageFromState,
} from '../src/orchestrator/workflowCostGuard.js';

// ════════════════════════════════════════════════════════════════════
//  1. Config resolution + env override
// ════════════════════════════════════════════════════════════════════

test('final fuse config: defaults, env override, and non-positive = disabled', () => {
  assert.equal(resolveTaskExecutorUsageVolumeCeiling({}), DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME);
  assert.equal(DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME, 600_000);
  assert.equal(resolveExecutorPhysicalCallCeiling({}), DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK);
  assert.equal(DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK, 4);
  assert.equal(resolveWorkflowUsageVolumeCeiling({}), DEFAULT_WORKFLOW_MAX_USAGE_VOLUME);
  assert.equal(DEFAULT_WORKFLOW_MAX_USAGE_VOLUME, 1_500_000);

  assert.equal(resolveTaskExecutorUsageVolumeCeiling({ TASK_MAX_EXECUTOR_USAGE_VOLUME: '250000' }), 250_000);
  assert.equal(resolveExecutorPhysicalCallCeiling({ MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK: '6' }), 6);
  assert.equal(resolveWorkflowUsageVolumeCeiling({ WORKFLOW_MAX_USAGE_VOLUME: '3000000' }), 3_000_000);

  assert.equal(resolveTaskExecutorUsageVolumeCeiling({ TASK_MAX_EXECUTOR_USAGE_VOLUME: '0' }), 0);
  assert.equal(resolveExecutorPhysicalCallCeiling({ MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK: '-1' }), 0);
  assert.equal(resolveWorkflowUsageVolumeCeiling({ WORKFLOW_MAX_USAGE_VOLUME: 'nonsense' }), 0);
});

test('final fuse config: $5 cost ceiling is untouched by the new knobs', async () => {
  const { resolveWorkflowCostCeilingUsd, DEFAULT_WORKFLOW_MAX_COST_USD } = await import('../src/orchestrator/workflowCostGuard.js');
  assert.equal(DEFAULT_WORKFLOW_MAX_COST_USD, 5.0);
  assert.equal(resolveWorkflowCostCeilingUsd({}), 5.0);
  assert.equal(resolveWorkflowCostCeilingUsd({ WORKFLOW_MAX_USAGE_VOLUME: '1' }), 5.0);
});

test('final fuse config: anyTokenCeilingActive is true unless EVERY ceiling is disabled', () => {
  assert.equal(anyTokenCeilingActive({}), true, 'all four default ON');
  assert.equal(anyTokenCeilingActive({ WORKFLOW_MAX_COST_USD: '0' }), true, 'volume/call ceilings still ON');
  assert.equal(anyTokenCeilingActive({
    WORKFLOW_MAX_COST_USD: '0',
    WORKFLOW_MAX_USAGE_VOLUME: '0',
    TASK_MAX_EXECUTOR_USAGE_VOLUME: '0',
    MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK: '0',
  }), false, 'every ceiling disabled -> best-effort resume');
});

// ════════════════════════════════════════════════════════════════════
//  2. Resume fail-closed broadening
// ════════════════════════════════════════════════════════════════════

test('final fuse resume gate: guardActive alone (cost ceiling $0) still demands a reconstructable prior state', () => {
  // cost off, but a volume/call ceiling on -> guardActive true.
  const EN = { ceilingUsd: 0, guardActive: true };
  assert.equal(assertResumeCostStateReconstructable(null, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ workflowId: 'w' }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: { records: 'nope' } }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: { records: [] } }, EN).ok, true);
  // nothing active at all -> best effort.
  assert.equal(assertResumeCostStateReconstructable(null, { ceilingUsd: 0, guardActive: false }).ok, true);
});

// Reuse the resume harness shape from tokenHardeningPass.test.js.
async function resumeWithState(readLiveWorkflowStateFn, { env } = {}) {
  const { supergptResume } = await import('../src/orchestrator/supergpt.js');
  const worktreeRoot = path.join(process.env.HOME || process.env.USERPROFILE, '.supergpt', 'worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const workflowId = `wf-agy-test-final-failclosed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cleanup = () => {
    for (const name of fs.readdirSync(worktreeRoot)) {
      if (name === workflowId || name.startsWith(`${workflowId}.`)) fs.rmSync(path.join(worktreeRoot, name), { recursive: true, force: true });
    }
  };
  cleanup();
  let pipelineCalls = 0;
  try {
    fs.writeFileSync(path.join(worktreeRoot, `${workflowId}.workspace.json`), JSON.stringify({
      workflow_id: workflowId, source_workspace: process.cwd(), source_repo_root: process.cwd(),
      source_branch: 'main', baseline_head: 'HEAD', isolated_worktree_path: process.cwd(),
      goal: 'g', external_read_roots: [],
    }));
    const result = await supergptResume({
      workflowId, cwd: process.cwd(), env,
      _pipeline: async () => { pipelineCalls += 1; return { status: 'WORKFLOW_DONE', summary: 'ran', deliveredFiles: [] }; },
      _readLiveWorkflowState: () => readLiveWorkflowStateFn(workflowId),
    });
    return { result, pipelineCalls };
  } finally {
    cleanup();
  }
}

test('final fuse resume gate: cost ceiling OFF but volume ceiling ON + unreconstructable state -> BLOCKING, zero dispatch', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => null, {
    env: { ...process.env, WORKFLOW_MAX_COST_USD: '0' }, // volume/call ceilings still default ON
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(pipelineCalls, 0, 'Planner/Supervisor/Executor/Reviewer/closeout never run');
  assert.equal(result.blockingSafetyEvent?.code, 'WORKFLOW_COST_STATE_UNAVAILABLE');
  assert.equal(result.blockingSafetyEvent?.severity, 'BLOCKING');
});

test('final fuse resume gate: EVERY ceiling disabled -> missing state resumes best-effort', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => null, {
    env: {
      ...process.env,
      WORKFLOW_MAX_COST_USD: '0',
      WORKFLOW_MAX_USAGE_VOLUME: '0',
      TASK_MAX_EXECUTOR_USAGE_VOLUME: '0',
      MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK: '0',
    },
  });
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(pipelineCalls, 1);
});

// ════════════════════════════════════════════════════════════════════
//  3. Real defaultPipeline — Planner boundary pre-check
// ════════════════════════════════════════════════════════════════════

test('final fuse: a resume whose rehydrated usage volume is already over the ceiling runs the Planner ZERO times', async () => {
  const { supergptResume } = await import('../src/orchestrator/supergpt.js');
  const { SUPERGPT_WORKTREE_ROOT } = await import('../src/orchestrator/workflowWorktree.js');
  const { nullWindowSession } = await import('../src/orchestrator/agyProviderSessions.js');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-fuse-planner-'));
  const workflowId = `wf-agy-final-planner-${Date.now()}`;
  const sourceRepo = path.join(tmpRoot, 'source-repo');
  fs.mkdirSync(sourceRepo, { recursive: true });
  execSync('git init -b main', { cwd: sourceRepo });
  execSync('git config user.name "Test"', { cwd: sourceRepo });
  execSync('git config user.email "test@example.com"', { cwd: sourceRepo });
  fs.writeFileSync(path.join(sourceRepo, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: sourceRepo });
  const headSha = execSync('git rev-parse HEAD', { cwd: sourceRepo, encoding: 'utf8' }).trim();

  const worktreeDir = path.join(SUPERGPT_WORKTREE_ROOT, `repo-${workflowId}`);
  fs.mkdirSync(SUPERGPT_WORKTREE_ROOT, { recursive: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  execSync(`git worktree add --detach ${worktreeDir} HEAD`, { cwd: sourceRepo });

  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), JSON.stringify({
    workflow_id: workflowId,
    isolated_worktree_path: worktreeDir,
    source_workspace: sourceRepo,
    source_repo_root: sourceRepo,
    source_branch: 'main',
    baseline_head: headSha,
    closeout_verification_commands: ['echo ok'],
  }));

  // A prior process persisted 1.7M processed tokens for this workflow — already
  // over the default 1.5M workflow usage-volume ceiling.
  const prior = new UsageTracker();
  [600_000, 600_000, 500_000].forEach((vol, i) => prior.record({
    workflowId, role: 'executor', callId: `prior-${i}`, taskId: `t${i}`, attempt: 1, model: 'sonnet',
    usage: { input_tokens: vol, output_tokens: 0, callId: `prior-${i}` },
  }));
  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.state.json`), JSON.stringify({
    workflowId, workflowStatus: 'HUMAN_REQUIRED', tokenUsage: prior.summary(),
  }));

  let plannerCalled = false;
  const fakePlanner = async () => {
    plannerCalled = true;
    return { status: 'READY', summary: 's', plan: '1. x', planText: '1. x',
      tasks: [{ task_id: 't-1', goal: 'x', allowed_files: [], verification_commands: ['echo ok'] }],
      closeoutVerificationCommands: ['echo ok'] };
  };
  let realModelCalled = false;
  const fakeProviders = () => ({
    runtime: { invoke: async (_role, { resolve }) => ({ value: await resolve(async () => { realModelCalled = true; throw new Error('no real model'); }) }) },
    supervisorSession: { create: async () => ({ tabId: 's' }), decide: async () => ({ action: 'WORKFLOW_DONE', summary: 'x' }), close: async () => {} },
    createReviewerSession: () => () => ({ create: async () => ({ tabId: 'r' }), review: async () => ({ decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' }), close: async () => {} }),
    createExecutorSessionManager: () => ({ createSession: () => ({ executeTask: async () => ({ exitCode: 0, status: 'DONE' }), close: async () => {} }) }),
    windowSession: nullWindowSession,
    sessionStore: { snapshot: () => ({}) },
  });

  try {
    const result = await supergptResume({
      workflowId,
      cwd: sourceRepo,
      _resolveWorkflowPlan: fakePlanner,
      _selectProviders: fakeProviders,
      _createGateRunner: () => ({ async run(cmds) { return { pass: true, results: cmds.map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' }; } }),
    });

    assert.equal(plannerCalled, false, 'the Planner must never be dispatched once the rehydrated budget is already over a ceiling');
    assert.equal(realModelCalled, false);
    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(result.blockingSafetyEvent?.code, 'WORKFLOW_USAGE_VOLUME_EXCEEDED');
    assert.match(result.reason, /usage volume/i);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    for (const name of fs.readdirSync(SUPERGPT_WORKTREE_ROOT)) {
      if (name === workflowId || name.startsWith(`${workflowId}.`)) fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, name), { recursive: true, force: true });
    }
  }
});

// ════════════════════════════════════════════════════════════════════
//  4. PR-closeout repair Executor
// ════════════════════════════════════════════════════════════════════

import { createRealGithubPrCloseoutAdapters } from '../src/orchestrator/supergpt.js';
import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';

function repairCard() {
  return {
    task_id: 'pr-closeout-repair',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'repair', context: 'c', scope: 's', allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
}

test('final fuse: PR-closeout repair Executor stops before spending when the Task usage-volume ceiling is already reached', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-fuse-closeout-'));
  try {
    const usageTracker = new UsageTracker();
    // one prior repair Executor call already at the 600k task ceiling
    usageTracker.record({
      workflowId: 'w', role: 'executor', callId: 'prior-repair', taskId: 'pr-closeout-repair', attempt: 1, model: 'sonnet',
      usage: { input_tokens: 600_000, output_tokens: 0, callId: 'prior-repair' },
    });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-closeout-final', kind: 'INTERNAL_TEST', root });
    let executeCalls = 0;
    const adapters = createRealGithubPrCloseoutAdapters({
      repoRoot: process.cwd(), cwd: process.cwd(), prNumber: 123,
      selection: { createExecutorSessionManager: () => ({ async execute() { executeCalls += 1; return { task_id: 'pr-closeout-repair', status: 'COMPLETE', changed_files: [], tests_run: [], test_results: [], issues: 'none', next_recommendation: 'proceed' }; } }) },
      createGateRunner: () => ({ run: async () => ({ pass: true, results: [] }) }),
      baseline: null, signal: null,
      workflowId: 'wf-internal-test-closeout-final',
      workflowStateManager, usageTracker,
      taskExecutorUsageVolumeCeiling: 600_000,
      executorPhysicalCallCeiling: 4,
    });

    const out = await adapters.runRepairTask(repairCard());
    assert.equal(executeCalls, 0, 'no repair Executor call once the task ceiling is reached');
    assert.equal(out.status, 'FAILED');
    assert.equal(out.safetyCode, 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED');
    assert.equal(out.safetyBlocking, true);
    const ev = workflowStateManager.getSafetyEvents()[0];
    assert.equal(ev.code, 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED');
    assert.equal(ev.severity, 'BLOCKING');
    assert.equal(ev.usageVolume, 600_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════
//  5. Incident replay — wf-agy-9a3583e5 (pure mock, no pipeline)
// ════════════════════════════════════════════════════════════════════
//
// Original incident: 6 Executor physical calls, 1,844,098 processed tokens,
// $1.304 Claude cost — on ONE task. ~307k tokens & ~$0.22 per call.

const INCIDENT_PER_CALL_VOLUME = Math.round(1_844_098 / 6); // ~307,350
const INCIDENT_PER_CALL_COST = 1.304 / 6;

// Walk the incident forward, applying the SAME "check before each dispatch"
// the loop applies, using only the mechanical fuse (default thresholds).
function replayIncidentUnderFinalFuse() {
  const tracker = new UsageTracker();
  const taskId = 'incident-task';
  const limits = {
    volumeLimit: DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME,     // 600k
    callLimit: DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK, // 4
  };
  for (let call = 1; call <= 6; call += 1) {
    // pre-dispatch checks (task call-count / task volume / workflow volume / cost)
    const taskHit = taskExecutorCeilingExceeded(tracker, taskId, limits);
    const wfVol = workflowUsageVolumeExceeded(tracker, DEFAULT_WORKFLOW_MAX_USAGE_VOLUME);
    const wfCost = workflowCostExceeded(tracker, 5.0);
    if (taskHit || wfVol || wfCost) {
      const u = executorTaskUsage(tracker, taskId);
      return {
        stoppedBeforeCall: call,
        physicalCalls: u.physicalCalls,
        usageVolume: u.usageVolume,
        measuredCost: Number(tracker.summary().measuredTotal.costUsd.toFixed(4)),
        code: taskHit ? (taskHit.kind === 'CALLS' ? 'EXECUTOR_CALL_CEILING_EXCEEDED' : 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED')
          : wfVol ? 'WORKFLOW_USAGE_VOLUME_EXCEEDED' : 'WORKFLOW_COST_BUDGET_EXCEEDED',
      };
    }
    // dispatch happened -> record it
    tracker.record({
      workflowId: 'wf-agy-9a3583e5', role: 'executor', callId: `incident-${call}`, taskId, attempt: call, model: 'sonnet',
      usage: { input_tokens: INCIDENT_PER_CALL_VOLUME, output_tokens: 0, callId: `incident-${call}` },
      costUsd: INCIDENT_PER_CALL_COST,
    });
  }
  return { stoppedBeforeCall: null };
}

test('incident replay: the mechanical fuse ALONE truncates wf-agy-9a3583e5 long before its 6 calls / 1.84M / $1.30', () => {
  const r = replayIncidentUnderFinalFuse();
  // The task cumulative usage-volume ceiling (600k) is the first wall.
  assert.equal(r.code, 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED');
  assert.equal(r.stoppedBeforeCall, 3, 'stopped before the 3rd Executor dispatch');
  assert.equal(r.physicalCalls, 2, 'at most 2 physical Executor calls (was 6)');
  assert.ok(r.usageVolume >= 600_000 && r.usageVolume < 700_000, `~614k processed tokens (was 1.84M): ${r.usageVolume}`);
  assert.ok(r.measuredCost < 0.5, `< $0.50 measured cost (was $1.30): $${r.measuredCost}`);
});

test('incident replay: the fuse never fires on the NORMAL converged path (Executor #1 -> PASS)', () => {
  // With 1e97a65 (no-new-information) + db8b75a (baseline-diff) the loop
  // converges after a single Executor call. One ~307k call must sit far below
  // every ceiling — the fuse is a fuse, not part of the happy path.
  const tracker = new UsageTracker();
  tracker.record({
    workflowId: 'wf-normal', role: 'executor', callId: 'n1', taskId: 'incident-task', attempt: 1, model: 'sonnet',
    usage: { input_tokens: INCIDENT_PER_CALL_VOLUME, output_tokens: 0, callId: 'n1' }, costUsd: INCIDENT_PER_CALL_COST,
  });
  assert.equal(taskExecutorCeilingExceeded(tracker, 'incident-task', {
    volumeLimit: DEFAULT_TASK_MAX_EXECUTOR_USAGE_VOLUME,
    callLimit: DEFAULT_MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK,
  }), null);
  assert.equal(workflowUsageVolumeExceeded(tracker, DEFAULT_WORKFLOW_MAX_USAGE_VOLUME), null);
  assert.equal(workflowCostExceeded(tracker, 5.0), null);
});
