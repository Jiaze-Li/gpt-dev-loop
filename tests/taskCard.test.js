import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTaskCard, readTaskCard } from '../src/orchestrator/taskCard.js';

const EXAMPLE_TASK_CARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'workflow',
  'examples',
  'TASK_CARD_EXAMPLE.md'
);

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

test('readTaskCard accepts the standard example Task Card from TASK_PROTOCOL.md as-is', async () => {
  const taskCard = await readTaskCard(EXAMPLE_TASK_CARD_PATH);

  assert.equal(taskCard.task_id, 'e2e-example-001');
  assert.deepEqual(taskCard.allowed_files, ['docs/E2E_TEST.md']);
  assert.deepEqual(taskCard.forbidden_files, ['src/**', 'docs/workflow/**']);
  assert.equal(taskCard.completion_signal, 'DONE');
});

test('parseTaskCard normalizes unstable allowed_files paths to stable workspace-relative form', () => {
  const card = sampleCard().replace('- src/**', '- ./src/./a.js\n- src/lib/../a.js\n- tests//a.test.js');
  const taskCard = parseTaskCard(card);
  assert.deepEqual(taskCard.allowed_files, ['src/a.js', 'tests/a.test.js']);
});

test('parseTaskCard collapses post-normalization duplicate allowed_files', () => {
  const card = sampleCard().replace('- src/**', '- src/a.js\n- ./src/a.js\n- src/./a.js');
  assert.deepEqual(parseTaskCard(card).allowed_files, ['src/a.js']);
});

test('parseTaskCard rejects an absolute path in allowed_files', () => {
  const card = sampleCard().replace('- src/**', '- /etc/passwd');
  assert.throws(() => parseTaskCard(card), /unsafe path.*absolute/);
});

test('parseTaskCard rejects a path escape in forbidden_files', () => {
  const card = sampleCard().replace('- docs/workflow/**', '- ../../outside');
  assert.throws(() => parseTaskCard(card), /unsafe path.*escapes/);
});

test('parseTaskCard keeps a boundary path that normalizes within the workspace', () => {
  const card = sampleCard().replace('- src/**', '- ./src/nested/../keep.js');
  assert.deepEqual(parseTaskCard(card).allowed_files, ['src/keep.js']);
});

test('parseTaskCard gives a clear, field-specific error for each required field missing in turn', () => {
  for (const field of [
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
  ]) {
    const card = sampleCard()
      .split('\n\n')
      .filter((section) => !section.startsWith(`## ${field}\n`) && !section.startsWith(`## ${field}\r`))
      .join('\n\n');
    assert.throws(
      () => parseTaskCard(card),
      new RegExp(`missing the "${field}" section`),
      `expected a clear error when "${field}" is missing`
    );
  }
});
