import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupervisorPrompt,
  parseSupervisorDecision,
  describeSupervisorReplyStructure,
  formatSupervisorReplyDiagnostic,
  SUPERVISOR_ACTIONS,
} from '../src/orchestrator/supervisorProtocol.js';
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

// TASK_PROTOCOL.md §3 fields, but on the wire as this protocol's
// render-stable "@@ field_name" markers (not "## field_name" Markdown
// headings) — the same shape a Supervisor reply's NEXT_TASK body must
// match, since parseSupervisorDecision translates these markers to "##"
// and hands the result straight to taskCard.js's real parseTaskCard.
function renderTaskCardPlaintext(taskCard) {
  const ctx = taskCard.repository_context;
  return `@@ task_id
${taskCard.task_id}

@@ repository_context
repository_name: ${ctx.repository_name}
repository_url: ${ctx.repository_url ?? 'none'}
branch: ${ctx.branch}
commit_sha: ${ctx.commit_sha}

@@ goal
${taskCard.goal}

@@ context
${taskCard.context}

@@ scope
${taskCard.scope}

@@ allowed_files
${renderList(taskCard.allowed_files)}

@@ forbidden_files
${renderList(taskCard.forbidden_files)}

@@ acceptance_criteria
${renderList(taskCard.acceptance_criteria)}

@@ verification_commands
${renderList(taskCard.verification_commands.map((command) => `\`${command}\``))}

@@ completion_signal
${taskCard.completion_signal}`;
}

function nextTaskReply(taskCard) {
  return `NEXT_TASK\n\n${renderTaskCardPlaintext(taskCard)}`;
}

function workflowDoneReply(summary) {
  return `WORKFLOW_DONE\n\n@@ summary\n${summary}`;
}

function humanRequiredReply(reason, question) {
  return `HUMAN_REQUIRED\n\n@@ reason\n${reason}\n\n@@ question\n${question}`;
}

// Models the REAL transport boundary this protocol exists to survive:
// extension/domActions.js reads the Supervisor's reply from ChatGPT's
// rendered assistant DOM node (`.markdown` innerText), not from raw text.
// A conceptual GPT reply containing literal "## field_name" Markdown gets
// rendered by ChatGPT into an <h2> element whose innerText is just
// "field_name" — the "##" and the following space are gone by the time
// this parser ever sees the string. A literal "@@ field_name" line is not
// Markdown syntax, so ChatGPT's renderer leaves it untouched and its
// innerText is the line verbatim. This function reproduces exactly that
// transform for both cases, standing in for "GPT conceptual output" ->
// "rendered DOM" -> ".markdown innerText string" in a test.
function renderedInnerText(conceptualGptOutput) {
  return conceptualGptOutput.replace(/^##\s+(\S+)\s*$/gm, '$1');
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

test('buildSupervisorPrompt names all four actions and demands a plain-text, render-stable "@@" section reply, not JSON and not Markdown headings', () => {
  const prompt = buildSupervisorPrompt({ workflowGoal: 'ship the feature' });
  for (const action of Object.values(SUPERVISOR_ACTIONS)) {
    assert.match(prompt, new RegExp(action));
  }
  assert.match(prompt, /@@ task_id/);
  assert.match(prompt, /@@ summary/);
  assert.match(prompt, /@@ reason/);
  assert.match(prompt, /@@ question/);
  assert.doesNotMatch(prompt, /JSON/);
  // The prompt template itself must not use "## field_name" — that's the
  // exact format this protocol moved away from because it doesn't survive
  // ChatGPT's Markdown rendering.
  assert.doesNotMatch(prompt, /^##\s+\w+\s*$/m);
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

test('buildSupervisorPrompt\'s fillable NEXT_TASK example no longer instructs GPT to copy the ambiguous "DONE | BLOCKED | HUMAN_REQUIRED" string', () => {
  const prompt = buildSupervisorPrompt({ workflowGoal: 'ship the feature' });
  // The fillable example's "@@ completion_signal" value must be the bare
  // word DONE, not the old pipe-separated placeholder GPT used to copy
  // verbatim into real Task Cards.
  assert.match(prompt, /@@ completion_signal\nDONE\n/);
  // The pipe-separated string may still appear in the prose that warns
  // GPT never to emit it — this only guards the fillable template value.
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

// --- Real transport boundary: ChatGPT Markdown rendering -------------------

test('a NEXT_TASK reply using "@@" markers survives being rendered through ChatGPT Markdown and read back as plain innerText', () => {
  const taskCard = demoTaskCardObject();
  const conceptualGptOutput = nextTaskReply(taskCard);
  // "@@ field_name" is not Markdown syntax, so rendering is a no-op here —
  // this assertion documents that fact rather than exercising a transform.
  const renderedText = renderedInnerText(conceptualGptOutput);
  assert.equal(renderedText, conceptualGptOutput);

  const decision = parseSupervisorDecision(renderedText);
  assert.equal(decision.action, 'NEXT_TASK');
  assert.deepEqual(decision.task_card, taskCard);
});

test('a NEXT_TASK reply using legacy "##" Markdown headings does NOT survive ChatGPT rendering and fails loudly rather than being repaired', () => {
  const taskCard = demoTaskCardObject();
  // What a GPT reply in the OLD "## field_name" heading format conceptually
  // contained, before ChatGPT ever rendered it.
  const legacyMarkdownHeadingReply = `NEXT_TASK

## task_id
${taskCard.task_id}

## repository_context
repository_name: ${taskCard.repository_context.repository_name}
repository_url: ${taskCard.repository_context.repository_url}
branch: ${taskCard.repository_context.branch}
commit_sha: ${taskCard.repository_context.commit_sha}

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
${renderList(taskCard.verification_commands.map((c) => `\`${c}\``))}

## completion_signal
${taskCard.completion_signal}`;

  // What extension/domActions.js actually reads back, once ChatGPT has
  // rendered each "## field_name" line into an <h2> element and its
  // innerText has collapsed the heading down to bare "field_name" — this
  // is the exact rendered-DOM shape reported against this bug: literal
  // "##" headings are simply gone.
  const renderedText = renderedInnerText(legacyMarkdownHeadingReply);
  assert.match(renderedText, /^task_id$/m);
  assert.doesNotMatch(renderedText, /##/);

  assertInvalidOutput(() => parseSupervisorDecision(renderedText), /no "@@ field_name" markers|invalid/i);
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

test('rejects NEXT_TASK whose body still uses legacy "##" Markdown headings instead of "@@" markers', () => {
  const taskCard = demoTaskCardObject();
  const markdownHeadingBody = renderTaskCardPlaintext(taskCard).replace(/^@@ /gm, '## ');
  assertInvalidOutput(() => parseSupervisorDecision(`NEXT_TASK\n\n${markdownHeadingBody}`));
});

test('rejects NEXT_TASK whose body is missing a required Task Card field', () => {
  const taskCard = demoTaskCardObject();
  const plaintext = renderTaskCardPlaintext(taskCard).replace(/@@ acceptance_criteria\n.*?\n\n/s, '');
  assertInvalidOutput(() => parseSupervisorDecision(`NEXT_TASK\n\n${plaintext}`), /acceptance_criteria/);
});

test('rejects NEXT_TASK with an invalid completion_signal', () => {
  const taskCard = demoTaskCardObject({ completion_signal: 'MAYBE' });
  assertInvalidOutput(() => parseSupervisorDecision(nextTaskReply(taskCard)), /invalid completion_signal/);
});

test('rejects NEXT_TASK whose completion_signal is the literal template placeholder "DONE | BLOCKED | HUMAN_REQUIRED"', () => {
  const taskCard = demoTaskCardObject({ completion_signal: 'DONE | BLOCKED | HUMAN_REQUIRED' });
  assertInvalidOutput(() => parseSupervisorDecision(nextTaskReply(taskCard)), /invalid completion_signal/);
});

test('parses a NEXT_TASK reply whose completion_signal is exactly "DONE"', () => {
  const taskCard = demoTaskCardObject({ completion_signal: 'DONE' });
  const decision = parseSupervisorDecision(nextTaskReply(taskCard));
  assert.equal(decision.action, 'NEXT_TASK');
  assert.equal(decision.task_card.completion_signal, 'DONE');
});

test('rejects CONTINUE_REWORK carrying a body', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('CONTINUE_REWORK\n\nalso refactor the auth module while you are at it'),
    /must have no body/
  );
});

test('rejects WORKFLOW_DONE missing the summary section', () => {
  assertInvalidOutput(() => parseSupervisorDecision('WORKFLOW_DONE'), /non-empty "@@ summary"/);
});

test('rejects WORKFLOW_DONE with an empty summary section', () => {
  assertInvalidOutput(() => parseSupervisorDecision('WORKFLOW_DONE\n\n@@ summary\n   '), /non-empty "@@ summary"/);
});

test('rejects WORKFLOW_DONE still using a legacy "## summary" Markdown heading', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('WORKFLOW_DONE\n\n## summary\nall done'),
    /non-empty "@@ summary"/
  );
});

test('rejects HUMAN_REQUIRED missing the reason section', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('HUMAN_REQUIRED\n\n@@ question\nwhat now?'),
    /non-empty "@@ reason"/
  );
});

test('rejects HUMAN_REQUIRED missing the question section', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('HUMAN_REQUIRED\n\n@@ reason\nambiguous spec'),
    /non-empty "@@ question"/
  );
});

test('rejects HUMAN_REQUIRED still using legacy "##" Markdown headings', () => {
  assertInvalidOutput(
    () => parseSupervisorDecision('HUMAN_REQUIRED\n\n## reason\nambiguous spec\n\n## question\nwhat now?'),
    /non-empty "@@ reason"/
  );
});

// --- structural diagnostics -------------------------------------------------

test('describeSupervisorReplyStructure reports the complete marker list for a well-formed NEXT_TASK reply', () => {
  const taskCard = demoTaskCardObject();
  const reply = nextTaskReply(taskCard);
  const diag = describeSupervisorReplyStructure(reply);
  assert.equal(diag.action, 'NEXT_TASK');
  assert.deepEqual(diag.markers, [
    'task_id',
    'repository_context',
    'goal',
    'context',
    'scope',
    'allowed_files',
    'forbidden_files',
    'acceptance_criteria',
    'verification_commands',
    'completion_signal',
  ]);
  assert.deepEqual(diag.missing, []);
  assert.deepEqual(diag.duplicates, []);
  assert.equal(diag.length, reply.trim().length);
});

test('describeSupervisorReplyStructure reports a missing "repository_context" marker structurally, without echoing any field content', () => {
  const taskCard = demoTaskCardObject();
  const reply = nextTaskReply(taskCard).replace(/@@ repository_context\n.*?\n\n/s, '');
  const diag = describeSupervisorReplyStructure(reply);
  assert.equal(diag.action, 'NEXT_TASK');
  assert.deepEqual(diag.missing, ['repository_context']);
  assert.ok(!diag.markers.includes('repository_context'));
});

test('describeSupervisorReplyStructure reports duplicate marker names', () => {
  const reply = 'NEXT_TASK\n\n@@ task_id\nfoo\n\n@@ task_id\nbar\n\n@@ goal\nsomething';
  const diag = describeSupervisorReplyStructure(reply);
  assert.deepEqual(diag.duplicates, ['task_id']);
  assert.deepEqual(diag.markers, ['task_id', 'task_id', 'goal']);
});

test('formatSupervisorReplyDiagnostic never includes field content, only marker names/counts/length', () => {
  const taskCard = demoTaskCardObject({
    goal: 'SECRET_GOAL_TEXT_MUST_NOT_APPEAR',
    context: 'super-secret-repo-url https://example.com/private-repo.git',
  });
  const reply = nextTaskReply(taskCard).replace(/@@ repository_context\n.*?\n\n/s, '');
  const diagnostic = formatSupervisorReplyDiagnostic(reply);
  assert.doesNotMatch(diagnostic, /SECRET_GOAL_TEXT_MUST_NOT_APPEAR/);
  assert.doesNotMatch(diagnostic, /example\.com/);
  assert.match(diagnostic, /^gpt-loop: supervisor response structure:/);
  assert.match(diagnostic, /action=NEXT_TASK/);
  assert.match(diagnostic, /missing=\[repository_context\]/);
  assert.match(diagnostic, /duplicates=\[\]/);
  assert.match(diagnostic, /length=\d+/);
});

test('a NEXT_TASK parse failure folds the structural diagnostic into the thrown error, with no field content leaked', () => {
  const taskCard = demoTaskCardObject({ goal: 'SECRET_GOAL_TEXT_MUST_NOT_APPEAR' });
  const reply = nextTaskReply(taskCard).replace(/@@ repository_context\n.*?\n\n/s, '');
  assert.throws(
    () => parseSupervisorDecision(reply),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT);
      assert.match(err.message, /supervisor response structure:/);
      assert.match(err.message, /missing=\[repository_context\]/);
      assert.doesNotMatch(err.message, /SECRET_GOAL_TEXT_MUST_NOT_APPEAR/);
      return true;
    }
  );
});
