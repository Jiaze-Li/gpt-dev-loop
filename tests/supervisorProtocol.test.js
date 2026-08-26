import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSupervisorPrompt, parseSupervisorDecision, SUPERVISOR_ACTIONS } from '../src/orchestrator/supervisorProtocol.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

function demoTaskCardObject(overrides = {}) {
  return {
    task_id: 'task-1',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'main',
      commit_sha: 'abc123',
    },
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['some test value must be verified'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function renderList(items) {
  return items && items.length ? items.map((item) => `- ${item}`).join('\n') : 'none';
}

// TASK_PROTOCOL.md §3 template, filled from a plain task-card object — the
// same shape a Supervisor reply's NEXT_TASK body must match, since
// parseSupervisorDecision hands that body straight to taskCard.js's real
// parseTaskCard.
function renderTaskCardMarkdown(taskCard) {
  const ctx = taskCard.repository_context;
  return `## task_id
${taskCard.task_id}

## repository_context
repository_name: ${ctx.repository_name}
repository_url: ${ctx.repository_url ?? 'none'}
branch: ${ctx.branch}
commit_sha: ${ctx.commit_sha}

## goal
${taskCard.goal}

## context
${taskCard.context}

## scope
${taskCard.scope}

## allowed_files
${renderList(taskCard.allowed_files)}

## forbidden_files
${renderList(taskCard.forbidden_files)}

## acceptance_criteria
${renderList(taskCard.acceptance_criteria)}

## verification_commands
${renderList(taskCard.verification_commands.map((command) => `\`${command}\``))}

## completion_signal
${taskCard.completion_signal}`;
}

function nextTaskReply(taskCard) {
  return `NEXT_TASK\n\n${renderTaskCardMarkdown(taskCard)}`;
}

function workflowDoneReply(summary) {
  return `WORKFLOW_DONE\n\n## summary\n${summary}`;
}

function humanRequiredReply(reason, question) {
  return `HUMAN_REQUIRED\n\n## reason\n${reason}\n\n## question\n${question}`;
}

function assertInvalidOutput(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AdapterError, 'must throw AdapterError');
    assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

// --- buildSupervisorPrompt -------------------------------------------------

test('buildSupervisorPrompt names all four actions and demands a plain-text section-based reply, not JSON', () => {
  const prompt = buildSupervisorPrompt({ workflowGoal: 'ship the feature' });
  for (const action of Object.values(SUPERVISOR_ACTIONS)) {
    assert.match(prompt, new RegExp(action));
  }
  assert.match(prompt, /## task_id/);
  assert.match(prompt, /## summary/);
  assert.match(prompt, /## reason/);
  assert.match(prompt, /## question/);
  assert.doesNotMatch(prompt, /JSON/);
  assert.match(prompt, /ship the feature/);
});

test('buildSupervisorPrompt renders repository context, history, and latest review result when given', () => {
  const prompt = buildSupervisorPrompt({
    workflowGoal: 'ship it',
    repositoryContext: { repository_name: 'repo', repository_url: null, branch: 'main', commit_sha: 'deadbeef' },
    history: [{ task_id: 'task-0', completion_signal: 'DONE' }],
    latestReviewResult: { decision: 'REWORK', required_changes: ['fix x'] },
  });
  assert.match(prompt, /deadbeef/);
  assert.match(prompt, /task-0/);
  assert.match(prompt, /"decision": "REWORK"/);
});

test('buildSupervisorPrompt tolerates an empty context', () => {
  const prompt = buildSupervisorPrompt();
  assert.match(prompt, /unknown/);
  assert.match(prompt, /none/);
});

// --- parseSupervisorDecision: valid actions --------------------------------

test('parses a valid NEXT_TASK decision, reusing the real Task Card parser', () => {
  const taskCard = demoTaskCardObject();
  const decision = parseSupervisorDecision(nextTaskReply(taskCard));
  assert.equal(decision.action, 'NEXT_TASK');
  assert.deepEqual(decision.task_card, taskCard);
});

test('parses a valid CONTINUE_REWORK decision', () => {
  const decision = parseSupervisorDecision('CONTINUE_REWORK');
  assert.deepEqual(decision, { action: 'CONTINUE_REWORK' });
});

test('parses a valid WORKFLOW_DONE decision', () => {
  const decision = parseSupervisorDecision(workflowDoneReply('all acceptance criteria met'));
  assert.deepEqual(decision, { action: 'WORKFLOW_DONE', summary: 'all acceptance criteria met' });
});

test('parses a valid HUMAN_REQUIRED decision', () => {
  const decision = parseSupervisorDecision(humanRequiredReply('ambiguous spec', 'should X or Y win?'));
  assert.deepEqual(decision, { action: 'HUMAN_REQUIRED', reason: 'ambiguous spec', question: 'should X or Y win?' });
});

test('tolerates surrounding whitespace/newlines around the reply', () => {
  const decision = parseSupervisorDecision('\n\n  CONTINUE_REWORK  \n\n');
  assert.equal(decision.action, 'CONTINUE_REWORK');
});

// --- parseSupervisorDecision: invalid output, no repair attempted ---------

test('rejects empty output', () => {
  assertInvalidOutput(() => parseSupervisorDecision(''), /empty/);
  assertInvalidOutput(() => parseSupervisorDecision('   \n  '), /empty/);
});

test('rejects prose instead of an action keyword', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('Sure, here is my decision: proceed with the next task.'),
    /first line must be exactly one of/
  );
});

test('rejects a first line that is an action keyword plus extra text', () => {
  assertInvalidOutput(() => parseSupervisorDecision('NEXT_TASK please'), /first line must be exactly one of/);
});

test('rejects an unknown action word', () => {
  assertInvalidOutput(() => parseSupervisorDecision('RETRY_LATER'), /first line must be exactly one of/);
});

test('rejects a reply wrapped in a markdown code fence', () => {
  assertInvalidOutput(() => parseSupervisorDecision('```\nCONTINUE_REWORK\n```'), /first line must be exactly one of/);
});

test('rejects NEXT_TASK with no Task Card body', () => {
  assertInvalidOutput(() => parseSupervisorDecision('NEXT_TASK'), /no Task Card body/);
});

test('rejects NEXT_TASK whose body is missing a required Task Card field', () => {
  const taskCard = demoTaskCardObject();
  const markdown = renderTaskCardMarkdown(taskCard).replace(/## acceptance_criteria\n.*?\n\n/s, '');
  assertInvalidOutput(() => parseSupervisorDecision(`NEXT_TASK\n\n${markdown}`), /acceptance_criteria/);
});

test('rejects NEXT_TASK with an invalid completion_signal', () => {
  const taskCard = demoTaskCardObject({ completion_signal: 'MAYBE' });
  assertInvalidOutput(() => parseSupervisorDecision(nextTaskReply(taskCard)), /invalid completion_signal/);
});

test('rejects CONTINUE_REWORK carrying a body', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('CONTINUE_REWORK\n\nalso refactor the auth module while you are at it'),
    /must have no body/
  );
});

test('rejects WORKFLOW_DONE missing the summary section', () => {
  assertInvalidOutput(() => parseSupervisorDecision('WORKFLOW_DONE'), /non-empty "## summary"/);
});

test('rejects WORKFLOW_DONE with an empty summary section', () => {
  assertInvalidOutput(() => parseSupervisorDecision('WORKFLOW_DONE\n\n## summary\n   '), /non-empty "## summary"/);
});

test('rejects HUMAN_REQUIRED missing the reason section', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('HUMAN_REQUIRED\n\n## question\nwhat now?'),
    /non-empty "## reason"/
  );
});

test('rejects HUMAN_REQUIRED missing the question section', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('HUMAN_REQUIRED\n\n## reason\nambiguous spec'),
    /non-empty "## question"/
  );
});
