import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCard } from '../src/orchestrator/taskCard.js';

function sampleCard({ completionSignal = 'DONE' } = {}) {
  return `## task_id
demo-task

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: main
commit_sha: abc123

## goal
Ship the thing.

## context
Follows on from the previous task.

## scope
In scope:
- the thing
Out of scope:
- everything else

## allowed_files
- src/**

## forbidden_files
- docs/workflow/**

## acceptance_criteria
- [ ] the thing works
- [x] tests pass

## verification_commands
- \`npm test\`
- \`npm run lint\`

## completion_signal
${completionSignal}`;
}

test('parseTaskCard extracts every field per TASK_PROTOCOL.md §2', () => {
  const taskCard = parseTaskCard(sampleCard());

  assert.equal(taskCard.task_id, 'demo-task');
  assert.deepEqual(taskCard.repository_context, {
    repository_name: 'gpt-dev-loop',
    repository_url: 'https://github.com/example/gpt-dev-loop',
    branch: 'main',
    commit_sha: 'abc123',
  });
  assert.equal(taskCard.goal, 'Ship the thing.');
  assert.match(taskCard.scope, /In scope/);
  assert.deepEqual(taskCard.allowed_files, ['src/**']);
  assert.deepEqual(taskCard.forbidden_files, ['docs/workflow/**']);
  assert.deepEqual(taskCard.acceptance_criteria, ['the thing works', 'tests pass']);
  assert.deepEqual(taskCard.verification_commands, ['npm test', 'npm run lint']);
  assert.equal(taskCard.completion_signal, 'DONE');
});

test('parseTaskCard treats "none" allowed_files/forbidden_files as empty lists', () => {
  const card = sampleCard().replace('- docs/workflow/**', 'none');
  const taskCard = parseTaskCard(card);
  assert.deepEqual(taskCard.forbidden_files, []);
});

test('parseTaskCard rejects a card missing a required field', () => {
  const card = sampleCard().replace('## goal\nShip the thing.\n\n', '');
  assert.throws(() => parseTaskCard(card), /missing the "goal" section/);
});

test('parseTaskCard rejects an invalid completion_signal', () => {
  assert.throws(() => parseTaskCard(sampleCard({ completionSignal: 'MAYBE' })), /invalid completion_signal/);
});

test('parseTaskCard rejects text with no headings at all', () => {
  assert.throws(() => parseTaskCard('just some prose'), /no "## field_name" headings/);
});
