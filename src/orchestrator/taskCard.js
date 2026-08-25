// Parses a Task Card (docs/workflow/TASK_PROTOCOL.md §1/§3) markdown
// document into the plain object shape the Workflow Manager's
// `runTask(taskCard)` and the three adapters (ADAPTER_INTERFACE.md) expect.
//
// Splits on "## field_name" headings, the same convention
// claudeExecutorAdapter.js/gptReviewerAdapter.js already use to parse their
// own reply formats — kept independent of those adapters since a Task Card
// is a different document shape (TASK_PROTOCOL.md §2 fields, not
// EXECUTION_REPORT.md/REVIEW_RESULT.md's).

import { readFile } from 'node:fs/promises';

const REQUIRED_FIELDS = [
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
];

const COMPLETION_SIGNALS = new Set(['DONE', 'BLOCKED', 'HUMAN_REQUIRED']);

// TASK_PROTOCOL.md §2 repository_context: repository_name/repository_url/
// branch/commit_sha, one "key: value" per line.
function parseRepositoryContext(raw) {
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(repository_name|repository_url|branch|commit_sha):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim();
  }
  return {
    repository_name: fields.repository_name ?? null,
    repository_url: fields.repository_url && fields.repository_url !== 'none' ? fields.repository_url : null,
    branch: fields.branch ?? null,
    commit_sha: fields.commit_sha ?? null,
  };
}

function parseBulletList(raw) {
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

// acceptance_criteria items are "- [ ] <condition>" checkboxes
// (TASK_PROTOCOL.md §3 template); strip the checkbox marker.
function parseAcceptanceCriteria(raw) {
  return parseBulletList(raw).map((item) => item.replace(/^\[[ xX]\]\s*/, ''));
}

// verification_commands items are "- `<command>`"; strip the backticks.
function parseVerificationCommands(raw) {
  return parseBulletList(raw).map((item) => item.replace(/^`|`$/g, ''));
}

export function parseTaskCard(text) {
  const headingRe = /^##\s+(\w+)\s*$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length === 0) {
    throw new Error('task card contains no "## field_name" headings');
  }

  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[name] = text.slice(start, end).trim();
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in sections)) {
      throw new Error(`task card is missing the "${field}" section`);
    }
  }

  const completionSignal = sections.completion_signal.trim();
  if (!COMPLETION_SIGNALS.has(completionSignal)) {
    throw new Error(`task card has an invalid completion_signal: "${completionSignal}"`);
  }

  return {
    task_id: sections.task_id.trim(),
    repository_context: parseRepositoryContext(sections.repository_context),
    goal: sections.goal.trim(),
    context: sections.context.trim(),
    scope: sections.scope.trim(),
    allowed_files: parseBulletList(sections.allowed_files),
    forbidden_files: parseBulletList(sections.forbidden_files),
    acceptance_criteria: parseAcceptanceCriteria(sections.acceptance_criteria),
    verification_commands: parseVerificationCommands(sections.verification_commands),
    completion_signal: completionSignal,
  };
}

export async function readTaskCard(filePath) {
  const text = await readFile(filePath, 'utf8');
  return parseTaskCard(text);
}
