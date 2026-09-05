// § Pending external review must never project to a synthetic internal clean
// review (self-repair pass on top of the accepted External Model Trigger
// Authority core — see externalModelTriggerAuthority.js / prCloseoutLoop.js /
// supergpt.js#createRealGithubPrCloseoutAdapters).
//
// Once a "@codex review" / "@claude review" trigger for a HEAD has crossed
// the Authority's dispatch boundary (DISPATCHING or later), a mechanical
// polling timeout or an authority-blocked duplicate for that SAME head must
// NEVER be reinterpreted as "no review happened": no cross-reviewer
// failover, no synthetic internal CLEAN fallback, and the closeout loop must
// stop at HUMAN_REQUIRED rather than reaching DONE from an invented review.
//
// Every test here drives the REAL createGithubPrReviewAdapter +
// ExternalModelTriggerAuthority + the exported pendingTrustedReview()
// projection (the exact function createRealGithubPrCloseoutAdapters().
// requestTrustedReview uses) + the REAL runPrCloseoutLoop. Only the GitHub
// wire client and the clock are fakes — no shell, no network, no model call.
//
// REAL EXTERNAL MODEL TRIGGERS = 0. REAL PROVIDER CALLS = 0. SUPERGPT_* TOOL
// CALLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGithubPrReviewAdapter,
  GITHUB_REVIEW_FAILURES,
} from '../src/orchestrator/adapters/githubPrReviewAdapter.js';
import { ExternalModelTriggerAuthority, EXTERNAL_TRIGGER_STATUS } from '../src/orchestrator/externalModelTriggerAuthority.js';
import { pendingTrustedReview } from '../src/orchestrator/supergpt.js';
import { runPrCloseoutLoop, PR_CLOSEOUT_LOOP_STATUS } from '../src/orchestrator/prCloseoutLoop.js';

// Deterministic polling clock: sleep() advances the virtual clock instead of
// waiting on a real timer, so a bounded maxWaitMs poll-to-timeout resolves
// instantly.
function pollingClock(start = 0) {
  const c = { t: start };
  return { now: () => c.t, sleep: async (ms) => { c.t += ms; } };
}

function fakeGithub({ available = () => true, resultsByCall = null, postError = null } = {}) {
  const gh = {
    postCalls: 0,
    listCalls: 0,
    async getPrHead() { return gh.head; },
    async isReviewerAvailable({ reviewer }) { return available(reviewer); },
    async postReviewTrigger() {
      gh.postCalls += 1;
      if (postError) throw postError;
      return { id: `c${gh.postCalls}`, createdAt: 'now' };
    },
    async listReviewResults() {
      gh.listCalls += 1;
      if (!resultsByCall) return [];
      return resultsByCall[gh.listCalls] ?? [];
    },
  };
  gh.head = 'H1';
  return gh;
}

// Mirrors the exact control flow of
// createRealGithubPrCloseoutAdapters().requestTrustedReview using the REAL
// adapter + REAL exported pendingTrustedReview() projection, so the
// production decision logic is exercised end to end without executing `gh`
// via a shell.
async function requestTrustedReviewLikeProduction({ github, authority, prHead = 'H1', workflowId = 'wf-1' }) {
  const codexAdapter = createGithubPrReviewAdapter({
    github, clock: pollingClock(), reviewer: 'codex', workflowId, triggerAuthority: authority,
    pollIntervalMs: 5_000, maxWaitMs: 15_000,
  });
  const res = await codexAdapter.requestReview({ prNumber: 4, prHead });
  if (res.ok) return { review: res.review, codexPosts: github.postCalls };
  if (res.externalTriggerDispatched) return { review: pendingTrustedReview('codex', res, prHead), codexPosts: github.postCalls };

  const claudeAdapter = createGithubPrReviewAdapter({
    github, clock: pollingClock(), reviewer: 'claude', workflowId, triggerAuthority: authority,
    pollIntervalMs: 5_000, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead });
  if (claudeRes.ok) return { review: claudeRes.review, codexPosts: github.postCalls };
  if (claudeRes.externalTriggerDispatched) return { review: pendingTrustedReview('claude', claudeRes, prHead), codexPosts: github.postCalls };

  return {
    review: { reviewer: 'internal', headSha: prHead, reviewedAt: new Date().toISOString(), findings: [] },
    codexPosts: github.postCalls,
  };
}

// --------------------------------------------------------------------------
// 1. Codex available -> trigger posted -> timeout: pending, no Claude post,
//    no synthetic internal clean review.
// --------------------------------------------------------------------------
test('1. posted-trigger timeout: pending review, Codex post=1, Claude post=0, never synthetic clean', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({});
  const { review, codexPosts } = await requestTrustedReviewLikeProduction({ github: gh, authority });

  assert.equal(codexPosts, 1);
  assert.equal(gh.postCalls, 1); // never a second (Claude) post
  assert.equal(review.pending, true);
  assert.notEqual(review.reviewer, 'internal');
  assert.equal(review.reviewer, 'codex');
  assert.equal(review.reason, 'external_review_posted_trigger_timeout');
  assert.equal('findings' in review, false); // never a synthetic findings:[] clean payload
});

// --------------------------------------------------------------------------
// 2. That pending projection, fed into the REAL closeout loop, stops at
//    HUMAN_REQUIRED — never DONE from an invented internal review.
// --------------------------------------------------------------------------
test('2. pending external review projects the REAL closeout loop to HUMAN_REQUIRED, never DONE', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({});
  let posts = 0;

  const outcome = await runPrCloseoutLoop({
    init: { prNumber: 4, prHead: 'H1', configuredReviewer: 'codex' },
    adapters: {
      getPrHead: async () => 'H1',
      requestTrustedReview: async ({ prNumber: p, prHead }) => {
        const { review, codexPosts } = await requestTrustedReviewLikeProduction({ github: gh, authority, prHead });
        posts = codexPosts;
        return review;
      },
    },
  });

  assert.equal(outcome.status, PR_CLOSEOUT_LOOP_STATUS.HUMAN_REQUIRED);
  assert.notEqual(outcome.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(outcome.reason, 'external_review_posted_trigger_timeout');
  assert.equal(posts, 1); // total external posts across the whole closeout call = 1
  assert.equal(gh.postCalls, 1);
});

// --------------------------------------------------------------------------
// 3. Codex unavailable BEFORE authorize/dispatch: zero-spend, no reservation,
//    Claude may still authorize + post.
// --------------------------------------------------------------------------
test('3. Codex unavailable pre-dispatch creates zero authority state; Claude posts once', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({ available: (r) => r !== 'codex' });

  // Prove codex made zero physical posts BEFORE Claude ever runs, by driving
  // just the codex adapter first.
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const codexRes = await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(codexRes.failure, GITHUB_REVIEW_FAILURES.UNAVAILABLE);
  assert.equal(codexRes.externalTriggerDispatched, false);
  assert.equal(gh.postCalls, 0);

  const { review } = await requestTrustedReviewLikeProduction({ github: gh, authority });

  const records = await authority.list('wf-1');
  assert.equal(records.filter((r) => r.reviewerRequested === 'codex').length, 0, 'no RESERVED/DISPATCHING record for codex');
  assert.equal(gh.postCalls, 1); // Claude's post
  // Claude posted then also timed out (no results injected) — still pending,
  // never a synthetic internal clean review, since Claude's own trigger DID
  // cross the dispatch boundary.
  assert.equal(review.pending, true);
  assert.equal(review.reviewer, 'claude');
});

// --------------------------------------------------------------------------
// 4. Existing same-head dedupe: Codex H1 triggered -> Claude H1 cannot post.
// --------------------------------------------------------------------------
test('4. Codex H1 triggered -> Claude H1 authorize() is a REUSE, never a second post', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({});
  await requestTrustedReviewLikeProduction({ github: gh, authority }); // codex posts, times out, pending short-circuits before Claude ever runs
  assert.equal(gh.postCalls, 1);

  // Explicitly drive a Claude adapter for the SAME head to prove REUSE holds
  // even if something did ask Claude directly.
  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(gh.postCalls, 1); // still exactly one physical post total
  assert.equal(claudeRes.ok, false);
  assert.equal(claudeRes.externalTriggerDispatched, true);
});

// --------------------------------------------------------------------------
// 5. Timeout replay: a later retry for the same HEAD reuses the same
//    trigger; no additional external post.
// --------------------------------------------------------------------------
test('5. timeout replay reuses the SAME trigger — no additional external post', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({});
  const first = await requestTrustedReviewLikeProduction({ github: gh, authority });
  assert.equal(first.codexPosts, 1);

  const retry = await requestTrustedReviewLikeProduction({ github: gh, authority });
  assert.equal(gh.postCalls, 1); // no repost on retry
  assert.equal(retry.review.pending, true);
});

// --------------------------------------------------------------------------
// 6. DISPATCHING/UNRESOLVED: no Claude/internal fallback.
// --------------------------------------------------------------------------
test('6. dispatchFn ambiguous (UNRESOLVED) -> no Claude post, no synthetic internal clean review', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({ postError: new Error('network blip after send') });

  const { review, codexPosts } = await requestTrustedReviewLikeProduction({ github: gh, authority });

  assert.equal(codexPosts, 1); // one physical dispatch attempt was made
  assert.equal(review.pending, true);
  assert.notEqual(review.reviewer, 'internal');

  // A subsequent Claude ask for the SAME head must also be denied (UNRESOLVED
  // is DISPATCH_OR_LATER) rather than posting.
  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(claudeRes.externalTriggerDispatched, true);
  assert.equal(gh.postCalls, 1);
});

// --------------------------------------------------------------------------
// 7. New HEAD still permits one new external review.
// --------------------------------------------------------------------------
test('7. a fresh HEAD after a pending review still authorizes exactly one new trigger', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({});
  await requestTrustedReviewLikeProduction({ github: gh, authority, prHead: 'H1' });
  assert.equal(gh.postCalls, 1);

  gh.head = 'H2';
  const second = await requestTrustedReviewLikeProduction({ github: gh, authority, prHead: 'H2' });
  assert.equal(gh.postCalls, 2);
  assert.equal(second.review.pending, true); // still times out (no results injected), but a NEW trigger was allowed
});

// --------------------------------------------------------------------------
// 8. A delayed but matching Codex result can still settle the trigger
//    normally (persisted trigger is not poisoned by earlier empty polls).
// --------------------------------------------------------------------------
test('8. a delayed matching Codex result settles the persisted trigger normally', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({
    resultsByCall: {
      1: [],
      2: [{ id: 900, author: 'codex', headSha: 'H1', submittedAt: '2026-01-01T00:00:02Z', findings: [] }],
    },
  });
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority,
    pollIntervalMs: 15_000, maxWaitMs: 45_000,
  });
  const res = await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(res.ok, true);
  assert.equal(res.review.reviewer, 'codex');
  assert.equal(gh.postCalls, 1);
});

// --------------------------------------------------------------------------
// REUSE reviewer semantics: a reused trigger keeps polling under the
// ORIGINAL reviewer identity, never the identity of whichever adapter
// happens to reuse it.
// --------------------------------------------------------------------------
test('REUSE keeps the original reviewer identity — a matching result under that identity still resolves', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({
    resultsByCall: {
      1: [],
      2: [{ id: 901, author: 'codex', headSha: 'H1', submittedAt: '2026-01-01T00:00:02Z', findings: [] }],
    },
  });
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' }); // just posts; result not yet injected on call 1

  // A fresh Claude adapter now reuses the persisted Codex trigger. It must
  // recognize the CODEX-authored result, not require a claude-authored one.
  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(1), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority,
    pollIntervalMs: 1_000, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(gh.postCalls, 1); // Claude never posted
  assert.equal(claudeRes.ok, true);
  assert.equal(claudeRes.review.reviewer, 'codex'); // ownership preserved, not reassigned to claude
});

// --------------------------------------------------------------------------
// Availability ordering: an unavailable reviewer never touches the authority
// at all (zero RESERVED/DISPATCHING records for it).
// --------------------------------------------------------------------------
test('availability probe runs before authorize(): unavailable reviewer creates zero authority state', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = fakeGithub({ available: () => false });
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const res = await adapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(res.failure, GITHUB_REVIEW_FAILURES.UNAVAILABLE);
  assert.equal(res.externalTriggerDispatched, false);
  const records = await authority.list('wf-1');
  assert.equal(records.length, 0);
  assert.equal(gh.postCalls, 0);
});
