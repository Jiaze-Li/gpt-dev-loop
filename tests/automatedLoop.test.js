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
function makeFakeSupervisor(decisions) {
  const queue = [...decisions];
  const calls = [];
  let created = false;
  let closed = false;
  return {
    calls,
    isCreated: () => created,
    isClosed: () => closed,
    async create() {
      created = true;
    },
    async decide(context) {
      calls.push(context);
      if (queue.length === 0) throw new Error('fake supervisor: no more queued decisions');
      return queue.shift();
    },
    async close() {
      closed = true;
    },
  };
}

// Fake ReviewerSession factory: each call to the factory returns a new
// object with its own identity, so tests can assert "same task -> same
// object" / "different task -> different object" by reference.
function makeFakeReviewerFactory(resultsByTaskId) {
  const created = [];
  function makeReviewerSession() {
    const session = {
      id: created.length + 1,
      taskId: null,
      reviewCalls: 0,
      closed: false,
      async create(taskId) {
        session.taskId = taskId;
      },
      async review(taskId, taskCard, executionReport, evidence) {
        assert.equal(taskId, session.taskId, 'review() called with a taskId this session was not create()d for');
        session.reviewCalls += 1;
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

// Fake ClaudeSessionManager factory: each execute() call is tracked with a
// unique incrementing sessionNumber, mirroring the real
// ClaudeSessionManager's "fresh session per execute() call" contract.
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
  const runs = [];
  return {
    runs,
    async run(verificationCommands) {
      runs.push(verificationCommands);
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

test('1. NEXT_TASK -> Claude -> Reviewer PASS -> Supervisor WORKFLOW_DONE', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'WORKFLOW_DONE', summary: 'all done' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [passResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-1',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-2',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-3',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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

  await runAutomatedWorkflow({
    workflowId: 'wf-4',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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

  await runAutomatedWorkflow({
    workflowId: 'wf-5',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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

test('6. HUMAN_REQUIRED stops immediately and does not close either session', async () => {
  const taskCard = demoTaskCard();
  const supervisor = makeFakeSupervisor([
    { action: 'NEXT_TASK', task_card: taskCard },
    { action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'which behavior is correct?' },
  ]);
  const createReviewerSession = makeFakeReviewerFactory({ [taskCard.task_id]: [reworkResult(taskCard.task_id)] });
  const createClaudeSessionManager = makeFakeClaudeManagerFactory();
  const gateRunner = makeFakeGateRunner();
  const persistence = makeFakePersistence();

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-6',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.reason, 'ambiguous spec');
  assert.equal(result.question, 'which behavior is correct?');
  assert.equal(supervisor.isClosed(), false);
  assert.equal(createReviewerSession.created[0].closed, false);
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

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-7',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
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

  await assert.rejects(
    () =>
      runAutomatedWorkflow({
        workflowId: 'wf-8',
        supervisorSession: supervisor,
        createReviewerSession,
        createClaudeSessionManager,
        gateRunner,
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

  const result = await runAutomatedWorkflow({
    workflowId: 'wf-9',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
    persistence,
    workflowGoal: 'ship it',
    repositoryContext: taskCard.repository_context,
    maxAttemptsPerTask: 3,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.match(result.reason, /maxAttemptsPerTask/);
  assert.equal(result.taskId, taskCard.task_id);
  assert.equal(createClaudeSessionManager.managers[0].executions.length, 3);
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

  await runAutomatedWorkflow({
    workflowId: 'wf-10',
    supervisorSession: supervisor,
    createReviewerSession,
    createClaudeSessionManager,
    gateRunner,
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
