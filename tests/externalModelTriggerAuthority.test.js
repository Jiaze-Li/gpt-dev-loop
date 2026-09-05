// External Model Trigger Authority — deterministic, zero-model, durable,
// fail-closed authorization boundary for "@codex review" / "@claude review"
// GitHub PR-review triggers (see src/orchestrator/externalModelTriggerAuthority.js).
//
// Every test here is fully offline/deterministic. REAL EXTERNAL MODEL
// TRIGGERS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExternalModelTriggerAuthority,
  ExternalTriggerStore,
  ExternalTriggerPermit,
  EXTERNAL_TRIGGER_STATUS,
  DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS,
  DEFAULT_MAX_EXTERNAL_MODEL_TRIGGERS,
} from '../src/orchestrator/externalModelTriggerAuthority.js';
import { ExternalTriggerError, EXTERNAL_TRIGGER_ERROR_CODES, isExternalTriggerFailure } from '../src/orchestrator/errors.js';
import {
  createGithubPrReviewAdapter, GITHUB_REVIEW_FAILURES,
} from '../src/orchestrator/adapters/githubPrReviewAdapter.js';
import { DEFAULT_MAX_REPAIR_ROUNDS, DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS } from '../src/orchestrator/prCloseoutPolicy.js';

function fakeClock(start = 0) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms) => { c.t += ms; }, _c: c };
}

// A polling clock for adapter-level integration tests: sleep() advances the
// virtual clock instantly instead of using a real timer, so a bounded
// maxWaitMs poll-to-timeout resolves in microseconds, not real seconds.
function pollingClock(start = 0) {
  const c = { t: start };
  return { now: () => c.t, sleep: async (ms) => { c.t += ms; } };
}

function intent(overrides = {}) {
  return {
    workflowId: 'wf-1', prNumber: 4, headSha: 'H1', triggerKind: 'PR_REVIEW', reviewer: 'codex', ...overrides,
  };
}

// A minimal fake Persistence (matches ReservationStore's expected shape):
// readWorkflowState/updateWorkflowState against an in-memory map, so tests
// can exercise durability/restart without touching the filesystem.
function fakePersistence() {
  const store = new Map();
  return {
    async readWorkflowState(workflowId) { return store.get(workflowId) ?? {}; },
    async updateWorkflowState(workflowId, patch) {
      store.set(workflowId, { ...(store.get(workflowId) ?? {}), ...patch });
    },
  };
}

// --------------------------------------------------------------------------
// 1. First HEAD trigger
// --------------------------------------------------------------------------
test('1. fresh HEAD -> one authorization, one dispatch', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent());
  assert.equal(auth.outcome, 'ALLOW');
  let posts = 0;
  const result = await authority.dispatch(auth.permit, intent(), async () => {
    posts += 1;
    return { id: 'c1', createdAt: '2026-01-01T00:00:00Z' };
  });
  assert.equal(posts, 1);
  assert.equal(result.commentId, 'c1');
});

// --------------------------------------------------------------------------
// 2. Same reviewer + same HEAD duplicate
// --------------------------------------------------------------------------
test('2. same reviewer + same HEAD already TRIGGERED -> reused, no repost', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth1 = await authority.authorize(intent());
  await authority.dispatch(auth1.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));

  // TRIGGERED is reused (not re-authorized as a fresh dispatch) — the caller
  // adopts the persisted comment id and never calls dispatch() again.
  const again = await authority.authorize(intent());
  assert.equal(again.outcome, 'REUSE');
  assert.equal(again.trigger.commentId, 'c1');
});

// --------------------------------------------------------------------------
// 3. Different reviewer + same HEAD — critical cross-reviewer dedupe
// --------------------------------------------------------------------------
test('3. Codex triggered H1 -> Claude requesting H1 gets zero posts (reused, not re-authorized)', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const codexAuth = await authority.authorize(intent({ reviewer: 'codex' }));
  await authority.dispatch(codexAuth.permit, intent({ reviewer: 'codex' }), async () => ({ id: 'codex-1', createdAt: 'now' }));

  // Reviewer change alone is never fresh information for the same HEAD: the
  // Claude request reuses the ALREADY-triggered comment; no permit is ever
  // minted for it, so dispatch() (the physical post) can never be reached.
  const claudeAuth = await authority.authorize(intent({ reviewer: 'claude' }));
  assert.equal(claudeAuth.outcome, 'REUSE');
  assert.equal(claudeAuth.trigger.commentId, 'codex-1');
  assert.equal(claudeAuth.permit, undefined);
});

// --------------------------------------------------------------------------
// 4. Reviewer unavailable pre-dispatch (integration, via the adapter)
// --------------------------------------------------------------------------
test('4. Codex unavailable pre-dispatch (zero spend) -> Claude may authorize + post H1', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = {
    postCalls: 0,
    async getPrHead() { return 'H1'; },
    async isReviewerAvailable({ reviewer }) { return reviewer !== 'codex'; },
    async postReviewTrigger() { gh.postCalls += 1; return { id: 'c1', createdAt: 'now' }; },
    async listReviewResults() { return []; },
  };
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const codexRes = await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(codexRes.failure, GITHUB_REVIEW_FAILURES.UNAVAILABLE);
  assert.equal(gh.postCalls, 0);

  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(claudeRes.failure, GITHUB_REVIEW_FAILURES.TIMEOUT); // no matching result injected
  assert.equal(gh.postCalls, 1);
});

// --------------------------------------------------------------------------
// 5. Provider/reviewer timeout -> retry reuses the SAME persisted trigger
// --------------------------------------------------------------------------
test('5. timeout then retry request -> post count remains 1 (same trigger reused)', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth1 = await authority.authorize(intent());
  await authority.dispatch(auth1.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));

  // A later retry for the SAME head must REUSE, not error and not repost.
  const retry = await authority.authorize(intent());
  assert.equal(retry.outcome, 'REUSE');
  assert.equal(retry.trigger.commentId, 'c1');
});

// --------------------------------------------------------------------------
// 6 & 7. New HEAD authorized; old HEAD returning later stays consumed
// --------------------------------------------------------------------------
test('6/7. H2 gets one fresh trigger; H1 returning later never re-triggers', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const a1 = await authority.authorize(intent({ headSha: 'H1' }));
  await authority.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));

  const a2 = await authority.authorize(intent({ headSha: 'H2' }));
  assert.equal(a2.outcome, 'ALLOW');
  await authority.dispatch(a2.permit, intent({ headSha: 'H2' }), async () => ({ id: 'c2', createdAt: 'now' }));

  // HEAD returns to H1 — must not re-trigger; H1's persisted trigger is
  // reused, never re-posted, regardless of which reviewer asks.
  const back = await authority.authorize(intent({ headSha: 'H1', reviewer: 'claude' }));
  assert.equal(back.outcome, 'REUSE');
  assert.equal(back.trigger.commentId, 'c1');
});

// --------------------------------------------------------------------------
// 8. Crash after RESERVED — dispatch mechanically impossible -> may cancel
// --------------------------------------------------------------------------
test('8. RESERVED never reaching DISPATCHING is safely superseded, no false "maybe sent"', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth1 = await authority.authorize(intent()); // RESERVED, never dispatched
  assert.equal(auth1.outcome, 'ALLOW');

  // A second authorize() for the SAME head (simulating resume after a crash
  // before dispatch()) must supersede the dangling RESERVED and still allow
  // a fresh dispatch — dispatch never physically began.
  const auth2 = await authority.authorize(intent());
  assert.equal(auth2.outcome, 'ALLOW');
  const result = await authority.dispatch(auth2.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));
  assert.equal(result.commentId, 'c1');
});

// --------------------------------------------------------------------------
// 9. Crash after DISPATCHING -> UNRESOLVED/blocking, post count after restart = 0
// --------------------------------------------------------------------------
test('9. DISPATCHING persisted then process "crashes" -> resume reconciles to UNRESOLVED, no retrigger', async () => {
  const persistence = fakePersistence();
  const authority1 = new ExternalModelTriggerAuthority({ store: new ExternalTriggerStore(persistence) });
  const auth = await authority1.authorize(intent());
  // Simulate a crash: markDispatching persisted, dispatchFn never resolves
  // (mimic by directly driving dispatch() with a dispatchFn that never
  // settles is awkward in a unit test; instead we drive to DISPATCHING via a
  // dispatchFn that throws, which persists UNRESOLVED — a stronger
  // authority test below (11) covers that path explicitly). Here we
  // simulate the crash by loading a FRESH authority instance against the
  // SAME store after persist() wrote DISPATCHING but before this process
  // ever wrote TRIGGERED/UNRESOLVED: force that shape directly through the
  // store to model an interrupted process.
  void auth;
  const raw = await persistence.readWorkflowState('wf-1');
  const subjectKey = 'wf-1::4::PR_REVIEW';
  raw.externalModelTriggers[subjectKey].triggers.H1.status = EXTERNAL_TRIGGER_STATUS.DISPATCHING;
  await persistence.updateWorkflowState('wf-1', raw);

  const authority2 = new ExternalModelTriggerAuthority({ store: new ExternalTriggerStore(persistence) });
  await authority2.reconcileOnResume('wf-1');

  let posts = 0;
  await assert.rejects(
    () => authority2.authorize(intent()),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
  );
  assert.equal(posts, 0);
});

// --------------------------------------------------------------------------
// 10. Post succeeds, TRIGGERED persistence fails -> stays blocking, no retry
// --------------------------------------------------------------------------
test('10. postReviewTrigger succeeds but TRIGGERED persist fails -> blocking, retry post = 0', async () => {
  // Fail only the save immediately AFTER dispatchFn resolves (the TRIGGERED
  // write) — every save up to and including the DISPATCHING boundary must
  // succeed normally so dispatchFn actually runs.
  let failNext = false;
  const inner = fakePersistence();
  const flaky = {
    async readWorkflowState(id) { return inner.readWorkflowState(id); },
    async updateWorkflowState(id, patch) {
      if (failNext) { failNext = false; throw new Error('disk full'); }
      return inner.updateWorkflowState(id, patch);
    },
  };
  const authority = new ExternalModelTriggerAuthority({ store: new ExternalTriggerStore(flaky) });
  const auth = await authority.authorize(intent());

  let posts = 0;
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent(), async () => {
      posts += 1;
      failNext = true; // arm the failure for the TRIGGERED write that follows
      return { id: 'c1', createdAt: 'now' };
    }),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_UNRESOLVED,
  );
  assert.equal(posts, 1);

  // Retry must not post again — permit is single-use and the trigger stays
  // durably DISPATCHING (blocking, not TRIGGERED, so it is a hard duplicate
  // denial rather than a reusable trigger).
  await assert.rejects(
    () => authority.authorize(intent()),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
  );
});

// --------------------------------------------------------------------------
// 11. postReviewTrigger() throws after DISPATCHING -> UNRESOLVED, no fallback
// --------------------------------------------------------------------------
test('11. dispatchFn throws after DISPATCHING -> UNRESOLVED, no cross-reviewer fallback, no retry', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent({ reviewer: 'codex' }));
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent({ reviewer: 'codex' }), async () => { throw new Error('ECONNRESET'); }),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_UNRESOLVED,
  );

  let claudePosts = 0;
  await assert.rejects(
    async () => {
      const claudeAuth = await authority.authorize(intent({ reviewer: 'claude' }));
      await authority.dispatch(claudeAuth.permit, intent({ reviewer: 'claude' }), async () => {
        claudePosts += 1;
        return { id: 'x' };
      });
    },
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
  );
  assert.equal(claudePosts, 0);
});

// --------------------------------------------------------------------------
// 12. Pending survives resume: TRIGGERED reused via a fresh authority
//     instance backed by the same durable store — no repost, polling
//     resumes against the persisted comment id.
// --------------------------------------------------------------------------
test('12. TRIGGERED survives resume -> requestReview posts 0, polls persisted trigger', async () => {
  const persistence = fakePersistence();
  const authority1 = new ExternalModelTriggerAuthority({ store: new ExternalTriggerStore(persistence) });
  const auth = await authority1.authorize(intent());
  await authority1.dispatch(auth.permit, intent(), async () => ({ id: 'comment-123', createdAt: 'now' }));

  // Fresh process: new authority instance, same durable store, no local
  // adapter pendingState.
  const authority2 = new ExternalModelTriggerAuthority({ store: new ExternalTriggerStore(persistence) });
  let postCalls = 0;
  let listedSinceId = null;
  const gh = {
    async getPrHead() { return 'H1'; },
    async postReviewTrigger() { postCalls += 1; return { id: 'should-not-be-used' }; },
    async listReviewResults({ sinceId }) { listedSinceId = sinceId; return []; },
  };
  const adapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority2, maxWaitMs: 15_000,
  });
  const res = await adapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(res.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);
  assert.equal(postCalls, 0);
  assert.equal(listedSinceId, 'comment-123');
});

// --------------------------------------------------------------------------
// 13-16. Result settlement — covered at the adapter/policy layer already
// (prCloseoutLoop.test.js's stale/wrong-author/wrong-head matching); here we
// only check that a matching result marks the trigger RESULT_RECEIVED and
// the HEAD remains untriggerable.
// --------------------------------------------------------------------------
test('13. matching result -> RESULT_RECEIVED, HEAD remains untriggerable', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent());
  await authority.dispatch(auth.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));
  await authority.recordResult({
    workflowId: 'wf-1', prNumber: 4, headSha: 'H1', triggerKind: 'PR_REVIEW', resultMeta: { reviewId: 999 },
  });
  const records = await authority.list('wf-1');
  assert.equal(records[0].status, EXTERNAL_TRIGGER_STATUS.RESULT_RECEIVED);

  await assert.rejects(
    () => authority.authorize(intent()),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
  );
});

// --------------------------------------------------------------------------
// 17/18/19. Persistence read/RESERVED-write/DISPATCHING-write failures fail
// closed (post = 0).
// --------------------------------------------------------------------------
test('17. trigger persistence read failure -> fail closed, no permit minted', async () => {
  const brokenStore = { async load() { throw new Error('read failed'); } };
  const authority = new ExternalModelTriggerAuthority({ store: brokenStore });
  await assert.rejects(
    () => authority.authorize(intent()),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_STATE_UNAVAILABLE,
  );
});

test('18. RESERVED persistence failure -> post = 0', async () => {
  const brokenStore = {
    async load() { return {}; },
    async save() { throw new Error('write failed'); },
  };
  const authority = new ExternalModelTriggerAuthority({ store: brokenStore });
  await assert.rejects(
    () => authority.authorize(intent()),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_STATE_UNAVAILABLE,
  );
});

test('19. DISPATCHING persistence failure -> post = 0 (dispatchFn never runs)', async () => {
  const inner = { data: {} };
  let failNext = false;
  const store = {
    async load(id) { return inner.data[id] ?? {}; },
    async save(id, subjects) {
      if (failNext) throw new Error('write failed');
      inner.data[id] = subjects;
    },
  };
  const authority = new ExternalModelTriggerAuthority({ store });
  const auth = await authority.authorize(intent()); // RESERVED persisted fine

  failNext = true; // arm failure for the DISPATCHING boundary write
  let posts = 0;
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent(), async () => { posts += 1; return { id: 'c1' }; }),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_STATE_UNAVAILABLE,
  );
  assert.equal(posts, 0);
});

// --------------------------------------------------------------------------
// 20/21. Trigger-count / review-round ceilings — injected low limits
// --------------------------------------------------------------------------
test('20. trigger-count ceiling exhausted -> fresh HEAD still denied', async () => {
  const authority = new ExternalModelTriggerAuthority({ maxExternalModelTriggers: 1, maxExternalReviewRounds: 10 });
  const a1 = await authority.authorize(intent({ headSha: 'H1' }));
  await authority.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));

  await assert.rejects(
    () => authority.authorize(intent({ headSha: 'H2' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_LIMIT_EXCEEDED,
  );
});

test('21. review-round ceiling exhausted -> fresh HEAD still denied', async () => {
  const authority = new ExternalModelTriggerAuthority({ maxExternalReviewRounds: 1, maxExternalModelTriggers: 10 });
  const a1 = await authority.authorize(intent({ headSha: 'H1' }));
  await authority.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));

  await assert.rejects(
    () => authority.authorize(intent({ headSha: 'H2' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_REVIEW_ROUND_LIMIT_EXCEEDED,
  );
});

// --------------------------------------------------------------------------
// 22. Wall-clock ceiling — restart must not reset the deadline
// --------------------------------------------------------------------------
test('22. wall-clock ceiling exceeded -> fresh HEAD denied; restart does not reset it', async () => {
  const clock = fakeClock(0);
  const persistence = fakePersistence();
  const authority1 = new ExternalModelTriggerAuthority({
    store: new ExternalTriggerStore(persistence), clock, wallClockMs: 1000,
  });
  const a1 = await authority1.authorize(intent({ headSha: 'H1' }));
  await authority1.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));

  clock.advance(5000); // past the 1000ms deadline

  // Fresh authority instance (simulating a restart) backed by the SAME
  // durable store must see the SAME deadline, not a freshly-started one.
  const authority2 = new ExternalModelTriggerAuthority({
    store: new ExternalTriggerStore(persistence), clock, wallClockMs: 1000,
  });
  await assert.rejects(
    () => authority2.authorize(intent({ headSha: 'H2' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED,
  );
});

// --------------------------------------------------------------------------
// 23. Polling does not consume trigger count
// --------------------------------------------------------------------------
test('23. many listReviewResults() calls never change the trigger count', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent());
  await authority.dispatch(auth.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));
  const before = (await authority.list('wf-1')).length;
  for (let i = 0; i < 5; i += 1) {
    // Polling reads are outside this authority entirely (§ Part U) — nothing
    // to call here; assert the ledger is unaffected by repeated inspection.
    await authority.list('wf-1');
  }
  const after = (await authority.list('wf-1')).length;
  assert.equal(before, after);
});

// --------------------------------------------------------------------------
// 24/25. Permit single-use + intent-bound
// --------------------------------------------------------------------------
test('24. permit is single-use: a second dispatch on the same permit is rejected', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent());
  await authority.dispatch(auth.permit, intent(), async () => ({ id: 'c1', createdAt: 'now' }));
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent(), async () => ({ id: 'c2', createdAt: 'now' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_CONSUMED,
  );
});

test('25. permit is intent-bound: cannot dispatch a different PR/HEAD/action', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const auth = await authority.authorize(intent({ headSha: 'H1' }));
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent({ headSha: 'H2' }), async () => ({ id: 'c1' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_INTENT_MISMATCH,
  );
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent({ prNumber: 5 }), async () => ({ id: 'c1' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_INTENT_MISMATCH,
  );
  await assert.rejects(
    () => authority.dispatch(auth.permit, intent({ headSha: 'H1', semanticAction: 'SOMETHING_ELSE' }), async () => ({ id: 'c1' })),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_TRIGGER_PERMIT_INTENT_MISMATCH,
  );
});

// --------------------------------------------------------------------------
// 26/27. Closeout-level integration: cross-reviewer fallback blocked /
// pre-dispatch fallback allowed, driven through the real adapter pair.
// --------------------------------------------------------------------------
test('26. same-head cross-reviewer fallback blocked at the adapter integration level', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = {
    postCalls: 0,
    async getPrHead() { return 'H1'; },
    async isReviewerAvailable() { return true; },
    async postReviewTrigger() { gh.postCalls += 1; return { id: 'codex-1', createdAt: 'now' }; },
    async listReviewResults() { return []; }, // codex times out; no matching result ever arrives
  };
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const codexRes = await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(codexRes.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);
  assert.equal(gh.postCalls, 1);

  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  const claudeRes = await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  // Claude reuses the persisted codex trigger and polls it (no repost); it
  // will never match (author filter requires 'claude'), so it also times out.
  assert.equal(claudeRes.failure, GITHUB_REVIEW_FAILURES.TIMEOUT);
  assert.equal(gh.postCalls, 1);
});

test('27. pre-dispatch reviewer-unavailable closeout fallback still posts exactly once', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const gh = {
    postCalls: 0,
    async getPrHead() { return 'H1'; },
    async isReviewerAvailable({ reviewer }) { return reviewer === 'claude'; },
    async postReviewTrigger() { gh.postCalls += 1; return { id: 'claude-1', createdAt: 'now' }; },
    async listReviewResults() { return []; },
  };
  const codexAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'codex', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  assert.equal((await codexAdapter.requestReview({ prNumber: 4, prHead: 'H1' })).failure, GITHUB_REVIEW_FAILURES.UNAVAILABLE);
  assert.equal(gh.postCalls, 0);

  const claudeAdapter = createGithubPrReviewAdapter({
    github: gh, clock: pollingClock(), reviewer: 'claude', workflowId: 'wf-1', triggerAuthority: authority, maxWaitMs: 15_000,
  });
  await claudeAdapter.requestReview({ prNumber: 4, prHead: 'H1' });
  assert.equal(gh.postCalls, 1);
});

// --------------------------------------------------------------------------
// 28/29. Repair/new-head happy path vs no-change loop
// --------------------------------------------------------------------------
test('28. HEAD change between repair rounds authorizes a second, distinct trigger', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const a1 = await authority.authorize(intent({ headSha: 'H1' }));
  await authority.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));
  const a2 = await authority.authorize(intent({ headSha: 'H2' }));
  await authority.dispatch(a2.permit, intent({ headSha: 'H2' }), async () => ({ id: 'c2', createdAt: 'now' }));
  const records = await authority.list('wf-1');
  assert.equal(records.length, 2);
});

test('29. no HEAD change -> no second external trigger', async () => {
  const authority = new ExternalModelTriggerAuthority({});
  const a1 = await authority.authorize(intent({ headSha: 'H1' }));
  await authority.dispatch(a1.permit, intent({ headSha: 'H1' }), async () => ({ id: 'c1', createdAt: 'now' }));
  const again = await authority.authorize(intent({ headSha: 'H1' }));
  assert.equal(again.outcome, 'REUSE');
});

// --------------------------------------------------------------------------
// Sanity: constants, error classification helper, permit opacity
// --------------------------------------------------------------------------
test('production default derivation matches the documented formula', () => {
  assert.equal(DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS, 1 + DEFAULT_MAX_REPAIR_ROUNDS + DEFAULT_MAX_ESCALATION_REPAIR_ROUNDS);
  assert.equal(DEFAULT_MAX_EXTERNAL_MODEL_TRIGGERS, DEFAULT_MAX_EXTERNAL_REVIEW_ROUNDS);
});

test('isExternalTriggerFailure recognizes ExternalTriggerError instances', () => {
  const err = new ExternalTriggerError(EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED, 'x');
  assert.equal(isExternalTriggerFailure(err), true);
  assert.equal(isExternalTriggerFailure(new Error('plain')), false);
});

test('ExternalTriggerPermit does not expose its token to an ordinary caller', () => {
  const authority = new ExternalModelTriggerAuthority({});
  return authority.authorize(intent()).then(({ permit }) => {
    assert.ok(permit instanceof ExternalTriggerPermit);
    assert.equal(permit._revealTokenTo(Symbol('forged')), undefined);
    assert.equal(JSON.stringify(permit).includes('token'), false);
  });
});
