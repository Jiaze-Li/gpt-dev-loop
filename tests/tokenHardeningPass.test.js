// Token-safety hardening pass — targeted proofs for:
//   A. PR Closeout repair executor accounting + safety events
//   B. Supervisor / Reviewer context hard limits on every provider
//   D. Executor loads zero SuperGPT MCP schemas
// (C. workflow cumulative cost breaker lives in automatedLoop.test.js;
//  E. executor turn cap lives in claudeExecutorAdapter.test.js.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';
import { createRealGithubPrCloseoutAdapters } from '../src/orchestrator/supergpt.js';
import { providerFailure } from '../src/orchestrator/productionRoleRuntime.js';

import { assembleSupervisorPrompt, createAgySupervisorProvider } from '../src/orchestrator/adapters/agySupervisorProvider.js';
import { createCodexSupervisorProvider } from '../src/orchestrator/adapters/codexSupervisorProvider.js';
import { createClaudeSupervisorProvider } from '../src/orchestrator/adapters/claudeSupervisorProvider.js';
import { assembleReviewerPrompt, createAgyReviewerProvider } from '../src/orchestrator/adapters/agyReviewerProvider.js';
import { createCodexReviewerProvider } from '../src/orchestrator/adapters/codexReviewerProvider.js';
import { createClaudeReviewerProvider } from '../src/orchestrator/adapters/claudeReviewerProvider.js';

// ── shared fixtures ─────────────────────────────────────────────────

function repairCard(overrides = {}) {
  return {
    task_id: 'pr-closeout-repair',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'repair', context: 'c', scope: 's',
    allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
    ...overrides,
  };
}

function execReport(overrides = {}) {
  return {
    task_id: 'pr-closeout-repair',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'def' },
    status: 'COMPLETE', changed_files: [], tests_run: [], test_results: [], issues: 'none', next_recommendation: 'proceed',
    ...overrides,
  };
}

function fakeSelection(executeImpl) {
  return {
    createExecutorSessionManager: ({ taskId }) => ({
      async execute(card) { return executeImpl(card, taskId); },
    }),
  };
}

function fakeGateRunner() {
  return () => ({ runGate: async () => ({ pass: true, results: [] }) });
}

function makeAdapters({ executeImpl, usageTracker, workflowStateManager, workflowCostCeilingUsd = 0 }) {
  return createRealGithubPrCloseoutAdapters({
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    prNumber: 123,
    selection: fakeSelection(executeImpl),
    createGateRunner: fakeGateRunner(),
    baseline: null,
    signal: null,
    workflowId: 'wf-internal-test-closeout-acct',
    workflowStateManager,
    usageTracker,
    workflowCostCeilingUsd,
  });
}

// ════════════════════════════════════════════════════════════════════
//  A. PR Closeout repair executor accounting
// ════════════════════════════════════════════════════════════════════

test('A1. successful PR Closeout repair executor usage is recorded exactly once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-acct-'));
  try {
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-closeout-acct', kind: 'INTERNAL_TEST', root });
    const adapters = makeAdapters({
      usageTracker, workflowStateManager,
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
    assert.equal(summary.executor.costUsd, 0.07);
    assert.equal(summary.executor.inputTokens, 1200);

    // Idempotent: replaying the same physical call must not double-count.
    await adapters.runRepairTask(repairCard()).catch(() => {});
    assert.equal(usageTracker.summary().executor.calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A2. repair executor budget failure: usage recorded + BLOCKING safety event + structured failure + no retry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-acct-'));
  try {
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-closeout-acct', kind: 'INTERNAL_TEST', root });
    let executeCalls = 0;

    const adapters = makeAdapters({
      usageTracker, workflowStateManager,
      executeImpl: async () => {
        executeCalls += 1;
        throw new AdapterError(
          ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED,
          'executor usage exceeded hard budget (numTurns=31/30)',
          {
            budgetExceededReason: 'numTurns=31/30',
            callId: 'call-claude-exe-repair-budget',
            model: 'sonnet',
            physicalCallReason: 'PRIMARY',
            attempt: 1,
            costUsd: 0.42,
            usage: { output_tokens: 900, cache_read_tokens: 120000, cache_creation_tokens: 40000, num_turns: 31, callId: 'call-claude-exe-repair-budget' },
          },
        );
      },
    });

    const out = await adapters.runRepairTask(repairCard());

    // structured, not a bare generic FAILED
    assert.equal(out.status, 'FAILED');
    assert.equal(out.safetyCode, 'EXECUTOR_BUDGET_EXCEEDED');
    assert.equal(out.safetyBlocking, true);
    assert.ok(out.usage);

    // the consumed provider call is metered with its real callId + cost
    const summary = usageTracker.summary();
    assert.equal(summary.executor.calls, 1);
    assert.equal(summary.executor.costUsd, 0.42);
    assert.equal(summary.records[0].callId, 'call-claude-exe-repair-budget');

    // user-visible BLOCKING safety event on the existing mechanism
    const events = workflowStateManager.getSafetyEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'EXECUTOR_BUDGET_EXCEEDED');
    assert.equal(events[0].severity, 'BLOCKING');
    assert.equal(events[0].role, 'executor');
    assert.match(events[0].reason, /numTurns=31\/30/);

    // no retry / failover — the executor was invoked exactly once
    assert.equal(executeCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A3. repair executor stops before spending when the workflow cost ceiling is already crossed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-acct-'));
  try {
    const usageTracker = new UsageTracker();
    usageTracker.record({ workflowId: 'w', role: 'executor', callId: 'prior', taskId: 't', attempt: 1, model: 'sonnet', usage: { input_tokens: 10, output_tokens: 5, callId: 'prior' }, costUsd: 9.0 });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-internal-test-closeout-acct', kind: 'INTERNAL_TEST', root });
    let executeCalls = 0;
    const adapters = makeAdapters({
      usageTracker, workflowStateManager, workflowCostCeilingUsd: 5.0,
      executeImpl: async () => { executeCalls += 1; return execReport(); },
    });

    const out = await adapters.runRepairTask(repairCard());
    assert.equal(executeCalls, 0, 'no repair executor call is dispatched once the ceiling is crossed');
    assert.equal(out.status, 'FAILED');
    assert.equal(out.safetyCode, 'WORKFLOW_COST_BUDGET_EXCEEDED');
    const events = workflowStateManager.getSafetyEvents();
    assert.equal(events[0].code, 'WORKFLOW_COST_BUDGET_EXCEEDED');
    assert.equal(events[0].severity, 'BLOCKING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════
//  B. Supervisor / Reviewer context hard limits — every provider
// ════════════════════════════════════════════════════════════════════

const SUP_CONTEXT = {
  workflowGoal: 'ship the thing',
  repositoryContext: { repository_name: 'r', branch: 'main', commit_sha: 'abc' },
  history: [],
};
const HUGE_CHECKPOINT = {
  overall_goal: 'g'.repeat(30_000),
  completed_tasks: Array.from({ length: 100 }, (_, i) => ({ task_id: `task-${i}`, status: 'PASS' + 'x'.repeat(300) })),
  current_task: { task_id: 'current', details: 'z'.repeat(8000) },
};

function reviewTaskCard() {
  return {
    task_id: 't-rev', repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'g', context: 'c', scope: 's', allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
}
function reviewExecReport() {
  return { task_id: 't-rev', repository_context: reviewTaskCard().repository_context, status: 'DONE', changed_files: [], tests_run: [], test_results: [], issues: 'none', next_recommendation: 'proceed' };
}
function hugeEvidence() {
  const failResults = [];
  for (let i = 0; i < 40; i++) failResults.push({ command: `suite-${i}`, pass: false, output: `ERR ${i}\n${'stack line '.repeat(300)}`, exitCode: 1 });
  return { status: 'CHANGED', head: 'h', base: 'b', diff: ('+ line of diff\n'.repeat(6000)), pass: false, results: failResults };
}

test('B0. central assemblers throw the correct context-budget code and never build a model call', () => {
  assert.throws(
    () => assembleSupervisorPrompt({ ...SUP_CONTEXT, checkpoint: HUGE_CHECKPOINT }),
    (e) => e instanceof AdapterError && e.code === ADAPTER_ERROR_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED,
  );
  assert.throws(
    () => assembleReviewerPrompt(reviewTaskCard(), reviewExecReport(), hugeEvidence(), { attempt: 1 }),
    (e) => e instanceof AdapterError && e.code === ADAPTER_ERROR_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED,
  );
  // A normal context passes straight through.
  assert.ok(assembleSupervisorPrompt(SUP_CONTEXT).prompt.length > 0);
});

function spyCall(flag) {
  return async () => { flag.invoked = true; throw new Error('provider call must not be reached'); };
}

for (const [name, makeProvider] of [
  ['agy', (call) => createAgySupervisorProvider({ callAgy: async (...a) => { call(...a); } })],
  ['codex', (call) => createCodexSupervisorProvider({ call })],
  ['claude', (call) => createClaudeSupervisorProvider({ call })],
]) {
  test(`B-supervisor(${name}): oversized context throws SUPERVISOR_CONTEXT_BUDGET_EXCEEDED before any model call`, async () => {
    const flag = { invoked: false };
    const provider = makeProvider(spyCall(flag));
    await assert.rejects(
      () => provider.decide({ ...SUP_CONTEXT, checkpoint: HUGE_CHECKPOINT }, {}),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED);
        return true;
      },
    );
    assert.equal(flag.invoked, false, `${name} supervisor provider must not call the model`);
  });
}

for (const [name, makeProvider] of [
  ['agy', (call) => createAgyReviewerProvider({ callAgy: async (...a) => { call(...a); } })],
  ['codex', (call) => createCodexReviewerProvider({ call })],
  ['claude', (call) => createClaudeReviewerProvider({ call })],
]) {
  test(`B-reviewer(${name}): oversized evidence throws REVIEWER_CONTEXT_BUDGET_EXCEEDED before any model call`, async () => {
    const flag = { invoked: false };
    const provider = makeProvider(spyCall(flag));
    await assert.rejects(
      () => provider.review(reviewTaskCard(), reviewExecReport(), hugeEvidence(), { attempt: 1 }),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED);
        return true;
      },
    );
    assert.equal(flag.invoked, false, `${name} reviewer provider must not call the model`);
  });
}

test('B-classification: context-budget failures are non-retryable (no provider failover)', () => {
  assert.deepEqual(
    providerFailure(new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED, 'x')),
    { code: 'SUPERVISOR_CONTEXT_BUDGET_EXCEEDED' },
  );
  assert.deepEqual(
    providerFailure(new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED, 'x')),
    { code: 'REVIEWER_CONTEXT_BUDGET_EXCEEDED' },
  );
});

// ════════════════════════════════════════════════════════════════════
//  D. Executor loads zero SuperGPT MCP schemas
// ════════════════════════════════════════════════════════════════════

test('D. scoped Executor is spawned with --strict-mcp-config and no --mcp-config', async () => {
  const { createClaudeExecutorAdapter } = await import('../src/orchestrator/adapters/claudeExecutorAdapter.js');

  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    const listeners = {};
    const child = {
      pid: 4242,
      stdout: { on: (ev, cb) => { listeners[`out:${ev}`] = cb; } },
      stderr: { on: (ev, cb) => { listeners[`err:${ev}`] = cb; } },
      stdin: { write() {}, end() {} },
      on: (ev, cb) => { listeners[ev] = cb; },
      kill() {},
    };
    setImmediate(() => {
      listeners['out:data']?.(Buffer.from(JSON.stringify({
        result: [
          '## task_id', 'task-mcp',
          '## repository_context', 'repository_name: r\nrepository_url: none\nbranch: main\ncommit_sha: abc',
          '## status', 'DONE',
          '## changed_files', '- src/x.js',
          '## tests_run', '- `npm test`',
          '## test_results', '- `npm test`: pass — ok',
          '## issues', 'none',
          '## next_recommendation', 'proceed',
        ].join('\n'),
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })));
      listeners['close']?.(0, null);
    });
    return child;
  };

  const adapter = createClaudeExecutorAdapter({ model: 'sonnet', spawn: fakeSpawn });
  await adapter.execute({
    task_id: 'task-mcp',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'g', context: 'c', scope: 's',
    allowed_files: ['src/x.js'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  });

  const args = calls[0].args;
  assert.ok(args.includes('--strict-mcp-config'), 'no SuperGPT MCP server can be inherited');
  assert.ok(!args.includes('--mcp-config'), 'no MCP config is passed, so zero MCP tools load');
  // built-in coding tools + the verification allowlist are untouched
  assert.ok(args.includes('--permission-mode') && args.includes('acceptEdits'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.some((a) => a === 'Bash(npm test)'));
  assert.ok(args.includes('--max-turns') && args.includes('30'));
});

// ════════════════════════════════════════════════════════════════════
//  C-resume. Cumulative cost ceiling survives a process restart
// ════════════════════════════════════════════════════════════════════

import { supergptResume } from '../src/orchestrator/supergpt.js';
import { rehydrateUsageFromState } from '../src/orchestrator/workflowCostGuard.js';

test('C-resume. supergptResume rehydrates the cumulative cost into the tracker handed to the pipeline', async () => {
  const worktreeRoot = path.join(process.env.HOME || process.env.USERPROFILE, '.supergpt', 'worktrees');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(worktreeRoot, { recursive: true });
  const workflowId = `wf-agy-test-resume-cost-${Date.now()}`;
  const cleanup = () => {
    for (const name of readdirSync(worktreeRoot)) {
      if (name === workflowId || name.startsWith(`${workflowId}.`)) {
        rmSync(path.join(worktreeRoot, name), { recursive: true, force: true });
      }
    }
  };
  cleanup();

  // A prior process persisted a $4.00 usage snapshot for this workflow.
  const prior = new UsageTracker();
  [2.5, 1.0, 0.5].forEach((costUsd, i) => prior.record({
    workflowId, role: 'executor', callId: `prior-${i}`, taskId: `t${i}`, attempt: 1, model: 'sonnet',
    usage: { input_tokens: 100, output_tokens: 20, callId: `prior-${i}` }, costUsd,
  }));
  const persistedState = { workflowId, tokenUsage: prior.summary() };

  try {
    writeFileSync(path.join(worktreeRoot, `${workflowId}.workspace.json`), JSON.stringify({
      workflow_id: workflowId,
      source_workspace: process.cwd(),
      source_repo_root: process.cwd(),
      source_branch: 'main',
      baseline_head: 'HEAD',
      isolated_worktree_path: process.cwd(),
      goal: 'resume cost test',
      external_read_roots: [],
    }));

    let seenCost = null;
    const spyPipeline = async (opts) => {
      seenCost = opts.usageTracker?.summary()?.measuredTotal?.costUsd ?? null;
      return { status: 'HUMAN_REQUIRED', reason: 'stop here', question: 'q' };
    };

    const result = await supergptResume({
      workflowId,
      answer: 'go',
      cwd: process.cwd(),
      _pipeline: spyPipeline,
      _readLiveWorkflowState: () => persistedState,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(seenCost, 4.0, 'the pipeline receives a tracker already carrying the $4.00 prior cost');
  } finally {
    cleanup();
  }
});

test('C-resume. rehydrate is a no-op for a non-resume run (fresh $0 aggregate)', () => {
  // A fresh (non-resume) tracker is never pre-loaded.
  const t = new UsageTracker();
  assert.equal(rehydrateUsageFromState(t, undefined), 0);
  assert.equal(t.summary().measuredTotal.costUsd, 0);
});

// ════════════════════════════════════════════════════════════════════
//  C-failclosed. Resume fails CLOSED when prior spend cannot be
//  reconstructed and the cost ceiling is enabled
// ════════════════════════════════════════════════════════════════════

import { assertResumeCostStateReconstructable } from '../src/orchestrator/workflowCostGuard.js';

test('C-failclosed. assertResumeCostStateReconstructable: unit matrix', () => {
  const EN = { ceilingUsd: 5 };
  const OFF = { ceilingUsd: 0 };

  // 1. missing state
  assert.equal(assertResumeCostStateReconstructable(null, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable(undefined, EN).ok, false);
  // 2. unreadable / unparseable -> caller passes null; same as above
  // 3. malformed: not an object
  assert.equal(assertResumeCostStateReconstructable('not json', EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable(42, EN).ok, false);
  // 3b. state object but tokenUsage absent / null / not an object / records not an array
  assert.equal(assertResumeCostStateReconstructable({ workflowId: 'w' }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: null }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: 'x' }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: {} }, EN).ok, false);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: { records: 'no' } }, EN).ok, false);
  // 4. valid: records array (empty === proven zero, or populated)
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: { records: [] } }, EN).ok, true);
  assert.equal(assertResumeCostStateReconstructable({ tokenUsage: { records: [{ callId: 'x', costUsd: 1 }] } }, EN).ok, true);
  // 6. guard disabled -> always ok, flagged inactive (best-effort resume preserved)
  const disabled = assertResumeCostStateReconstructable(null, OFF);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.guardActive, false);
});

async function resumeWithState(readLiveWorkflowStateFn, { workflowStatePresent = true, env } = {}) {
  const worktreeRoot = path.join(process.env.HOME || process.env.USERPROFILE, '.supergpt', 'worktrees');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(worktreeRoot, { recursive: true });
  const workflowId = `wf-agy-test-resume-failclosed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cleanup = () => {
    for (const name of readdirSync(worktreeRoot)) {
      if (name === workflowId || name.startsWith(`${workflowId}.`)) rmSync(path.join(worktreeRoot, name), { recursive: true, force: true });
    }
  };
  cleanup();
  let pipelineCalls = 0;
  try {
    writeFileSync(path.join(worktreeRoot, `${workflowId}.workspace.json`), JSON.stringify({
      workflow_id: workflowId, source_workspace: process.cwd(), source_repo_root: process.cwd(),
      source_branch: 'main', baseline_head: 'HEAD', isolated_worktree_path: process.cwd(),
      goal: 'g', external_read_roots: [],
    }));
    const result = await supergptResume({
      workflowId, cwd: process.cwd(), env,
      _pipeline: async () => { pipelineCalls += 1; return { status: 'WORKFLOW_DONE', summary: 'ran', deliveredFiles: [] }; },
      _readLiveWorkflowState: () => readLiveWorkflowStateFn(workflowId),
    });
    return { result, pipelineCalls, workflowId };
  } finally {
    cleanup();
  }
}

test('C-failclosed. missing persisted state on resume -> BLOCKING WORKFLOW_COST_STATE_UNAVAILABLE, HUMAN_REQUIRED, zero dispatch', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => null);
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(pipelineCalls, 0, 'pipeline (Planner/Supervisor/Executor/Reviewer/closeout) never runs');
  assert.equal(result.blockingSafetyEvent?.code, 'WORKFLOW_COST_STATE_UNAVAILABLE');
  assert.equal(result.blockingSafetyEvent?.severity, 'BLOCKING');
  assert.match(result.reason, /prior spend cannot be reconstructed/i);
  // NOT mislabeled as budget-exceeded
  assert.ok(!/BUDGET_EXCEEDED/.test(result.blockingSafetyEvent.code));
});

test('C-failclosed. corrupt / unreadable persisted state -> same fail-closed, zero dispatch', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => { throw new Error('EIO: unreadable'); });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(pipelineCalls, 0);
  assert.equal(result.blockingSafetyEvent?.code, 'WORKFLOW_COST_STATE_UNAVAILABLE');
});

test('C-failclosed. state present but tokenUsage/records absent -> fail closed, zero dispatch', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => ({ workflowId: 'x', workflowStatus: 'HUMAN_REQUIRED' }));
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(pipelineCalls, 0);
  assert.equal(result.blockingSafetyEvent?.code, 'WORKFLOW_COST_STATE_UNAVAILABLE');

  const malformed = await resumeWithState(() => ({ tokenUsage: { records: 'nope' } }));
  assert.equal(malformed.result.status, 'HUMAN_REQUIRED');
  assert.equal(malformed.pipelineCalls, 0);
});

test('C-failclosed. valid persisted state (records: []) -> resume proceeds normally', async () => {
  const { result, pipelineCalls } = await resumeWithState(() => ({
    workflowId: 'x', tokenUsage: { records: [], measuredTotal: { calls: 0, costUsd: 0 } },
  }));
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(pipelineCalls, 1);
});

test('C-failclosed. all token ceilings disabled -> missing state resumes best-effort', async () => {
  // Disabling only the $ cost ceiling is no longer sufficient: the mechanical
  // usage-volume / Executor-call ceilings default ON and also demand a
  // reconstructable prior state. Every ceiling must be off for best-effort.
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
  assert.equal(pipelineCalls, 1, 'all-disabled ceilings keep the pre-existing best-effort resume behavior');
});

test('C-failclosed. fresh (non-resume) workflow is unaffected by the resume gate', async () => {
  // assertResumeCostStateReconstructable is only consulted on isResume; a
  // fresh run writes its own {records: []} snapshot and never fail-closes.
  const worktreeRoot = path.join(process.env.HOME || process.env.USERPROFILE, '.supergpt', 'worktrees');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(worktreeRoot, { recursive: true });
  const { runSuperGPT } = await import('../src/orchestrator/supergpt.js');
  const workflowId = `wf-agy-test-fresh-nogate-${Date.now()}`;
  const cleanup = () => { for (const name of readdirSync(worktreeRoot)) { if (name === workflowId || name.startsWith(`${workflowId}.`)) rmSync(path.join(worktreeRoot, name), { recursive: true, force: true }); } };
  cleanup();
  let pipelineCalls = 0;
  try {
    const result = await runSuperGPT({
      workflowId, goal: 'fresh run', cwd: process.cwd(), isResume: false, externalReadRoots: [],
      _pipeline: async () => { pipelineCalls += 1; return { status: 'WORKFLOW_DONE', summary: 'ok', deliveredFiles: [] }; },
      _readLiveWorkflowState: () => { throw new Error('resume state must not be consulted for a fresh run'); },
    });
    assert.equal(result.status, 'WORKFLOW_DONE');
    assert.equal(pipelineCalls, 1);
  } finally {
    cleanup();
  }
});
