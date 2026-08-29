// Deterministic regressions for the six unresolved PR #3 review threads.
//
//   P1-1 (3881395887) — restore the advanced task baseline on resume
//   P1-2 (3881395891) — preserve STOPPED (resumable) workflows during GC
//   P1-3 (3881395898) — same-process supergpt_stop awaits owner teardown
//   P1-4 (3881395901) — cross-process control updates cannot lose stop.requested
//   P2-1 (3881395906) — reviewer rate-limit resumes at Reviewer, not Executor
//   P2-2 (3881395910) — delivery success is distinct from cleanup failure

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { gcSuperGptResources } from '../src/orchestrator/workflowLifecycle.js';
import { deliverWorkflowResult } from '../src/orchestrator/resultDelivery.js';
import {
  claimOwner,
  requestStop,
  isStopRequested,
  readControl,
  saveCheckpoint,
  recordAdvancedBaselineHead,
  recordDeliveryCompleted,
  isDeliveryCompleted,
  clearControl,
} from '../src/orchestrator/workflowControl.js';
import { runSuperGPT, supergptStop, restoreResumableWorkspace } from '../src/orchestrator/supergpt.js';

// --- shared loop fakes -------------------------------------------------------

function taskCard(id) {
  return {
    task_id: id,
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'c' },
    goal: id, context: id, scope: id,
    allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
}
const pass = (id) => ({ task_id: id, decision: 'PASS', findings: 'ok', required_changes: 'none', rationale: 'ok' });

function fakeSupervisor(decisions) {
  const queue = [...decisions];
  return {
    decideCalls: [],
    async create() { return { tabId: 501, conversationId: null }; },
    async decide(ctx) { this.decideCalls.push({ ...ctx, history: [...(ctx.history || [])] }); return queue.shift(); },
    async close() {},
  };
}
function fakeExecutorFactory() {
  const managers = [];
  const f = ({ taskId }) => {
    const m = { taskId, executions: [], async execute(tc) { m.executions.push(tc.task_id); return { task_id: tc.task_id, status: 'DONE', changed_files: [], callId: `exec-${tc.task_id}` }; } };
    managers.push(m);
    return m;
  };
  f.managers = managers;
  f.totalExecutions = () => managers.reduce((n, m) => n + m.executions.length, 0);
  return f;
}
function fakeGate() {
  const g = { runs: 0, async run() { g.runs += 1; return { pass: true, results: [], changed_files: [], git_diff: '' }; } };
  return g;
}
function fakeWindow() {
  return {
    async create() { return { windowId: 900, initialTabId: 999 }; },
    async activateTab(t) { return { tabId: t, active: true, windowId: 900, windowFocused: false }; },
    async closeTab() {},
    async listTabs() { return []; },
    async close() {},
  };
}

class RateLimitedError extends Error {
  constructor(msg) { super(msg); this.name = 'RateLimitedError'; this.code = 'RATE_LIMITED'; }
}

// ===========================================================================
// P2-1 — Reviewer rate-limit resumes at Reviewer, not Executor
// ===========================================================================

test('P2-1: reviewer rate limit after Gate PASS persists a REVIEW_PENDING checkpoint with the Executor/Gate evidence', async () => {
  let captured = null;
  const exec = fakeExecutorFactory();
  const gate = fakeGate();
  const rev = () => ({
    async create() { return { tabId: 601 }; },
    async review() { throw new RateLimitedError('ChatGPT is rate-limiting requests'); },
    async close() {},
  });

  const res = await runAutomatedWorkflow({
    workflowId: 'wf-rp-1',
    supervisorSession: fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]),
    createReviewerSession: rev,
    createClaudeSessionManager: exec,
    gateRunner: gate,
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    computeGateFingerprint: () => 'FP-STABLE',
    onCheckpoint: (cp) => { captured = cp; },
  });

  assert.equal(res.status, 'HUMAN_REQUIRED');
  assert.equal(exec.totalExecutions(), 1, 'Executor ran exactly once');
  assert.equal(gate.runs, 1, 'Gate ran exactly once');
  assert.equal(captured.phase, 'REVIEW_PENDING');
  assert.equal(captured.currentTaskId, 'a');
  assert.ok(captured.executionReport, 'execution report persisted');
  assert.ok(captured.gateEvidence, 'gate evidence persisted');
  assert.equal(captured.worktreeFingerprint, 'FP-STABLE');
  assert.equal(captured.attempt, 1);
});

test('P2-1: resuming a REVIEW_PENDING checkpoint restarts at the Reviewer — Executor and Gate counts unchanged', async () => {
  // Run 1: rate-limited reviewer.
  let captured = null;
  const exec1 = fakeExecutorFactory();
  const gate1 = fakeGate();
  await runAutomatedWorkflow({
    workflowId: 'wf-rp-2',
    supervisorSession: fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]),
    createReviewerSession: () => ({ async create() { return { tabId: 601 }; }, async review() { throw new RateLimitedError('rl'); }, async close() {} }),
    createClaudeSessionManager: exec1,
    gateRunner: gate1,
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    computeGateFingerprint: () => 'FP-1',
    onCheckpoint: (cp) => { captured = cp; },
  });
  assert.equal(exec1.totalExecutions(), 1);
  assert.equal(gate1.runs, 1);

  // Run 2: resume — reviewer now succeeds.
  const exec2 = fakeExecutorFactory();
  const gate2 = fakeGate();
  let reviewCalls = 0;
  const res2 = await runAutomatedWorkflow({
    workflowId: 'wf-rp-2',
    supervisorSession: fakeSupervisor([{ action: 'WORKFLOW_DONE', summary: 'done' }]),
    createReviewerSession: () => ({ async create() { return { tabId: 601 }; }, async review() { reviewCalls += 1; return pass('a'); }, async close() {} }),
    createClaudeSessionManager: exec2,
    gateRunner: gate2,
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    computeGateFingerprint: () => 'FP-1',
    checkpoint: captured,
  });

  assert.equal(res2.status, 'WORKFLOW_DONE');
  assert.equal(exec2.totalExecutions(), 0, 'Executor did NOT re-run on resume');
  assert.equal(gate2.runs, 0, 'Gate did NOT re-run on resume');
  assert.equal(reviewCalls, 1, 'Reviewer ran once on resume (2 total across both runs)');
  assert.deepEqual(res2.history.map((h) => h.task_id), ['a']);
});

test('P2-1 / stale evidence: a post-Gate worktree change routes a REVIEW_PENDING resume back through a fresh attempt', async () => {
  let captured = null;
  const exec1 = fakeExecutorFactory();
  await runAutomatedWorkflow({
    workflowId: 'wf-rp-3',
    supervisorSession: fakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard('a') }]),
    createReviewerSession: () => ({ async create() { return { tabId: 601 }; }, async review() { throw new RateLimitedError('rl'); }, async close() {} }),
    createClaudeSessionManager: exec1,
    gateRunner: fakeGate(),
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    computeGateFingerprint: () => 'FP-BEFORE',
    onCheckpoint: (cp) => { captured = cp; },
  });

  const exec2 = fakeExecutorFactory();
  const gate2 = fakeGate();
  const res2 = await runAutomatedWorkflow({
    workflowId: 'wf-rp-3',
    supervisorSession: fakeSupervisor([{ action: 'WORKFLOW_DONE', summary: 'done' }]),
    createReviewerSession: () => ({ async create() { return { tabId: 601 }; }, async review() { return pass('a'); }, async close() {} }),
    createClaudeSessionManager: exec2,
    gateRunner: gate2,
    windowSession: fakeWindow(),
    workflowGoal: 'g',
    repositoryContext: taskCard('a').repository_context,
    computeGateFingerprint: () => 'FP-AFTER-DRIFT',
    checkpoint: captured,
  });

  assert.equal(res2.status, 'WORKFLOW_DONE');
  assert.equal(exec2.totalExecutions(), 1, 'stale gate evidence forced a fresh Executor attempt');
  assert.equal(gate2.runs, 1, 'and a fresh Gate run');
});

// ===========================================================================
// P1-4 — cross-process control updates cannot lose stop.requested
// ===========================================================================

test('P1-4: a stale checkpoint write by the owner cannot clear a stop request from another process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-p14-'));
  try {
    const workflowId = 'wf-race';
    claimOwner({ root, workflowId, pid: process.pid });

    // Owner process A reads control before the stop arrives.
    const staleView = readControl({ root, workflowId });
    assert.equal(staleView.stop.requested, false);

    // Stop process B records a durable stop.
    requestStop({ root, workflowId, reason: 'user stop mid-checkpoint' });

    // Owner process A now persists a checkpoint built from its stale view.
    saveCheckpoint({ root, workflowId }, { history: [{ task_id: 'a', decision: 'PASS' }], staleControl: staleView });

    // The stop request survives the owner's read-modify-write.
    assert.equal(isStopRequested({ root, workflowId }), true);
    assert.equal(readControl({ root, workflowId }).stop.reason, 'user stop mid-checkpoint');
    // ...and the checkpoint was still persisted.
    assert.deepEqual(readControl({ root, workflowId }).checkpoint.history.map((h) => h.task_id), ['a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P1-4: only a legitimate owner claim clears a stale stop request; routine checkpoint writes never do', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-p14b-'));
  try {
    const workflowId = 'wf-claim';
    requestStop({ root, workflowId, reason: 'left over from a dead run' });
    assert.equal(isStopRequested({ root, workflowId }), true);

    // A routine checkpoint write must NOT clear it.
    saveCheckpoint({ root, workflowId }, { history: [] });
    assert.equal(isStopRequested({ root, workflowId }), true);

    // A fresh owner claim (a real lifecycle boundary) clears it.
    claimOwner({ root, workflowId, pid: process.pid });
    assert.equal(isStopRequested({ root, workflowId }), false);

    // A later checkpoint write does not resurrect or re-clear anything.
    saveCheckpoint({ root, workflowId }, { history: [{ task_id: 'x', decision: 'PASS' }] });
    assert.equal(isStopRequested({ root, workflowId }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// P1-2 — STOPPED resumable workflows survive age-based GC; DONE still collected
// ===========================================================================

const fakeSpawn = (command, args) => ({
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(0)); },
  _removed: args.includes('remove'),
});

async function makeWorkflowDir(root, wfId, { status, withMetadata = true } = {}) {
  const dir = path.join(root, `repo-${wfId}`);
  await mkdir(dir, { recursive: true });
  if (status) {
    await writeFile(path.join(root, `${wfId}.state.json`),
      JSON.stringify({ workflowId: wfId, workflowStatus: status, activeProcesses: [] }));
  }
  if (withMetadata) {
    await writeFile(path.join(root, `${wfId}.workspace.json`), JSON.stringify({ workflow_id: wfId }));
  }
  return dir;
}

test('P1-2: a STOPPED workflow with preserved worktree metadata survives age-based GC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-p12-'));
  try {
    const stoppedDir = await makeWorkflowDir(root, 'wf-agy-stopped-1', { status: 'STOPPED' });
    const doneDir = await makeWorkflowDir(root, 'wf-agy-done-1', { status: 'DONE' });
    const abandonedStoppedDir = await makeWorkflowDir(root, 'wf-agy-stopped-2', { status: 'STOPPED', withMetadata: false });

    const res = await gcSuperGptResources({ root, maxAgeMs: -1, spawn: fakeSpawn });

    assert.equal(res.cleanedWorktrees.includes(stoppedDir), false, 'resumable STOPPED worktree preserved despite age');
    assert.ok(existsSync(stoppedDir));
    assert.ok(existsSync(path.join(root, 'wf-agy-stopped-1.workspace.json')), 'resume inputs survive');

    assert.ok(res.cleanedWorktrees.includes(doneDir), 'a DONE workflow is still collected');
    assert.equal(existsSync(doneDir), false);

    assert.ok(res.cleanedWorktrees.includes(abandonedStoppedDir), 'a STOPPED workflow with no resume metadata is still disposable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// P1-3 — same-process supergpt_stop awaits owner teardown before returning
// ===========================================================================

test('P1-3: same-process supergpt_stop does not resolve until the owning run finishes tearing down', async () => {
  const workflowId = `wf-agy-p13-${process.pid}-${Date.now()}`;
  const { SUPERGPT_WORKTREE_ROOT } = await import('../src/orchestrator/workflowWorktree.js');
  let teardownComplete = false;
  let pipelineAborted;
  const abortedP = new Promise((r) => { pipelineAborted = r; });

  const running = runSuperGPT({
    goal: 'p13',
    workflowId,
    _pipeline: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        pipelineAborted();
        setTimeout(() => { teardownComplete = true; resolve({ status: 'CANCELLED' }); }, 80);
      }, { once: true });
    }),
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20)); // let claimOwner land

  const stopP = supergptStop({ workflowId, root: SUPERGPT_WORKTREE_ROOT, reason: 'same-process stop' });
  let stopResolved = false;
  stopP.then(() => { stopResolved = true; });

  await abortedP;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopResolved, false, 'stop is still awaiting owner teardown');
  assert.equal(teardownComplete, false, 'owner teardown is still pending');

  const stopResult = await stopP;
  assert.equal(teardownComplete, true, 'owner teardown finished before stop returned');
  assert.equal(stopResult.status, 'STOPPED');
  assert.equal(stopResult.ownerAcknowledged, true, 'the owning run acknowledged via its own terminal state');

  await running;
  try {
    fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.control.json`), { force: true });
    fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.stop.json`), { force: true });
    fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.state.json`), { force: true });
  } catch { /* best effort */ }
});

// ===========================================================================
// P2-2 — delivery success is a different state from cleanup failure
// ===========================================================================

test('P2-2: delivery succeeds + worktree cleanup throws -> delivery is still reported successful', async () => {
  const seq = [];
  const fakeDelivery = {
    calculateApprovedDelta: async () => ({ changedPaths: ['b.txt'], patch: '', untrackedFiles: [], isEmpty: false }),
    checkDeliveryConflicts: async () => ({ safe: true, conflicts: [] }),
    deliverApprovedDelta: async () => { seq.push('deliver'); return { delivered: ['b.txt'] }; },
    cleanupDeliveredWorktree: async () => { seq.push('cleanup'); throw new Error('git worktree remove failed: locked'); },
  };
  let deliveredRecorded = null;
  const report = await deliverWorkflowResult({
    worktree: { worktree_path: '/wt', baseline_head: 'BASE', source_workspace: '/src', source_repo_root: '/src' },
    delivery: fakeDelivery,
    onDelivered: ({ changed_files }) => { deliveredRecorded = changed_files; },
  });

  assert.equal(report.status, 'DELIVERED', 'a cleanup failure is NOT a failed delivery');
  assert.equal(report.cleanup_status, 'WARNING');
  assert.match(report.cleanup_error, /locked/);
  assert.equal(report.worktree_preserved, true, 'the worktree is left for a later cleanup retry');
  assert.deepEqual(deliveredRecorded, ['b.txt'], 'delivery success was recorded BEFORE cleanup ran');
  assert.deepEqual(seq, ['deliver', 'cleanup']);
});

test('P2-2: a workflow whose delivery already succeeded never re-delivers on resume (cleanup retry only)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-p22-'));
  try {
    const workflowId = 'wf-delivered';
    recordDeliveryCompleted({ root, workflowId, changedFiles: ['b.txt'], cleanup: { status: 'WARNING', error: 'remove failed' } });
    const control = readControl({ root, workflowId });
    assert.equal(isDeliveryCompleted(control), true);
    assert.deepEqual(control.delivery.changed_files, ['b.txt']);
    assert.equal(control.delivery.cleanup.status, 'WARNING');
    // The delivery-completed marker is independent of the delivery_ready phase
    // hint, so a resume routes to cleanup-retry and never back into delivery.
    assert.notEqual(control.phase, 'delivery_ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// P1-1 — restore the advanced task baseline on resume
// ===========================================================================

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -b main', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  execSync('git add . && git commit -m initial', { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

test('P1-1: restoreResumableWorkspace reconstructs the delivery baseline from the original invocation snapshot', () => {
  const meta = {
    isolated_worktree_path: '/wt', source_workspace: '/src', source_branch: 'main', baseline_head: 'ORIGINAL',
  };
  const { baseline, worktree } = restoreResumableWorkspace(meta);
  assert.equal(baseline.head, 'ORIGINAL');
  assert.equal(worktree.baseline_head, 'ORIGINAL');
});

test('P1-1: resume sets the per-task Gate baseline to the persisted advanced commit, not the invocation baseline', async () => {
  const { SUPERGPT_WORKTREE_ROOT } = await import('../src/orchestrator/workflowWorktree.js');
  const { nullWindowSession } = await import('../src/orchestrator/agyProviderSessions.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-p11-'));
  const workflowId = `wf-agy-p11-${Date.now()}`;
  const sourceRepo = path.join(tmpRoot, 'source');
  const originalHead = initGitRepo(sourceRepo);

  const worktreeDir = path.join(SUPERGPT_WORKTREE_ROOT, `repo-${workflowId}`);
  fs.mkdirSync(SUPERGPT_WORKTREE_ROOT, { recursive: true });
  execSync(`git worktree add --detach ${worktreeDir} HEAD`, { cwd: sourceRepo });

  // Simulate task A already accepted and committed inside the worktree.
  fs.writeFileSync(path.join(worktreeDir, 'a.txt'), 'task A\n');
  execSync('git add . && git commit -m "task A"', { cwd: worktreeDir });
  const advancedHead = execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf8' }).trim();
  assert.notEqual(advancedHead, originalHead);

  // Task B's work is in-flight (uncommitted) in the worktree.
  fs.writeFileSync(path.join(worktreeDir, 'b.txt'), 'task B\n');

  const metaPath = path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    workflow_id: workflowId,
    isolated_worktree_path: worktreeDir,
    source_workspace: sourceRepo,
    source_repo_root: sourceRepo,
    source_branch: 'main',
    baseline_head: originalHead,
    closeout_verification_commands: ['echo closeout-ok'],
  }));

  // Durable control: task A in history, task B mid-flight (REWORK), advanced baseline persisted.
  saveCheckpoint({ root: SUPERGPT_WORKTREE_ROOT, workflowId }, {
    history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }],
    currentTaskCard: { ...taskCard('b'), verification_commands: ['echo task-b-ok'] },
    currentTaskId: 'b',
    attempt: 1,
    latestReviewResult: { task_id: 'b', decision: 'REWORK', required_changes: ['finish b'], findings: [], rationale: 'wip' },
  });
  recordAdvancedBaselineHead({ root: SUPERGPT_WORKTREE_ROOT, workflowId, head: advancedHead });

  let gateBaselineHead = null;
  const gateFactory = ({ baseline }) => ({
    async run(commands) {
      if (baseline && gateBaselineHead === null) gateBaselineHead = baseline.head;
      return { pass: true, results: (commands || []).map((c) => ({ command: c, pass: true, output: 'ok' })), changed_files: [], git_diff: '' };
    },
  });

  const executorTaskIds = [];
  const reviewerTaskIds = [];
  const fakeProviders = () => ({
    supervisorSession: {
      create: async () => ({ tabId: 'sup' }),
      decide: async (ctx) => {
        // task b is mid-flight REWORK -> continue it, then finish.
        if (ctx.latestReviewResult && ctx.latestReviewResult.decision === 'PASS') return { action: 'WORKFLOW_DONE', summary: 'done' };
        return { action: 'CONTINUE_REWORK' };
      },
      close: async () => {},
    },
    createReviewerSession: () => ({
      create: async () => ({ tabId: 'rev' }),
      review: async (id) => { reviewerTaskIds.push(id); return pass(id); },
      close: async () => {},
    }),
    createExecutorSessionManager: ({ taskId }) => {
      executorTaskIds.push(taskId);
      return { async execute(tc) { return { task_id: tc.task_id, status: 'DONE', changed_files: [], callId: `e-${tc.task_id}` }; } };
    },
    windowSession: nullWindowSession,
    sessionStore: { snapshot: () => ({}) },
    runtime: { invoke: async (role, { resolve }) => ({ value: await resolve(async () => ({})) }) },
  });

  const { supergptResume } = await import('../src/orchestrator/supergpt.js');
  const res = await supergptResume({
    workflowId,
    cwd: sourceRepo,
    _selectProviders: fakeProviders,
    _createGateRunner: gateFactory,
    _resolveWorkflowPlan: async () => ({ status: 'READY', plan: 'p', planText: 'p', summary: 's', tasks: [{ task_id: 'b' }], closeoutVerificationCommands: ['echo closeout-ok'] }),
  });

  assert.equal(res.reason ?? null, null, `resume should not fail: ${res.reason}`);
  assert.equal(gateBaselineHead, advancedHead, 'the resumed per-task Gate baseline is the advanced commit, not the invocation baseline');
  assert.notEqual(gateBaselineHead, originalHead);
  assert.deepEqual(executorTaskIds, ['b'], 'only the mid-flight task B executed; accepted task A did not re-run');
  assert.equal(reviewerTaskIds.includes('a'), false, 'accepted task A was not re-reviewed');
  assert.equal(res.status, 'WORKFLOW_DONE');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try { execSync(`git worktree remove --force ${worktreeDir}`, { cwd: sourceRepo }); } catch { /* repo already gone */ }
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  for (const ext of ['workspace.json', 'control.json', 'stop.json', 'state.json', 'resources.json']) {
    fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.${ext}`), { force: true });
  }
  fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, workflowId), { recursive: true, force: true });
});

test('P1-1 fail-closed: an advanced baseline recorded in control that is not a valid worktree commit refuses to fall back', async () => {
  const { SUPERGPT_WORKTREE_ROOT } = await import('../src/orchestrator/workflowWorktree.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-p11fc-'));
  const workflowId = `wf-agy-p11fc-${Date.now()}`;
  const sourceRepo = path.join(tmpRoot, 'source');
  const originalHead = initGitRepo(sourceRepo);
  const worktreeDir = path.join(SUPERGPT_WORKTREE_ROOT, `repo-${workflowId}`);
  fs.mkdirSync(SUPERGPT_WORKTREE_ROOT, { recursive: true });
  execSync(`git worktree add --detach ${worktreeDir} HEAD`, { cwd: sourceRepo });

  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), JSON.stringify({
    workflow_id: workflowId,
    isolated_worktree_path: worktreeDir,
    source_workspace: sourceRepo,
    source_repo_root: sourceRepo,
    source_branch: 'main',
    baseline_head: originalHead,
    closeout_verification_commands: ['echo ok'],
  }));
  saveCheckpoint({ root: SUPERGPT_WORKTREE_ROOT, workflowId }, { history: [{ task_id: 'a', decision: 'PASS', attempts: 1 }] });
  recordAdvancedBaselineHead({ root: SUPERGPT_WORKTREE_ROOT, workflowId, head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });

  const { supergptResume } = await import('../src/orchestrator/supergpt.js');
  const res = await supergptResume({
    workflowId,
    cwd: sourceRepo,
    _selectProviders: () => { throw new Error('should never reach provider selection'); },
    _createGateRunner: () => ({ async run() { return { pass: true, results: [] }; } }),
    _resolveWorkflowPlan: async () => ({ status: 'READY', plan: 'p', planText: 'p', summary: 's', tasks: [{ task_id: 'a' }], closeoutVerificationCommands: ['echo ok'] }),
  });

  assert.equal(res.status, 'FAILED');
  assert.match(res.reason, /advanced task baseline/i);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try { execSync(`git worktree remove --force ${worktreeDir}`, { cwd: sourceRepo }); } catch { /* ignore */ }
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  for (const ext of ['workspace.json', 'control.json', 'stop.json', 'state.json', 'resources.json']) {
    fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.${ext}`), { force: true });
  }
  fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, workflowId), { recursive: true, force: true });
});
