import test from 'node:test';
import assert from 'node:assert/strict';

import {
  supergptWatch,
  SUPERGPT_WATCH_TIMEOUT_MS,
  WORKFLOW_STATUSES,
  WORKFLOW_STAGES,
} from '../src/orchestrator/supergpt.js';
import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { parsePlannerJson } from '../src/orchestrator/planner.js';

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'task-1',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: null,
      branch: 'main',
      commit_sha: 'abc123',
    },
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function demoExecutionReport(taskId, overrides = {}) {
  return {
    task_id: taskId,
    repository_context: { repository_name: 'gpt-dev-loop', repository_url: null, branch: 'main', commit_sha: 'def456' },
    status: 'DONE',
    changed_files: [],
    tests_run: [],
    test_results: [],
    issues: 'none',
    next_recommendation: 'proceed',
    ...overrides,
  };
}

function passResult(taskId) {
  return { task_id: taskId, decision: 'PASS', findings: 'looks good', required_changes: 'none', rationale: 'all good' };
}

function reworkResult(taskId, rationale = 'not done') {
  return { task_id: taskId, decision: 'REWORK', findings: ['bug found'], required_changes: ['fix the bug'], rationale };
}

function makeFakeReviewerFactory(resultsByTaskId) {
  const created = [];
  function makeReviewerSession() {
    const tabId = 600 + created.length + 1;
    const session = {
      id: created.length + 1,
      tabId,
      taskId: null,
      created: false,
      getIdentity() {
        return { taskId: session.taskId, tabId, conversationId: null };
      },
      async create(taskId) {
        session.taskId = taskId;
        session.created = true;
        return { taskId, tabId, conversationId: null };
      },
      async review(taskId) {
        const queue = resultsByTaskId[taskId];
        if (!queue || queue.length === 0) throw new Error(`fake reviewer: no more queued results for ${taskId}`);
        return queue.shift();
      },
      async close() {
        session.closed = true;
      },
    };
    created.push(session);
    return session;
  }
  makeReviewerSession.created = created;
  return makeReviewerSession;
}

function makeFakeClaudeManagerFactory() {
  const managers = [];
  function createClaudeSessionManager({ taskId }) {
    let sessionCount = 0;
    const executions = [];
    const manager = {
      taskId,
      executions,
      async execute(taskCard) {
        sessionCount += 1;
        executions.push({ sessionNumber: sessionCount, taskCard });
        return demoExecutionReport(taskCard.task_id);
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

function makeFakeGateRunner() {
  return {
    async run() {
      return { pass: true, results: [] };
    },
  };
}

function makeFakeWindowSession() {
  return {
    async create() {
      return { windowId: 100, initialTabId: 999 };
    },
    async activateTab(tabId) {
      return { tabId, windowFocused: false, active: true };
    },
    async listTabs() {
      return [];
    },
    async close() {},
    async closeTab() {},
  };
}

// --- E2E A: Bounded Watch + Progress UI (> 45s) ---
test('E2E A: 真实 watch 超过 45 秒：RUNNING -> RUNNING -> DONE, 全程无 3 分钟 timeout，并实际显示完整 UI', async () => {
  const workflowId = 'wf-e2e-watch-45s';
  const startTime = Date.now();
  let virtualTime = startTime;

  // Workflow state that transitions to DONE after 50 seconds
  const state = {
    workflowId,
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    taskId: 'task-long-running',
    taskName: 'Heavy Verification Task',
    taskIndex: 1,
    taskTotal: 1,
    attempt: 1,
    stageStatuses: { executor: 'running', gate: 'waiting', reviewer: 'waiting' },
    startedAt: new Date(startTime).toISOString(),
    heartbeatAt: new Date(startTime).toISOString(),
    lastProgressAt: new Date(startTime).toISOString(),
    lastActivityAt: new Date(startTime).toISOString(),
  };

  const progressNotifications = [];

  // Watch 1: runs until bounded timeout (45s)
  const watch1 = await supergptWatch({
    workflowId,
    timeoutMs: 45000,
    intervalMs: 1000,
    _readState: () => {
      // simulate 50s total execution: during watch 1 (0-45s), workflow is still RUNNING
      if (virtualTime >= startTime + 50000) {
        state.workflowStatus = WORKFLOW_STATUSES.DONE;
        state.stage = WORKFLOW_STAGES.DONE;
      }
      state.heartbeatAt = new Date(virtualTime).toISOString();
      state.lastProgressAt = new Date(virtualTime).toISOString();
      state.lastActivityAt = new Date(virtualTime).toISOString();
      return state;
    },
    _now: () => virtualTime,
    _sleep: async (ms) => {
      virtualTime += ms;
    },
    onProgress: (p) => progressNotifications.push(p),
  });

  // 1. First watch returned in 45s with status RUNNING
  assert.equal(watch1.status, 'RUNNING');
  assert.equal(watch1.workflowId, workflowId);

  // 2. Full Progress UI format is present
  assert.match(watch1.formattedProgress, /SUPERGPT ⟳ RUNNING/);
  assert.match(watch1.formattedProgress, /Task\s+1 \/ 1 — Heavy Verification Task/);
  assert.match(watch1.formattedProgress, /Attempt\s+1/);
  assert.match(watch1.formattedProgress, /Stage\s+EXECUTOR/);
  assert.match(watch1.formattedProgress, /Planner/);
  assert.match(watch1.formattedProgress, /Supervisor/);
  assert.match(watch1.formattedProgress, /Executor/);
  assert.match(watch1.formattedProgress, /Gate/);
  assert.match(watch1.formattedProgress, /Reviewer/);
  assert.match(watch1.formattedProgress, /Elapsed/);
  assert.match(watch1.formattedProgress, /Heartbeat/);
  assert.match(watch1.formattedProgress, /Last progress/);
  assert.match(watch1.formattedProgress, /Last activity/);

  // Watch 2: continues watch and finishes when workflow reaches DONE at 50s
  const watch2 = await supergptWatch({
    workflowId,
    timeoutMs: 45000,
    intervalMs: 1000,
    _readState: () => {
      if (virtualTime >= startTime + 50000) {
        state.workflowStatus = WORKFLOW_STATUSES.DONE;
        state.stage = WORKFLOW_STAGES.DONE;
      }
      return state;
    },
    _now: () => virtualTime,
    _sleep: async (ms) => {
      virtualTime += ms;
    },
    onProgress: (p) => progressNotifications.push(p),
  });

  assert.equal(watch2.status, 'DONE');
  assert.match(watch2.formattedProgress, /SUPERGPT ⟳ DONE/);
});

// --- E2E B: Planner repo-aware 路径纠错 ---
test('E2E B: Planner 给错 src/orchestrator/claudeExecutorAdapter.js, Core 自动纠正为 src/orchestrator/adapters/claudeExecutorAdapter.js 全程不询问用户', async () => {
  const repoFiles = [
    'package.json',
    'README.md',
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'src/orchestrator/adapters/claudeReviewerProvider.js',
    'src/orchestrator/supergpt.js',
    'tests/claudeExecutorAdapter.test.js',
  ];

  // Planner generates incorrect path without adapters/
  const plannerOutput = {
    status: 'READY',
    summary: 'Update Claude executor adapter resilience',
    plan_text: '1. Fix adapter error handling',
    tasks: [
      {
        task_id: 'adapter-fix',
        goal: 'Improve timeout recovery in Claude executor adapter',
        allowed_files: [
          'src/orchestrator/claudeExecutorAdapter.js',
        ],
        verification_commands: ['node --test tests/claudeExecutorAdapter.test.js'],
      },
    ],
  };

  const parsedPlan = parsePlannerJson(plannerOutput, { repoFiles });

  // Core auto-corrected the path to the real repository file
  assert.equal(
    parsedPlan.tasks[0].allowed_files[0],
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'Core must auto-correct missing directory hierarchy to real existing file'
  );
  assert.equal(parsedPlan.status, 'READY');
  assert.equal(parsedPlan.question, undefined);
});

// --- E2E C: 3 次失败后自动 Supervisor escalation 全程无需用户 ---
test('E2E C: 构造普通实现连续 3 次 REWORK -> 自动 Supervisor -> 新 guidance -> escalation Executor -> Gate PASS -> Reviewer PASS -> DONE (全程无 HUMAN_REQUIRED)', async () => {
  const taskCard = demoTaskCard({
    task_id: 'resilience-refactor',
    goal: 'Refactor resilience layer',
    allowed_files: ['src/orchestrator/adapters/claudeExecutorAdapter.js'],
    verification_commands: ['node --test tests/claudeExecutorAdapter.test.js'],
  });

  let supervisorInvocations = 0;
  let supervisorEscalationReceivedContext = null;

  const supervisorSession = {
    create: async () => ({ tabId: 501, conversationId: null }),
    close: async () => {},
    decide: async (context) => {
      supervisorInvocations++;
      if (!context.latestReviewResult) {
        return { action: 'NEXT_TASK', task_card: taskCard };
      }
      if (context.latestReviewResult.decision === 'PASS') {
        return { action: 'WORKFLOW_DONE', summary: 'all passed' };
      }
      if (!supervisorEscalationReceivedContext && (context.isEscalating || context.normalAttempts >= 3)) {
        supervisorEscalationReceivedContext = {
          ...context,
          attemptHistory: [...context.attemptHistory],
        };
        return {
          action: 'CONTINUE_REWORK',
          guidance: 'Supervisor Guidance: switch strategy to use abort controller with exponential backoff',
          executor_model: 'opus',
        };
      }
      return { action: 'CONTINUE_REWORK' };
    },
  };

  // 3 REWORKs followed by 1 PASS
  const reviewerResults = [
    reworkResult(taskCard.task_id, 'r1: missing exponential backoff'),
    reworkResult(taskCard.task_id, 'r2: still missing exponential backoff'),
    reworkResult(taskCard.task_id, 'r3: non-converged without supervisor strategy change'),
    passResult(taskCard.task_id),
  ];

  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: reviewerResults,
  });

  const claudeManagerFactory = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner(); // Passes Gate each time
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-e2e-c-auto-escalation',
    supervisorSession,
    createReviewerSession,
    createClaudeSessionManager: claudeManagerFactory,
    gateRunner,
    windowSession,
    workflowGoal: 'Refactor resilience layer with robust retry policy',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
    onCheckpoint: (cp) => checkpoints.push(cp),
  });

  // 1. Workflow completed successfully with WORKFLOW_DONE, never stopped with HUMAN_REQUIRED
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(result.question, undefined);

  // 2. Supervisor received the escalation context after 3 normal attempts
  assert.ok(supervisorEscalationReceivedContext !== null, 'Supervisor must be invoked for escalation');
  assert.equal(supervisorEscalationReceivedContext.normalAttempts, 3);
  assert.equal(supervisorEscalationReceivedContext.isEscalating, true);
  assert.ok(Array.isArray(supervisorEscalationReceivedContext.attemptHistory));
  assert.equal(supervisorEscalationReceivedContext.attemptHistory.length, 3);

  // 3. Executor executions: 3 normal + 1 escalation = 4 executions
  const manager = claudeManagerFactory.managers[0];
  assert.equal(manager.executions.length, 4);

  // 4. The 4th execution (escalation attempt) received Supervisor guidance and escalated model
  const escalationExecution = manager.executions[3];
  assert.match(
    escalationExecution.taskCard.supervisor_guidance,
    /Supervisor Guidance: switch strategy to use abort controller with exponential backoff/
  );
  assert.equal(escalationExecution.taskCard.executor_model, 'opus');

  // 5. Final history and checkpoint reflects 4 total attempts and PASS
  assert.deepEqual(result.history, [
    {
      task_id: taskCard.task_id,
      decision: 'PASS',
      attempts: 4,
    },
  ]);

  const lastCp = checkpoints[checkpoints.length - 1];
  assert.equal(lastCp.normalAttempts, 3);
  assert.equal(lastCp.escalationAttempts, 1);
  assert.equal(lastCp.escalationActive, true);
});
