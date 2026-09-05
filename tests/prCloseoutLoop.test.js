import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runPrCloseoutLoop,
  serializeCloseoutState,
  restoreCloseoutState,
  PR_CLOSEOUT_LOOP_STATUS,
} from '../src/orchestrator/prCloseoutLoop.js';
import {
  initialCloseoutState,
  failoverReviewer,
  currentReviewerCandidate,
  lockActiveReviewer,
  PR_REVIEWER_FALLBACK_ORDER,
  REVIEW_INFRASTRUCTURE_REASON,
} from '../src/orchestrator/prCloseoutPolicy.js';
import { PrCloseoutError, PR_CLOSEOUT_ERROR_CODES } from '../src/orchestrator/errors.js';
import {
  WorkflowStateManager,
  readCloseoutState,
  readLiveWorkflowState,
} from '../src/orchestrator/workflowState.js';
import {
  createGithubPrReviewAdapter,
  resolveTriggerText,
  PR_REVIEW_TRIGGER_TEXT,
  GITHUB_REVIEW_FAILURES,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
} from '../src/orchestrator/adapters/githubPrReviewAdapter.js';
import { ExternalModelTriggerAuthority } from '../src/orchestrator/externalModelTriggerAuthority.js';

const REVIEWER = 'trusted-claude-reviewer';

// A fresh, in-memory, per-call External Model Trigger Authority for adapter
// tests that are not specifically exercising cross-reviewer/cross-process
// trigger dedupe (see externalModelTriggerAuthority.test.js for those). Every
// createGithubPrReviewAdapter() call below is a REQUIRED production
// collaborator, never a silent allow-all default.
function testTriggerAuthority(overrides = {}) {
  return new ExternalModelTriggerAuthority(overrides);
}

function rawReview(head, findings = []) {
  return { reviewer: REVIEWER, headSha: head, findings };
}

// A scripted, fully offline PR/reviewer environment.
function scenario({ heads, reviews, repairGate = 'PASS', repairStatus = 'COMPLETE', repairPlan = null }) {
  const state = {
    headIndex: 0,
    heads: [...heads],
    reviewCalls: [],
    repairCards: [],
    pushCalls: [],
    escalations: [],
    forcePushAttempts: 0,
  };
  const currentHead = () => state.heads[Math.min(state.headIndex, state.heads.length - 1)];
  return {
    state,
    adapters: {
      getPrHead: async () => currentHead(),
      requestTrustedReview: async ({ prHead }) => {
        state.reviewCalls.push(prHead);
        const entry = reviews[prHead];
        return typeof entry === 'function' ? entry() : entry;
      },
      runRepairTask: async (card) => {
        state.repairCards.push(card);
        return { status: repairStatus, gateResult: repairGate, plan: repairPlan };
      },
      pushRepair: async ({ expectedHead, force, forcePush }) => {
        if (force === true || forcePush === true) state.forcePushAttempts += 1;
        state.pushCalls.push(expectedHead);
        // Simulate a real non-force push advancing the branch head.
        state.headIndex += 1;
        return currentHead();
      },
      escalateSupervisor: async (payload) => { state.escalations.push(payload); },
    },
  };
}

test('serialize/restore round-trips a closeout state through JSON without loss', () => {
  const start = initialCloseoutState({ prNumber: 7, prHead: 'sha-1', configuredReviewer: REVIEWER });
  start.repairRounds = 2;
  start.escalated = true;
  start.lastActionableSignatures = ['P1:a.js:bug'];
  start.reviewedPrHead = 'sha-3';
  start.history = [{ action: 'FIX', reason: 'x', at: 'sha-1', round: 1 }];

  const wire = JSON.parse(JSON.stringify(serializeCloseoutState(start)));
  const restored = restoreCloseoutState(wire);

  assert.equal(restored.repairRounds, 2);
  assert.equal(restored.escalated, true);
  assert.deepEqual(restored.lastActionableSignatures, ['P1:a.js:bug']);
  assert.equal(restored.reviewedPrHead, 'sha-3');
  assert.equal(restored.maxRepairRounds, 3);
  assert.deepEqual(restored.history, start.history);
  // Idempotent.
  assert.deepEqual(serializeCloseoutState(restored), serializeCloseoutState(wire));
});

test('restoreCloseoutState fills defaults and clamps a corrupt round count', () => {
  const restored = restoreCloseoutState({ prHead: 'sha-1', configuredReviewer: REVIEWER, repairRounds: -4, history: null });
  assert.equal(restored.repairRounds, 0);
  assert.deepEqual(restored.history, []);
  assert.equal(restored.maxRepairRounds, 3);
  assert.equal(restored.escalated, false);
});

test('clean trusted review -> loop returns DONE with no repair', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1'],
    reviews: { 'sha-1': rawReview('sha-1', []) },
  });
  const out = await runPrCloseoutLoop({
    init: { prNumber: 7, configuredReviewer: REVIEWER },
    adapters,
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(out.reason, 'clean_trusted_review');
  assert.equal(state.repairCards.length, 0);
  assert.equal(state.pushCalls.length, 0);
});

test('P3-only review -> DONE, never triggers a repair', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1'],
    reviews: { 'sha-1': rawReview('sha-1', [{ severity: 'P3', file: 'a.js', message: 'rename' }]) },
  });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(state.repairCards.length, 0);
});

test('P1/P2 -> bounded repair via Executor->Gate->Reviewer, non-force push, re-review, DONE', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: {
      'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'src/a.js', line: 4, message: 'off by one' }]),
      'sha-2': rawReview('sha-2', []),
    },
  });
  const persisted = [];
  const out = await runPrCloseoutLoop({
    init: { prNumber: 7, configuredReviewer: REVIEWER },
    adapters,
    config: { configuredReviewer: REVIEWER, verificationCommands: ['node --test tests/a.test.js'] },
    persist: (s) => { persisted.push(s); },
  });

  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(state.repairCards.length, 1);
  assert.deepEqual(state.repairCards[0].allowed_files, ['src/a.js']);
  assert.deepEqual(state.repairCards[0].verification_commands, ['node --test tests/a.test.js']);
  assert.deepEqual(state.pushCalls, ['sha-1']); // pushed against the reviewed head
  assert.equal(state.forcePushAttempts, 0);
  assert.deepEqual(state.reviewCalls, ['sha-1', 'sha-2']);
  // State was persisted after every transition and ends clean.
  assert.ok(persisted.length >= 3);
  assert.equal(persisted.at(-1).repairRounds, 1);
});

test('repaired work that fails the deterministic gate is never pushed', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: { 'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'bug' }]) },
    repairGate: 'FAIL',
  });
  await assert.rejects(
    () => runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } }),
    (e) => e instanceof PrCloseoutError && e.code === PR_CLOSEOUT_ERROR_CODES.REPAIR_GATE_NOT_PASSED,
  );
  assert.equal(state.pushCalls.length, 0);
});

test('a repair plan that force-pushes or edits workflows is rejected before push', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: { 'sha-1': rawReview('sha-1', [{ severity: 'P2', file: 'a.js', message: 'bug' }]) },
    repairPlan: { forcePush: true },
  });
  await assert.rejects(
    () => runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } }),
    (e) => e.code === PR_CLOSEOUT_ERROR_CODES.UNSAFE_REPAIR_ACTION,
  );
  assert.equal(state.pushCalls.length, 0);
});

test('incomplete repair task -> HUMAN_REQUIRED, no push', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: { 'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'bug' }]) },
    repairStatus: 'HUMAN_REQUIRED',
  });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.equal(out.reason, 'repair_task_human_required');
  assert.equal(state.pushCalls.length, 0);
});

test('untrusted reviewer identity fails closed', async () => {
  const { adapters } = scenario({
    heads: ['sha-1'],
    reviews: { 'sha-1': { reviewer: 'imposter', headSha: 'sha-1', findings: [] } },
  });
  await assert.rejects(
    () => runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } }),
    (e) => e.code === PR_CLOSEOUT_ERROR_CODES.UNTRUSTED_REVIEWER,
  );
});

test('PR head change invalidates a stale review and forces a refresh', async () => {
  let call = 0;
  const { state, adapters } = scenario({
    heads: ['sha-1'],
    reviews: {
      'sha-1': () => {
        call += 1;
        // First review still reports the old head; second catches up.
        return call === 1
          ? rawReview('sha-OLD', [{ severity: 'P1', file: 'a.js', message: 'bug' }])
          : rawReview('sha-1', []);
      },
    },
  });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.deepEqual(state.reviewCalls, ['sha-1', 'sha-1']);
});

test('a stale review that never refreshes stops at HUMAN_REQUIRED', async () => {
  const { adapters } = scenario({
    heads: ['sha-1'],
    reviews: { 'sha-1': () => rawReview('sha-OLD', [{ severity: 'P1', file: 'a.js', message: 'bug' }]) },
  });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.equal(out.reason, 'stale_review_not_refreshing');
});

test('same finding surviving a repair round escalates, then stops at HUMAN_REQUIRED', async () => {
  const finding = { severity: 'P1', file: 'a.js', message: 'race on close' };
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2', 'sha-3'],
    reviews: {
      'sha-1': rawReview('sha-1', [finding]),
      'sha-2': rawReview('sha-2', [finding]),
      'sha-3': rawReview('sha-3', [finding]),
    },
  });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.equal(out.reason, 'unresolved_after_supervisor_escalation');
  assert.equal(state.escalations.length, 1);
  assert.equal(state.forcePushAttempts, 0);
});

test('automatic repair rounds are capped at 3, escalates to Supervisor, then stops if still unresolved', async () => {
  const heads = Array.from({ length: 5 }, (_, i) => `sha-${i + 1}`);
  const reviews = {};
  for (let i = 1; i <= 5; i += 1) {
    reviews[`sha-${i}`] = i <= 4
      ? rawReview(`sha-${i}`, [{ severity: 'P2', file: `f${i}.js`, message: `distinct issue ${i}` }])
      : rawReview(`sha-${i}`, []);
  }
  const { state, adapters } = scenario({ heads, reviews });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.equal(out.reason, 'max_repair_rounds_exhausted');
  assert.equal(state.repairCards.length, 3);
  assert.equal(state.escalations.length, 1);
  assert.equal(out.rounds, 3);
});

test('escalation branch B: Supervisor closes a finding OUT_OF_SCOPE -> loop returns DONE', async () => {
  const finding = { severity: 'P1', file: 'a.js', message: 'intentional design choice' };
  const { state, adapters } = scenario({
    heads: ['sha-1', 'sha-2', 'sha-3'],
    reviews: {
      'sha-1': rawReview('sha-1', [finding]),
      'sha-2': rawReview('sha-2', [finding]),
      'sha-3': rawReview('sha-3', [finding]),
    },
  });
  const seen = [];
  adapters.escalateSupervisor = async (payload) => {
    seen.push(payload);
    return { kind: 'OUT_OF_SCOPE' };
  };
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(out.reason, 'supervisor_closed_findings_out_of_scope');
  assert.equal(seen.length, 1);
  // The Supervisor got the full escalation context.
  assert.ok(Array.isArray(seen[0].context.rounds));
  assert.equal(seen[0].context.headSha, 'sha-2');
  assert.equal(seen[0].context.activeFindings.length, 1);
});

test('escalation branch C: Supervisor supplies a new strategy -> escalation repair (own budget), then DONE', async () => {
  const reviews = {};
  for (let i = 1; i <= 4; i += 1) {
    reviews[`sha-${i}`] = rawReview(`sha-${i}`, [{ severity: 'P2', file: `f${i}.js`, message: `distinct ${i}` }]);
  }
  reviews['sha-5'] = rawReview('sha-5', []);
  const { state, adapters } = scenario({ heads: ['sha-1', 'sha-2', 'sha-3', 'sha-4', 'sha-5'], reviews });
  adapters.escalateSupervisor = async () => ({ kind: 'NEW_STRATEGY', strategy: 'rewrite the module' });
  const persisted = [];
  const out = await runPrCloseoutLoop({
    init: { configuredReviewer: REVIEWER },
    adapters,
    config: { configuredReviewer: REVIEWER },
    persist: (s) => persisted.push(s),
  });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(state.repairCards.length, 4); // 3 ordinary + 1 escalation repair
  assert.equal(out.rounds, 3); // ordinary repair rounds unchanged
  assert.equal(persisted.at(-1).escalationRepairRounds, 1);
  assert.ok(persisted.at(-1).repairLog.some((e) => String(e.round).startsWith('E')));
  assert.equal(state.forcePushAttempts, 0);
});

test('escalation branch E: Supervisor returns HUMAN_REQUIRED with its reason', async () => {
  const finding = { severity: 'P1', file: 'a.js', message: 'ambiguous requirement' };
  const { adapters } = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: { 'sha-1': rawReview('sha-1', [finding]), 'sha-2': rawReview('sha-2', [finding]) },
  });
  adapters.escalateSupervisor = async () => ({ kind: 'HUMAN_REQUIRED', reason: 'product_owner_decision', question: 'which behaviour is correct?' });
  const out = await runPrCloseoutLoop({ init: { configuredReviewer: REVIEWER }, adapters, config: { configuredReviewer: REVIEWER } });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.equal(out.reason, 'product_owner_decision');
});

test('fork PR with no safe write path is review-only for actionable findings', async () => {
  const { state, adapters } = scenario({
    heads: ['sha-1'],
    reviews: { 'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'bug' }]) },
  });
  const out = await runPrCloseoutLoop({
    init: { configuredReviewer: REVIEWER, isFork: true, safeForkWritePath: false },
    adapters,
    config: { configuredReviewer: REVIEWER, isFork: true },
  });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.REVIEW_ONLY);
  assert.equal(state.pushCalls.length, 0);
});

test('resume: a persisted mid-loop state continues to the same terminal outcome', async () => {
  const finding = { severity: 'P1', file: 'a.js', message: 'off by one' };

  // Run 1 — crash right after the first repair push by capping iterations.
  const s1 = scenario({
    heads: ['sha-1', 'sha-2'],
    reviews: { 'sha-1': rawReview('sha-1', [finding]), 'sha-2': rawReview('sha-2', []) },
  });
  let lastPersisted = null;
  await runPrCloseoutLoop({
    init: { prNumber: 7, configuredReviewer: REVIEWER },
    adapters: s1.adapters,
    config: { configuredReviewer: REVIEWER },
    persist: (st) => { lastPersisted = st; },
    maxIterations: 1,
  }).catch(() => {});
  assert.ok(lastPersisted);

  // Run 2 — fresh scenario already at the repaired head, resuming from the
  // persisted state.
  const s2 = scenario({
    heads: ['sha-2'],
    reviews: { 'sha-2': rawReview('sha-2', []) },
  });
  const out = await runPrCloseoutLoop({
    state: JSON.parse(JSON.stringify(lastPersisted)),
    adapters: s2.adapters,
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
});

test('WorkflowStateManager persists and reloads the closeout state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-state-'));
  try {
    const mgr = new WorkflowStateManager({ workflowId: 'wf-agy-closeout-test', root });
    const closeout = serializeCloseoutState(
      initialCloseoutState({ prNumber: 7, prHead: 'sha-1', configuredReviewer: REVIEWER }),
    );
    closeout.repairRounds = 2;
    mgr.recordCloseoutState(closeout);

    const reloaded = readCloseoutState({ workflowId: 'wf-agy-closeout-test', root });
    assert.deepEqual(reloaded, closeout);
    assert.equal(readLiveWorkflowState({ workflowId: 'wf-agy-closeout-test', root }).prCloseout.repairRounds, 2);

    mgr.recordCloseoutState(null);
    assert.equal(readCloseoutState({ workflowId: 'wf-agy-closeout-test', root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// GitHub PR Closeout review adapter (githubPrReviewAdapter.js)
// --------------------------------------------------------------------------

// A scripted, fully offline GitHub PR + reviewer environment with a fake clock.
function fakeGithub({
  head = 'sha-1',
  headTimeline = null,
  results = [],
  resultsByTick = null,
  availableReviewers = null,
  postError = null,
  listError = null,
} = {}) {
  const gh = {
    tick: 0,
    head,
    comments: [],
    nextId: 100,
    listCalls: 0,
    postCalls: 0,
    forcePush: 0,
    async getPrHead() {
      if (Array.isArray(headTimeline)) {
        const value = headTimeline[Math.min(gh.tick, headTimeline.length - 1)];
        gh.tick += 1;
        return value;
      }
      return gh.head;
    },
    async isReviewerAvailable({ reviewer }) {
      if (availableReviewers === null) return true;
      return availableReviewers.includes(reviewer);
    },
    async postReviewTrigger({ prNumber, body }) {
      gh.postCalls += 1;
      if (postError) throw postError;
      const comment = { id: (gh.nextId += 1), body, prNumber, createdAt: `2026-01-01T00:00:0${gh.postCalls}Z` };
      gh.comments.push(comment);
      return comment;
    },
    async listReviewResults() {
      gh.listCalls += 1;
      if (listError) throw listError;
      const batch = resultsByTick
        ? (resultsByTick[gh.listCalls] ?? [])
        : results;
      return batch;
    },
  };
  return gh;
}

function fakeClock(start = 0) {
  const c = { t: start, sleeps: [] };
  return {
    now: () => c.t,
    sleep: async (ms) => { c.sleeps.push(ms); c.t += ms; },
    _c: c,
  };
}

test('resolveTriggerText returns the evidence-backed @codex/@claude review contract', () => {
  assert.equal(resolveTriggerText('codex'), '@codex review');
  assert.equal(resolveTriggerText('claude'), '@claude review');
  assert.equal(PR_REVIEW_TRIGGER_TEXT.claude, '@claude review');
  // Injected metadata override wins, but an unknown reviewer with no override throws.
  assert.equal(resolveTriggerText('claude', { overrides: { claude: '@claude please review' } }), '@claude please review');
  assert.throws(() => resolveTriggerText('mystery-bot'), /no confirmed GitHub trigger contract/);
});

test('adapter triggers @codex review then returns the reviewer result bound to the current head', async () => {
  const gh = fakeGithub({
    head: 'sha-1',
    resultsByTick: {
      1: [],
      2: [{ id: 500, author: 'codex', headSha: 'sha-1', submittedAt: '2026-01-01T01:00:00Z', findings: [{ severity: 'P1', file: 'a.js', message: 'bug' }] }],
    },
  });
  const clock = fakeClock();
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock, reviewer: 'codex', workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const out = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });

  assert.equal(out.ok, true);
  assert.equal(out.review.reviewer, 'codex');
  assert.equal(out.review.headSha, 'sha-1');
  assert.deepEqual(out.review.findings, [{ severity: 'P1', file: 'a.js', message: 'bug' }]);
  assert.equal(gh.comments[0].body, '@codex review');
  assert.equal(gh.postCalls, 1);
  // Polled with an interval inside the 15–30s band.
  assert.ok(clock._c.sleeps.every((ms) => ms >= MIN_POLL_INTERVAL_MS && ms <= MAX_POLL_INTERVAL_MS));
});

test('adapter ignores stale reviews: wrong author, old head, pre-trigger', async () => {
  const gh = fakeGithub({
    head: 'sha-2',
    resultsByTick: {
      1: [
        { id: 1, author: 'codex', headSha: 'sha-2', submittedAt: '2025-01-01T00:00:00Z', findings: [] }, // before trigger id
        { id: 900, author: 'someone-else', headSha: 'sha-2', submittedAt: '2026-02-01T00:00:00Z', findings: [] }, // wrong author
        { id: 901, author: 'claude', headSha: 'sha-OLD', submittedAt: '2026-02-01T00:00:00Z', findings: [] }, // old head
      ],
      2: [
        { id: 902, author: 'claude', headSha: 'sha-2', submittedAt: '2026-02-02T00:00:00Z', findings: [] },
      ],
    },
  });
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock: fakeClock(), reviewer: 'claude', workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const out = await adapter.requestReview({ prNumber: 7, prHead: 'sha-2' });
  assert.equal(out.ok, true);
  assert.equal(out.review.reviewId, 902);
});

test('adapter de-dupes a pending trigger for the same reviewer/head (no second comment)', async () => {
  const gh = fakeGithub({ head: 'sha-1', results: [] });
  const clock = fakeClock();
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock, reviewer: 'codex', maxWaitMs: 40_000, workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const first = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });
  assert.equal(first.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);
  assert.equal(gh.postCalls, 1);
  assert.ok(adapter.pending);

  // Resume: the pending trigger is reused, not re-posted.
  const resumed = createGithubPrReviewAdapter({
    github: gh, clock, reviewer: 'codex', maxWaitMs: 40_000, pending: first.pending,
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  await resumed.requestReview({ prNumber: 7, prHead: 'sha-1' });
  assert.equal(gh.postCalls, 1);
});

test('external head change during the wait invalidates and re-triggers against the new head', async () => {
  const gh = fakeGithub({
    headTimeline: ['sha-1', 'sha-1', 'sha-2', 'sha-2'],
    resultsByTick: {
      1: [],
      2: [{ id: 700, author: 'codex', headSha: 'sha-1', submittedAt: '2026-01-01T05:00:00Z', findings: [] }], // late old-head result — must be ignored
      3: [{ id: 800, author: 'codex', headSha: 'sha-2', submittedAt: '2026-01-01T06:00:00Z', findings: [] }],
    },
  });
  const persisted = [];
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock: fakeClock(), reviewer: 'codex', persist: (p) => persisted.push(p),
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const out = await adapter.requestReview({ prNumber: 7 });
  assert.equal(out.ok, true);
  assert.equal(out.review.headSha, 'sha-2');
  assert.equal(gh.postCalls, 2); // re-triggered for the new head
  assert.equal(gh.forcePush, 0);
});

test('adapter returns classified failures: UNAVAILABLE / AUTHORITY_BLOCKED / TIMEOUT / INFRASTRUCTURE', async () => {
  const unavailable = createGithubPrReviewAdapter({
    github: fakeGithub({ availableReviewers: ['claude'] }), clock: fakeClock(), reviewer: 'codex',
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  assert.equal((await unavailable.requestReview({ prNumber: 1, prHead: 'sha-1' })).failure, GITHUB_REVIEW_FAILURES.UNAVAILABLE);

  // A postReviewTrigger() error crosses the External Model Trigger Authority
  // (already durably DISPATCHING at that point) and is therefore ambiguous —
  // classified as an authority-blocked UNRESOLVED, never a plain retryable
  // TRIGGER_FAILED (§ Part H: unknown trigger outcome != zero).
  const triggerFailed = createGithubPrReviewAdapter({
    github: fakeGithub({ postError: new Error('422 unprocessable') }), clock: fakeClock(), reviewer: 'codex',
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  assert.equal((await triggerFailed.requestReview({ prNumber: 1, prHead: 'sha-1' })).failure, GITHUB_REVIEW_FAILURES.AUTHORITY_BLOCKED);

  const timedOut = createGithubPrReviewAdapter({
    github: fakeGithub({ results: [] }), clock: fakeClock(), reviewer: 'codex', maxWaitMs: 30_000,
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  assert.equal((await timedOut.requestReview({ prNumber: 1, prHead: 'sha-1' })).failure, GITHUB_REVIEW_FAILURES.TIMEOUT);

  const infra = createGithubPrReviewAdapter({
    github: fakeGithub({ listError: Object.assign(new Error('bad gateway'), { status: 502 }) }),
    clock: fakeClock(), reviewer: 'codex', workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  assert.equal((await infra.requestReview({ prNumber: 1, prHead: 'sha-1' })).failure, GITHUB_REVIEW_FAILURES.INFRASTRUCTURE);
});

test('adapter result feeds the closeout loop as a trusted review payload', async () => {
  const gh = fakeGithub({
    head: 'sha-1',
    resultsByTick: {
      1: [{ id: 400, author: 'trusted-claude-reviewer', headSha: 'sha-1', submittedAt: '2026-01-01T02:00:00Z', findings: [] }],
    },
  });
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock: fakeClock(), reviewer: 'claude',
    reviewerIdentities: { claude: 'trusted-claude-reviewer' },
    workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const out = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });
  assert.equal(out.ok, true);

  const loop = await runPrCloseoutLoop({
    init: { prNumber: 7, configuredReviewer: REVIEWER },
    adapters: {
      getPrHead: async () => 'sha-1',
      requestTrustedReview: async () => out.review,
    },
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(loop.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(loop.reason, 'clean_trusted_review');
});

// --------------------------------------------------------------------------
// Reviewer failover composition (adapter classified failure -> failoverReviewer)
// and the zero-model-token guarantee of the polling wait.
// --------------------------------------------------------------------------

// Records every property read on the wrapped object so a test can prove the
// polling wait touches nothing but the injected GitHub client + fake clock.
function recordingProxy(target, seen) {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string') seen.add(prop);
      return obj[prop];
    },
  });
}

test('Codex -> Claude -> internal timeout fallback: no repair round burned, no real wait', async () => {
  let state = initialCloseoutState({ prNumber: 7, prHead: 'sha-1', configuredReviewer: REVIEWER });
  assert.deepEqual(state.reviewerCandidateOrder, PR_REVIEWER_FALLBACK_ORDER);

  const clock = fakeClock();
  const walk = [];
  // codex and claude both time out; internal finally produces a clean review.
  for (const candidate of ['codex', 'claude']) {
    assert.equal(currentReviewerCandidate(state), candidate);
    const adapter = createGithubPrReviewAdapter({
      github: fakeGithub({ head: 'sha-1', results: [] }),
      clock, reviewer: candidate, maxWaitMs: 45_000,
      // Fresh per-candidate authority: this test exercises the closeout
      // policy's reviewerCandidateOrder failover, not the External Model
      // Trigger Authority's cross-reviewer same-HEAD dedupe (covered in
      // externalModelTriggerAuthority.test.js).
      workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
    });
    const res = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });
    assert.equal(res.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);
    const f = failoverReviewer(state, 'timeout');
    assert.equal(f.switched, true);
    state = f.state;
    walk.push(f.reviewer);
  }
  assert.deepEqual(walk, ['claude', 'internal']);
  assert.equal(currentReviewerCandidate(state), 'internal');
  assert.equal(state.reviewerFailovers.length, 2);
  // Failover is never a repair attempt.
  assert.equal(state.repairRounds, 0);
  // The fake clock advanced only through injected sleeps — no real waiting.
  assert.ok(clock._c.sleeps.length > 0);
  assert.ok(clock._c.sleeps.every((ms) => ms >= MIN_POLL_INTERVAL_MS && ms <= MAX_POLL_INTERVAL_MS));

  // internal reviewer succeeds and the workflow locks onto it.
  state = lockActiveReviewer(state, 'internal');
  const done = await runPrCloseoutLoop({
    state: JSON.parse(JSON.stringify(serializeCloseoutState(state))),
    adapters: {
      getPrHead: async () => 'sha-1',
      requestTrustedReview: async () => rawReview('sha-1', []),
    },
    config: { configuredReviewer: REVIEWER },
  });
  assert.equal(done.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
});

test('adapter INFRASTRUCTURE failure drives failover, never a repair round', async () => {
  let state = initialCloseoutState({ prNumber: 7, prHead: 'sha-1', configuredReviewer: REVIEWER });
  const adapter = createGithubPrReviewAdapter({
    github: fakeGithub({ listError: Object.assign(new Error('bad gateway'), { status: 502 }) }),
    clock: fakeClock(), reviewer: 'codex', workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const res = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });
  assert.equal(res.failure, GITHUB_REVIEW_FAILURES.INFRASTRUCTURE);

  const before = state.repairRounds;
  const f = failoverReviewer(state, 'infrastructure');
  state = f.state;
  assert.equal(f.reviewer, 'claude');
  assert.equal(state.repairRounds, before);
  assert.equal(state.reviewerFailovers.length, 1);
});

test('all reviewers exhausted -> REVIEW_INFRASTRUCTURE, no repair round consumed', () => {
  let state = initialCloseoutState({ prNumber: 7, prHead: 'sha-1', configuredReviewer: REVIEWER });
  let last;
  for (let i = 0; i < PR_REVIEWER_FALLBACK_ORDER.length; i += 1) {
    last = failoverReviewer(state, 'timeout');
    state = last.state;
  }
  assert.equal(last.exhausted, true);
  assert.equal(last.humanRequiredReason, REVIEW_INFRASTRUCTURE_REASON);
  assert.equal(state.repairRounds, 0);
});

test('polling wait spends zero model tokens: only the GitHub client and clock are touched', async () => {
  const seenGh = new Set();
  const seenClock = new Set();
  const gh = recordingProxy(fakeGithub({ head: 'sha-1', results: [] }), seenGh);
  const clock = recordingProxy(fakeClock(), seenClock);
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock, reviewer: 'codex', maxWaitMs: 60_000, workflowId: 'wf-test', triggerAuthority: testTriggerAuthority(),
  });
  const res = await adapter.requestReview({ prNumber: 7, prHead: 'sha-1' });
  assert.equal(res.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);

  const allowedGh = new Set(['getPrHead', 'isReviewerAvailable', 'postReviewTrigger', 'listReviewResults']);
  const allowedClock = new Set(['now', 'sleep', '_c']);
  for (const name of seenGh) assert.ok(allowedGh.has(name), `unexpected github access: ${name}`);
  for (const name of seenClock) assert.ok(allowedClock.has(name), `unexpected clock access: ${name}`);
  // It really did poll (multiple list calls) and it really did back off via the
  // injected clock rather than a real timer.
  assert.ok(gh.listCalls > 1);
  assert.ok(clock._c.sleeps.length > 1);
});
