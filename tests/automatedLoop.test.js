import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

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
  return {
    writes,
    async writeState(state) {
      writes.push(state);
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

test('9. maxAttemptsPerTask stops an infinite CONTINUE_REWORK loop with HUMAN_REQUIRED', async () => {
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
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /maxAttemptsPerTask/);
  assert.equal(result.taskId, taskCard.task_id);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 3);
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
