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

import { normalizeWorkspaceRelativePaths, WorkspacePathError } from './workspaceConfig.js';

export const REQUIRED_FIELDS = [
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

// allowed_files / forbidden_files are workspace file references. Normalize
// them to stable workspace-relative paths and reject absolute paths or
// escapes at the Task Card boundary (TASK_PROTOCOL.md §2 trust boundary).
function parseWorkspaceFileList(field, raw) {
  try {
    return normalizeWorkspaceRelativePaths(parseBulletList(raw)).paths;
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      throw new Error(`task card "${field}" contains an unsafe path: ${err.message}`);
    }
    throw err;
  }
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
    allowed_files: parseWorkspaceFileList('allowed_files', sections.allowed_files),
    forbidden_files: parseWorkspaceFileList('forbidden_files', sections.forbidden_files),
    acceptance_criteria: parseAcceptanceCriteria(sections.acceptance_criteria),
    verification_commands: parseVerificationCommands(sections.verification_commands),
    completion_signal: completionSignal,
  };
}

export async function readTaskCard(filePath) {
  const text = await readFile(filePath, 'utf8');
  return parseTaskCard(text);
}

// ---------------------------------------------------------------------------
// Immutable, auditable acceptance version chain (SUPERSEDE/AMEND authorization)
// ---------------------------------------------------------------------------
//
// Historical acceptance criteria are never overwritten in place. Every change
// appends a new version record carrying the full before/after, the reason, and
// the approving authority. The chain tracks which version is currently active;
// all downstream consumers (Gate, Reviewer, provider payloads, automated loop,
// control service, persistence, timeline) must resolve the active version
// through `resolveActiveAcceptance` rather than reading a raw criteria array.
//
// An acceptance change may ONLY originate from an explicit HUMAN_REQUIRED
// decision or a controlled orchestrator decision. An Executor's execution
// report, code, or commands can never change acceptance criteria.

export const ACCEPTANCE_MUTATION_COMMANDS = Object.freeze({
  AMEND: 'AMEND_ACCEPTANCE',
  SUPERSEDE: 'SUPERSEDE_ACCEPTANCE',
});

export const ACCEPTANCE_APPROVERS = Object.freeze({
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  CONTROLLED_ORCHESTRATOR: 'CONTROLLED_ORCHESTRATOR',
});

const AUTHORIZED_ACCEPTANCE_APPROVERS = new Set(Object.values(ACCEPTANCE_APPROVERS));

// Sources that are structurally forbidden from ever mutating acceptance.
const EXECUTOR_ORIGIN_SOURCES = new Set([
  'EXECUTOR',
  'EXECUTION_REPORT',
  'EXECUTOR_REPORT',
  'EXECUTOR_VERIFICATION',
  'CLAUDE_EXECUTOR',
]);

export class AcceptanceAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcceptanceAuthorizationError';
    this.code = 'ACCEPTANCE_MUTATION_UNAUTHORIZED';
  }
}

export class AcceptanceVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcceptanceVersionError';
    this.code = 'ACCEPTANCE_VERSION_INVALID';
  }
}

function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria)) {
    throw new AcceptanceVersionError('acceptance criteria must be an array');
  }
  const out = criteria.map((item) => String(item).trim()).filter((item) => item.length > 0);
  if (out.length === 0) {
    throw new AcceptanceVersionError('acceptance criteria must contain at least one non-empty item');
  }
  return out;
}

function freezeVersion(entry) {
  return Object.freeze({
    ...entry,
    acceptance: Object.freeze([...entry.acceptance]),
    oldAcceptance: entry.oldAcceptance ? Object.freeze([...entry.oldAcceptance]) : null,
    newAcceptance: entry.newAcceptance ? Object.freeze([...entry.newAcceptance]) : null,
  });
}

function requireChain(chain) {
  if (!chain || typeof chain !== 'object' || !Array.isArray(chain.versions) || chain.versions.length === 0) {
    throw new AcceptanceVersionError('invalid acceptance chain');
  }
}

// Establish version 1 from the Task Card's parsed acceptance_criteria. Migrating
// an existing workflow uses this too: the pre-existing criteria become version 1
// and are never rewritten in place.
export function createAcceptanceChain(criteria, { approvedAt = null, approvedBy = 'PLANNER' } = {}) {
  const v1 = freezeVersion({
    version: 1,
    acceptance: normalizeCriteria(criteria),
    command: 'INITIAL',
    reason: 'Initial acceptance criteria captured from the Task Card.',
    approvedBy,
    approvedAt,
    supersedesVersion: null,
    oldAcceptance: null,
    newAcceptance: null,
  });
  return { activeVersion: 1, versions: [v1] };
}

// The single source of truth every downstream consumer must read.
export function resolveActiveAcceptance(chain) {
  requireChain(chain);
  const active = chain.versions.find((v) => v.version === chain.activeVersion);
  if (!active) {
    throw new AcceptanceVersionError(`active acceptance version ${chain.activeVersion} not present in chain`);
  }
  return { version: active.version, acceptance: [...active.acceptance] };
}

// Stamp the current active acceptance onto a Task Card object so every
// downstream consumer (Executor prompt, Gate, Reviewer, provider payloads)
// reads that exact version instead of a raw, Executor-mutable criteria array.
// Returns a new object; the input card is not mutated.
export function stampActiveAcceptance(taskCard, chain) {
  const { version, acceptance } = resolveActiveAcceptance(chain);
  return { ...taskCard, acceptance_criteria: acceptance, acceptance_version: version };
}

// Reject an acceptance mutation request that originates from an Executor before
// any authority check even runs.
export function assertAcceptanceMutationAllowed({ originatedBy } = {}) {
  const source = String(originatedBy ?? '').toUpperCase();
  if (EXECUTOR_ORIGIN_SOURCES.has(source)) {
    throw new AcceptanceAuthorizationError(
      `acceptance mutation rejected: Executor-originated request ("${originatedBy}") cannot change acceptance criteria`,
    );
  }
}

function mutateAcceptance(command, chain, opts = {}) {
  requireChain(chain);
  const { newAcceptance, reason, approvedBy, approvedAt = null, supersedesVersion, originatedBy } = opts;

  if (originatedBy !== undefined) {
    assertAcceptanceMutationAllowed({ originatedBy });
  }
  if (!AUTHORIZED_ACCEPTANCE_APPROVERS.has(approvedBy)) {
    throw new AcceptanceAuthorizationError(
      `acceptance ${command} rejected: approvedBy "${approvedBy}" is not an authorized source ` +
        `(only ${[...AUTHORIZED_ACCEPTANCE_APPROVERS].join(', ')} may change acceptance criteria)`,
    );
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new AcceptanceVersionError(`acceptance ${command} requires a non-empty reason`);
  }

  const active = chain.versions.find((v) => v.version === chain.activeVersion);
  const nextVersion = Math.max(...chain.versions.map((v) => v.version)) + 1;
  const normalizedNew = normalizeCriteria(newAcceptance);
  const supersedes = command === ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE
    ? (supersedesVersion ?? active.version)
    : null;

  const entry = freezeVersion({
    version: nextVersion,
    acceptance: normalizedNew,
    command,
    reason: reason.trim(),
    approvedBy,
    approvedAt,
    supersedesVersion: supersedes,
    oldAcceptance: [...active.acceptance],
    newAcceptance: normalizedNew,
  });

  // Append-only: prior version entries are reused by reference, never mutated.
  return { activeVersion: nextVersion, versions: [...chain.versions, entry] };
}

export function amendAcceptance(chain, opts) {
  return mutateAcceptance(ACCEPTANCE_MUTATION_COMMANDS.AMEND, chain, opts);
}

export function supersedeAcceptance(chain, opts) {
  return mutateAcceptance(ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE, chain, opts);
}

// Full auditable history, oldest first.
export function acceptanceAuditLog(chain) {
  requireChain(chain);
  return chain.versions.map((v) => ({
    version: v.version,
    command: v.command,
    reason: v.reason,
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
    supersedesVersion: v.supersedesVersion,
    oldAcceptance: v.oldAcceptance ? [...v.oldAcceptance] : null,
    newAcceptance: v.newAcceptance ? [...v.newAcceptance] : null,
  }));
}

// Recover the criteria of any historical version without changing the chain.
export function getAcceptanceVersion(chain, version) {
  requireChain(chain);
  const found = chain.versions.find((v) => v.version === version);
  if (!found) {
    throw new AcceptanceVersionError(`acceptance version ${version} not present in chain`);
  }
  return { version: found.version, acceptance: [...found.acceptance] };
}

export function serializeAcceptanceChain(chain) {
  requireChain(chain);
  return JSON.parse(JSON.stringify(chain));
}

export function deserializeAcceptanceChain(raw) {
  requireChain(raw);
  return {
    activeVersion: raw.activeVersion,
    versions: raw.versions.map(freezeVersion),
  };
}
