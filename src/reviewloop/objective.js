// Immutable ReviewObjective.
//
// The original success definition for one ReviewLoop session. It is captured
// once by reviewloop_begin and can NEVER be weakened by the Worker, the
// Reviewer, the Supervisor, or a later REWORK round. Every review validates
// against this original objective — a small repair passing does not let
// ReviewLoop declare a larger original task complete.

import { createHash } from 'node:crypto';

export const REVIEW_MODES = Object.freeze({ LOCAL: 'LOCAL', PR: 'PR' });

export const DEFAULT_BLOCKING_SEVERITIES = Object.freeze(['P1', 'P2']);
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
// LOCAL mode always uses the internal Reviewer pool. PR mode uses an explicit
// external reviewer; when the caller omits it, the default is `codex` — never
// `internal` (an internal identity must never become a PR trigger identity).
export const DEFAULT_PR_REVIEWER = 'codex';
export const PR_REVIEWERS = Object.freeze(['codex', 'claude']);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

// Build the immutable objective record. `mode` is LOCAL unless a PR number is
// supplied. `reviewer` only applies to PR mode (codex | claude); LOCAL mode
// always uses the internal Reviewer pool.
export function createReviewObjective({
  loopId,
  goal,
  repository,
  mode,
  prNumber = null,
  reviewer = null,
  baseline = null,
  prHead = null,
  constraints = [],
  blockingSeverities = DEFAULT_BLOCKING_SEVERITIES,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!loopId) throw new Error('createReviewObjective: loopId is required');
  if (!goal || !String(goal).trim()) throw new Error('createReviewObjective: goal is required');

  const resolvedMode = mode
    || (prNumber != null ? REVIEW_MODES.PR : REVIEW_MODES.LOCAL);
  if (!Object.values(REVIEW_MODES).includes(resolvedMode)) {
    throw new Error(`createReviewObjective: unknown mode "${resolvedMode}"`);
  }

  const normalizedConstraints = Array.isArray(constraints)
    ? constraints.map((c) => String(c)).filter(Boolean)
    : (constraints ? [String(constraints)] : []);

  const blocking = Array.isArray(blockingSeverities) && blockingSeverities.length
    ? [...new Set(blockingSeverities.map((s) => String(s).toUpperCase()))]
    : [...DEFAULT_BLOCKING_SEVERITIES];

  const rounds = Number.isInteger(maxReviewRounds) && maxReviewRounds > 0
    ? maxReviewRounds
    : DEFAULT_MAX_REVIEW_ROUNDS;

  const objective = {
    loopId: String(loopId),
    goal: String(goal),
    repository: repository
      ? {
        root: repository.root ?? null,
        name: repository.name ?? null,
        url: repository.url ?? null,
      }
      : null,
    mode: resolvedMode,
    prNumber: resolvedMode === REVIEW_MODES.PR ? (prNumber ?? null) : null,
    reviewer: (() => {
      if (resolvedMode !== REVIEW_MODES.PR) return 'internal';
      const r = String(reviewer || DEFAULT_PR_REVIEWER).toLowerCase();
      if (!PR_REVIEWERS.includes(r)) {
        throw new Error(`createReviewObjective: PR reviewer must be one of ${PR_REVIEWERS.join(' | ')}, got "${r}"`);
      }
      return r;
    })(),
    baseline: baseline ?? null,
    initialPrHead: resolvedMode === REVIEW_MODES.PR ? (prHead ?? null) : null,
    constraints: normalizedConstraints,
    blockingSeverities: blocking,
    maxReviewRounds: rounds,
    createdAt,
  };

  objective.fingerprint = sha256(JSON.stringify({
    goal: objective.goal,
    repository: objective.repository,
    mode: objective.mode,
    prNumber: objective.prNumber,
    reviewer: objective.reviewer,
    constraints: objective.constraints,
    blockingSeverities: objective.blockingSeverities,
    maxReviewRounds: objective.maxReviewRounds,
  }));

  return freezeDeep(objective);
}

function computeObjectiveFingerprint(o) {
  return sha256(JSON.stringify({
    goal: o.goal,
    repository: o.repository ?? null,
    mode: o.mode,
    prNumber: o.prNumber ?? null,
    reviewer: o.reviewer,
    constraints: o.constraints ?? [],
    blockingSeverities: o.blockingSeverities ?? [],
    maxReviewRounds: o.maxReviewRounds,
  }));
}

// A serialized objective read back from durable state is re-frozen so nothing
// downstream can mutate it. Its stored fingerprint is re-verified: any tamper
// with a load-bearing field (goal, blocking severities, rounds, constraints,
// mode, prNumber, repository) is detected as corruption.
export function rehydrateObjective(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(raw));
  const expected = computeObjectiveFingerprint(copy);
  if (copy.fingerprint && copy.fingerprint !== expected) {
    throw new Error('ReviewObjective weakened: persisted objective fingerprint does not match its fields');
  }
  return freezeDeep(copy);
}

// Deterministic check that a candidate objective did not weaken the original.
// A weakening is: fewer blocking severities, fewer review rounds, dropped
// constraints, or any change to goal / repository / mode / prNumber.
export function assertObjectiveNotWeakened(original, candidate) {
  if (!original) return true;
  if (!candidate) throw new Error('ReviewObjective missing on resume');
  const problems = [];
  if (candidate.goal !== original.goal) problems.push('goal changed');
  if (candidate.mode !== original.mode) problems.push('mode changed');
  if ((candidate.prNumber ?? null) !== (original.prNumber ?? null)) problems.push('prNumber changed');
  if (JSON.stringify(candidate.repository ?? null) !== JSON.stringify(original.repository ?? null)) {
    problems.push('repository changed');
  }
  const origBlocking = new Set(original.blockingSeverities ?? []);
  for (const sev of origBlocking) {
    if (!(candidate.blockingSeverities ?? []).includes(sev)) problems.push(`blocking severity ${sev} dropped`);
  }
  if ((candidate.maxReviewRounds ?? 0) < (original.maxReviewRounds ?? 0)) {
    problems.push('maxReviewRounds reduced');
  }
  const candConstraints = new Set(candidate.constraints ?? []);
  for (const c of original.constraints ?? []) {
    if (!candConstraints.has(c)) problems.push(`constraint dropped: ${c}`);
  }
  if (problems.length) {
    throw new Error(`ReviewObjective weakened: ${problems.join('; ')}`);
  }
  return true;
}
