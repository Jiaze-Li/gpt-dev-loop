import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  DEFAULT_PR_REVIEWER,
  DEFAULT_MAX_PR_REPAIR_ROUNDS,
  PR_REVIEWER_FALLBACK_ORDER,
  REVIEW_INFRASTRUCTURE_REASON,
  PR_CLOSEOUT_ACTIONS,
  initialCloseoutState,
  decideCloseout,
  invalidateReviewEvidence,
  assertRepairReadyForPush,
  validateRepairAction,
  assertRepairActionSafe,
  buildRepairTaskCard,
  normalizePrReviewer,
  resolveReviewerFallbackOrder,
  currentReviewerCandidate,
  lockActiveReviewer,
  failoverReviewer,
  recordRepairRound,
  buildSupervisorEscalationContext,
  applySupervisorEscalationOutcome,
  normalizeSupervisorEscalationOutcome,
  SUPERVISOR_ESCALATION_OUTCOMES,
  DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS,
} from '../src/orchestrator/prCloseoutPolicy.js';
import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from '../src/orchestrator/errors.js';
import { ingestTrustedReview } from '../src/orchestrator/trustedPrReview.js';
import {
  NORMALIZED_REVIEW_STATUS,
  NORMALIZED_FINDING_SEVERITIES,
  normalizeFindingSeverity,
  normalizeReviewFinding,
  normalizedFindingSignature,
  normalizeProviderReview,
  blockingSignatures,
  assertNormalizedReviewUsable,
} from '../src/orchestrator/adapters/normalizedPrReview.js';
import {
  codexCleanReview,
  codexActionableReview,
  claudeActionableReview,
  internalNonBlockingReview,
  codexProviderErrorReview,
  malformedReview,
  noFindingsChannelReview,
} from './fixtures/pr-review-fixtures.mjs';

const REVIEWER = 'trusted-claude-reviewer';

function baseState(overrides = {}) {
  return initialCloseoutState({
    prNumber: 7,
    prHead: 'sha-1',
    configuredReviewer: REVIEWER,
    ...overrides,
  });
}

function rawReview(head, findings = []) {
  return { reviewer: REVIEWER, headSha: head, findings };
}

test('default max repair rounds is 3', () => {
  assert.equal(DEFAULT_MAX_REPAIR_ROUNDS, 3);
  assert.equal(baseState().maxRepairRounds, 3);
});

test('clean trusted review -> DONE', () => {
  const { action, reason, state } = decideCloseout({
    state: baseState(),
    review: rawReview('sha-1', []),
    currentPrHead: 'sha-1',
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.DONE);
  assert.equal(reason, 'clean_trusted_review');
  assert.equal(state.reviewedPrHead, 'sha-1');
});

test('P3-only trusted review does not trigger a repair -> DONE', () => {
  const { action, reason } = decideCloseout({
    state: baseState(),
    review: rawReview('sha-1', [{ severity: 'P3', file: 'a.js', message: 'rename var' }]),
    currentPrHead: 'sha-1',
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.DONE);
  assert.equal(reason, 'non_actionable_findings_only');
});

test('actionable P1/P2 -> FIX and increments a bounded repair round', () => {
  const { action, state } = decideCloseout({
    state: baseState(),
    review: rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'off by one' }]),
    currentPrHead: 'sha-1',
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.FIX);
  assert.equal(state.repairRounds, 1);
  assert.equal(state.lastActionableSignatures.length, 1);
});

test('untrusted reviewer result is rejected (fail closed)', () => {
  assert.throws(
    () => decideCloseout({
      state: baseState(),
      review: { reviewer: 'imposter', headSha: 'sha-1', findings: [] },
      currentPrHead: 'sha-1',
    }),
    (error) => error instanceof PrCloseoutError
      && error.code === PR_CLOSEOUT_ERROR_CODES.UNTRUSTED_REVIEWER,
  );
});

test('stale review head -> REFRESH_REVIEW and prior evidence invalidated', () => {
  const { action, reason, state } = decideCloseout({
    state: baseState(),
    review: rawReview('sha-OLD', [{ severity: 'P1', file: 'a.js', message: 'bug' }]),
    currentPrHead: 'sha-1',
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.REFRESH_REVIEW);
  assert.equal(reason, 'stale_review_head');
  assert.equal(state.reviewedPrHead, null);
});

test('external PR-head change invalidates an already-ingested review', () => {
  const ingested = ingestTrustedReview({
    review: rawReview('sha-1', [{ severity: 'P2', file: 'a.js', message: 'bug' }]),
    config: { configuredReviewer: REVIEWER },
    currentPrHead: 'sha-1',
  });
  const { action } = decideCloseout({
    state: baseState(),
    review: ingested,
    currentPrHead: 'sha-2',
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.REFRESH_REVIEW);
});

test('fork PR with no safe write path is review-only for actionable findings', () => {
  const { action, reason } = decideCloseout({
    state: baseState({ isFork: true, safeForkWritePath: false }),
    review: rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'bug' }]),
    currentPrHead: 'sha-1',
    config: { isFork: true },
  });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.REVIEW_ONLY);
  assert.equal(reason, 'fork_pr_no_safe_write_path');
});

test('same finding repeated after a repair round -> ESCALATE_SUPERVISOR', () => {
  let state = baseState();
  const finding = { severity: 'P1', file: 'a.js', message: 'race on close' };

  ({ state } = decideCloseout({ state, review: rawReview('sha-1', [finding]), currentPrHead: 'sha-1' }));
  assert.equal(state.repairRounds, 1);

  // repair pushed a new head, same finding survives
  const res = decideCloseout({ state, review: rawReview('sha-2', [finding]), currentPrHead: 'sha-2' });
  assert.equal(res.action, PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR);
  assert.equal(res.reason, 'repeated_finding_after_repair');
  assert.equal(res.state.escalated, true);
});

test('repeated finding after escalation -> HUMAN_REQUIRED', () => {
  let state = baseState();
  const finding = { severity: 'P1', file: 'a.js', message: 'race on close' };
  ({ state } = decideCloseout({ state, review: rawReview('sha-1', [finding]), currentPrHead: 'sha-1' }));
  ({ state } = decideCloseout({ state, review: rawReview('sha-2', [finding]), currentPrHead: 'sha-2' }));
  assert.equal(state.escalated, true);
  const res = decideCloseout({ state, review: rawReview('sha-3', [finding]), currentPrHead: 'sha-3' });
  assert.equal(res.action, PR_CLOSEOUT_ACTIONS.HUMAN_REQUIRED);
  assert.equal(res.reason, 'unresolved_after_supervisor_escalation');
});

test('three automatic repair rounds then ESCALATE_SUPERVISOR', () => {
  let state = baseState();
  for (let i = 1; i <= DEFAULT_MAX_REPAIR_ROUNDS; i += 1) {
    const res = decideCloseout({
      state,
      review: rawReview(`sha-${i}`, [{ severity: 'P2', file: `f${i}.js`, message: `distinct issue ${i}` }]),
      currentPrHead: `sha-${i}`,
    });
    assert.equal(res.action, PR_CLOSEOUT_ACTIONS.FIX);
    state = res.state;
  }
  assert.equal(state.repairRounds, 3);
  const res = decideCloseout({
    state,
    review: rawReview('sha-4', [{ severity: 'P2', file: 'f4.js', message: 'distinct issue 4' }]),
    currentPrHead: 'sha-4',
  });
  assert.equal(res.action, PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR);
  assert.equal(res.reason, 'max_repair_rounds_reached_supervisor_escalation');
  assert.equal(res.state.escalated, true);
});

test('invalidateReviewEvidence clears reviewed head and updates PR head', () => {
  const next = invalidateReviewEvidence(baseState(), 'sha-9');
  assert.equal(next.reviewedPrHead, null);
  assert.equal(next.prHead, 'sha-9');
});

test('assertRepairReadyForPush requires a passing deterministic gate', () => {
  assert.equal(assertRepairReadyForPush({ gateResult: 'PASS' }), true);
  assert.throws(
    () => assertRepairReadyForPush({ gateResult: 'FAIL' }),
    (e) => e.code === PR_CLOSEOUT_ERROR_CODES.REPAIR_GATE_NOT_PASSED,
  );
  assert.throws(() => assertRepairReadyForPush({}), PrCloseoutError);
});

test('validateRepairAction rejects force-push, auto-merge, workflow edits', () => {
  assert.equal(validateRepairAction({ changedFiles: ['src/a.js'] }).safe, true);
  assert.equal(validateRepairAction({ forcePush: true }).safe, false);
  assert.equal(validateRepairAction({ merge: true }).safe, false);
  assert.equal(validateRepairAction({ merge: true }, { allowMerge: true }).safe, true);
  assert.equal(validateRepairAction({ changedFiles: ['.github/workflows/ci.yml'] }).safe, false);
  assert.equal(validateRepairAction({ modifiesWorkflowFiles: true }).safe, false);
  assert.throws(
    () => assertRepairActionSafe({ forcePush: true }),
    (e) => e.code === PR_CLOSEOUT_ERROR_CODES.UNSAFE_REPAIR_ACTION,
  );
});

test('PR Closeout reviewer defaults: codex, three-stage fallback, max 3 repair rounds', () => {
  assert.equal(DEFAULT_PR_REVIEWER, 'codex');
  assert.equal(DEFAULT_MAX_PR_REPAIR_ROUNDS, 3);
  assert.deepEqual(PR_REVIEWER_FALLBACK_ORDER, ['codex', 'claude', 'internal']);

  const s = baseState();
  assert.equal(s.prReviewer, 'codex');
  assert.deepEqual(s.reviewerCandidateOrder, ['codex', 'claude', 'internal']);
  assert.equal(s.reviewerLocked, false);
  assert.equal(s.activeReviewer, null);
});

test('normalizePrReviewer coerces unknown values to the default', () => {
  assert.equal(normalizePrReviewer('CLAUDE'), 'claude');
  assert.equal(normalizePrReviewer('internal'), 'internal');
  assert.equal(normalizePrReviewer('gpt-9'), 'codex');
  assert.equal(normalizePrReviewer(undefined), 'codex');
  assert.equal(normalizePrReviewer('gpt-9', 'internal'), 'internal');
});

test('resolveReviewerFallbackOrder puts the configured reviewer first, keeps internal last-resort', () => {
  assert.deepEqual(resolveReviewerFallbackOrder('claude'), ['claude', 'codex', 'internal']);
  assert.deepEqual(resolveReviewerFallbackOrder('internal'), ['internal', 'codex', 'claude']);
  assert.deepEqual(resolveReviewerFallbackOrder(undefined), ['codex', 'claude', 'internal']);
});

test('initialCloseoutState honors configured prReviewer and maxPrRepairRounds', () => {
  const s = initialCloseoutState({ prNumber: 1, prHead: 'h', prReviewer: 'claude', maxPrRepairRounds: 5 });
  assert.equal(s.prReviewer, 'claude');
  assert.deepEqual(s.reviewerCandidateOrder, ['claude', 'codex', 'internal']);
  assert.equal(s.maxRepairRounds, 5);
  const bad = initialCloseoutState({ prNumber: 1, prHead: 'h', maxPrRepairRounds: 0 });
  assert.equal(bad.maxRepairRounds, 3);
});

test('failoverReviewer walks codex -> claude -> internal then reports exhaustion', () => {
  let s = baseState();
  assert.equal(currentReviewerCandidate(s), 'codex');

  let r = failoverReviewer(s, 'trigger_failed');
  assert.equal(r.switched, true);
  assert.equal(r.reviewer, 'claude');
  assert.equal(currentReviewerCandidate(r.state), 'claude');
  assert.equal(r.state.reviewerFailovers.length, 1);

  r = failoverReviewer(r.state, 'timeout');
  assert.equal(r.reviewer, 'internal');

  r = failoverReviewer(r.state, 'unavailable');
  assert.equal(r.switched, false);
  assert.equal(r.exhausted, true);
  assert.equal(r.humanRequiredReason, REVIEW_INFRASTRUCTURE_REASON);
  assert.equal(r.humanRequiredReason, 'REVIEW_INFRASTRUCTURE');
});

test('once locked, a reviewer survives further failover attempts', () => {
  let s = baseState();
  s = lockActiveReviewer(s, 'codex');
  assert.equal(s.reviewerLocked, true);
  assert.equal(s.activeReviewer, 'codex');
  assert.equal(currentReviewerCandidate(s), 'codex');

  const r = failoverReviewer(s, 'timeout');
  assert.equal(r.switched, false);
  assert.equal(r.exhausted, false);
  assert.equal(r.reviewer, 'codex');
  assert.equal(currentReviewerCandidate(r.state), 'codex');
});

test('decideCloseout leaves the new reviewer fields intact', () => {
  const { state } = decideCloseout({
    state: baseState(),
    review: rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'x' }]),
    currentPrHead: 'sha-1',
  });
  assert.equal(state.prReviewer, 'codex');
  assert.deepEqual(state.reviewerCandidateOrder, ['codex', 'claude', 'internal']);
  assert.equal(state.repairRounds, 1);
});

// --------------------------------------------------------------------------
// Supervisor escalation context + deterministic decision branches (§4)
// --------------------------------------------------------------------------

function ingest(head, findings) {
  return ingestTrustedReview({
    review: rawReview(head, findings),
    config: { configuredReviewer: REVIEWER },
    currentPrHead: head,
  });
}

test('recordRepairRound appends immutable per-round evidence', () => {
  let state = baseState();
  const before = state.repairLog;
  state = recordRepairRound(state, {
    round: 1, head: 'sha-1', newHead: 'sha-2',
    signatures: ['P1:a.js:bug'],
    findings: [{ severity: 'P1', file: 'a.js', line: 3, message: 'bug', signature: 'P1:a.js:bug' }],
    repairSummary: 'fixed the bug', gateEvidence: 'PASS',
  });
  assert.equal(before.length, 0);
  assert.equal(state.repairLog.length, 1);
  assert.equal(state.repairLog[0].newHead, 'sha-2');
  assert.equal(state.repairLog[0].gateEvidence, 'PASS');
  assert.equal(state.repairLog[0].findings[0].message, 'bug');
});

test('buildSupervisorEscalationContext carries head, reviewer, 3-round evidence, active findings, diff', () => {
  let state = lockActiveReviewer(baseState(), 'codex');
  for (let i = 1; i <= 3; i += 1) {
    state = recordRepairRound(state, {
      round: i, head: `sha-${i}`, newHead: `sha-${i + 1}`,
      signatures: [`P2:f${i}.js:issue ${i}`],
      findings: [{ severity: 'P2', file: `f${i}.js`, message: `issue ${i}`, signature: `P2:f${i}.js:issue ${i}` }],
      repairSummary: `round ${i} summary`, gateEvidence: 'PASS',
    });
  }
  const active = ingest('sha-4', [{ severity: 'P1', file: 'f4.js', message: 'still broken' }]);
  const ctx = buildSupervisorEscalationContext({
    state, currentPrHead: 'sha-4', activeReview: active, diff: 'diff --git a/f4.js',
  });
  assert.equal(ctx.headSha, 'sha-4');
  assert.equal(ctx.reviewer, 'codex');
  assert.equal(ctx.rounds.length, 3);
  assert.deepEqual(ctx.repairSummaries.map((r) => r.repairSummary), ['round 1 summary', 'round 2 summary', 'round 3 summary']);
  assert.deepEqual(ctx.gateEvidence.map((r) => r.gateEvidence), ['PASS', 'PASS', 'PASS']);
  assert.equal(ctx.activeFindings.length, 1);
  assert.equal(ctx.activeFindings[0].message, 'still broken');
  assert.equal(ctx.diff, 'diff --git a/f4.js');
});

test('normalizeSupervisorEscalationOutcome rejects unknown kinds, accepts wrapped outcome', () => {
  assert.equal(normalizeSupervisorEscalationOutcome(undefined), null);
  assert.equal(normalizeSupervisorEscalationOutcome({ kind: 'MYSTERY' }), null);
  assert.equal(normalizeSupervisorEscalationOutcome({ kind: 're_review' }).kind, 'RE_REVIEW');
  assert.equal(
    normalizeSupervisorEscalationOutcome({ outcome: { kind: 'HUMAN_REQUIRED', reason: 'needs product call' } }).reason,
    'needs product call',
  );
});

test('applySupervisorEscalationOutcome branch A: RE_REVIEW leaves findings intact', () => {
  const active = ingest('sha-4', [{ severity: 'P1', file: 'a.js', message: 'x' }]);
  const r = applySupervisorEscalationOutcome(baseState(), { kind: 'RE_REVIEW' }, { activeReview: active });
  assert.equal(r.action, 'RE_REVIEW');
  assert.deepEqual(r.state.resolvedSignatures, []);
  assert.equal(r.state.supervisorEscalations.length, 1);
});

test('applySupervisorEscalationOutcome branch B: OUT_OF_SCOPE closes the active signatures', () => {
  const active = ingest('sha-4', [{ severity: 'P1', file: 'a.js', message: 'wontfix' }]);
  const r = applySupervisorEscalationOutcome(baseState(), { kind: 'OUT_OF_SCOPE' }, { activeReview: active });
  assert.equal(r.action, 'RE_REVIEW');
  assert.deepEqual(r.state.resolvedSignatures, active.actionableSignatures);

  // A subsequent decideCloseout then closes the PR out deterministically.
  const d = decideCloseout({ state: r.state, review: rawReview('sha-4', [{ severity: 'P1', file: 'a.js', message: 'wontfix' }]), currentPrHead: 'sha-4' });
  assert.equal(d.action, PR_CLOSEOUT_ACTIONS.DONE);
  assert.equal(d.reason, 'supervisor_closed_findings_out_of_scope');
});

test('applySupervisorEscalationOutcome branch C/D: escalation repair has its own budget, then HUMAN_REQUIRED', () => {
  assert.equal(DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS, 3);
  let state = baseState();
  for (let i = 1; i <= DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS; i += 1) {
    const r = applySupervisorEscalationOutcome(state, { kind: i % 2 ? 'NEW_STRATEGY' : 'STRONGER_PROVIDER', provider: 'opus' });
    assert.equal(r.action, 'ESCALATION_REPAIR');
    assert.equal(r.state.escalationRepairRounds, i);
    assert.equal(r.state.repairRounds, 0, 'escalation repair never burns an ordinary round');
    state = r.state;
  }
  const spent = applySupervisorEscalationOutcome(state, { kind: 'NEW_STRATEGY' });
  assert.equal(spent.action, 'HUMAN_REQUIRED');
  assert.equal(spent.reason, 'escalation_repair_budget_exhausted');
});

test('applySupervisorEscalationOutcome branch E: HUMAN_REQUIRED carries the reason/question', () => {
  const r = applySupervisorEscalationOutcome(baseState(), {
    kind: 'HUMAN_REQUIRED', reason: 'architecture decision', question: 'which API contract?',
  });
  assert.equal(r.action, 'HUMAN_REQUIRED');
  assert.equal(r.reason, 'architecture decision');
  assert.equal(r.question, 'which API contract?');
});

test('applySupervisorEscalationOutcome with no decision defaults to bounded RE_REVIEW', () => {
  const r = applySupervisorEscalationOutcome(baseState(), null);
  assert.equal(r.action, 'RE_REVIEW');
  assert.equal(r.reason, 'awaiting_supervisor_decision');
});

// --------------------------------------------------------------------------
// Unified normalized review schema / provider-boundary parser
// --------------------------------------------------------------------------

test('normalizeFindingSeverity collapses everything but P1/P2 to OTHER', () => {
  assert.deepEqual(NORMALIZED_FINDING_SEVERITIES, ['P1', 'P2', 'OTHER']);
  assert.equal(normalizeFindingSeverity('p1'), 'P1');
  assert.equal(normalizeFindingSeverity('BLOCKER'), 'P1');
  assert.equal(normalizeFindingSeverity('critical'), 'P1');
  assert.equal(normalizeFindingSeverity('P2'), 'P2');
  assert.equal(normalizeFindingSeverity('major'), 'P2');
  assert.equal(normalizeFindingSeverity('P3'), 'OTHER');
  assert.equal(normalizeFindingSeverity('nit'), 'OTHER');
  assert.equal(normalizeFindingSeverity('suggestion'), 'OTHER');
  assert.equal(normalizeFindingSeverity(undefined), 'OTHER');
});

test('normalizeReviewFinding maps location + title/description and a stable signature', () => {
  const f = normalizeReviewFinding({ severity: 'blocker', path: 'src/a.js', lineNumber: 9, message: 'Null   Deref' });
  assert.equal(f.severity, 'P1');
  assert.equal(f.file, 'src/a.js');
  assert.equal(f.line, 9);
  assert.equal(f.title, 'Null   Deref');
  assert.equal(f.signature, normalizedFindingSignature({ severity: 'p1', file: 'SRC/A.JS', title: 'null deref' }));
  assert.equal(normalizeReviewFinding({}), null);
  assert.equal(normalizeReviewFinding({ id: 'RULE-7', severity: 'P1', message: 'x' }).signature, 'id:RULE-7');
});

test('normalizeProviderReview: codex clean -> CLEAN, no blocking findings', () => {
  const n = normalizeProviderReview({ raw: codexCleanReview, currentPrHead: 'sha-1' });
  assert.equal(n.provider, 'codex');
  assert.equal(n.status, NORMALIZED_REVIEW_STATUS.CLEAN);
  assert.equal(n.head_sha, 'sha-1');
  assert.equal(n.review_id, 'codex-rev-1');
  assert.deepEqual(n.blocking, []);
  assert.equal(n.error, null);
});

test('normalizeProviderReview: codex/claude blocking findings -> ACTIONABLE, only P1/P2 block', () => {
  const codex = normalizeProviderReview({ raw: codexActionableReview, currentPrHead: 'sha-1' });
  assert.equal(codex.status, NORMALIZED_REVIEW_STATUS.ACTIONABLE);
  assert.equal(codex.findings.length, 2);
  assert.equal(codex.blocking.length, 1);
  assert.equal(codex.blocking[0].severity, 'P1');

  const claude = normalizeProviderReview({ raw: claudeActionableReview, currentPrHead: 'sha-1' });
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.status, NORMALIZED_REVIEW_STATUS.ACTIONABLE);
  assert.equal(claude.review_id, 900);
  assert.equal(claude.blocking.length, 1);
  assert.equal(claude.blocking[0].file, 'src/b.js');
  assert.deepEqual(blockingSignatures(claude), claude.blocking.map((f) => f.signature));
});

test('normalizeProviderReview: internal non-blocking (P3/suggestion) -> CLEAN', () => {
  const n = normalizeProviderReview({ raw: internalNonBlockingReview, currentPrHead: 'sha-1' });
  assert.equal(n.provider, 'internal');
  assert.equal(n.status, NORMALIZED_REVIEW_STATUS.CLEAN);
  assert.equal(n.findings.length, 2);
  assert.equal(n.blocking.length, 0);
});

test('normalizeProviderReview: provider failure / malformed / no findings channel -> FAILED', () => {
  const err = normalizeProviderReview({ raw: codexProviderErrorReview, currentPrHead: 'sha-1' });
  assert.equal(err.status, NORMALIZED_REVIEW_STATUS.FAILED);
  assert.equal(err.error.reason, 'PROVIDER_ERROR');

  const bad = normalizeProviderReview({ raw: malformedReview, currentPrHead: 'sha-1' });
  assert.equal(bad.status, NORMALIZED_REVIEW_STATUS.FAILED);
  assert.equal(bad.error.reason, 'MALFORMED_PAYLOAD');

  const noChannel = normalizeProviderReview({ raw: noFindingsChannelReview, currentPrHead: 'sha-1' });
  assert.equal(noChannel.status, NORMALIZED_REVIEW_STATUS.FAILED);
  assert.equal(noChannel.error.reason, 'NO_FINDINGS_CHANNEL');

  assert.throws(
    () => assertNormalizedReviewUsable(err),
    (e) => e instanceof PrCloseoutError && e.code === PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
  );
});

test('ingestTrustedReview exposes the unified normalized structure and status', () => {
  const out = ingestTrustedReview({
    review: rawReview('sha-1', [
      { severity: 'P1', file: 'a.js', message: 'bug' },
      { severity: 'P3', file: 'b.js', message: 'nit' },
    ]),
    config: { configuredReviewer: REVIEWER },
    currentPrHead: 'sha-1',
  });
  assert.equal(out.status, NORMALIZED_REVIEW_STATUS.ACTIONABLE);
  assert.equal(out.normalized.status, NORMALIZED_REVIEW_STATUS.ACTIONABLE);
  assert.equal(out.normalized.blocking.length, 1);
  assert.equal(out.normalized.findings.length, 2);
});

test('decideCloseout drives off the unified status: OTHER-only normalized review -> DONE', () => {
  const preIngested = {
    verdict: 'ACTIONABLE', // stale legacy hint the Core must ignore in favour of status
    status: NORMALIZED_REVIEW_STATUS.CLEAN,
    headSha: 'sha-1',
    actionableSignatures: [],
    actionable: [],
  };
  const { action } = decideCloseout({ state: baseState(), review: preIngested, currentPrHead: 'sha-1' });
  assert.equal(action, PR_CLOSEOUT_ACTIONS.DONE);
});

test('decideCloseout rejects a pre-ingested FAILED normalized review (fail closed)', () => {
  assert.throws(
    () => decideCloseout({
      state: baseState(),
      review: {
        status: NORMALIZED_REVIEW_STATUS.FAILED,
        verdict: 'CLEAN',
        headSha: 'sha-1',
        actionableSignatures: [],
        error: { reason: 'PROVIDER_ERROR', message: 'boom' },
      },
      currentPrHead: 'sha-1',
    }),
    (e) => e instanceof PrCloseoutError && e.code === PR_CLOSEOUT_ERROR_CODES.MALFORMED_REVIEW,
  );
});

test('buildRepairTaskCard produces a focused normal Executor task card', () => {
  const trusted = ingestTrustedReview({
    review: rawReview('sha-1', [
      { severity: 'P1', file: 'src/a.js', line: 10, message: 'bug one' },
      { severity: 'P3', file: 'src/b.js', message: 'nit' },
    ]),
    config: { configuredReviewer: REVIEWER },
    currentPrHead: 'sha-1',
  });
  const card = buildRepairTaskCard(trusted, {
    repositoryContext: { repository_name: 'demo' },
    prNumber: 7,
    verificationCommands: ['node --test tests/a.test.js'],
  });
  assert.deepEqual(card.allowed_files, ['src/a.js']);
  assert.ok(card.forbidden_files.includes('.github/workflows/'));
  assert.equal(card.completion_signal, 'DONE');
  assert.deepEqual(card.verification_commands, ['node --test tests/a.test.js']);
});
