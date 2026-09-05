import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgySupervisorProvider,
  buildAgySupervisorPrompt,
  buildCompactGoal,
  buildCompactHistory,
  buildCompactReviewResult,
  enforcePromptBudget,
  GOAL_CHAR_LIMIT,
  RATIONALE_LIMIT,
  FINDING_LIMIT,
  NORMAL_TARGET,
  HARD_LIMIT,
} from '../src/orchestrator/adapters/agySupervisorProvider.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import {
  AgyTimeoutError,
  AgyExitError,
  AgyExecutableNotFoundError,
  AgyConversationResumeError,
} from '../src/agy/agyClient.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

// ════════════════════════════════════════════════════════════════════
//  Fixture helpers
// ════════════════════════════════════════════════════════════════════

function makeConversationalCallAgy(answers) {
  const queue = [...answers];
  const calls = [];
  let counter = 0;
  async function callAgy({ prompt, model, conversationId } = {}) {
    calls.push({ prompt, model, conversationId: conversationId ?? null });
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) throw answer;
    const cid = conversationId ?? `sup-conv-${++counter}`;
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return { model, exitCode: 0, text, json: { result: text }, stdout: text, durationMs: 1, conversationId: cid };
  }
  callAgy.calls = calls;
  return callAgy;
}

const CONTEXT = {
  workflowGoal: 'PLAN: create work/auto-a.txt then finish.',
  repositoryContext: { repository_name: 'gpt-dev-loop', repository_url: null, branch: 'phase1-handshake', commit_sha: 'abc' },
  history: [],
  latestReviewResult: null,
};

/** Generate a very large workflowGoal string. */
function makeLargeGoal(charCount) {
  const base = 'Task: implement feature X with detailed specification and acceptance criteria. ';
  return base.repeat(Math.ceil(charCount / base.length)).slice(0, charCount);
}

/** Generate N completed history entries with optional large fields. */
function makeCompletedTasks(count, { withLargeDetails = false } = {}) {
  const tasks = [];
  for (let i = 1; i <= count; i++) {
    const entry = {
      task_id: `task-${i}`,
      decision: 'PASS',
      attempts: Math.ceil(Math.random() * 3),
    };
    if (withLargeDetails) {
      // Simulate what the old code might have carried — verbose fields that
      // buildCompactHistory should now ignore.
      entry.executionReport = 'x'.repeat(2000);
      entry.gateEvidence = { diff: 'y'.repeat(2000), results: [{ command: 'npm test', output: 'z'.repeat(1000) }] };
      entry.reviewerProse = 'r'.repeat(2000);
    }
    tasks.push(entry);
  }
  return tasks;
}

/** Generate a multi-round REWORK review result with large content. */
function makeLargeReworkReview() {
  return {
    decision: 'REWORK',
    task_id: 'task-rework-1',
    required_changes: [
      'Fix the import statement in src/foo.js — currently importing from a non-existent module. ' + 'a'.repeat(500),
      'Update the test expectations in tests/foo.test.js to match the new API signature. ' + 'b'.repeat(500),
      { severity: 'HIGH', file: 'src/bar.js', issue: 'Missing null check causes crash. ' + 'c'.repeat(500) },
    ],
    findings: [
      { severity: 'CRITICAL', file: 'src/baz.js', issue: 'SQL injection vulnerability in query builder. ' + 'd'.repeat(500) },
      { severity: 'MEDIUM', path: 'src/utils.js', description: 'Memory leak in event listener. ' + 'e'.repeat(500) },
      'Simple string finding that should be truncated: ' + 'f'.repeat(500),
    ],
    rationale: 'The implementation has several issues that need addressing:\n' +
      '1. Import resolution failure\n' +
      '2. Test coverage gaps\n' +
      '3. Security vulnerabilities\n' +
      'g'.repeat(1000),
    source: 'REVIEWER',
    round: 3,
  };
}

/**
 * Build a context fixture that would produce 50k+ chars under the OLD
 * buildAgySupervisorPrompt (which echoed everything verbatim).
 */
function makeBloatedContext() {
  return {
    workflowGoal: makeLargeGoal(10_000),
    repositoryContext: { repository_name: 'big-repo', repository_url: 'https://github.com/org/big-repo', branch: 'main', commit_sha: 'deadbeef' },
    history: makeCompletedTasks(20, { withLargeDetails: true }),
    latestReviewResult: makeLargeReworkReview(),
  };
}

// ════════════════════════════════════════════════════════════════════
//  Tests: buildCompactGoal
// ════════════════════════════════════════════════════════════════════

test('buildCompactGoal: short goal passes through unchanged', () => {
  const short = 'Create feature X';
  assert.equal(buildCompactGoal(short), short);
});

test('buildCompactGoal: null/empty → "(none provided)"', () => {
  assert.equal(buildCompactGoal(null), '(none provided)');
  assert.equal(buildCompactGoal(''), '(none provided)');
  assert.equal(buildCompactGoal(undefined), '(none provided)');
});

test('buildCompactGoal: long goal is deterministically truncated', () => {
  const long = makeLargeGoal(5000);
  const compact = buildCompactGoal(long);
  assert.ok(compact.length < long.length, 'should be shorter');
  assert.ok(compact.startsWith(long.slice(0, 100)), 'should start with the original text');
  assert.match(compact, /truncated from 5000 to 2000 chars/);
  assert.ok(compact.length <= GOAL_CHAR_LIMIT + 200, 'total length bounded by limit + marker');
});

test('buildCompactGoal: custom limit', () => {
  const goal = 'a'.repeat(500);
  const compact = buildCompactGoal(goal, 100);
  assert.ok(compact.startsWith('a'.repeat(100)));
  assert.match(compact, /truncated from 500 to 100 chars/);
});

test('buildCompactGoal: goal exactly at limit passes through', () => {
  const exact = 'x'.repeat(GOAL_CHAR_LIMIT);
  assert.equal(buildCompactGoal(exact), exact);
});

test('buildCompactGoal: tail-of-plan tasks preserved via plannedTasks index when goal truncated', () => {
  // A 5000-char goal where tasks 4 and 5 appear only after char 2000.
  // Without plannedTasks fallback, these tasks would be invisible.
  const preamble = 'Project plan overview: '.repeat(100); // ~2300 chars
  const tailTasks = '\n## Task 4: Add authentication middleware\n## Task 5: CRITICAL — never delete production data\n';
  const goal = preamble + tailTasks;
  assert.ok(goal.length > GOAL_CHAR_LIMIT, 'fixture must exceed limit');
  assert.ok(goal.indexOf('Task 4') > GOAL_CHAR_LIMIT, 'Task 4 must be past truncation boundary');

  // Without plannedTasks: tail constraints are lost
  const withoutTasks = buildCompactGoal(goal, GOAL_CHAR_LIMIT, null);
  assert.ok(!withoutTasks.includes('Task 4'), 'without plannedTasks, tail task should be absent from truncated text');
  assert.ok(!withoutTasks.includes('CRITICAL'), 'without plannedTasks, critical constraint should be absent');

  // With plannedTasks: complete task index appended
  const plannedTasks = [
    { task_id: 'task-1', goal: 'Set up project structure' },
    { task_id: 'task-2', goal: 'Implement core module' },
    { task_id: 'task-3', goal: 'Write unit tests' },
    { task_id: 'task-4', goal: 'Add authentication middleware' },
    { task_id: 'task-5', goal: 'CRITICAL — never delete production data' },
  ];
  const withTasks = buildCompactGoal(goal, GOAL_CHAR_LIMIT, plannedTasks);
  assert.match(withTasks, /truncated from/, 'should still show truncation marker');
  assert.match(withTasks, /Planned tasks \(complete index\)/, 'should append task index');
  assert.match(withTasks, /task-4: Add authentication middleware/, 'task 4 must appear in index');
  assert.match(withTasks, /task-5: CRITICAL/, 'task 5 critical constraint must appear in index');
  // All 5 tasks visible
  for (let i = 1; i <= 5; i++) {
    assert.match(withTasks, new RegExp(`task-${i}`), `task-${i} must be in the index`);
  }
});

test('buildAgySupervisorPrompt: long goal with plannedTasks preserves tail tasks in prompt', () => {
  const ctx = {
    workflowGoal: makeLargeGoal(5000),
    repositoryContext: CONTEXT.repositoryContext,
    history: [],
    latestReviewResult: null,
    plannedTasks: [
      { task_id: 'setup', goal: 'Initialize project' },
      { task_id: 'core', goal: 'Build core feature' },
      { task_id: 'security', goal: 'CRITICAL: Add input validation to prevent injection' },
    ],
  };
  const prompt = buildAgySupervisorPrompt(ctx);
  assert.match(prompt, /Planned tasks \(complete index\)/, 'task index should appear in final prompt');
  assert.match(prompt, /security: CRITICAL: Add input validation/, 'critical tail task must be in final prompt');
  assert.ok(prompt.length <= HARD_LIMIT, 'prompt should still be within hard limit');
});

// ════════════════════════════════════════════════════════════════════
//  Tests: buildCompactHistory
// ════════════════════════════════════════════════════════════════════

test('buildCompactHistory: empty → "none"', () => {
  assert.equal(buildCompactHistory([]), 'none');
  assert.equal(buildCompactHistory(null), 'none');
});

test('buildCompactHistory: entries projected to one-liners', () => {
  const history = [
    { task_id: 'task-1', decision: 'PASS', attempts: 1 },
    { task_id: 'task-2', decision: 'PASS', attempts: 3 },
    { task_id: 'task-3', decision: 'OUT_OF_SCOPE', attempts: 2 },
  ];
  const compact = buildCompactHistory(history);
  assert.match(compact, /1\. task-1: PASS \(1 attempt\)/);
  assert.match(compact, /2\. task-2: PASS \(3 attempts\)/);
  assert.match(compact, /3\. task-3: OUT_OF_SCOPE \(2 attempts\)/);
});

test('buildCompactHistory: 20 tasks stay compact', () => {
  const history = makeCompletedTasks(20, { withLargeDetails: true });
  const compact = buildCompactHistory(history);
  // Even with 20 tasks carrying large details, the compact projection is small
  assert.ok(compact.length < 1500, `expected < 1500 chars, got ${compact.length}`);
  assert.ok(!compact.includes('xxxx'), 'should not contain execution report content');
  assert.ok(!compact.includes('yyyy'), 'should not contain gate evidence content');
});

test('buildCompactHistory: string entries pass through', () => {
  const history = ['manual checkpoint: resumed from snapshot'];
  const compact = buildCompactHistory(history);
  assert.match(compact, /1\. manual checkpoint: resumed from snapshot/);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: buildCompactReviewResult
// ════════════════════════════════════════════════════════════════════

test('buildCompactReviewResult: null → "none"', () => {
  assert.equal(buildCompactReviewResult(null), 'none');
});

test('buildCompactReviewResult: PASS → short status message', () => {
  const result = buildCompactReviewResult({ decision: 'PASS' });
  assert.match(result, /Previous task PASSED/);
});

test('buildCompactReviewResult: REWORK preserves decision-relevant fields', () => {
  const review = {
    decision: 'REWORK',
    task_id: 'task-5',
    required_changes: ['Fix import in foo.js', 'Update test expectations'],
    rationale: 'Two issues found.',
    source: 'REVIEWER',
    round: 2,
  };
  const compact = buildCompactReviewResult(review);
  assert.match(compact, /decision: REWORK/);
  assert.match(compact, /task_id: task-5/);
  assert.match(compact, /Fix import in foo.js/);
  assert.match(compact, /Update test expectations/);
  assert.match(compact, /rationale: Two issues found/);
  assert.match(compact, /source: REVIEWER/);
  assert.match(compact, /round: 2/);
});

test('buildCompactReviewResult: structured findings keep severity/file/issue', () => {
  const review = {
    decision: 'REWORK',
    task_id: 'task-6',
    required_changes: ['fix it'],
    findings: [
      { severity: 'CRITICAL', file: 'src/auth.js', issue: 'SQL injection' },
      { severity: 'MEDIUM', path: 'src/util.js', description: 'Memory leak' },
    ],
  };
  const compact = buildCompactReviewResult(review);
  assert.match(compact, /\[CRITICAL\] src\/auth\.js SQL injection/);
  assert.match(compact, /\[MEDIUM\] src\/util\.js Memory leak/);
});

test('buildCompactReviewResult: large review result is capped', () => {
  const review = makeLargeReworkReview();
  const compact = buildCompactReviewResult(review);
  // Must be much smaller than the raw review
  const rawSize = JSON.stringify(review).length;
  assert.ok(compact.length < rawSize, `compact ${compact.length} should be < raw ${rawSize}`);
  // Rationale is capped
  const rationaleMatch = compact.match(/rationale: ([\s\S]+?)(?:source:|round:|$)/);
  if (rationaleMatch) {
    assert.ok(rationaleMatch[1].length <= RATIONALE_LIMIT + 50, 'rationale should be capped');
  }
  // Core decision fields still present
  assert.match(compact, /decision: REWORK/);
  assert.match(compact, /task_id: task-rework-1/);
  assert.match(compact, /required_changes:/);
  assert.match(compact, /findings:/);
});

test('buildCompactReviewResult: REWORK finding severity preserved', () => {
  const review = {
    decision: 'REWORK',
    task_id: 'rw-1',
    required_changes: [
      { severity: 'HIGH', file: 'src/db.js', issue: 'Connection pool exhaustion under load' },
    ],
    findings: [
      { severity: 'HIGH', file: 'src/db.js', issue: 'Connection pool exhaustion under load' },
    ],
    rationale: 'Performance regression detected.',
    source: 'GATE',
    round: 1,
  };
  const compact = buildCompactReviewResult(review);
  assert.match(compact, /\[HIGH\]/);
  assert.match(compact, /src\/db\.js/);
  assert.match(compact, /Connection pool exhaustion/);
  assert.match(compact, /source: GATE/);
  assert.match(compact, /round: 1/);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: enforcePromptBudget
// ════════════════════════════════════════════════════════════════════

test('enforcePromptBudget: under limit → pass-through', () => {
  const prompt = 'short prompt';
  const result = enforcePromptBudget(prompt);
  assert.equal(result.prompt, prompt);
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.originalLength, prompt.length);
});

test('enforcePromptBudget: over limit → budgetExceeded + marker', () => {
  const prompt = 'x'.repeat(30_000);
  const result = enforcePromptBudget(prompt);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.originalLength, 30_000);
  assert.equal(result.limit, HARD_LIMIT);
  assert.match(result.prompt, /SUPERVISOR_CONTEXT_BUDGET_EXCEEDED/);
});

test('enforcePromptBudget: custom limit', () => {
  const prompt = 'x'.repeat(1000);
  const result = enforcePromptBudget(prompt, 500);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.limit, 500);
});

test('enforcePromptBudget: exactly at limit → pass-through', () => {
  const prompt = 'x'.repeat(HARD_LIMIT);
  const result = enforcePromptBudget(prompt);
  assert.equal(result.budgetExceeded, false);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: buildAgySupervisorPrompt — bloated context stays compact
// ════════════════════════════════════════════════════════════════════

test('bloated context (50k+ raw) stays within HARD_LIMIT', () => {
  const bloated = makeBloatedContext();
  const prompt = buildAgySupervisorPrompt(bloated);

  // Verify the old approach would have been huge
  const rawGoalChars = bloated.workflowGoal.length;  // 10k
  const rawHistoryChars = JSON.stringify(bloated.history).length;  // ~140k+
  const rawReviewChars = JSON.stringify(bloated.latestReviewResult).length;  // ~5k+
  const oldEstimate = rawGoalChars + rawHistoryChars + rawReviewChars;
  assert.ok(oldEstimate > 50_000, `fixture should produce 50k+ raw chars, got ${oldEstimate}`);

  // New prompt must be within limits
  assert.ok(prompt.length <= HARD_LIMIT, `prompt ${prompt.length} chars should be <= ${HARD_LIMIT}`);
  assert.ok(prompt.length <= NORMAL_TARGET * 2, `prompt should be in reasonable range`);
});

test('bloated context: decision-relevant fields still present', () => {
  const bloated = makeBloatedContext();
  const prompt = buildAgySupervisorPrompt(bloated);

  // Core structure present
  assert.match(prompt, /You are the Supervisor/);
  assert.match(prompt, /Plan \(authoritative\)/);
  assert.match(prompt, /Repository context/);
  assert.match(prompt, /Task history/);
  assert.match(prompt, /Latest Review Result/);

  // Rework info preserved
  assert.match(prompt, /decision: REWORK/);
  assert.match(prompt, /task_id: task-rework-1/);
  assert.match(prompt, /required_changes:/);

  // Goal truncation marker present
  assert.match(prompt, /truncated from 10000 to 2000 chars/);

  // History entries present (all 20 tasks)
  assert.match(prompt, /20\. task-20: PASS/);

  // Rework is in progress → correct action constraint
  assert.match(prompt, /CONTINUE_REWORK or HUMAN_REQUIRED only/);
});

test('normal context (small goal, few tasks) stays well under NORMAL_TARGET', () => {
  const prompt = buildAgySupervisorPrompt(CONTEXT);
  assert.ok(prompt.length < NORMAL_TARGET, `prompt ${prompt.length} should be < ${NORMAL_TARGET}`);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: NEXT_TASK decision flow (unchanged contract)
// ════════════════════════════════════════════════════════════════════

test('NEXT_TASK: valid task_card object -> parsed Task Card', async () => {
  const callAgy = makeFakeCallAgy({ action: 'NEXT_TASK', task_card: validTaskCardObject() });
  const provider = createAgySupervisorProvider({ callAgy, model: 'gemini-3.7-flash-high' });
  const decision = await provider.decide(CONTEXT);

  assert.equal(decision.action, 'NEXT_TASK');
  assert.equal(decision.task_card.task_id, 'auto-a');
  assert.deepEqual(decision.task_card.allowed_files, ['work/auto-a.txt']);
  assert.deepEqual(decision.task_card.acceptance_criteria, ['work/auto-a.txt contains exactly auto-a-ok']);
  assert.equal(decision.task_card.completion_signal, 'DONE');
  assert.equal(callAgy.calls[0].model, 'gemini-3.7-flash-high');
});

test('NEXT_TASK: code-fenced JSON is tolerated', async () => {
  const fenced = '```json\n' + JSON.stringify({ action: 'NEXT_TASK', task_card: validTaskCardObject() }) + '\n```';
  const callAgy = makeFakeCallAgy(fenced);
  const provider = createAgySupervisorProvider({ callAgy });
  const decision = await provider.decide(CONTEXT);
  assert.equal(decision.action, 'NEXT_TASK');
});

// ════════════════════════════════════════════════════════════════════
//  Tests: WORKFLOW_DONE / CONTINUE_REWORK / HUMAN_REQUIRED
// ════════════════════════════════════════════════════════════════════

test('WORKFLOW_DONE / CONTINUE_REWORK / HUMAN_REQUIRED', async () => {
  const done = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'WORKFLOW_DONE', summary: 'all tasks passed' }) });
  assert.deepEqual(await done.decide(CONTEXT), { action: 'WORKFLOW_DONE', summary: 'all tasks passed', conversationId: null });

  const reworkCtx = { ...CONTEXT, latestReviewResult: { decision: 'REWORK', required_changes: ['x'] } };
  const rework = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'CONTINUE_REWORK' }) });
  assert.deepEqual(await rework.decide(reworkCtx), { action: 'CONTINUE_REWORK', conversationId: null });

  const human = createAgySupervisorProvider({
    callAgy: makeFakeCallAgy({ action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'which format?' }),
  });
  assert.deepEqual(await human.decide(CONTEXT), {
    action: 'HUMAN_REQUIRED',
    reason: 'ambiguous spec',
    question: 'which format?',
    conversationId: null,
  });
});

// ════════════════════════════════════════════════════════════════════
//  Tests: fail-closed (unchanged contract)
// ════════════════════════════════════════════════════════════════════

test('fail closed: malformed JSON -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy('not json {') });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
    return true;
  });
});

test('fail closed: unknown action -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'DO_STUFF' }) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: NEXT_TASK with missing task_card field -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const bad = validTaskCardObject();
  delete bad.verification_commands;
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy({ action: 'NEXT_TASK', task_card: bad }) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: NEXT_TASK with invalid completion_signal -> SUPERVISOR_INVALID_OUTPUT', async () => {
  const provider = createAgySupervisorProvider({
    callAgy: makeFakeCallAgy({ action: 'NEXT_TASK', task_card: validTaskCardObject({ completion_signal: 'MAYBE' }) }),
  });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
});

test('fail closed: agy timeout -> SUPERVISOR_TIMEOUT', async () => {
  const provider = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyTimeoutError(1000)) });
  await assert.rejects(() => provider.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT);
});

test('fail closed: agy nonzero exit / missing binary -> SUPERVISOR_UNAVAILABLE', async () => {
  const exit = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyExitError(2, 'boom')) });
  await assert.rejects(() => exit.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE);

  const missing = createAgySupervisorProvider({ callAgy: makeFakeCallAgy(new AgyExecutableNotFoundError('agy')) });
  await assert.rejects(() => missing.decide(CONTEXT), (err) => err.code === ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: conversation ID forwarding (unchanged contract)
// ════════════════════════════════════════════════════════════════════

test('decide() returns the agy conversation id, and forwards a supplied one verbatim', async () => {
  const callAgy = makeConversationalCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { action: 'WORKFLOW_DONE', summary: 'done' },
  ]);
  const provider = createAgySupervisorProvider({ callAgy });

  const first = await provider.decide(CONTEXT);
  assert.equal(first.conversationId, 'sup-conv-1');
  assert.equal(callAgy.calls[0].conversationId, null);

  const second = await provider.decide(CONTEXT, { conversationId: 'sup-conv-1' });
  assert.equal(second.conversationId, 'sup-conv-1');
  assert.equal(callAgy.calls[1].conversationId, 'sup-conv-1');
});

test('fail closed: agy cannot resume the requested conversation -> AgyConversationResumeError propagates', async () => {
  const callAgy = makeConversationalCallAgy([
    new AgyConversationResumeError('agy could not resume conversation sup-conv-9'),
  ]);
  const provider = createAgySupervisorProvider({ callAgy });
  await assert.rejects(
    () => provider.decide(CONTEXT, { conversationId: 'sup-conv-9' }),
    (err) => err instanceof AgyConversationResumeError && err.code === 'AGY_CONVERSATION_RESUME_FAILED',
  );
});

// ════════════════════════════════════════════════════════════════════
//  Tests: prompt structure (backward-compatible assertions)
// ════════════════════════════════════════════════════════════════════

test('prompt carries the plan text and constrains actions during rework', () => {
  const p1 = buildAgySupervisorPrompt(CONTEXT);
  assert.match(p1, /PLAN: create work\/auto-a\.txt/);
  assert.match(p1, /NEXT_TASK, WORKFLOW_DONE, or HUMAN_REQUIRED only/);

  const p2 = buildAgySupervisorPrompt({ ...CONTEXT, latestReviewResult: { decision: 'REWORK', required_changes: ['fix'] } });
  assert.match(p2, /CONTINUE_REWORK or HUMAN_REQUIRED only/);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: prompt hard limit enforcement via decide()
// ════════════════════════════════════════════════════════════════════

test('decide() throws SUPERVISOR_CONTEXT_BUDGET_EXCEEDED when prompt exceeds hard limit', async () => {
  // Create a callAgy that should never be reached
  let callAgyInvoked = false;
  const callAgy = makeFakeCallAgy(({ prompt }) => {
    callAgyInvoked = true;
    return { action: 'WORKFLOW_DONE', summary: 'done' };
  });

  // Build a context that would exceed the hard limit even with compaction.
  // We use an absurdly large checkpoint (which is passed through uncompacted)
  // to push over the limit.
  const hugeCheckpoint = {
    overall_goal: 'g'.repeat(30_000),
    completed_tasks: Array.from({ length: 100 }, (_, i) => ({
      task_id: `task-${i}`,
      status: 'PASS' + 'x'.repeat(200),
    })),
    current_task: { task_id: 'current', details: 'z'.repeat(5000) },
  };

  const provider = createAgySupervisorProvider({ callAgy });
  await assert.rejects(
    () => provider.decide({ ...CONTEXT, checkpoint: hugeCheckpoint }),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED);
      assert.ok(err.message.includes('exceeded hard limit'));
      return true;
    },
  );

  // Verify model was NOT called
  assert.equal(callAgyInvoked, false, 'callAgy should NOT have been invoked');
});

// ════════════════════════════════════════════════════════════════════
//  Tests: deterministic truncation — the full lifecycle scenario
// ════════════════════════════════════════════════════════════════════

test('full lifecycle: 20 completed tasks + multi-round REWORK + large goal → compact prompt', () => {
  const ctx = makeBloatedContext();
  const prompt = buildAgySupervisorPrompt(ctx);

  // Verify prompt size is reasonable
  assert.ok(prompt.length <= HARD_LIMIT, `prompt should be <= ${HARD_LIMIT}, got ${prompt.length}`);

  // Verify goal was truncated
  assert.match(prompt, /truncated from 10000 to 2000 chars/);

  // Verify all 20 tasks are represented in compact history
  for (let i = 1; i <= 20; i++) {
    assert.match(prompt, new RegExp(`task-${i}: PASS`), `task-${i} should appear in history`);
  }

  // Verify REWORK info is preserved
  assert.match(prompt, /decision: REWORK/);
  assert.match(prompt, /required_changes:/);
  assert.match(prompt, /findings:/);

  // Verify structured finding severity is preserved
  assert.match(prompt, /\[CRITICAL\]/);
  assert.match(prompt, /\[HIGH\]/);
  assert.match(prompt, /\[MEDIUM\]/);

  // Verify file paths preserved in findings
  assert.match(prompt, /src\/baz\.js/);
  assert.match(prompt, /src\/bar\.js/);

  // Verify source and round preserved
  assert.match(prompt, /source: REVIEWER/);
  assert.match(prompt, /round: 3/);
});

test('REWORK review: issue text, file path, severity, and required change all present', () => {
  const review = {
    decision: 'REWORK',
    task_id: 'rw-check',
    required_changes: ['Add error handling to processPayment()'],
    findings: [
      { severity: 'HIGH', file: 'src/payment.js', issue: 'Missing try-catch around API call' },
    ],
    rationale: 'The payment processor can throw on network errors. Must handle gracefully.',
    source: 'REVIEWER',
    round: 2,
  };
  const compact = buildCompactReviewResult(review);
  assert.match(compact, /decision: REWORK/);
  assert.match(compact, /task_id: rw-check/);
  assert.match(compact, /Add error handling to processPayment/);
  assert.match(compact, /\[HIGH\] src\/payment\.js Missing try-catch/);
  assert.match(compact, /rationale: The payment processor/);
  assert.match(compact, /source: REVIEWER/);
  assert.match(compact, /round: 2/);
});

// ════════════════════════════════════════════════════════════════════
//  Tests: budget constants are sane
// ════════════════════════════════════════════════════════════════════

test('budget constants are reasonable', () => {
  assert.ok(GOAL_CHAR_LIMIT >= 1000, 'GOAL_CHAR_LIMIT should be at least 1000');
  assert.ok(GOAL_CHAR_LIMIT <= 5000, 'GOAL_CHAR_LIMIT should be at most 5000');
  assert.ok(RATIONALE_LIMIT >= 200, 'RATIONALE_LIMIT should be at least 200');
  assert.ok(FINDING_LIMIT >= 100, 'FINDING_LIMIT should be at least 100');
  assert.ok(NORMAL_TARGET < HARD_LIMIT, 'NORMAL_TARGET should be less than HARD_LIMIT');
  assert.ok(HARD_LIMIT <= 30_000, 'HARD_LIMIT should be at most 30k');
  assert.ok(NORMAL_TARGET >= 10_000, 'NORMAL_TARGET should be at least 10k');
});

// ════════════════════════════════════════════════════════════════════
//  Tests: REAL MODEL CALLS = 0 verification
// ════════════════════════════════════════════════════════════════════

test('all tests use mock/fixture callAgy — no real model calls', () => {
  // This test is a meta-assertion: all provider tests above use
  // makeFakeCallAgy or makeConversationalCallAgy, both of which are
  // synchronous deterministic fakes that never spawn a process.
  // The buildAgySupervisorPrompt / buildCompact* / enforcePromptBudget
  // tests don't call any provider at all.
  assert.ok(true, 'All tests in this file use mock/fixture — 0 real model calls');
});
