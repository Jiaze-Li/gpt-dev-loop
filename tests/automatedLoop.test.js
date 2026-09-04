import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { buildPrompt, measureExecutorInputBreakdown } from '../src/orchestrator/adapters/claudeExecutorAdapter.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';

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

function reworkResult(taskId) {
  return { task_id: taskId, decision: 'REWORK', findings: 'bug', required_changes: ['fix the bug'], rationale: 'not done' };
}

// Fake SupervisorSession: replies with the next queued decision on every
// decide() call, regardless of what context it was given (tests assert on
// the decision *sequence*, not on prompt content — that's supervisorProtocol.test.js's job).
// Also mirrors the real SupervisorSession's create({windowId}) contract
// (returns { tabId, conversationId }) and exposes getIdentity() so window-
// activation tests can address this session's tab explicitly.
// `windowSession` (optional) is a makeFakeWindowSession()-shaped fake whose
// tabRegistry this supervisor's create()/close() will register/unregister
// itself into — only tests exercising the tab-count invariant pass this;
// every pre-existing test omits it and behaves exactly as before.
function makeFakeSupervisor(decisions, { tabId = 501, windowSession } = {}) {
  const queue = [...decisions];
  const calls = [];
  const createCalls = [];
  let created = false;
  let closed = false;
  return {
    calls,
    createCalls,
    tabId,
    isCreated: () => created,
    isClosed: () => closed,
    getIdentity() {
      return { tabId, conversationId: null };
    },
    async create(opts) {
      created = true;
      createCalls.push(opts);
      if (windowSession) windowSession.tabRegistry.set(tabId, 'chatgpt');
      return { tabId, conversationId: null };
    },
    async decide(context) {
      calls.push(context);
      if (queue.length === 0) throw new Error('fake supervisor: no more queued decisions');
      const next = queue.shift();
      // A queued Error models a transport failure on that decide() call
      // (e.g. a ChatGPT rate limit) — thrown, not returned.
      if (next instanceof Error) throw next;
      return next;
    },
    async close() {
      closed = true;
      if (windowSession) windowSession.tabRegistry.delete(tabId);
    },
  };
}

// Fake ReviewerSession factory: each call to the factory returns a new
// object with its own identity (including a unique tabId), so tests can
// assert "same task -> same object" / "different task -> different object"
// by reference, and "same tab reused across REWORK" / "new task -> new tab"
// by tabId.
//
// `order` (optional) is a shared array every stage-crossing fake in this
// file can push named events onto, so tests can assert cross-object
// ordering (e.g. "claude execute happened before reviewer.create") without
// timing/sleeps — see makeFakeClaudeManagerFactory/makeFakeGateRunner/
// makeFakeWindowSession for the other ends of that same array.
// `windowSession` (optional, third arg) — same tabRegistry-linking contract
// as makeFakeSupervisor above, for the tab-count-invariant tests.
function makeFakeReviewerFactory(resultsByTaskId, order, windowSession) {
  const created = [];
  function makeReviewerSession() {
    const tabId = 600 + created.length + 1;
    const session = {
      id: created.length + 1,
      tabId,
      taskId: null,
      created: false,
      createCalls: [],
      reviewCalls: 0,
      closed: false,
      getIdentity() {
        return { taskId: session.taskId, tabId, conversationId: null };
      },
      async create(taskId, opts) {
        session.taskId = taskId;
        session.created = true;
        session.createCalls.push(opts);
        if (order) order.push(`reviewer.create:${taskId}`);
        if (windowSession) windowSession.tabRegistry.set(tabId, 'chatgpt');
        return { taskId, tabId, conversationId: null };
      },
      reviewOpts: [],
      async review(taskId, taskCard, executionReport, evidence, opts = {}) {
        assert.equal(taskId, session.taskId, 'review() called with a taskId this session was not create()d for');
        assert.equal(session.created, true, 'review() called before create()');
        session.reviewCalls += 1;
        session.reviewOpts.push(opts);
        if (order) order.push(`reviewer.review:${taskId}`);
        const queue = resultsByTaskId[taskId];
        if (!queue || queue.length === 0) throw new Error(`fake reviewer: no more queued results for ${taskId}`);
        const next = queue.shift();
        // A queued Error models a transport failure on that review() call
        // (e.g. a ChatGPT rate limit) — thrown, not returned.
        if (next instanceof Error) throw next;
        return next;
      },
      async close() {
        session.closed = true;
        if (windowSession) windowSession.tabRegistry.delete(tabId);
      },
    };
    created.push(session);
    return session;
  }
  makeReviewerSession.created = created;
  return makeReviewerSession;
}

// Fake ClaudeSessionManager factory: each execute() call is tracked with a
// unique incrementing sessionNumber, mirroring the real
// ClaudeSessionManager's "fresh session per execute() call" contract.
// `onExecute`, if given, runs before the fake resolves — used by the
// failure-cleanup test to throw mid-attempt.
function makeFakeClaudeManagerFactory(order, onExecute) {
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
        if (order) order.push(`claude.execute:${taskCard.task_id}`);
        if (onExecute) await onExecute(taskCard, sessionCount);
        return demoExecutionReport(taskCard.task_id);
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

function makeFakeGateRunner(order) {
  const runs = [];
  return {
    runs,
    async run(verificationCommands) {
      runs.push(verificationCommands);
      if (order) order.push('gate.run');
      return { pass: true, results: [] };
    },
  };
}

function makeFakePersistence() {
  const writes = [];
  const acceptanceChains = {};
  return {
    writes,
    acceptanceChains,
    async writeState(state) {
      writes.push(state);
    },
    async writeAcceptanceChain(_workflowId, chain, taskId) {
      acceptanceChains[taskId ?? '_'] = chain;
      return chain;
    },
    async readAcceptanceChain(_workflowId, taskId) {
      return acceptanceChains[taskId ?? '_'] ?? null;
    },
  };
}

// Fake windowSession: the dedicated-automation-window dependency
// automatedLoop.js now requires. Records every create()/activateTab()/
// close() call so tests can assert ordering and addressing (never a global
// "current active tab", always an explicit tabId this loop already knows
// about). `focusOverride` lets a test force a single activateTab() call to
// report windowFocused:true, to prove the loop aborts rather than
// proceeding when the automation-window invariant is violated.
// `initialTabId` (default 999) simulates the placeholder tab chrome.windows.
// create() always creates as a side effect of opening the window at all
// (see automatedLoop.js's module doc comment on the 3-tab placeholder
// finding, 2026-08-27). `tabRegistry` is a live Map<tabId, urlState> other
// fakes (makeFakeSupervisor/makeFakeReviewerFactory) register/unregister
// themselves into when given this windowSession, so listTabs() reports a
// realistic snapshot of what's actually open in the window at each stage —
// exactly what the real extension-backed listTabs would see.
function makeFakeWindowSession(order, { windowId = 900, focusOverride, initialTabId = 999 } = {}) {
  const activations = [];
  const closedTabIds = [];
  const listTabsCalls = [];
  const tabRegistry = new Map();
  let created = false;
  let closedWindowId = null;
  return {
    windowId,
    activations,
    closedTabIds,
    listTabsCalls,
    tabRegistry,
    isCreated: () => created,
    closedWindowId: () => closedWindowId,
    async create() {
      created = true;
      if (order) order.push('window.create');
      tabRegistry.set(initialTabId, 'chatgpt');
      return { windowId, initialTabId };
    },
    async activateTab(tabId) {
      activations.push(tabId);
      if (order) order.push(`window.activateTab:${tabId}`);
      const windowFocused = focusOverride && focusOverride.tabId === tabId && activations.filter((t) => t === tabId).length === focusOverride.onCall ? true : false;
      return { tabId, active: true, windowId, windowFocused };
    },
    async closeTab(tabId) {
      closedTabIds.push(tabId);
      tabRegistry.delete(tabId);
      if (order) order.push(`window.closeTab:${tabId}`);
    },
    async listTabs(id) {
      listTabsCalls.push(id);
      if (order) order.push(`window.listTabs:${id}`);
      return [...tabRegistry.entries()].map(([tabId, urlState]) => ({
        windowId: id,
        tabId,
        active: false,
        status: 'complete',
        urlState,
        openerTabId: null,
      }));
    },
    async close(id) {
      closedWindowId = id;
      if (order) order.push(`window.close:${id}`);
    },
  };
}

test('1. NEXT_TASK -> Claude -> Reviewer PASS -> Supervisor WORKFLOW_DONE', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(result.summary, 'all done');
  assert.equal(supervisor.isCreated(), true);
  assert.equal(supervisor.isClosed(), true);
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].closed, true);
  assert.equal(createClaudeSessionManager.managers.length, 1);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.deepEqual(result.history, [{ task_id: taskCard.task_id, decision: 'PASS', attempts: 1 }]);
});

test('2. REWORK -> CONTINUE_REWORK -> fresh Claude #2 -> SAME ReviewerSession -> PASS', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done after rework' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-2',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  // Only one ReviewerSession was ever created for this one task.
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].reviewCalls, 2);
  // Only one ClaudeSessionManager was created for this task, but it ran
  // execute() twice — each one a fresh Claude session per its own contract.
  assert.equal(createClaudeSessionManager.managers.length, 1);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 2);
  assert.deepEqual(
    createClaudeSessionManager.managers[0].executions.map((e) => e.sessionNumber),
    [1, 2]
  );
  // Rework feedback was persisted before the second attempt.
  assert.equal(persistence.writes.length, 1);
  assert.equal(persistence.writes[0].task_id, taskCard.task_id);
  assert.match(persistence.writes[0].last_error, /fix the bug/);
});

test('3. PASS -> Supervisor NEXT_TASK -> new task uses a NEW ReviewerSession', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    'task-a': [passResult('task-a')],
    'task-b': [passResult('task-b')],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-3',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(createReviewerSession.created.length, 2);
  assert.notEqual(createReviewerSession.created[0], createReviewerSession.created[1]);
  assert.equal(createReviewerSession.created[0].taskId, 'task-a');
  assert.equal(createReviewerSession.created[1].taskId, 'task-b');
  assert.equal(createReviewerSession.created[0].closed, true);
  assert.equal(createReviewerSession.created[1].closed, true);
  assert.equal(createClaudeSessionManager.managers.length, 2);
});

test('4. same task REWORK reuses the SAME ReviewerSession (three rounds)', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-4',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 5,
  });

  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].reviewCalls, 3);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 3);
});

test('5. every Claude attempt for a task is a fresh execute() call, numbered in order', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-5',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 5,
  });

  const executions = createClaudeSessionManager.managers[0].executions;
  assert.deepEqual(
    executions.map((e) => e.sessionNumber),
    [1, 2, 3]
  );
});

test('6. HUMAN_REQUIRED stops immediately and does not close either session or the automation window', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'which behavior is correct?' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [reworkResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-6',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.reason, 'ambiguous spec');
  assert.equal(result.question, 'which behavior is correct?');
  assert.equal(supervisor.isClosed(), false);
  assert.equal(createReviewerSession.created[0].closed, false);
  assert.equal(windowSession.closedWindowId(), null);
  // No further Claude/GPT calls were made after HUMAN_REQUIRED.
  assert.equal(supervisor.calls.length, 2);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
});

test('7. Reviewer REWORK but Supervisor illegally returns NEXT_TASK -> rejected', async () => {
  const taskCard = demoTaskCard();
  const otherTask = demoTaskCard({ task_id: 'task-2' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'NEXT_TASK', task_card: otherTask }, // illegal: latest review was REWORK
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [reworkResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-7',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
        windowSession,
        persistence,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION);
      return true;
    }
  );
  // The illegal NEXT_TASK was never acted on: no second ReviewerSession was created.
  assert.equal(createReviewerSession.created.length, 1);
  // Error-path cleanup still ran: the automation window was closed.
  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
});

test('8. Reviewer PASS but Supervisor illegally returns CONTINUE_REWORK -> rejected', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' }, // illegal: latest review was PASS
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-8',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION);
      return true;
    }
  );
  // No second Claude execution happened off the back of the illegal CONTINUE_REWORK.
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
});

test('9. maxAttemptsPerTask and maxEscalationAttempts stop an infinite CONTINUE_REWORK loop with HUMAN_REQUIRED', async () => {
  const taskCard = demoTaskCard();
  // Supervisor is willing to CONTINUE_REWORK forever; the loop's own guard must stop it.
  const decisions = [{ action: 'NEXT_TASK', task_card: taskCard }];
  for (let i = 0; i < 10; i += 1) decisions.push({ action: 'CONTINUE_REWORK' });
  const supervisor = makeFakeSupervisor(decisions);

  const reworkQueue = [];
  for (let i = 0; i < 10; i += 1) reworkQueue.push(reworkResult(taskCard.task_id));
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-9',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /exhausted escalation attempts/);
  assert.equal(result.taskId, taskCard.task_id);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 5);
  // Same "preserve state to continue later" contract as direct HUMAN_REQUIRED.
  assert.equal(windowSession.closedWindowId(), null);
});


test('10. Reviewer tab closes when a task ends, but its ChatGPT conversation is never deleted', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-10',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  const session = createReviewerSession.created[0];
  assert.equal(session.closed, true); // tab closed
  // The fake's close() never calls anything conversation-deletion-shaped —
  // this loop only ever calls session.close(), never a delete primitive.
  // (ReviewerSession.close() itself is proven elsewhere — reviewerSession.test.js
  // — to send a plain tab-close request, not the ChatGPT delete-conversation flow.)
});

// --- Lazy Reviewer tab/conversation creation (live E2E finding, 2026-08-27) -

test('11. first attempt: claude execute and gate both happen before reviewer.create, which is immediately followed by review', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] }, order);
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-11',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  const reviewerTabId = createReviewerSession.created[0].tabId;
  assert.deepEqual(
    order.filter((e) => !e.startsWith('window.')),
    [`claude.execute:${taskCard.task_id}`, 'gate.run', `reviewer.create:${taskCard.task_id}`, `reviewer.review:${taskCard.task_id}`]
  );
  // The reviewer tab was activated right before review(), not before create().
  const createIdx = order.indexOf(`reviewer.create:${taskCard.task_id}`);
  const activateIdx = order.indexOf(`window.activateTab:${reviewerTabId}`);
  const reviewIdx = order.indexOf(`reviewer.review:${taskCard.task_id}`);
  assert.ok(createIdx < activateIdx && activateIdx < reviewIdx, 'expected create -> activate -> review ordering');
});

test('12. REWORK round does not call reviewer.create again — only review()', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done after rework' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)] },
    order
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-12',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  const createEvents = order.filter((e) => e.startsWith('reviewer.create:'));
  assert.equal(createEvents.length, 1, 'reviewer.create must happen exactly once across both attempts');
  assert.deepEqual(
    order.filter((e) => !e.startsWith('window.')),
    [
      `claude.execute:${taskCard.task_id}`,
      'gate.run',
      `reviewer.create:${taskCard.task_id}`,
      `reviewer.review:${taskCard.task_id}`,
      `claude.execute:${taskCard.task_id}`,
      'gate.run',
      `reviewer.review:${taskCard.task_id}`,
    ]
  );
});

test('13. a subsequent NEXT_TASK creates a new Reviewer exactly once, deferred past its own first claude/gate round', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { 'task-a': [passResult('task-a')], 'task-b': [passResult('task-b')] },
    order
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-13',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  assert.equal(createReviewerSession.created.length, 2);
  const createEvents = order.filter((e) => e.startsWith('reviewer.create:'));
  assert.deepEqual(createEvents, ['reviewer.create:task-a', 'reviewer.create:task-b']);
  assert.deepEqual(
    order.filter((e) => !e.startsWith('window.')),
    [
      'claude.execute:task-a',
      'gate.run',
      'reviewer.create:task-a',
      'reviewer.review:task-a',
      'claude.execute:task-b',
      'gate.run',
      'reviewer.create:task-b',
      'reviewer.review:task-b',
    ]
  );
});

test('14. maxAttemptsPerTask tripping before any review() never opens a Reviewer tab (no leaked tab on early HUMAN_REQUIRED)', async () => {
  const taskCard = demoTaskCard();
  const decisions = [{ action: 'NEXT_TASK', task_card: taskCard }];
  for (let i = 0; i < 5; i += 1) decisions.push({ action: 'CONTINUE_REWORK' });
  const supervisor = makeFakeSupervisor(decisions);
  const createReviewerSession = makeFakeReviewerFactory({});
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-14',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 0,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  // maxAttemptsPerTask=0 trips before the first claude execute/gate/review —
  // the ReviewerSession object may have been instantiated at NEXT_TASK, but
  // its create() (the call that actually opens a background tab) must
  // never have been invoked.
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].created, false);
});

// --- Lightweight stage logging ---------------------------------------------

test('15. logs every stage without leaking prompt/reply content', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'a secret summary that must not leak into logs' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();
  const lines = [];

  await runAutomatedWorkflow({
    workflowId: 'wf-15',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    log: (line) => lines.push(line),
  });

  const stageOf = (re) => lines.some((l) => re.test(l));
  assert.ok(stageOf(/^task selected:/), 'missing "task selected" stage log');
  assert.ok(stageOf(/^claude attempt started:/), 'missing "claude attempt started" stage log');
  assert.ok(stageOf(/^claude attempt completed:/), 'missing "claude attempt completed" stage log');
  assert.ok(stageOf(/^gate started:/), 'missing "gate started" stage log');
  assert.ok(stageOf(/^gate completed:/), 'missing "gate completed" stage log');
  assert.ok(stageOf(/^reviewer created:/), 'missing "reviewer created" stage log');
  assert.ok(stageOf(/^review started:/), 'missing "review started" stage log');
  assert.ok(stageOf(/^review completed:/), 'missing "review completed" stage log');
  assert.ok(stageOf(/^supervisor decision:/), 'missing "supervisor decision" stage log');
  assert.ok(stageOf(/^automation window created:/), 'missing "automation window created" stage log');

  // reviewer created" must log exactly once (lazy creation, once per task).
  assert.equal(lines.filter((l) => l.startsWith('reviewer created:')).length, 1);

  // No log line ever carries prompt/reply free text — reviewer findings,
  // rationale, or the Supervisor's WORKFLOW_DONE summary.
  for (const line of lines) {
    assert.doesNotMatch(line, /secret summary/);
    assert.doesNotMatch(line, /fix the bug/); // reworkResult's required_changes text
    assert.doesNotMatch(line, /looks good|not done/); // findings/rationale text
  }
});

// --- Dedicated background automation window integration --------------------

test('16. exactly one automation window is created for the whole workflow, across multiple tasks and rework rounds', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'CONTINUE_REWORK' },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    'task-a': [reworkResult('task-a'), passResult('task-a')],
    'task-b': [passResult('task-b')],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const order = [];
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-16',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  assert.equal(order.filter((e) => e === 'window.create').length, 1);
});

test('17. Supervisor and every Reviewer tab are created inside the SAME automation window', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    'task-a': [passResult('task-a')],
    'task-b': [passResult('task-b')],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-17',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  assert.equal(supervisor.createCalls.length, 1);
  assert.equal(supervisor.createCalls[0].windowId, windowSession.windowId);
  assert.equal(createReviewerSession.created.length, 2);
  for (const session of createReviewerSession.created) {
    assert.equal(session.createCalls.length, 1);
    assert.equal(session.createCalls[0].windowId, windowSession.windowId);
  }
});

test('18. the Supervisor tab is activated inside the automation window before every single decide() call', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)] },
    order
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession(order);

  const originalDecide = supervisor.decide.bind(supervisor);
  supervisor.decide = async (context) => {
    order.push('supervisor.decide');
    return originalDecide(context);
  };

  await runAutomatedWorkflow({
    workflowId: 'wf-18',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  const decideCount = order.filter((e) => e === 'supervisor.decide').length;
  assert.equal(decideCount, 3);
  const decideIdxs = order.reduce((acc, e, i) => (e === 'supervisor.decide' ? [...acc, i] : acc), []);
  for (const idx of decideIdxs) {
    assert.equal(order[idx - 1], `window.activateTab:${supervisor.tabId}`, `expected an activation of the supervisor tab immediately before decide() at index ${idx}`);
  }
});

test('19. the Reviewer tab is activated inside the automation window before every single review() call', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)] },
    order
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-19',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  const reviewerTabId = createReviewerSession.created[0].tabId;
  const reviewIdxs = order.reduce((acc, e, i) => (e === `reviewer.review:${taskCard.task_id}` ? [...acc, i] : acc), []);
  assert.equal(reviewIdxs.length, 2);
  for (const idx of reviewIdxs) {
    assert.equal(order[idx - 1], `window.activateTab:${reviewerTabId}`, `expected an activation of the reviewer tab immediately before review() at index ${idx}`);
  }
});

test('20. an activation reporting the automation window became focused aborts the workflow instead of proceeding', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  // The very first activation (the Supervisor tab, before the first decide()) reports focused=true.
  const windowSession = makeFakeWindowSession(undefined, { focusOverride: { tabId: 501, onCall: 1 } });

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-20',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    /focused/
  );
  // The Supervisor never even got asked for a decision.
  assert.equal(supervisor.calls.length, 0);
  // Error-path cleanup still closed the automation window.
  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
});

test('21. same-task REWORK activates the SAME Reviewer tab on every round — never opens a second tab', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-21',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 5,
  });

  assert.equal(createReviewerSession.created.length, 1);
  const reviewerTabId = createReviewerSession.created[0].tabId;
  const reviewerActivations = windowSession.activations.filter((t) => t === reviewerTabId);
  assert.equal(reviewerActivations.length, 3); // once per review() round
});

test('22. NEXT_TASK closes the previous task\'s Reviewer tab and opens a new one, in the same automation window', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { 'task-a': [passResult('task-a')], 'task-b': [passResult('task-b')] },
    order
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const windowSession = makeFakeWindowSession(order);

  await runAutomatedWorkflow({
    workflowId: 'wf-22',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  const [sessionA, sessionB] = createReviewerSession.created;
  assert.notEqual(sessionA.tabId, sessionB.tabId);
  assert.equal(sessionA.closed, true);
  assert.equal(sessionA.createCalls[0].windowId, windowSession.windowId);
  assert.equal(sessionB.createCalls[0].windowId, windowSession.windowId);
});

test('23. WORKFLOW_DONE closes the Reviewer tab, the Supervisor session, and the automation window, in that order', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const order = [];
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] }, order);
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(order);
  const gateRunner = makeFakeGateRunner(order);
  const windowSession = makeFakeWindowSession(order);

  const originalClose = () => {};
  await runAutomatedWorkflow({
    workflowId: 'wf-23',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
  assert.equal(createReviewerSession.created[0].closed, true);
  assert.equal(supervisor.isClosed(), true);
  const closeWindowIdx = order.indexOf(`window.close:${windowSession.windowId}`);
  assert.notEqual(closeWindowIdx, -1);
  assert.equal(closeWindowIdx, order.length - 1, 'automation window must be closed last');
});

test('24. an unexpected failure mid-attempt still closes the Reviewer tab, the Supervisor session, and the automation window', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const boom = new Error('gate runner exploded unexpectedly');
  const failingGateRunner = {
    async run() {
      throw boom;
    },
  };
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-24',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner: failingGateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    (err) => err === boom
  );

  assert.equal(supervisor.isClosed(), true);
  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
  // The ReviewerSession object was instantiated at NEXT_TASK but never
  // actually create()'d a tab (the throw happened before that point) — the
  // best-effort cleanup calling close() on it anyway must not itself throw.
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].created, false);
  assert.equal(createReviewerSession.created[0].closed, true);
});

test('26. keepOpenOnFailure:true preserves the Reviewer tab, Supervisor session, and automation window on an unexpected failure instead of closing them', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const windowSession = makeFakeWindowSession();
  const boom = new Error('gate runner exploded unexpectedly');
  const failingGateRunner = {
    async run() {
      throw boom;
    },
  };
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const lines = [];

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-26',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner: failingGateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
        keepOpenOnFailure: true,
        log: (line) => lines.push(line),
      }),
    (err) => err === boom
  );

  // Unlike test 24 (the same failure without the flag), nothing gets closed.
  assert.equal(supervisor.isClosed(), false);
  assert.equal(windowSession.closedWindowId(), null);
  assert.equal(createReviewerSession.created[0].closed, false);

  assert.ok(
    lines.some((l) => l.includes('keep-open-on-failure') && l.includes(`windowId=${windowSession.windowId}`)),
    'must log the preserved windowId when keep-open-on-failure is set'
  );
});

test('27. keepOpenOnFailure default (false) is unaffected — an unexpected failure still closes everything exactly as before', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const windowSession = makeFakeWindowSession();
  const boom = new Error('gate runner exploded unexpectedly');
  const failingGateRunner = {
    async run() {
      throw boom;
    },
  };
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-27',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner: failingGateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    (err) => err === boom
  );

  assert.equal(supervisor.isClosed(), true);
  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
  assert.equal(createReviewerSession.created[0].closed, true);
});

test('28. keepOpenOnSuccess:true preserves the Reviewer tab, Supervisor session, and automation window on WORKFLOW_DONE instead of closing them', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const lines = [];

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-28',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    keepOpenOnSuccess: true,
    log: (line) => lines.push(line),
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(supervisor.isClosed(), false);
  assert.equal(windowSession.closedWindowId(), null);
  assert.equal(createReviewerSession.created[0].closed, false);
  assert.ok(
    lines.some((l) => l.includes('--keep-open') && l.includes(`windowId=${windowSession.windowId}`)),
    'must log the preserved windowId when keep-open is set'
  );
});

test('29. keepOpenOnSuccess default (false) is unaffected — WORKFLOW_DONE still closes everything exactly as before', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-29',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(supervisor.isClosed(), true);
  assert.equal(windowSession.closedWindowId(), windowSession.windowId);
  assert.equal(createReviewerSession.created[0].closed, true);
});

test('30. HUMAN_REQUIRED still preserves everything under its own existing resume contract, regardless of keepOpenOnFailure/keepOpenOnSuccess', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'HUMAN_REQUIRED', reason: 'need a human', question: 'what now?' }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-30',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    keepOpenOnFailure: true,
    keepOpenOnSuccess: true,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(supervisor.isClosed(), false);
  assert.equal(windowSession.closedWindowId(), null);
});

// --- Automation window tab-count invariant (diagnostic finding, 2026-08-27) -

test('31. the automation window\'s initial placeholder tab is closed once the real Supervisor tab is up — exactly 1 working tab after Supervisor creation', async () => {
  const taskCard = demoTaskCard();
  const windowSession = makeFakeWindowSession(undefined, { initialTabId: 999 });
  const supervisor = makeFakeSupervisor([{ action: 'WORKFLOW_DONE', summary: 'done' }], { tabId: 501, windowSession });
  const createReviewerSession = makeFakeReviewerFactory({}, undefined, windowSession);
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();

  await runAutomatedWorkflow({
    workflowId: 'wf-31',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    keepOpenOnSuccess: true, // so the window's tabs aren't torn down before we can inspect them
  });

  // The initial placeholder tab (999) was explicitly closed...
  assert.deepEqual(windowSession.closedTabIds, [999]);
  // ...leaving exactly the Supervisor tab (501) as the window's one working tab.
  assert.deepEqual([...windowSession.tabRegistry.keys()], [501]);
});

test('32. while a Reviewer tab is open there are exactly 2 working tabs; after it closes (NEXT_TASK), exactly 1 remains', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const windowSession = makeFakeWindowSession(undefined, { initialTabId: 999 });
  const supervisor = makeFakeSupervisor(
    [
      { action: 'NEXT_TASK', task_card: taskA },
      { action: 'NEXT_TASK', task_card: taskB },
      { action: 'WORKFLOW_DONE', summary: 'both done' },
    ],
    { tabId: 501, windowSession }
  );
  const tabCountsAfterEachReviewerCreate = [];
  const createReviewerSession = makeFakeReviewerFactory(
    { 'task-a': [passResult('task-a')], 'task-b': [passResult('task-b')] },
    undefined,
    windowSession
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();

  // Snapshot the working-tab count every time a Reviewer tab is created, by
  // wrapping listTabs (automatedLoop.js calls it right after each
  // reviewer-create stage).
  const originalListTabs = windowSession.listTabs.bind(windowSession);
  windowSession.listTabs = async (id) => {
    const tabs = await originalListTabs(id);
    tabCountsAfterEachReviewerCreate.push(tabs.length);
    return tabs;
  };

  await runAutomatedWorkflow({
    workflowId: 'wf-32',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  // Stages logged per task: after-window-create, a fail-closed listTabs
  // check right after the placeholder close (see automatedLoop.js's
  // placeholder-cleanup verification), after-supervisor-create,
  // after-reviewer-create(task-a), after-reviewer-create(task-b) = 5 calls.
  assert.equal(tabCountsAfterEachReviewerCreate.length, 5);
  const [afterWindowCreate, afterPlaceholderClose, afterSupervisorCreate, afterReviewerCreateA, afterReviewerCreateB] = tabCountsAfterEachReviewerCreate;
  assert.equal(afterWindowCreate, 1); // just the placeholder, not yet closed
  assert.equal(afterPlaceholderClose, 1); // placeholder verified gone; Supervisor tab (already registered by create()) remains
  assert.equal(afterSupervisorCreate, 1); // placeholder closed, Supervisor tab open
  assert.equal(afterReviewerCreateA, 2); // Supervisor + Reviewer(task-a)
  // task-a's Reviewer tab was closed (NEXT_TASK) before task-b's was created.
  assert.equal(afterReviewerCreateB, 2); // Supervisor + Reviewer(task-b)

  // After the whole workflow (WORKFLOW_DONE closes everything), nothing remains.
  assert.deepEqual([...windowSession.tabRegistry.keys()], []);
});

test('33. stage diagnostics log tab snapshots at after-window-create/after-supervisor-create/after-reviewer-create, carrying only safe metadata', async () => {
  const taskCard = demoTaskCard();
  const windowSession = makeFakeWindowSession(undefined, { initialTabId: 999 });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'a secret summary that must not leak' },
  ], { tabId: 501, windowSession });
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] }, undefined, windowSession);
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const lines = [];

  await runAutomatedWorkflow({
    workflowId: 'wf-33',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    log: (line) => lines.push(line),
  });

  const stageLine = (stage) => lines.find((l) => l.startsWith(`automation window tabs: ${stage}:`));
  const afterWindowCreate = stageLine('after-window-create');
  const afterSupervisorCreate = stageLine('after-supervisor-create');
  const afterReviewerCreate = stageLine('after-reviewer-create');
  assert.ok(afterWindowCreate, 'missing "after-window-create" tab-diagnostic stage log');
  assert.ok(afterSupervisorCreate, 'missing "after-supervisor-create" tab-diagnostic stage log');
  assert.ok(afterReviewerCreate, 'missing "after-reviewer-create" tab-diagnostic stage log');

  for (const line of [afterWindowCreate, afterSupervisorCreate, afterReviewerCreate]) {
    const jsonStart = line.indexOf('[');
    const tabs = JSON.parse(line.slice(jsonStart));
    for (const tab of tabs) {
      assert.deepEqual(Object.keys(tab).sort(), ['active', 'openerTabId', 'status', 'tabId', 'urlState', 'windowId'].sort());
    }
  }

  assert.equal(JSON.parse(afterWindowCreate.slice(afterWindowCreate.indexOf('['))).length, 1);
  assert.equal(JSON.parse(afterSupervisorCreate.slice(afterSupervisorCreate.indexOf('['))).length, 1);
  assert.equal(JSON.parse(afterReviewerCreate.slice(afterReviewerCreate.indexOf('['))).length, 2);

  for (const line of lines) {
    assert.doesNotMatch(line, /secret summary/);
  }
});

test('25. every window activation addresses a tabId this loop actually knows about — never a bare/global "current tab"', async () => {
  const taskA = demoTaskCard({ task_id: 'task-a' });
  const taskB = demoTaskCard({ task_id: 'task-b' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskA },
    { action: 'CONTINUE_REWORK' },
    { action: 'NEXT_TASK', task_card: taskB },
    { action: 'WORKFLOW_DONE', summary: 'both done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    'task-a': [reworkResult('task-a'), passResult('task-a')],
    'task-b': [passResult('task-b')],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  await runAutomatedWorkflow({
    workflowId: 'wf-25',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship both',
    repositoryContext: taskA.repository_context,
  });

  const knownTabIds = new Set([supervisor.tabId, ...createReviewerSession.created.map((s) => s.tabId)]);
  for (const tabId of windowSession.activations) {
    assert.ok(knownTabIds.has(tabId), `activateTab(${tabId}) addressed a tab this loop never created`);
  }
});

test('34. fails closed instead of continuing when the placeholder tab is still present right after closeTab() reports success', async () => {
  // Models the 2026-08-27 live finding: the extension-side response for
  // windowCreate silently dropped initialTabId (and windowListTabs silently
  // dropped tabs) on the wire, so closeTab() could appear to succeed while
  // the placeholder tab was never actually identified/removed. This proves
  // the loop refuses to proceed rather than silently running with an
  // unexpected extra tab, per requirement A4.
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  // closeTab() resolves normally but never actually removes the tab from
  // the registry — the observable shape of the live bug.
  windowSession.closeTab = async () => {};

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-34',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
        windowSession,
        workflowGoal: 'ship it',
        repositoryContext: taskCard.repository_context,
      }),
    (err) => err.message.includes('still present after close()')
  );
});

// --- Bounded rate-limit recovery (2026-08-27) --------------------------
//
// A ChatGPT "making requests too quickly" throttle during a Reviewer review
// (or a Supervisor decision) is not a task/review/gate/send failure: only
// the throttled GPT request is retried, after a bounded conservative
// cooldown. Claude, the deterministic gate, the task attempt counter, the
// ReviewerSession/conversation and the Supervisor session are all left
// exactly as they were.

function rlError(where = 'looking for the composer') {
  const err = new Error(`ChatGPT reported "making requests too quickly" while ${where}.`);
  err.name = 'RateLimitedError';
  err.code = 'RATE_LIMITED';
  return err;
}

// Deterministic recovery config for tests: tiny fixed cooldown, no jitter,
// no real wait.
function fakeRecovery() {
  const sleeps = [];
  return {
    sleeps,
    rateLimitRecovery: {
      maxRetries: 2,
      cooldownMs: 1000,
      cooldownJitterMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}

test('rate-limit: Reviewer throttle before send -> cooldown -> SAME review retried -> recovery succeeds', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done after a rate-limit hiccup' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [rlError(), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const logs = [];
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
    log: (l) => logs.push(l),
  });

  assert.equal(result.status, 'WORKFLOW_DONE');

  const session = createReviewerSession.created[0];
  // Same ReviewerSession reused — never a new conversation.
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(session.reviewCalls, 2);
  // The retry reused the attempt (same review, not a new attempt).
  assert.deepEqual(session.reviewOpts, [{ reuseAttempt: false }, { reuseAttempt: true }]);
  // Claude did NOT rerun, the gate did NOT rerun.
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(gateRunner.runs.length, 1);
  // Exactly one bounded cooldown happened, at the configured duration.
  assert.deepEqual(rec.sleeps, [1000]);
  // Required log lines (no prompt/reply content).
  assert.ok(logs.includes('review rate limited: task=task-1 attempt=1 retry=1'), logs.join('\n'));
  assert.ok(logs.includes('rate-limit cooldown started'));
  assert.ok(logs.includes('rate-limit cooldown completed'));
  assert.ok(logs.includes('review retry started'));
  // The retry reactivated the SAME reviewer tab before resending.
  const reviewerTabId = session.tabId;
  assert.ok(
    windowSession.activations.filter((t) => t === reviewerTabId).length >= 2,
    'reviewer tab must be reactivated for the retry'
  );
});

test('rate-limit: repeated Reviewer throttle exhausts the retry budget -> resumable HUMAN_REQUIRED, nothing closed/rerun', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [rlError(), rlError(), rlError()],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const logs = [];
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-2',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
    log: (l) => logs.push(l),
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.taskId, 'task-1');
  assert.match(result.reason, /rate-limited/i);
  assert.match(result.reason, /budget is exhausted/i);
  // Bounded: initial + exactly maxRetries(2) retries, then stop.
  assert.equal(createReviewerSession.created[0].reviewCalls, 3);
  assert.deepEqual(rec.sleeps, [1000, 2000]);
  // No attempt increment, no Claude/gate rerun.
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(gateRunner.runs.length, 1);
  // Resumable: nothing was torn down.
  assert.equal(supervisor.isClosed(), false);
  assert.equal(createReviewerSession.created[0].closed, false);
  assert.equal(windowSession.closedWindowId(), null);
});

test('rate-limit: a throttle that may have landed AFTER send is not blindly duplicated', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [rlError('waiting for a reply'), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-3',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /may already have been submitted/i);
  // Never retried — exactly one review() call, no cooldown.
  assert.equal(createReviewerSession.created[0].reviewCalls, 1);
  assert.deepEqual(rec.sleeps, []);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(gateRunner.runs.length, 1);
});

test('rate-limit: RATE_LIMITED stays distinct from a Reviewer REWORK verdict', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done after real rework' },
  ]);
  // attempt 1: throttle then a genuine REWORK; attempt 2: PASS.
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [rlError(), reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-4',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  // The throttle was absorbed by a retry; only the REAL REWORK drove a
  // second Claude attempt + a rework-feedback persist.
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 2);
  assert.equal(persistence.writes.length, 1);
  assert.match(persistence.writes[0].last_error, /fix the bug/);
  assert.equal(createReviewerSession.created[0].reviewCalls, 3);
  // attempt-1 retry reused the attempt; attempt-2 is a fresh attempt.
  assert.deepEqual(createReviewerSession.created[0].reviewOpts, [
    { reuseAttempt: false },
    { reuseAttempt: true },
    { reuseAttempt: false },
  ]);
});

test('rate-limit: normal REWORK path is unchanged when no throttle occurs', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkResult(taskCard.task_id), passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-5',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(rec.sleeps, []);
  assert.equal(createReviewerSession.created[0].reviewCalls, 2);
  assert.deepEqual(createReviewerSession.created[0].reviewOpts, [{ reuseAttempt: false }, { reuseAttempt: false }]);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 2);
});

test('rate-limit: Supervisor decision throttle before send -> cooldown -> same decision retried', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    rlError(),
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const logs = [];
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-6',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
    log: (l) => logs.push(l),
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(rec.sleeps, [1000]);
  assert.ok(logs.includes('supervisor decision rate limited: task=none retry=1'), logs.join('\n'));
  assert.ok(logs.includes('supervisor decision retry started'));
  // decide() called 3x: throttled, NEXT_TASK, WORKFLOW_DONE.
  assert.equal(supervisor.calls.length, 3);
  // The supervisor tab was reactivated for the retry.
  assert.ok(windowSession.activations.filter((t) => t === supervisor.tabId).length >= 2);
});

test('rate-limit: Supervisor decision throttle exhausts budget -> resumable HUMAN_REQUIRED', async () => {
  const supervisor = makeFakeSupervisor([rlError(), rlError(), rlError()]);
  const createReviewerSession = makeFakeReviewerFactory({});
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const rec = fakeRecovery();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-rl-7',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: demoTaskCard().repository_context,
    rateLimitRecovery: rec.rateLimitRecovery,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /rate-limited/i);
  assert.equal(supervisor.calls.length, 3);
  assert.deepEqual(rec.sleeps, [1000, 2000]);
  // Nothing torn down.
  assert.equal(supervisor.isClosed(), false);
  assert.equal(windowSession.closedWindowId(), null);
});

// P1-1: STATE_MACHINE.md §2 — VERIFYING FAIL -> REWORK (never REVIEWING).
// A non-environment Gate failure must consume ZERO Reviewer calls and route
// deterministically to a fresh Executor attempt. A Reviewer PASS must never
// be able to override a Gate FAIL.
test('P1-1. Gate FAIL routes to REWORK with zero Reviewer calls; PASS after fix completes', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done after gate fix' },
  ]);

  // attempt 1 Gate FAIL (ordinary test failure), attempt 2 Gate PASS.
  const gateOutcomes = [
    { pass: false, results: [{ command: 'npm test', pass: false, output: '1 failing' }] },
    { pass: true, results: [{ command: 'npm test', pass: true, output: 'ok' }] },
  ];
  let gateRuns = 0;
  const gateRunner = {
    runs: [],
    async run(cmds) {
      this.runs.push(cmds);
      return gateOutcomes[gateRuns++] ?? gateOutcomes[gateOutcomes.length - 1];
    },
  };

  // Reviewer would return PASS if ever called — it must NOT be called for
  // the failed Gate attempt.
  const passWithUsage = {
    ...passResult(taskCard.task_id),
    callId: 'rev-call-attempt-2',
    usage: { input_tokens: 10, output_tokens: 5, callId: 'rev-call-attempt-2' },
  };
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [passWithUsage],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const persistence = makeFakePersistence();
  const windowSession = makeFakeWindowSession();

  const usageRecords = [];
  const usageTracker = {
    record: (r) => usageRecords.push(r),
    summary: () => ({}),
  };

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-p1-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    usageTracker,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');

  // attempt 1: Gate FAIL — zero Reviewer calls, task not completed, fresh
  // Executor attempt followed.
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(createReviewerSession.created[0].reviewCalls, 1, 'Reviewer called exactly once — only for the PASS attempt 2');
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 2, 'two Executor attempts');
  assert.equal(gateRuns, 2);

  // History records a single PASS after the rework, not a completion off the
  // failed Gate attempt.
  assert.deepEqual(result.history, [{ task_id: taskCard.task_id, decision: 'PASS', attempts: 2 }]);

  // Usage accounting contains no Reviewer call for attempt 1.
  const reviewerUsage = usageRecords.filter((r) => r.role === 'reviewer' || r.role === 'internal_reviewer' || r.role === 'internalReviewer');
  assert.equal(reviewerUsage.length, 1);
  assert.equal(reviewerUsage[0].attempt, 2);
  assert.ok(!reviewerUsage.some((r) => r.attempt === 1), 'no Reviewer usage recorded for the failed Gate attempt');

  // The failing Gate output was persisted as actionable rework feedback.
  assert.ok(persistence.writes.some((w) => /1 failing/.test(w.last_error || '')));
});

// A ClaudeSessionManager whose execute() delegates to the real
// productionRoleRuntime, so a provider-candidate timeout is resolved by
// candidate-level failover *inside* one execute() call — exactly how the
// production wiring behaves. Used to prove the loop's implementation-retry
// accounting (attemptCount / history.attempts) is not charged for provider
// failover.
function makeRuntimeBackedClaudeManagerFactory({ rolePolicy, adapters, onEvent, spendAuthority } = {}) {
  const managers = [];
  function createClaudeSessionManager({ taskId }) {
    const executions = [];
    const runtime = createProductionRoleRuntime({
      rolePolicy,
      quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
      providerHealth: new ProviderHealthRegistry(),
      resolveFamily: (family) => ({
        requestedFamily: family,
        resolvedModel: family.split(':')[1] || family,
        provider: family.split(':')[0],
        capabilities: { roles: ['executor'] },
      }),
      adapters,
      onEvent,
      ...(spendAuthority ? { spendAuthority } : {}),
    });
    const manager = {
      taskId,
      executions,
      async execute(taskCard, { signal } = {}) {
        executions.push({ taskCard });
        const { value } = await runtime.invoke('executor', { taskCard }, { signal });
        return value;
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

test('regression: an Executor provider timeout fails over sonnet -> codex -> opus inside one attempt, without consuming an implementation retry', async () => {
  // This test exercises the GENERIC productionRoleRuntime failover
  // mechanism, not the current SuperGPT production policy (which is
  // Sonnet-only — see providerCapabilities.js). ModelSpendAuthority always
  // enforces provider eligibility regardless of rolePolicy, so a
  // TEST-ONLY permissive capability source is injected explicitly here to
  // allow codex/opus as Executor candidates; production code never does
  // this.
  const testOnlyPermissiveCapabilities = {
    isExecutorEligible: (family) => ['claude:sonnet', 'codex:default', 'claude:opus'].includes(family),
  };
  const spendAuthority = new ModelSpendAuthority({ providerCapabilities: testOnlyPermissiveCapabilities });
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done after failover' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const attempted = [];
  const events = [];
  const timeout = (name) => async () => {
    attempted.push(name);
    throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, `executor "${name}" did not respond within 600000ms`);
  };
  const createClaudeSessionManager = makeRuntimeBackedClaudeManagerFactory({
    rolePolicy: {
      executor: [{ family: 'claude:sonnet' }, { family: 'codex:default' }, { family: 'claude:opus' }],
    },
    spendAuthority,
    adapters: {
      executor: {
        'claude:sonnet': timeout('claude:sonnet'),
        'codex:default': timeout('codex:default'),
        'claude:opus': async (payload) => {
          attempted.push('claude:opus');
          return demoExecutionReport(payload.taskCard.task_id);
        },
      },
    },
    onEvent: (e) => events.push(e),
  });

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-timeout-failover',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');

  // Candidate-level failover ran in the mandated order, each candidate exactly
  // once — no per-candidate retry.
  assert.deepEqual(attempted, ['claude:sonnet', 'codex:default', 'claude:opus']);

  // The whole failover happened inside a single execute() call: one Executor
  // attempt, one Gate run, history charged for exactly one attempt.
  assert.equal(createClaudeSessionManager.managers.length, 1);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(gateRunner.runs.length, 1);
  assert.deepEqual(result.history, [{ task_id: taskCard.task_id, decision: 'PASS', attempts: 1 }]);

  // The timeouts were classified as provider-level failover, not swallowed or
  // reclassified as a different failure mode.
  const failed = events.filter((e) => e.type === 'ROLE_INVOCATION_FAILED');
  assert.deepEqual(failed.map((e) => e.failure), ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT']);
  assert.equal(events.filter((e) => e.type === 'ROLE_INVOCATION_SUCCEEDED').length, 1);

  // Every physical failover attempt (sonnet, codex, opus) obtained and
  // consumed its OWN fresh permit — none reused a prior candidate's permit
  // or authorization decision.
  assert.deepEqual(spendAuthority.stats(), { issued: 3, consumed: 3, outstanding: 0 });
});

test('executor mechanical budget breaker is not silently failed over into a second full provider run', async () => {
  const attempted = [];
  const runtime = createProductionRoleRuntime({
    rolePolicy: { executor: [{ family: 'claude:sonnet' }, { family: 'claude:opus' }] },
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily: (family) => ({ requestedFamily: family, resolvedModel: family, provider: 'claude', capabilities: { roles: ['executor'] } }),
    adapters: {
      executor: {
        'claude:sonnet': async () => {
          attempted.push('sonnet');
          throw new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED, 'executor runtime exceeded mechanical limit');
        },
        'claude:opus': async () => {
          attempted.push('opus');
          return demoExecutionReport('task-1');
        },
      },
    },
  });
  await assert.rejects(() => runtime.invoke('executor', { taskCard: demoTaskCard() }), (err) => err.code === ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED);
  assert.deepEqual(attempted, ['sonnet']);
});

// --- Executor unauthorized-probe attribution & Escalation Budget Tests ---

function makeScriptedClaudeManagerFactory(reportsByTaskId) {
  const managers = [];
  function createClaudeSessionManager({ taskId }) {
    const executions = [];
    const manager = {
      taskId,
      executions,
      async execute(taskCard) {
        executions.push({ taskCard });
        const queue = reportsByTaskId[taskCard.task_id] || [];
        const spec = queue.shift() || {};
        const report = demoExecutionReport(taskCard.task_id, {
          status: spec.status ?? 'DONE',
          issues: spec.issues ?? 'none',
          next_recommendation: spec.next_recommendation ?? 'proceed',
        });
        Object.defineProperty(report, 'permissionDenials', {
          value: spec.permissionDenials ?? [],
          enumerable: false,
        });
        return report;
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

test('executor: a denied UNLISTED probe command is not reclassified as ENVIRONMENT and does not burn a retry', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['npm test'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      {
        status: 'BLOCKED',
        issues: 'node and npm appear unavailable in this environment',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/probe.test.js' } }],
      },
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-probe-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 1,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 2);
  assert.ok(execs[1].taskCard.unauthorized_probe_guidance);
  assert.deepEqual(execs[1].taskCard.unauthorized_probe_guidance.denied_commands, ['node --test tests/probe.test.js']);
  assert.deepEqual(execs[1].taskCard.unauthorized_probe_guidance.approved_verification_commands, ['npm test']);
  assert.equal('unauthorized_probe_guidance' in execs[0].taskCard, false);
});

test('executor: a denied APPROVED verification command IS an ENVIRONMENT blocker -> HUMAN_REQUIRED', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['npm test'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      {
        status: 'BLOCKED',
        issues: 'permission denied executing npm test',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'npm test' } }],
      },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-probe-2',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blockerCategory, 'ENVIRONMENT');
  assert.equal(gateRunner.runs.length, 0);
});

test('executor: probe comparison is strictly verbatim — whitespace variants and redirects are EXECUTOR_UNAUTHORIZED_PROBE', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['node --test tests/a.test.js'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      // Probe 1: leading space
      {
        status: 'BLOCKED',
        issues: 'blocked probe',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: ' node --test tests/a.test.js' } }],
      },
      // Probe 2: pipe and tail
      {
        status: 'BLOCKED',
        issues: 'blocked probe 2',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/a.test.js 2>&1 | tail -10' } }],
      },
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-probe-strict',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 1,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 3);
  assert.deepEqual(execs[1].taskCard.unauthorized_probe_guidance.denied_commands, [' node --test tests/a.test.js']);
  assert.deepEqual(execs[2].taskCard.unauthorized_probe_guidance.denied_commands, ['node --test tests/a.test.js 2>&1 | tail -10']);
});

test('Case A: normalAttempts=1 -> Executor unauthorized probe -> 自动 fresh Executor -> normalAttempts 仍为 1 -> HUMAN_REQUIRED=false', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['node --test tests/a.test.js'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      {
        status: 'BLOCKED',
        issues: 'blocked probe',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/a.test.js 2>&1; echo "EXIT: $?"' } }],
      },
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];
  const onCheckpoint = (cp) => checkpoints.push(cp);

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-case-a',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'case a test',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    onCheckpoint,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.notEqual(result.status, 'HUMAN_REQUIRED');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 2);
  const finalCp = checkpoints[checkpoints.length - 1];
  assert.equal(finalCp.normalAttempts, 1);
});

test('Case B: 连续两次 unauthorized probe -> 都不消耗 implementation budget -> Core 每次注入 approved-command-only guidance -> 不进入 Reviewer', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['node --test tests/b.test.js'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  let reviewerCalls = 0;
  const rawReviewerFactory = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createReviewerSession = () => {
    const session = rawReviewerFactory();
    const origReview = session.review;
    session.review = async (...args) => {
      reviewerCalls += 1;
      return origReview.apply(session, args);
    };
    return session;
  };
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      {
        status: 'BLOCKED',
        issues: 'blocked probe 1',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'git log -1' } }],
      },
      {
        status: 'BLOCKED',
        issues: 'blocked probe 2',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/b.test.js | grep ok' } }],
      },
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];
  const onCheckpoint = (cp) => checkpoints.push(cp);

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-case-b',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'case b test',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    onCheckpoint,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 3);
  assert.deepEqual(execs[1].taskCard.unauthorized_probe_guidance.denied_commands, ['git log -1']);
  assert.deepEqual(execs[2].taskCard.unauthorized_probe_guidance.denied_commands, ['node --test tests/b.test.js | grep ok']);
  // Reviewer called exactly once at the end, zero times during probes
  assert.equal(reviewerCalls, 1);
  const finalCp = checkpoints[checkpoints.length - 1];
  assert.equal(finalCp.normalAttempts, 1);
});

test('Case C: unauthorized probe 后 fresh Executor 使用精确批准命令 -> 正常进入 Gate -> 后续 implementation REWORK 递增 normalAttempts', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['node --test tests/c.test.js'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [
      { task_id: taskCard.task_id, decision: 'REWORK', findings: ['need fix'], required_changes: ['fix it'], rationale: 'r1' },
      passResult(taskCard.task_id),
    ],
  });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      // Attempt 1: unauthorized probe
      {
        status: 'BLOCKED',
        issues: 'blocked probe',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/c.test.js 2>&1' } }],
      },
      // Attempt 1 retry: clean execution -> Gate passes -> Reviewer returns REWORK
      { status: 'DONE' },
      // Attempt 2: clean execution -> Gate passes -> Reviewer passes
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];
  const onCheckpoint = (cp) => checkpoints.push(cp);

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-case-c',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'case c test',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    onCheckpoint,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 3);
  const finalCp = checkpoints[checkpoints.length - 1];
  assert.equal(finalCp.normalAttempts, 2);
});

test('Case D: 1 次真实 REWORK -> unauthorized probe -> 再 2 次真实 REWORK -> 此时才达到 normalAttempts = 3 -> 自动 Supervisor escalation -> 全程不 HUMAN_REQUIRED', async () => {
  const taskCard = demoTaskCard({ verification_commands: ['node --test tests/d.test.js'] });
  let supervisorCalled = false;
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' }, // after attempt 1
    { action: 'CONTINUE_REWORK' }, // after attempt 2
    { action: 'CONTINUE_REWORK', guidance: 'supervisor escalation guidance' }, // after attempt 3 (escalation)
    { action: 'WORKFLOW_DONE', summary: 'done on escalation' },
  ]);
  const reworkRes = (r) => ({
    task_id: taskCard.task_id,
    decision: 'REWORK',
    findings: ['fix'],
    required_changes: ['fix'],
    rationale: r,
  });
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [
      reworkRes('r1'), // after attempt 1
      reworkRes('r2'), // after attempt 2
      reworkRes('r3'), // after attempt 3
      passResult(taskCard.task_id), // after escalation attempt 4
    ],
  });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      // Attempt 1: real execution -> REWORK (normalAttempts = 1)
      { status: 'DONE' },
      // Attempt 2 try 1: unauthorized probe -> does NOT burn attempt
      {
        status: 'BLOCKED',
        issues: 'blocked probe in attempt 2',
        permissionDenials: [{ tool_name: 'Bash', tool_input: { command: 'node --test tests/d.test.js 2>&1; echo $?' } }],
      },
      // Attempt 2 try 2: real execution -> REWORK (normalAttempts = 2)
      { status: 'DONE' },
      // Attempt 3: real execution -> REWORK (normalAttempts = 3 -> triggers escalation)
      { status: 'DONE' },
      // Escalation Attempt (attempt 4, escalationAttempts = 1): real execution -> PASS
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];
  const onCheckpoint = (cp) => checkpoints.push(cp);

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-case-d',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'case d test',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
    onCheckpoint,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.notEqual(result.status, 'HUMAN_REQUIRED');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 5);
  // Escalation guidance was passed to final attempt
  assert.equal(execs[4].taskCard.supervisor_guidance, 'supervisor escalation guidance');
  const finalCp = checkpoints[checkpoints.length - 1];
  assert.equal(finalCp.normalAttempts, 3);
  assert.equal(finalCp.escalationAttempts, 1);
  assert.equal(finalCp.escalationActive, true);
});

test('Nested Route Error: Executor BLOCKED reporting missing supergpt_route / supergpt MCP does NOT trigger HUMAN_REQUIRED and recovers autonomously', async () => {
  const taskCard = demoTaskCard({ task_id: 'task-nested-route' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeScriptedClaudeManagerFactory({
    [taskCard.task_id]: [
      // Attempt 1: Executor erroneously reports BLOCKED due to supergpt_route MCP tool absence
      {
        status: 'BLOCKED',
        issues: ['Required `supergpt_route` MCP tool is unavailable. Global repository policy prohibits proceeding directly when SuperGPT MCP is unavailable.'],
        next_recommendation: 'Configure or restore the SuperGPT MCP tools, then retry this task.',
      },
      // Attempt 2: After guidance, Executor executes Task Card directly and finishes
      { status: 'DONE' },
    ],
  });
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-nested-route-recovery',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'nested route recovery test',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.notEqual(result.status, 'HUMAN_REQUIRED');
  const execs = createClaudeSessionManager.managers[0].executions;
  assert.equal(execs.length, 2);
  assert.match(execs[1].taskCard.unauthorized_probe_guidance.message, /internal Executor.*active SuperGPT workflow/);
});

test('deterministic closeout fast path: Gate PASS + Reviewer PASS + queue empty -> deterministic WORKFLOW_DONE without model supervisor calls', async () => {
  const taskCard = demoTaskCard();
  const plannedTasks = [
    {
      task_id: taskCard.task_id,
      goal: taskCard.goal,
      scope: taskCard.scope,
      allowed_files: taskCard.allowed_files,
      verification_commands: taskCard.verification_commands,
    },
  ];
  let supervisorCallCount = 0;
  const supervisor = {
    async create() { return { tabId: 501, conversationId: null }; },
    async decide(context) {
      supervisorCallCount += 1;
      throw new Error('Supervisor model should NOT be called on deterministic closeout fast path');
    },
    async close() {},
    getIdentity() { return { tabId: 501, conversationId: null }; },
  };

  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [passResult(taskCard.task_id)],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  // Initial task is supplied via NEXT_TASK
  const supervisorWithInit = {
    ...supervisor,
    async decide(context) {
      if (context.latestReviewResult?.decision === 'PASS') {
        supervisorCallCount += 1;
        throw new Error('Supervisor model should NOT be called after Reviewer PASS');
      }
      return { action: 'NEXT_TASK', task_card: taskCard };
    },
  };

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-deterministic-closeout',
    supervisorSession: supervisorWithInit,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'deterministic closeout',
    repositoryContext: taskCard.repository_context,
    plannedTasks,
    planSummary: 'done fast',
    maxAttemptsPerTask: 3,
  });

  // After PASS, loop completes with WORKFLOW_DONE and did not call supervisor for closeout
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(supervisorCallCount, 0);
});

test('escalation: normal attempts=3 exhausted automatically enters Supervisor escalation and finishes without HUMAN_REQUIRED', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK', guidance: 'focus on fix' },
    { action: 'WORKFLOW_DONE', summary: 'completed on escalation' },
  ]);
  const reworkRes = (rationale) => ({
    task_id: taskCard.task_id,
    decision: 'REWORK',
    findings: ['fix defect'],
    required_changes: ['fix defect'],
    rationale,
  });
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [
      reworkRes('r1'),
      reworkRes('r2'),
      reworkRes('r3'),
      passResult(taskCard.task_id),
    ],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const checkpoints = [];
  const onCheckpoint = (cp) => checkpoints.push(cp);

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-escalation-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
    onCheckpoint,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(result.history, [
    {
      task_id: taskCard.task_id,
      decision: 'PASS',
      attempts: 4,
    },
  ]);
  const finalCp = checkpoints[checkpoints.length - 1];
  assert.equal(finalCp.normalAttempts, 3);
  assert.equal(finalCp.escalationAttempts, 1);
  assert.equal(finalCp.escalationActive, true);
});

test('escalation: exhausting escalation budget triggers HUMAN_REQUIRED', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
  ]);
  const reworkRes = {
    task_id: taskCard.task_id,
    decision: 'REWORK',
    findings: ['still failing'],
    required_changes: ['still failing'],
  };
  const createReviewerSession = makeFakeReviewerFactory({
    [taskCard.task_id]: [reworkRes, reworkRes],
  });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const checkpoint = {
    history: [],
    currentTaskCard: taskCard,
    currentTaskId: taskCard.task_id,
    attempt: 3,
    normalAttempts: 3,
    escalationAttempts: 0,
    escalationActive: true,
    latestReviewResult: reworkRes,
  };

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-escalation-exhaust',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 1,
    humanAnswer: 'proceed with escalation',
    checkpoint,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /exhausted escalation attempts/);
});

test('escalation: retry-phase consumption never touches the escalation budget', async () => {
  const taskCard = demoTaskCard();
  const decisions = [{ action: 'NEXT_TASK', task_card: taskCard }];
  for (let i = 0; i < 10; i += 1) decisions.push({ action: 'CONTINUE_REWORK' });
  const supervisor = makeFakeSupervisor(decisions);
  const reworkQueue = [];
  for (let i = 0; i < 10; i += 1) reworkQueue.push(reworkResult(taskCard.task_id));
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-budget-independence',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
    onCheckpoint: (cp) => checkpoints.push(cp),
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /exhausted escalation attempts/);
  // Every checkpoint written during the retry phase (first 3 attempts) kept escalation at zero
  // and inactive — retries did not draw down the escalation quota early.
  const retryPhaseCheckpoints = checkpoints.filter((cp) => cp.normalAttempts < 3 || (cp.normalAttempts === 3 && !cp.escalationActive && cp.escalationAttempts === 0));
  assert.ok(retryPhaseCheckpoints.length >= 3);
  for (const cp of retryPhaseCheckpoints) {
    assert.equal(cp.escalationAttempts, 0);
    assert.equal(cp.escalationActive, false);
  }
  const last = checkpoints[checkpoints.length - 1];
  assert.equal(last.normalAttempts, 3);
  assert.equal(last.escalationAttempts, 2);
});


function outOfScopeResult(taskId) {
  return {
    task_id: taskId,
    decision: 'OUT_OF_SCOPE',
    findings: ['acceptance criterion needs a file outside allowed_files'],
    required_changes: ['modify src/other-module.js (not in this Task Card allowed_files)'],
    rationale: 'the only way to satisfy the criterion is outside declared scope',
  };
}

test('OUT_OF_SCOPE: Reviewer OUT_OF_SCOPE closes the task deterministically and the workflow proceeds', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done; one task closed out-of-scope' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [outOfScopeResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const checkpoints = [];

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-oos-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    onCheckpoint: (cp) => checkpoints.push(cp),
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  // Recorded in history, distinct from PASS, and auditable.
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].task_id, taskCard.task_id);
  assert.equal(result.history[0].decision, 'OUT_OF_SCOPE');
  assert.deepEqual(result.history[0].out_of_scope_changes, [
    'modify src/other-module.js (not in this Task Card allowed_files)',
  ]);
  // No rework loop — exactly one Executor attempt, one review.
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(createReviewerSession.created[0].reviewCalls, 1);
  // The lifecycle result is persisted for resume.
  const last = checkpoints[checkpoints.length - 1];
  assert.equal(last.latestReviewResult.decision, 'OUT_OF_SCOPE');
});

test('OUT_OF_SCOPE: after OUT_OF_SCOPE a Supervisor CONTINUE_REWORK is an illegal transition', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'CONTINUE_REWORK' }, // illegal: the task is closed (OUT_OF_SCOPE)
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [outOfScopeResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  await assert.rejects(
    () => runAutomatedWorkflow({
      workflowId: 'wf-oos-2',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      windowSession,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    }),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION);
      return true;
    }
  );
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
});

test('stale REWORK isolation: a checkpoint REWORK from a superseded round is not resumed as mid-flight', async () => {
  const taskCard = demoTaskCard({ task_id: 'stale-task' });
  const freshTask = demoTaskCard({ task_id: 'fresh-task' });
  // reviewRound has advanced to 5; the persisted REWORK is stamped round 2.
  const checkpoint = {
    history: [],
    currentTaskCard: taskCard,
    currentTaskId: taskCard.task_id,
    attempt: 2,
    normalAttempts: 2,
    escalationAttempts: 0,
    escalationActive: false,
    reviewRound: 5,
    latestReviewResult: {
      task_id: taskCard.task_id,
      decision: 'REWORK',
      round: 2,
      required_changes: ['stale ask from an old round'],
      findings: 'x',
      rationale: 'y',
    },
  };
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: freshTask },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ 'fresh-task': [passResult('fresh-task')] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const lines = [];

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-stale-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    checkpoint,
    maxAttemptsPerTask: 3,
    log: (l) => lines.push(l),
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  // The stale task was never re-executed; only the fresh task ran.
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['fresh-task']);
  assert.ok(lines.some((l) => /stale REWORK ignored/.test(l)), 'expected a stale-REWORK diagnostic log line');
});

test('stale REWORK isolation: a current-round REWORK checkpoint DOES still resume the task', async () => {
  const taskCard = demoTaskCard({ task_id: 'live-task' });
  const checkpoint = {
    history: [],
    currentTaskCard: taskCard,
    currentTaskId: taskCard.task_id,
    attempt: 1,
    normalAttempts: 1,
    escalationAttempts: 0,
    escalationActive: false,
    reviewRound: 1,
    latestReviewResult: {
      task_id: taskCard.task_id,
      decision: 'REWORK',
      round: 1,
      required_changes: ['a genuinely current ask'],
      findings: 'x',
      rationale: 'y',
    },
  };
  const supervisor = makeFakeSupervisor([
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ 'live-task': [passResult('live-task')] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-live-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence: { async writeState() {} },
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    checkpoint,
    maxAttemptsPerTask: 5,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['live-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['live-task']);
});

// A checkpoint serialized and reloaded through persistence (JSON round-trip)
// must not resume a persisted REWORK unless it is POSITIVELY identified as the
// restored task AND the restored round. These cases each strip one piece of
// that identity and prove the loop treats the result as stale.
const reloadCheckpoint = (cp) => JSON.parse(JSON.stringify(cp));

function runResumeExpectingNoMidFlight(checkpoint, freshTaskId = 'fresh-task') {
  const freshTask = demoTaskCard({ task_id: freshTaskId });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: freshTask },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [freshTaskId]: [passResult(freshTaskId)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const lines = [];
  return runAutomatedWorkflow({
    workflowId: 'wf-stale-reload',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    workflowGoal: 'ship it',
    repositoryContext: freshTask.repository_context,
    checkpoint: reloadCheckpoint(checkpoint),
    maxAttemptsPerTask: 3,
    log: (l) => lines.push(l),
  }).then((result) => ({ result, createClaudeSessionManager, lines }));
}

test('stale REWORK after persistence reload: new-format checkpoint whose persisted REWORK has no round metadata is stale', async () => {
  const staleTask = demoTaskCard({ task_id: 'stale-task' });
  const checkpoint = {
    history: [],
    currentTaskCard: staleTask,
    currentTaskId: staleTask.task_id,
    attempt: 2,
    normalAttempts: 2,
    escalationAttempts: 0,
    escalationActive: false,
    reviewRound: 3, // new-format checkpoint
    latestReviewResult: {
      task_id: staleTask.task_id, // task identity present…
      decision: 'REWORK',
      // …but NO round — cannot be positively tied to reviewRound 3.
      required_changes: ['legacy ask without round metadata'],
      findings: 'x',
      rationale: 'y',
    },
  };
  const { result, createClaudeSessionManager, lines } = await runResumeExpectingNoMidFlight(checkpoint);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['fresh-task']);
  assert.ok(lines.some((l) => /stale REWORK ignored/.test(l)));
});

test('stale REWORK after persistence reload: persisted REWORK for a different task id is stale', async () => {
  const restoredTask = demoTaskCard({ task_id: 'restored-task' });
  const checkpoint = {
    history: [],
    currentTaskCard: restoredTask,
    currentTaskId: restoredTask.task_id,
    attempt: 1,
    normalAttempts: 1,
    escalationAttempts: 0,
    escalationActive: false,
    reviewRound: 1,
    latestReviewResult: {
      task_id: 'some-other-task', // cross-task REWORK
      decision: 'REWORK',
      round: 1, // round matches, identity does not
      required_changes: ['ask that belongs to another task'],
      findings: 'x',
      rationale: 'y',
    },
  };
  const { result, createClaudeSessionManager, lines } = await runResumeExpectingNoMidFlight(checkpoint);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['fresh-task']);
  assert.ok(lines.some((l) => /stale REWORK ignored/.test(l)));
});

test('stale REWORK after persistence reload: a completed (PASS) review reload never re-executes the closed task', async () => {
  const doneTask = demoTaskCard({ task_id: 'done-task' });
  const checkpoint = {
    history: [{ task_id: 'done-task', decision: 'PASS', attempts: 2 }],
    currentTaskCard: doneTask, // still present in the snapshot…
    currentTaskId: doneTask.task_id,
    attempt: 2,
    normalAttempts: 2,
    escalationAttempts: 0,
    escalationActive: false,
    reviewRound: 2,
    latestReviewResult: { task_id: 'done-task', decision: 'PASS', round: 2, required_changes: 'none', findings: 'ok', rationale: 'ok' },
  };
  const freshTask = demoTaskCard({ task_id: 'next-task' });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: freshTask },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ 'next-task': [passResult('next-task')] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-pass-reload',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    workflowGoal: 'ship it',
    repositoryContext: freshTask.repository_context,
    checkpoint: reloadCheckpoint(checkpoint),
  });
  assert.equal(result.status, 'WORKFLOW_DONE');
  // done-task was accepted before the crash; it is never re-executed.
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['next-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['done-task', 'next-task']);
});

test('legacy checkpoint (no reviewRound field) still resumes a non-terminal REWORK — migration rule', async () => {
  const legacyTask = demoTaskCard({ task_id: 'legacy-task' });
  const checkpoint = {
    history: [],
    currentTaskCard: legacyTask,
    currentTaskId: legacyTask.task_id,
    attempt: 1,
    normalAttempts: 1,
    // no reviewRound, no round on the review result — pre-stamping format
    latestReviewResult: { task_id: 'legacy-task', decision: 'REWORK', required_changes: ['fix'], findings: 'x', rationale: 'y' },
  };
  const supervisor = makeFakeSupervisor([
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-legacy-reload',
    supervisorSession: supervisor,
    createReviewerSession: makeFakeReviewerFactory({ 'legacy-task': [passResult('legacy-task')] }),
    createClaudeSessionManager,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    persistence: { async writeState() {} },
    workflowGoal: 'ship it',
    repositoryContext: legacyTask.repository_context,
    checkpoint: reloadCheckpoint(checkpoint),
    maxAttemptsPerTask: 5,
  });
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['legacy-task']);
  assert.deepEqual(result.history.map((h) => h.task_id), ['legacy-task']);
});

test('OUT_OF_SCOPE survives a persistence reload: task stays closed, history preserved, no re-execution, genuine REWORK still handled', async () => {
  const oosTask = demoTaskCard({ task_id: 'oos-task' });
  // Phase 1: run to the OUT_OF_SCOPE closure and capture the checkpoint.
  const checkpoints = [];
  const sup1 = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: oosTask },
    { action: 'HUMAN_REQUIRED', reason: 'pause here', question: 'q?' },
  ]);
  const res1 = await runAutomatedWorkflow({
    workflowId: 'wf-oos-reload',
    supervisorSession: sup1,
    createReviewerSession: makeFakeReviewerFactory({ 'oos-task': [outOfScopeResult('oos-task')] }),
    createClaudeSessionManager: makeFakeClaudeManagerFactory(),
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    workflowGoal: 'ship it',
    repositoryContext: oosTask.repository_context,
    onCheckpoint: (cp) => checkpoints.push(cp),
  });
  assert.equal(res1.status, 'HUMAN_REQUIRED');
  const snapshot = checkpoints[checkpoints.length - 1];
  assert.equal(snapshot.latestReviewResult.decision, 'OUT_OF_SCOPE');
  assert.deepEqual(snapshot.history.map((h) => h.decision), ['OUT_OF_SCOPE']);

  // Phase 2: reload the serialized checkpoint. The closed task must not run
  // again; a following task that genuinely needs REWORK still converges.
  const reworkTask = demoTaskCard({ task_id: 'rework-task' });
  const sup2 = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: reworkTask },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const exec2 = makeFakeClaudeManagerFactory();
  const res2 = await runAutomatedWorkflow({
    workflowId: 'wf-oos-reload',
    supervisorSession: sup2,
    createReviewerSession: makeFakeReviewerFactory({
      'rework-task': [reworkResult('rework-task'), passResult('rework-task')],
    }),
    createClaudeSessionManager: exec2,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    persistence: { async writeState() {} },
    workflowGoal: 'ship it',
    repositoryContext: reworkTask.repository_context,
    checkpoint: reloadCheckpoint(snapshot),
    maxAttemptsPerTask: 5,
  });
  assert.equal(res2.status, 'WORKFLOW_DONE');
  // oos-task never re-executed on resume.
  assert.deepEqual(exec2.managers.map((m) => m.taskId), ['rework-task']);
  // History still carries the OUT_OF_SCOPE closure, then the reworked PASS.
  assert.deepEqual(res2.history.map((h) => [h.task_id, h.decision]), [
    ['oos-task', 'OUT_OF_SCOPE'],
    ['rework-task', 'PASS'],
  ]);
  // The genuine REWORK was honoured: rework-task took two executor attempts.
  assert.equal(exec2.managers[0].executions.length, 2);
});

test('two-budget recovery: a restored checkpoint with partly-spent retry AND escalation keeps the counters independent', async () => {
  const taskCard = demoTaskCard({ task_id: 'budget-task' });
  // Crash point: retry budget fully spent (3/3), escalation partly spent (1/2),
  // escalation phase active. Positively-identified current-round REWORK.
  const checkpoint = {
    history: [],
    currentTaskCard: taskCard,
    currentTaskId: taskCard.task_id,
    attempt: 4,
    normalAttempts: 3,
    escalationAttempts: 1,
    escalationActive: true,
    reviewRound: 4,
    latestReviewResult: {
      task_id: 'budget-task',
      decision: 'REWORK',
      round: 4,
      required_changes: ['still not converged'],
      findings: 'x',
      rationale: 'y',
    },
  };
  const checkpoints = [];
  const supervisor = makeFakeSupervisor([
    { action: 'CONTINUE_REWORK' },
    { action: 'CONTINUE_REWORK' },
  ]);
  const result = await runAutomatedWorkflow({
    workflowId: 'wf-two-budget',
    supervisorSession: supervisor,
    createReviewerSession: makeFakeReviewerFactory({ 'budget-task': [reworkResult('budget-task')] }),
    createClaudeSessionManager: makeFakeClaudeManagerFactory(),
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    persistence: { async writeState() {} },
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    checkpoint: reloadCheckpoint(checkpoint),
    maxAttemptsPerTask: 3,
    maxEscalationAttempts: 2,
    humanAnswer: 'continue escalation',
    onCheckpoint: (cp) => checkpoints.push(cp),
  });

  // One more escalation attempt (1 -> 2) then the escalation budget is spent.
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /exhausted escalation attempts/);
  // The retry counter was never reset, reused, or mixed into escalation.
  for (const cp of checkpoints) {
    assert.equal(cp.normalAttempts, 3, 'retry counter stayed frozen at its exhausted value');
    assert.equal(cp.escalationActive, true);
  }
  const last = checkpoints[checkpoints.length - 1];
  assert.equal(last.escalationAttempts, 2);
  assert.equal(last.normalAttempts, 3);
});

test('legacy checkpoint: missing task_id on persisted REWORK is treated as stale (fail-closed)', async () => {
  const legacyTask = demoTaskCard({ task_id: 'legacy-task-no-id' });
  const checkpoint = {
    history: [],
    currentTaskCard: legacyTask,
    currentTaskId: legacyTask.task_id,
    attempt: 1,
    normalAttempts: 1,
    // Legacy format (no reviewRound), but persistedReview has NO task_id
    latestReviewResult: { decision: 'REWORK', required_changes: ['fix'], findings: 'x', rationale: 'y' },
  };
  const { result, createClaudeSessionManager, lines } = await runResumeExpectingNoMidFlight(checkpoint);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
  assert.ok(lines.some((l) => /stale REWORK ignored/.test(l)));
});

test('legacy checkpoint: mismatched task_id on persisted REWORK is treated as stale (fail-closed)', async () => {
  const legacyTask = demoTaskCard({ task_id: 'legacy-task-mismatch' });
  const checkpoint = {
    history: [],
    currentTaskCard: legacyTask,
    currentTaskId: legacyTask.task_id,
    attempt: 1,
    normalAttempts: 1,
    // Legacy format (no reviewRound), but persistedReview has DIFFERENT task_id
    latestReviewResult: { task_id: 'other-task', decision: 'REWORK', required_changes: ['fix'], findings: 'x', rationale: 'y' },
  };
  const { result, createClaudeSessionManager, lines } = await runResumeExpectingNoMidFlight(checkpoint);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
  assert.ok(lines.some((l) => /stale REWORK ignored/.test(l)));
});

test('REVIEW_PENDING checkpoint: mismatched task_id does not restore as pending review', async () => {
  const pendingTask = demoTaskCard({ task_id: 'pending-task' });
  const checkpoint = {
    history: [],
    phase: 'REVIEW_PENDING',
    currentTaskCard: pendingTask,
    currentTaskId: 'different-task-id',
    executionReport: { output: 'done' },
    gateEvidence: { pass: true, results: [] },
    attempt: 1,
    normalAttempts: 1,
    latestReviewResult: { task_id: 'different-task-id', decision: 'REWORK', required_changes: ['fix'] },
  };
  const { result, createClaudeSessionManager } = await runResumeExpectingNoMidFlight(checkpoint);
  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(createClaudeSessionManager.managers.map((m) => m.taskId), ['fresh-task']);
});

test('regression: multi-task Executor requests stay compact and isolated while rework handoff and usage totals survive', async () => {
  const priorTranscript = 'PRIOR_FULL_TRANSCRIPT_SHOULD_NOT_LEAK_'.repeat(2_000);
  const unrelatedEvidence = 'UNRELATED_DIFF_AND_EVIDENCE_SHOULD_NOT_LEAK_'.repeat(2_000);
  const firstTask = demoTaskCard({
    task_id: 'compact-task-1',
    goal: 'change the first file',
    allowed_files: ['src/first.js'],
  });
  const secondTask = demoTaskCard({
    task_id: 'compact-task-2',
    goal: 'change the second file',
    allowed_files: ['src/second.js'],
    history: [{ task_id: firstTask.task_id, transcript: priorTranscript }],
    previous_executor_transcript: priorTranscript,
    evidence: { diff: unrelatedEvidence, files: ['src/first.js'] },
    auxiliary_snapshots: [
      { original_path: 'src/second.js', snapshot_path: '.aux/second.js', sha256: 'current', read_only: true },
      { original_path: 'src/first.js', snapshot_path: '.aux/first.js', sha256: 'prior', read_only: true },
    ],
  });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: firstTask },
    { action: 'NEXT_TASK', task_card: secondTask },
    { action: 'CONTINUE_REWORK' },
    { action: 'WORKFLOW_DONE', summary: 'autonomous multi-task completion' },
  ]);
  const withUsage = (result, callId) => ({
    ...result,
    callId,
    usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45, callId },
  });
  const createReviewerSession = makeFakeReviewerFactory({
    [firstTask.task_id]: [withUsage(passResult(firstTask.task_id), 'review-1')],
    [secondTask.task_id]: [
      withUsage({
        task_id: secondTask.task_id,
        decision: 'REWORK',
        findings: ['second-file edge case'],
        required_changes: ['handle the second-file edge case'],
        rationale: 'current task review only',
      }, 'review-2a'),
      withUsage(passResult(secondTask.task_id), 'review-2b'),
    ],
  });
  const managers = [];
  const prompts = [];
  const createClaudeSessionManager = ({ taskId }) => {
    const manager = {
      taskId,
      executions: [],
      async execute(taskCard) {
        const prompt = buildPrompt(taskCard);
        prompts.push({ taskId, prompt, taskCard });
        manager.executions.push({ taskCard });
        return demoExecutionReport(taskId, {
          callId: `execute-${taskId}-${manager.executions.length}`,
          model: 'sonnet',
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          inputBreakdown: measureExecutorInputBreakdown(taskCard, prompt),
        });
      },
    };
    managers.push(manager);
    return manager;
  };
  createClaudeSessionManager.managers = managers;
  const gateRunner = makeFakeGateRunner();
  const usageTracker = new UsageTracker();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-compact-multi-task',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession: makeFakeWindowSession(),
    usageTracker,
    workflowGoal: 'complete both tasks autonomously',
    repositoryContext: firstTask.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.deepEqual(result.history, [
    { task_id: firstTask.task_id, decision: 'PASS', attempts: 1 },
    { task_id: secondTask.task_id, decision: 'PASS', attempts: 2 },
  ]);
  assert.equal(gateRunner.runs.length, 3, 'every Executor attempt passes through the gate');
  assert.equal(createReviewerSession.created.length, 2, 'review state is isolated by task');
  assert.equal(createReviewerSession.created[0].reviewCalls, 1);
  assert.equal(createReviewerSession.created[1].reviewCalls, 2, 'rework reuses only the current task reviewer');

  const secondPrompts = prompts.filter((entry) => entry.taskId === secondTask.task_id);
  assert.equal(secondPrompts.length, 2);
  for (const { prompt } of secondPrompts) {
    assert.doesNotMatch(prompt, /PRIOR_FULL_TRANSCRIPT_SHOULD_NOT_LEAK_/);
    assert.doesNotMatch(prompt, /UNRELATED_DIFF_AND_EVIDENCE_SHOULD_NOT_LEAK_/);
    assert.doesNotMatch(prompt, /\.aux\/first\.js/);
    assert.match(prompt, /\.aux\/second\.js/);
    assert.ok(Buffer.byteLength(prompt) < 20_000, 'later request remains compact');
  }
  assert.doesNotMatch(secondPrompts[0].prompt, /handle the second-file edge case/);
  assert.match(secondPrompts[1].prompt, /handle the second-file edge case/);
  assert.match(secondPrompts[1].prompt, /current task review only/);

  const usage = usageTracker.summary();
  assert.equal(usage.executor.calls, 3);
  assert.equal(usage.executor.inputTokens, 300);
  assert.equal(usage.executor.outputTokens, 30);
  assert.equal(usage.internalReviewer.calls, 3);
  assert.equal(usage.internalReviewer.inputTokens, 120);
  assert.equal(usage.internalReviewer.outputTokens, 15);
  assert.equal(usage.total.inputTokens, 420);
  assert.equal(usage.total.outputTokens, 45);
  assert.equal(usage.total.totalTokens, 465);
  assert.equal(usage.executorInputBreakdownAggregate.callsWithBreakdown, 3);
});

test('active acceptance version chain is created, persisted and stamped onto the card every consumer sees', async () => {
  const taskCard = demoTaskCard({ acceptance_criteria: ['ship the demo', 'tests pass'] });
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);

  const reviewedCards = [];
  const baseFactory = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createReviewerSession = () => {
    const session = baseFactory();
    const origReview = session.review.bind(session);
    session.review = async (taskId, card, report, evidence, opts) => {
      reviewedCards.push(card);
      return origReview(taskId, card, report, evidence, opts);
    };
    return session;
  };
  createReviewerSession.created = baseFactory.created;

  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const windowSession = makeFakeWindowSession();
  const persistence = makeFakePersistence();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-acc',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');

  // persisted per-task chain, version 1 from the card's own criteria
  const chain = persistence.acceptanceChains[taskCard.task_id];
  assert.ok(chain, 'acceptance chain persisted for the task');
  assert.equal(chain.activeVersion, 1);
  assert.deepEqual(chain.versions[0].acceptance, ['ship the demo', 'tests pass']);

  // Executor and Reviewer both received the stamped active acceptance
  const execCard = createClaudeSessionManager.managers[0].executions[0].taskCard;
  assert.equal(execCard.acceptance_version, 1);
  assert.deepEqual(execCard.acceptance_criteria, ['ship the demo', 'tests pass']);
  assert.equal(reviewedCards.length, 1);
  assert.equal(reviewedCards[0].acceptance_version, 1);
  assert.deepEqual(reviewedCards[0].acceptance_criteria, ['ship the demo', 'tests pass']);
});

test('executor budget-exceeded still records the real provider call in the UsageTracker', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
  const gateRunner = makeFakeGateRunner();
  const usageTracker = new UsageTracker();

  const budgetError = new AdapterError(
    ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED,
    'executor usage exceeded hard budget (cacheCreation=900000/200000)',
    {
      budgetExceededReason: 'cacheCreation=900000/200000',
      callId: 'call-claude-exe-budget-1',
      model: 'sonnet',
      physicalCallReason: 'PRIMARY',
      attempt: 1,
      numTurns: 8,
      costUsd: 0.18,
      usage: {
        input_tokens: 16,
        output_tokens: 2010,
        cache_read_tokens: 287895,
        cache_creation_tokens: 900000,
        num_turns: 8,
        callId: 'call-claude-exe-budget-1',
      },
    }
  );
  const createClaudeSessionManager = makeFakeClaudeManagerFactory(null, () => { throw budgetError; });

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-budget-usage',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession: makeFakeWindowSession(),
    usageTracker,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  const usage = usageTracker.summary();
  assert.equal(usage.executor.calls, 1, 'the consumed provider call must be recorded, not dropped');
  assert.equal(usage.executor.outputTokens, 2010);
  assert.equal(usage.executor.cacheCreationTokens, 900000);
  assert.equal(usage.executor.cacheReadTokens, 287895);
});

test('executor budget-exceeded records a BLOCKING safety event on the workflow state', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-safety-'));
  try {
    const taskCard = demoTaskCard();
    const supervisor = makeFakeSupervisor([{ action: 'NEXT_TASK', task_card: taskCard }]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
    const gateRunner = makeFakeGateRunner();
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-agy-test-loopsafety', kind: 'INTERNAL_TEST', root });

    const budgetError = new AdapterError(
      ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED,
      'executor usage exceeded hard budget (cacheCreation=900000/200000)',
      {
        budgetExceededReason: 'cacheCreation=900000/200000',
        callId: 'call-claude-exe-budget-2',
        model: 'sonnet',
        physicalCallReason: 'PRIMARY',
        attempt: 1,
        numTurns: 8,
        usage: { output_tokens: 2010, cache_read_tokens: 287895, cache_creation_tokens: 900000, num_turns: 8, callId: 'call-claude-exe-budget-2' },
      }
    );
    const createClaudeSessionManager = makeFakeClaudeManagerFactory(null, () => { throw budgetError; });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-agy-test-loopsafety',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    const events = workflowStateManager.getSafetyEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'EXECUTOR_BUDGET_EXCEEDED');
    assert.equal(events[0].severity, 'BLOCKING');
    assert.equal(events[0].role, 'executor');
    assert.match(events[0].reason, /cacheCreation=900000\/200000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── NO NEW INFORMATION -> NO NEW MODEL CALL (Gate-rework loop) ────────
import { summarizeSafetyEvents } from '../src/orchestrator/safetyEvents.js';

test('no-new-information: identical dashboard Gate failure + unchanged diff stops after 2 Executor calls with a BLOCKING safety event', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-nonewinfo-'));
  try {
    const taskCard = demoTaskCard({
      task_id: 'add-vertex-count',
      allowed_files: ['src/utils/graph-algorithms.js', 'tests/graph-algorithms.test.js'],
      verification_commands: ['npm test'],
    });
    const plannedTasks = [{
      task_id: taskCard.task_id,
      goal: taskCard.goal,
      scope: taskCard.scope,
      allowed_files: taskCard.allowed_files,
      verification_commands: taskCard.verification_commands,
    }];

    // Replays the real wf-agy-9a3583e5 shape: the SAME 7 pre-existing
    // dashboard.test.js failures on every attempt, and the Executor's diff
    // never changes (it was correct from attempt 1).
    const DASHBOARD_FAIL = [
      '✖ D. Timeline shows newest-first (1.9ms)',
      '✖ M. /api/workflows returns Attention workflows by default (12ms)',
      '✖ M2. Default selector shows ONLY active/unresolved workflows (2.2ms)',
      '✖ Scenario A: Starting unrelated USER workflow C does NOT supersede (47ms)',
      '✖ Scenario B: Explicit replacement B marks A as SUPERSEDED (20ms)',
      '✖ Scenario D: Workflow A in HUMAN_REQUIRED resume transitions (1.1ms)',
      '✖ Q. API /api/focus and /api/workflows return active focus (9.8ms)',
    ].join('\n');
    const gateRunner = {
      runs: [],
      async run(cmds) {
        this.runs.push(cmds);
        return {
          pass: false,
          results: [{ command: 'npm test', pass: false, exitCode: 1, output: DASHBOARD_FAIL }],
          diff: 'diff --git a/src/utils/graph-algorithms.js b/src/utils/graph-algorithms.js\n+export function vertexCount(graph) {\n+  return collectVertices(graph).size;\n+}\n',
          changed_files: ['src/utils/graph-algorithms.js', 'tests/graph-algorithms.test.js'],
        };
      },
    };

    let supervisorDecideCalls = 0;
    const supervisor = {
      async create() { return { tabId: 501, conversationId: null }; },
      async decide(context) {
        // The initial task comes through NEXT_TASK; any decide() call while a
        // rework is pending would be a model call we are trying to avoid.
        if (context.latestReviewResult && context.latestReviewResult.decision !== 'PASS') {
          supervisorDecideCalls += 1;
          throw new Error('Supervisor model must NOT be called to decide a no-new-information gate rework');
        }
        return { action: 'NEXT_TASK', task_card: taskCard };
      },
      async close() {},
      getIdentity() { return { tabId: 501, conversationId: null }; },
    };

    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
    const createClaudeSessionManager = makeFakeClaudeManagerFactory();
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-nonewinfo', kind: 'INTERNAL_TEST', root });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-nonewinfo',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      workflowGoal: 'add vertexCount',
      repositoryContext: taskCard.repository_context,
      plannedTasks,
      planSummary: 'one bounded task',
      maxAttemptsPerTask: 3,
      maxEscalationAttempts: 2,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(supervisorDecideCalls, 0, 'no model Supervisor call was made');

    // F: real-fixture blast radius — down from 5-6 Executor calls to at most 2.
    const executorCalls = createClaudeSessionManager.managers[0].executions.length;
    assert.ok(executorCalls <= 2, `expected <= 2 Executor calls, got ${executorCalls}`);
    assert.equal(executorCalls, 2);

    // E: the BLOCKING safety event reaches the projection used by
    // supergpt_start_and_wait's terminal result.
    const events = workflowStateManager.getSafetyEvents();
    const projection = summarizeSafetyEvents(events);
    assert.ok(projection.blockingSafetyEvent, 'a blocking safety event is projected');
    assert.equal(projection.blockingSafetyEvent.code, 'NO_NEW_INFORMATION_RETRY_BLOCKED');
    assert.equal(projection.blockingSafetyEvent.severity, 'BLOCKING');
    assert.equal(projection.blockingSafetyEvent.taskId, taskCard.task_id);
    assert.equal(projection.blockingSafetyEvent.attempt, 2);
    assert.ok(projection.blockingSafetyEvent.fingerprint, 'carries the gate fingerprint');
    assert.ok(projection.blockingSafetyEvent.diffHash, 'carries the task diff hash');
    assert.match(projection.blockingSafetyEvent.actionTaken, /no further Executor call/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Workflow-level cumulative cost circuit breaker ───────────────────

import {
  resolveWorkflowCostCeilingUsd,
  workflowCostExceeded,
  DEFAULT_WORKFLOW_MAX_COST_USD,
} from '../src/orchestrator/workflowCostGuard.js';

function costingExecutorManagerFactory({ costUsd, usage }) {
  const managers = [];
  function createClaudeSessionManager({ taskId }) {
    const executions = [];
    const manager = {
      taskId,
      executions,
      async execute(taskCard) {
        executions.push({ taskCard });
        const report = demoExecutionReport(taskCard.task_id);
        Object.defineProperty(report, 'usage', { value: { ...usage }, enumerable: false });
        Object.defineProperty(report, 'callId', { value: usage.callId, enumerable: false });
        report.costUsd = costUsd;
        report.model = 'sonnet';
        return report;
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

test('workflow cost breaker: threshold-crossing call is recorded, then no further model call runs', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-cost-'));
  try {
    const taskCard = demoTaskCard();
    const supervisor = makeFakeSupervisor([
      { action: 'NEXT_TASK', task_card: taskCard },
      { action: 'WORKFLOW_DONE', summary: 'should never be reached' },
    ]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
    const gateRunner = makeFakeGateRunner();
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-agy-test-costbreak', kind: 'INTERNAL_TEST', root });

    // One valid Executor call that costs $0.12 — individually fine, but it
    // crosses the $0.10 aggregate ceiling.
    const createClaudeSessionManager = costingExecutorManagerFactory({
      costUsd: 0.12,
      usage: { input_tokens: 1000, output_tokens: 200, num_turns: 4, callId: 'call-claude-exe-cost-1' },
    });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-agy-test-costbreak',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      workflowCostCeilingUsd: 0.10,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    // C2: the crossing call's usage is recorded.
    const usage = usageTracker.summary();
    assert.equal(usage.executor.calls, 1);
    assert.equal(usage.executor.costUsd, 0.12);
    // C5: no subsequent model call — the Reviewer is never invoked (its tab
    // is never opened, review() never runs), and the supervisor is only
    // consulted once (before the executor), never again.
    const reviewerSessions = createReviewerSession.created;
    assert.ok(reviewerSessions.every((s) => s.created === false && s.reviewCalls === 0));
    assert.equal(supervisor.calls.length, 1);
    // C3 + C4: a BLOCKING safety event on the existing safety path.
    const events = workflowStateManager.getSafetyEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'WORKFLOW_COST_BUDGET_EXCEEDED');
    assert.equal(events[0].severity, 'BLOCKING');
    assert.match(events[0].reason, /exceeded the hard ceiling/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workflow cost breaker: a run that stays under the ceiling completes normally', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done under budget' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const gateRunner = makeFakeGateRunner();
  const usageTracker = new UsageTracker();
  const createClaudeSessionManager = costingExecutorManagerFactory({
    costUsd: 0.12,
    usage: { input_tokens: 1000, output_tokens: 200, num_turns: 4, callId: 'call-claude-exe-cost-ok' },
  });

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-cost-ok',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    windowSession: makeFakeWindowSession(),
    usageTracker,
    workflowCostCeilingUsd: 1.00,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(createReviewerSession.created.length, 1);
  assert.equal(usageTracker.summary().executor.costUsd, 0.12);
});

test('workflow cost guard: config resolution + dedupe-safe aggregate', () => {
  assert.equal(resolveWorkflowCostCeilingUsd({}), DEFAULT_WORKFLOW_MAX_COST_USD);
  assert.equal(resolveWorkflowCostCeilingUsd({ WORKFLOW_MAX_COST_USD: '2.5' }), 2.5);
  assert.equal(resolveWorkflowCostCeilingUsd({ WORKFLOW_MAX_COST_USD: '0' }), 0, 'non-positive disables the breaker');
  assert.equal(resolveWorkflowCostCeilingUsd({ WORKFLOW_MAX_COST_USD: 'nonsense' }), 0);

  const tracker = new UsageTracker();
  const rec = { workflowId: 'w', role: 'executor', callId: 'dup-1', taskId: 't', attempt: 1,
    model: 'sonnet', usage: { input_tokens: 10, output_tokens: 5, callId: 'dup-1' }, costUsd: 4.0 };
  tracker.record(rec);
  tracker.record(rec); // identical physical call — must not double-count
  assert.equal(tracker.summary().measuredTotal.costUsd, 4.0);
  assert.equal(workflowCostExceeded(tracker, 5.0), null);
  assert.deepEqual(
    { ...workflowCostExceeded(tracker, 3.0) },
    { totalCostUsd: 4.0, limitUsd: 3.0 },
  );
  assert.equal(workflowCostExceeded(tracker, 0), null, 'disabled ceiling never trips');
});

// ── Workflow cost breaker survives resume (whole-workflow, not per-process) ──

import { rehydrateUsageFromState } from '../src/orchestrator/workflowCostGuard.js';

// Build a UsageTracker holding ~$totalUsd of recorded model calls, then return
// the persisted-state shape (`{ tokenUsage: tracker.summary() }`) a prior
// process would have written to <workflowId>.state.json.
function persistedStateWithCost(perCall) {
  const tracker = new UsageTracker();
  perCall.forEach((costUsd, i) => {
    tracker.record({
      workflowId: 'wf-resume', role: i % 2 === 0 ? 'executor' : 'supervisor',
      callId: `prior-call-${i}`, taskId: `t${i}`, attempt: 1, model: 'sonnet',
      usage: { input_tokens: 100, output_tokens: 20, callId: `prior-call-${i}` },
      costUsd,
    });
  });
  return { tokenUsage: tracker.summary() };
}

test('resume: rehydrateUsageFromState restores the exact prior aggregate and is replay-safe', () => {
  const priorState = persistedStateWithCost([2.0, 1.5, 0.5]); // $4.00 total

  const fresh = new UsageTracker();
  const folded = rehydrateUsageFromState(fresh, priorState);
  assert.equal(folded, 3);
  assert.equal(fresh.summary().measuredTotal.costUsd, 4.0);

  // Replaying the same snapshot (e.g. a second resume) must not inflate it.
  rehydrateUsageFromState(fresh, priorState);
  assert.equal(fresh.summary().measuredTotal.costUsd, 4.0);

  // A genuinely new call in this process adds on top of the restored total.
  fresh.record({ workflowId: 'wf-resume', role: 'executor', callId: 'new-1', taskId: 'tN', attempt: 1,
    model: 'sonnet', usage: { input_tokens: 10, output_tokens: 5, callId: 'new-1' }, costUsd: 0.3 });
  assert.equal(fresh.summary().measuredTotal.costUsd, 4.3);

  // No prior snapshot → no-op.
  assert.equal(rehydrateUsageFromState(new UsageTracker(), null), 0);
  assert.equal(rehydrateUsageFromState(new UsageTracker(), { tokenUsage: { records: [] } }), 0);
});

test('resume: restored $4.00 + a new $1.20 call crosses the $5 ceiling — recorded, BLOCKING, HUMAN_REQUIRED, no later call', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-resume-cost-'));
  try {
    const taskCard = demoTaskCard();

    // ── prior process: accumulate $4.00, persist ──────────────────────
    const priorState = persistedStateWithCost([2.5, 1.0, 0.5]);
    assert.equal(new UsageTracker().summary().measuredTotal.costUsd, 0);

    // ── restart: fresh tracker, rehydrated from the persisted snapshot ─
    const usageTracker = new UsageTracker();
    rehydrateUsageFromState(usageTracker, priorState);
    assert.equal(usageTracker.summary().measuredTotal.costUsd, 4.0, 'restored aggregate is $4.00, not $0');

    const supervisor = makeFakeSupervisor([
      { action: 'NEXT_TASK', task_card: taskCard },
      { action: 'WORKFLOW_DONE', summary: 'never reached' },
    ]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-agy-test-resumecost', kind: 'INTERNAL_TEST', root });
    const createClaudeSessionManager = costingExecutorManagerFactory({
      costUsd: 1.20,
      usage: { input_tokens: 1000, output_tokens: 200, num_turns: 4, callId: 'call-claude-exe-resume-cross' },
    });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-agy-test-resumecost',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      workflowCostCeilingUsd: 5.0,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    const usage = usageTracker.summary();
    // the crossing call itself is recorded exactly once...
    assert.equal(usage.records.filter((r) => r.callId === 'call-claude-exe-resume-cross').length, 1);
    // ...on top of the 2 restored executor calls (indices 0 + 2), 3 total.
    assert.equal(usage.executor.calls, 3);
    // restored ($4.00) + new ($1.20) = $5.20
    assert.equal(Number(usage.measuredTotal.costUsd.toFixed(2)), 5.20);
    // no later model call
    const reviewerSessions = createReviewerSession.created;
    assert.ok(reviewerSessions.every((s) => s.created === false && s.reviewCalls === 0));
    assert.equal(supervisor.calls.length, 1);
    // BLOCKING safety event on the existing path
    const events = workflowStateManager.getSafetyEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'WORKFLOW_COST_BUDGET_EXCEEDED');
    assert.equal(events[0].severity, 'BLOCKING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume: restored cost + new cost still under the ceiling continues normally', async () => {
  const taskCard = demoTaskCard();
  const priorState = persistedStateWithCost([2.0, 1.0, 0.5]); // $3.50
  const usageTracker = new UsageTracker();
  rehydrateUsageFromState(usageTracker, priorState);
  assert.equal(usageTracker.summary().measuredTotal.costUsd, 3.5);

  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done under budget after resume' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = costingExecutorManagerFactory({
    costUsd: 0.50,
    usage: { input_tokens: 1000, output_tokens: 200, num_turns: 4, callId: 'call-claude-exe-resume-ok' },
  });

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-resume-ok',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    usageTracker,
    workflowCostCeilingUsd: 5.0,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(createReviewerSession.created[0].reviewCalls, 1);
  assert.equal(Number(usageTracker.summary().measuredTotal.costUsd.toFixed(2)), 4.0);
});

// ════════════════════════════════════════════════════════════════════
//  MECHANICAL TOKEN CEILINGS — the last-resort fuse
//  (1) per-Task Executor cumulative usageVolume
//  (2) per-Task Executor physical-call count
//  (3) whole-workflow cumulative usageVolume
//  + resume continuity for all three.
// ════════════════════════════════════════════════════════════════════

import {
  executorTaskUsage,
  taskExecutorCeilingExceeded,
  workflowUsageVolumeExceeded,
} from '../src/orchestrator/workflowCostGuard.js';

// Executor manager whose every execute() is a distinct physical call
// (unique callId) contributing `perCallVolume` processed tokens. costUsd is
// left null by default so the volume guards are exercised in isolation from
// the dollar cost breaker.
function volumeExecutorManagerFactory({ perCallVolume = 100_000, costUsd = null } = {}) {
  let n = 0;
  const managers = [];
  function createClaudeSessionManager({ taskId }) {
    const executions = [];
    const manager = {
      taskId,
      executions,
      async execute(taskCard) {
        n += 1;
        executions.push({ taskCard, n });
        const callId = `call-vol-${taskCard.task_id}-${n}`;
        const report = demoExecutionReport(taskCard.task_id);
        Object.defineProperty(report, 'usage', {
          value: { input_tokens: perCallVolume, output_tokens: 0, callId },
          enumerable: false,
        });
        Object.defineProperty(report, 'callId', { value: callId, enumerable: false });
        report.costUsd = costUsd;
        report.model = 'sonnet';
        return report;
      },
    };
    managers.push(manager);
    return manager;
  }
  createClaudeSessionManager.managers = managers;
  return createClaudeSessionManager;
}

function reworkForever(taskCard, rounds = 30) {
  const decisions = [{ action: 'NEXT_TASK', task_card: taskCard }];
  for (let i = 0; i < rounds; i += 1) decisions.push({ action: 'CONTINUE_REWORK' });
  decisions.push({ action: 'WORKFLOW_DONE', summary: 'never reached' });
  const reworkQueue = [];
  for (let i = 0; i < rounds; i += 1) reworkQueue.push(reworkResult(taskCard.task_id));
  return { decisions, reworkQueue };
}

function persistedStateWithExecutorVolume(perCallVolumes, { taskId = 't-prior', workflowId = 'wf-resume-vol' } = {}) {
  const tracker = new UsageTracker();
  perCallVolumes.forEach((vol, i) => tracker.record({
    workflowId, role: 'executor', callId: `prior-vol-${i}`, taskId, attempt: 1, model: 'sonnet',
    usage: { input_tokens: vol, output_tokens: 0, callId: `prior-vol-${i}` },
  }));
  return { tokenUsage: tracker.summary() };
}

// ── unit: the pure counters ─────────────────────────────────────────

test('token fuse unit: executorTaskUsage counts every physical-call reason, ignores dup/deterministic/other-task', () => {
  const t = new UsageTracker();
  for (const [i, reason] of ['PRIMARY', 'RETRY', 'FAILOVER', 'PROBE'].entries()) {
    t.record({
      workflowId: 'w', role: 'executor', callId: `c${i}`, taskId: 'task-1', attempt: i + 1, model: 'sonnet',
      physicalCallReason: reason,
      usage: { input_tokens: 100_000, output_tokens: 10_000, callId: `c${i}` },
    });
  }
  // a byte-identical replay of c0 — must NOT add a call
  t.record({
    workflowId: 'w', role: 'executor', callId: 'c0', taskId: 'task-1', attempt: 1, model: 'sonnet',
    usage: { input_tokens: 100_000, output_tokens: 10_000, callId: 'c0' },
  });
  // a different task, and a supervisor call — neither counts for task-1
  t.record({ workflowId: 'w', role: 'executor', callId: 'other', taskId: 'task-2', attempt: 1, model: 'sonnet', usage: { input_tokens: 500_000, output_tokens: 0, callId: 'other' } });
  t.record({ workflowId: 'w', role: 'supervisor', callId: 'sup', taskId: 'task-1', attempt: 1, model: 'sonnet', usage: { input_tokens: 999_999, output_tokens: 0, callId: 'sup' } });

  const u = executorTaskUsage(t, 'task-1');
  assert.equal(u.physicalCalls, 4, 'PRIMARY + RETRY + FAILOVER + PROBE all count; the replay does not');
  assert.equal(u.usageVolume, 4 * 110_000);

  // call ceiling checked before volume; >= semantics
  assert.equal(taskExecutorCeilingExceeded(t, 'task-1', { callLimit: 5, volumeLimit: 0 }), null);
  assert.deepEqual(
    { ...taskExecutorCeilingExceeded(t, 'task-1', { callLimit: 4, volumeLimit: 0 }) },
    { kind: 'CALLS', physicalCalls: 4, usageVolume: 440_000, limit: 4 },
  );
  assert.equal(taskExecutorCeilingExceeded(t, 'task-1', { callLimit: 0, volumeLimit: 440_001 }), null, '439,999 < limit passes');
  assert.equal(taskExecutorCeilingExceeded(t, 'task-1', { callLimit: 0, volumeLimit: 440_000 }).kind, 'VOLUME', 'reaching the limit trips');
});

test('token fuse unit: workflowUsageVolumeExceeded uses >= on the deduplicated measuredTotal', () => {
  const t = new UsageTracker();
  t.record({ workflowId: 'w', role: 'executor', callId: 'a', taskId: 't', attempt: 1, model: 'sonnet', usage: { input_tokens: 1_490_000, output_tokens: 0, callId: 'a' } });
  assert.equal(workflowUsageVolumeExceeded(t, 1_500_000), null, '1.49M < 1.5M');
  assert.equal(workflowUsageVolumeExceeded(t, 0), null, 'disabled ceiling never trips');
  t.record({ workflowId: 'w', role: 'executor', callId: 'b', taskId: 't', attempt: 2, model: 'sonnet', usage: { input_tokens: 10_000, output_tokens: 0, callId: 'b' } });
  assert.deepEqual(
    { ...workflowUsageVolumeExceeded(t, 1_500_000) },
    { totalUsageVolume: 1_500_000, limit: 1_500_000 },
  );
});

// ── integration: per-Task Executor physical-call ceiling ────────────

test('token fuse: a Task is stopped BEFORE the 5th real Executor call (MAX_EXECUTOR_PHYSICAL_CALLS_PER_TASK=4)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-callceil-'));
  try {
    const taskCard = demoTaskCard();
    const { decisions, reworkQueue } = reworkForever(taskCard);
    const supervisor = makeFakeSupervisor(decisions);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-callceil', kind: 'INTERNAL_TEST', root });
    const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 10_000 });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-callceil',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      // the heuristic bounds are set high so it is the mechanical fuse that fires
      maxAttemptsPerTask: 20,
      maxEscalationAttempts: 20,
      executorPhysicalCallCeiling: 4,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 4, 'exactly 4 physical Executor calls, never a 5th');
    assert.equal(usageTracker.summary().executor.calls, 4);
    // the Reviewer ran once per COMPLETED round (4), never for the blocked 5th
    assert.equal(createReviewerSession.created[0].reviewCalls, 4);
    const events = workflowStateManager.getSafetyEvents();
    const blocking = events.filter((e) => e.severity === 'BLOCKING');
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, 'EXECUTOR_CALL_CEILING_EXCEEDED');
    assert.equal(blocking[0].role, 'executor');
    assert.equal(blocking[0].taskId, taskCard.task_id);
    assert.equal(blocking[0].physicalCalls, 4);
    assert.equal(blocking[0].limit, 4);
    assert.match(blocking[0].reason, /physical-call ceiling/);
    // terminal projection carries it to the Front Agent
    const proj = summarizeSafetyEvents(events);
    assert.equal(proj.blockingSafetyEvent.code, 'EXECUTOR_CALL_CEILING_EXCEEDED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── integration: per-Task Executor cumulative usageVolume ceiling ───

test('token fuse: a Task is stopped once its Executor cumulative usageVolume reaches TASK_MAX_EXECUTOR_USAGE_VOLUME', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-taskvol-'));
  try {
    const taskCard = demoTaskCard();
    const { decisions, reworkQueue } = reworkForever(taskCard);
    const supervisor = makeFakeSupervisor(decisions);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-taskvol', kind: 'INTERNAL_TEST', root });
    // 300k per call: after call 2 the task sits at exactly 600k -> call 3 blocked.
    const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 300_000 });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-taskvol',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      maxAttemptsPerTask: 20,
      maxEscalationAttempts: 20,
      taskExecutorUsageVolumeCeiling: 600_000,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 2, '590k would pass; 600k blocks the next call');
    const blocking = workflowStateManager.getSafetyEvents().filter((e) => e.severity === 'BLOCKING');
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, 'TASK_EXECUTOR_USAGE_VOLUME_EXCEEDED');
    assert.equal(blocking[0].usageVolume, 600_000);
    assert.equal(blocking[0].limit, 600_000);
    assert.equal(blocking[0].physicalCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── integration: whole-workflow cumulative usageVolume ceiling ──────

test('token fuse: the whole workflow is stopped once measuredTotal.usageVolume reaches WORKFLOW_MAX_USAGE_VOLUME (cost-source independent)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-wfvol-'));
  try {
    const taskCard = demoTaskCard();
    const { decisions, reworkQueue } = reworkForever(taskCard);
    const supervisor = makeFakeSupervisor(decisions);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
    const usageTracker = new UsageTracker();
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-wfvol', kind: 'INTERNAL_TEST', root });
    // 800k per call, NO costUsd reported at all.
    const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 800_000, costUsd: null });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-wfvol',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      maxAttemptsPerTask: 20,
      maxEscalationAttempts: 20,
      // dollar ceiling ON but useless here: the provider reports no cost
      workflowCostCeilingUsd: 5.0,
      workflowUsageVolumeCeiling: 1_500_000,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 2, '800k then 1.6M — the 3rd call is blocked');
    const summary = usageTracker.summary();
    assert.equal(summary.measuredTotal.costUsd, 0, 'no cost was ever reported');
    assert.equal(summary.measuredTotal.usageVolume, 1_600_000);
    const blocking = workflowStateManager.getSafetyEvents().filter((e) => e.severity === 'BLOCKING');
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, 'WORKFLOW_USAGE_VOLUME_EXCEEDED');
    assert.equal(blocking[0].role, 'workflow');
    assert.equal(blocking[0].limit, 1_500_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('token fuse: a workflow that stays under every ceiling completes normally', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'done under every ceiling' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const usageTracker = new UsageTracker();
  const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 200_000, costUsd: 0.1 });

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-underceil',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner: makeFakeGateRunner(),
    windowSession: makeFakeWindowSession(),
    usageTracker,
    workflowCostCeilingUsd: 5.0,
    workflowUsageVolumeCeiling: 1_500_000,
    taskExecutorUsageVolumeCeiling: 600_000,
    executorPhysicalCallCeiling: 4,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 1);
  assert.equal(usageTracker.summary().executor.calls, 1);
});

// ── resume continuity ──────────────────────────────────────────────

test('token fuse resume: 1.4M persisted volume + a new 150k call crosses the 1.5M workflow ceiling', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-resume-vol-'));
  try {
    const taskCard = demoTaskCard();
    const priorState = persistedStateWithExecutorVolume([700_000, 700_000]); // 1.4M
    const usageTracker = new UsageTracker();
    rehydrateUsageFromState(usageTracker, priorState);
    assert.equal(usageTracker.summary().measuredTotal.usageVolume, 1_400_000, 'restored 1.4M, not 0');

    const { decisions, reworkQueue } = reworkForever(taskCard);
    const supervisor = makeFakeSupervisor(decisions);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-resume-vol-loop', kind: 'INTERNAL_TEST', root });
    const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 150_000 });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-resume-vol-loop',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      maxAttemptsPerTask: 20,
      maxEscalationAttempts: 20,
      workflowUsageVolumeCeiling: 1_500_000,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 1, 'one new call (1.4M -> 1.55M), then blocked — not reset to 0');
    assert.equal(usageTracker.summary().measuredTotal.usageVolume, 1_550_000);
    assert.equal(workflowStateManager.getSafetyEvents().filter((e) => e.severity === 'BLOCKING')[0].code, 'WORKFLOW_USAGE_VOLUME_EXCEEDED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('token fuse resume: a Task with 4 persisted Executor physical calls gets no 5th after restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-resume-calls-'));
  try {
    const taskCard = demoTaskCard(); // task_id: 'task-1'
    const priorState = persistedStateWithExecutorVolume([50_000, 50_000, 50_000, 50_000], { taskId: 'task-1' });
    const usageTracker = new UsageTracker();
    rehydrateUsageFromState(usageTracker, priorState);
    assert.equal(executorTaskUsage(usageTracker, 'task-1').physicalCalls, 4);

    const { decisions, reworkQueue } = reworkForever(taskCard);
    const supervisor = makeFakeSupervisor(decisions);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: reworkQueue });
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-resume-calls-loop', kind: 'INTERNAL_TEST', root });
    const createClaudeSessionManager = volumeExecutorManagerFactory({ perCallVolume: 10_000 });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-resume-calls-loop',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner: makeFakeGateRunner(),
      windowSession: makeFakeWindowSession(),
      usageTracker,
      workflowStateManager,
      maxAttemptsPerTask: 20,
      maxEscalationAttempts: 20,
      executorPhysicalCallCeiling: 4,
      workflowGoal: 'ship it',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 0, 'the ceiling was already reached before restart — zero new physical calls');
    assert.ok(createReviewerSession.created.every((s) => s.reviewCalls === 0), 'no Reviewer dispatch after the block');
    assert.equal(supervisor.calls.length, 1, 'Supervisor consulted once to pick the task, never again after the block');
    assert.equal(workflowStateManager.getSafetyEvents().filter((e) => e.severity === 'BLOCKING')[0].code, 'EXECUTOR_CALL_CEILING_EXCEEDED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── BASELINE-DIFF GATE ──────────────────────────────────────────────────
// Pre-existing / out-of-scope verification failures are attributed to the
// repository baseline, never to the current task, and never drive REWORK.

// A gate runner that returns a fixed evidence object (optionally a different
// one after the first call), and counts its calls.
function fixedGateRunner(evidence, evidenceAfterFirst) {
  const runs = [];
  return {
    runs,
    async run(commands) {
      runs.push(commands);
      const ev = (runs.length > 1 && evidenceAfterFirst) ? evidenceAfterFirst : evidence;
      return JSON.parse(JSON.stringify(ev));
    },
  };
}
function failEvidence(failLines) {
  return {
    pass: false,
    results: [{ command: 'npm test', pass: false, exitCode: 1, output: failLines.join('\n') }],
    changed_files: ['src/x.js'],
    diff: 'diff --git a/src/x.js b/src/x.js\n+// change\n',
  };
}
const DASHBOARD_3 = ['✖ dashboard A (1ms)', '✖ dashboard B (2ms)', '✖ dashboard C (3ms)'];

test('baseline-diff A: identical pre-existing failures -> task Gate PASSes, no REWORK, 1 Executor call, WARNING event', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-bdg-a-'));
  try {
    const taskCard = demoTaskCard({ task_id: 'add-feature', verification_commands: ['npm test'] });
    const supervisor = makeFakeSupervisor([
      { action: 'NEXT_TASK', task_card: taskCard },
      { action: 'WORKFLOW_DONE', summary: 'done — baseline failures are not mine' },
    ]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
    const createClaudeSessionManager = makeFakeClaudeManagerFactory();
    const baselineGateRunner = fixedGateRunner(failEvidence(DASHBOARD_3));
    const gateRunner = fixedGateRunner(failEvidence(DASHBOARD_3));
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-bdg-a', kind: 'INTERNAL_TEST', root });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-bdg-a',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      baselineGateRunner,
      windowSession: makeFakeWindowSession(),
      workflowStateManager,
      workflowGoal: 'add a feature',
      repositoryContext: taskCard.repository_context,
    });

    assert.equal(result.status, 'WORKFLOW_DONE');
    assert.equal(baselineGateRunner.runs.length, 1, 'baseline verification ran exactly once (pre-Executor)');
    assert.equal(createClaudeSessionManager.managers[0].executions.length, 1, 'no REWORK — a single Executor call');
    assert.equal(createReviewerSession.created[0].reviewCalls, 1, 'the task reached the Reviewer (treated as Gate PASS)');

    const projection = summarizeSafetyEvents(workflowStateManager.getSafetyEvents());
    assert.equal(projection.hasBlocking, false, 'ignoring baseline failures is not BLOCKING');
    const warn = projection.warningSafetyEvents.find((e) => e.code === 'PREEXISTING_VERIFICATION_FAILURES');
    assert.ok(warn, 'a PREEXISTING_VERIFICATION_FAILURES warning is recorded');
    assert.match(warn.reason, /dashboard A/);
    assert.equal(warn.taskId, taskCard.task_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline-diff B: current adds a NEW failure -> Gate FAIL, required_changes scoped to the new failure only', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-bdg-b-'));
  try {
    const taskCard = demoTaskCard({ task_id: 'graph-algorithms', verification_commands: ['npm test'] });
    const supervisor = makeFakeSupervisor([
      { action: 'NEXT_TASK', task_card: taskCard },
      { action: 'CONTINUE_REWORK' },
      { action: 'CONTINUE_REWORK' },
      { action: 'CONTINUE_REWORK' },
      { action: 'CONTINUE_REWORK' },
    ]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [] });
    const createClaudeSessionManager = makeFakeClaudeManagerFactory();
    const baselineGateRunner = fixedGateRunner(failEvidence(DASHBOARD_3));
    // Every post-Executor gate run: the 3 pre-existing + 1 genuinely new failure.
    const gateRunner = fixedGateRunner(failEvidence([...DASHBOARD_3, '✖ graph vertexCount is correct (4ms)']));
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-bdg-b', kind: 'INTERNAL_TEST', root });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-bdg-b',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      baselineGateRunner,
      windowSession: makeFakeWindowSession(),
      workflowStateManager,
      workflowGoal: 'implement graph algorithms',
      repositoryContext: taskCard.repository_context,
      maxAttemptsPerTask: 2,
      maxEscalationAttempts: 1,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED', 'the NEW failure keeps driving REWORK until the guard trips');
    const attempts = workflowStateManager.getState().taskAttempts.filter((a) => a.gateResult === 'FAIL');
    assert.ok(attempts.length >= 1);
    for (const a of attempts) {
      const joined = (a.requiredChanges || []).join(' | ');
      assert.match(joined, /graph vertexCount is correct/, 'required_changes cite the new failure');
      assert.doesNotMatch(joined, /dashboard/, 'required_changes never cite a pre-existing baseline failure');
    }
    // The pre-existing failures are not silently dropped — they are still in
    // the Gate evidence's baselineDiff.
    assert.ok(result.history !== undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline-diff F: on resume the persisted baseline is reused — baseline verification never re-runs on the modified worktree', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-bdg-f-'));
  try {
    const taskCard = demoTaskCard({ task_id: 'resume-task', verification_commands: ['npm test'] });

    // A hand-built live-rework checkpoint that already carries a persisted
    // pre-Executor baseline (3 pre-existing dashboard failures).
    const checkpoint = {
      history: [],
      currentTaskCard: taskCard,
      currentTaskId: taskCard.task_id,
      attempt: 1,
      normalAttempts: 1,
      escalationAttempts: 0,
      escalationActive: false,
      reviewRound: 1,
      latestReviewResult: {
        task_id: taskCard.task_id,
        decision: 'REWORK',
        round: 1,
        source: 'GATE',
        required_changes: ['Fix newly failing test/assertion introduced by this task: graph test D'],
        findings: 'x',
        rationale: 'y',
      },
      taskBaseline: {
        taskId: taskCard.task_id,
        commandsHash: 'deadbeef',
        evidence: {
          pass: false,
          results: [{ command: 'npm test', pass: false, exitCode: 1, output: DASHBOARD_3.join('\n') }],
        },
      },
    };

    const supervisor = makeFakeSupervisor([
      { action: 'CONTINUE_REWORK' },
      { action: 'WORKFLOW_DONE', summary: 'resumed and passed' },
    ]);
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
    const createClaudeSessionManager = makeFakeClaudeManagerFactory();
    // Post-Executor gate: the Executor fixed the new failure, only the 3
    // pre-existing dashboard failures remain.
    const gateRunner = fixedGateRunner(failEvidence(DASHBOARD_3));
    let baselineReran = false;
    const baselineGateRunner = {
      runs: [],
      async run() {
        baselineReran = true;
        throw new Error('baseline verification must NOT re-run on a resumed (already-modified) worktree');
      },
    };
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-bdg-f', kind: 'INTERNAL_TEST', root });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-bdg-f',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      baselineGateRunner,
      windowSession: makeFakeWindowSession(),
      workflowStateManager,
      workflowGoal: 'resume with a persisted baseline',
      repositoryContext: taskCard.repository_context,
      checkpoint,
      maxAttemptsPerTask: 5,
    });

    assert.equal(baselineReran, false, 'baseline verification was not re-run on resume');
    assert.equal(result.status, 'WORKFLOW_DONE');
    // The restored baseline let the Gate suppress the 3 pre-existing failures.
    const projection = summarizeSafetyEvents(workflowStateManager.getSafetyEvents());
    assert.ok(projection.warningSafetyEvents.some((e) => e.code === 'PREEXISTING_VERIFICATION_FAILURES'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline-diff G: wf-agy-9a3583e5 replay — 7 pre-existing dashboard failures, correct impl -> 1 Executor call, task PASS', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');

  const root = mkdtempSync(nodePath.join(tmpdir(), 'loop-bdg-g-'));
  try {
    const taskCard = demoTaskCard({
      task_id: 'add-vertex-count',
      allowed_files: ['src/utils/graph-algorithms.js', 'tests/graph-algorithms.test.js'],
      verification_commands: ['npm test'],
    });
    const plannedTasks = [{
      task_id: taskCard.task_id,
      goal: taskCard.goal,
      scope: taskCard.scope,
      allowed_files: taskCard.allowed_files,
      verification_commands: taskCard.verification_commands,
    }];
    const DASHBOARD_7 = [
      '✖ D. Timeline shows newest-first (1.9ms)',
      '✖ M. /api/workflows returns Attention workflows by default (12ms)',
      '✖ M2. Default selector shows ONLY active/unresolved workflows (2.2ms)',
      '✖ Scenario A: Starting unrelated USER workflow C does NOT supersede (47ms)',
      '✖ Scenario B: Explicit replacement B marks A as SUPERSEDED (20ms)',
      '✖ Scenario D: Workflow A in HUMAN_REQUIRED resume transitions (1.1ms)',
      '✖ Q. API /api/focus and /api/workflows return active focus (9.8ms)',
    ];
    const supervisor = {
      async create() { return { tabId: 501, conversationId: null }; },
      async decide(context) {
        if (context.latestReviewResult && context.latestReviewResult.decision !== 'PASS') {
          throw new Error('Supervisor must NOT be consulted — the task PASSes on baseline-diff');
        }
        return { action: 'NEXT_TASK', task_card: taskCard };
      },
      async close() {},
      getIdentity() { return { tabId: 501, conversationId: null }; },
    };
    const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
    const createClaudeSessionManager = makeFakeClaudeManagerFactory();
    const baselineGateRunner = fixedGateRunner(failEvidence(DASHBOARD_7));
    const gateRunner = fixedGateRunner(failEvidence(DASHBOARD_7));
    const workflowStateManager = new WorkflowStateManager({ workflowId: 'wf-bdg-g', kind: 'INTERNAL_TEST', root });

    const result = await runAutomatedWorkflow({
      workflowId: 'wf-bdg-g',
      supervisorSession: supervisor,
      createReviewerSession,
      createClaudeSessionManager,
      gateRunner,
      baselineGateRunner,
      windowSession: makeFakeWindowSession(),
      workflowStateManager,
      workflowGoal: 'add vertexCount',
      repositoryContext: taskCard.repository_context,
      plannedTasks,
      planSummary: 'one bounded task',
      maxAttemptsPerTask: 3,
      maxEscalationAttempts: 2,
    });

    assert.equal(result.status, 'WORKFLOW_DONE');
    assert.equal(
      createClaudeSessionManager.managers[0].executions.length,
      1,
      'baseline-diff drops the Executor call count from ~2 (no-new-information) to 1',
    );
    const projection = summarizeSafetyEvents(workflowStateManager.getSafetyEvents());
    const warn = projection.warningSafetyEvents.find((e) => e.code === 'PREEXISTING_VERIFICATION_FAILURES');
    assert.ok(warn, 'user is told the repository still has pre-existing verification failures');
    assert.match(warn.reason, /Timeline shows newest-first/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
