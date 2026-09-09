// The external-review wall clock bounds ONE review round's external-review
// wait — not the Worker's between-round implementation time, and not the whole
// multi-round loop. It is armed on the first authorize() for a subject and
// RE-ARMED for each genuinely new reviewable HEAD once the previous round has
// fully settled; within an unsettled round every authorize() keeps sharing one
// deadline so a hung / never-returning reviewer is still caught.
//
// Regression for the wedge where round 1's deadline (never re-armed) blocked a
// round-3 trigger from ever being posted, leaving the loop in a non-terminal
// HUMAN_REQUIRED that every retry re-hit.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExternalModelTriggerAuthority,
  DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS,
} from '../src/orchestrator/externalModelTriggerAuthority.js';
import { EXTERNAL_TRIGGER_ERROR_CODES } from '../src/orchestrator/errors.js';

const WF = 'wf-wallclock';
const PR = 4;
const intent = (headSha) => ({ workflowId: WF, prNumber: PR, headSha, reviewer: 'codex' });

function makeStore() {
  let state = {};
  return {
    async load() { return structuredClone(state); },
    async save(_key, value) { state = structuredClone(value); },
    peek: () => state,
  };
}

function makeAuthority(nowRef, store, events = []) {
  return new ExternalModelTriggerAuthority({
    store,
    clock: { now: () => nowRef.t },
    recordSafetyEvent: (e) => events.push(e),
  });
}

function subjectBucket(store) {
  return store.peek()[`${WF}::${PR}::PR_REVIEW`];
}

async function fullRound(auth, nowRef, headSha) {
  const decision = await auth.authorize(intent(headSha));
  assert.equal(decision.outcome, 'ALLOW', `round for ${headSha} should be authorized`);
  await auth.dispatch(decision.permit, intent(headSha), async () => ({
    id: `comment-${headSha}`, createdAt: new Date(nowRef.t).toISOString(),
  }));
  await auth.recordResult({ workflowId: WF, prNumber: PR, headSha });
}

test('re-arms the wall clock for a genuinely new HEAD after the previous round settled — even long past the old deadline', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:00:00.000Z') };
  const store = makeStore();
  const auth = makeAuthority(nowRef, store);

  await fullRound(auth, nowRef, 'H1');
  const firstDeadline = Date.parse(subjectBucket(store).wallClock.deadlineAt);
  assert.equal(firstDeadline, nowRef.t + DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS);

  // The Worker implements the fix; well past the round-1 deadline.
  nowRef.t += DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS + (30 * 60 * 1000);

  const decision = await auth.authorize(intent('H2'));
  assert.equal(decision.outcome, 'ALLOW', 'a new reviewable HEAD is not blocked by the previous round\'s deadline');
  assert.equal(
    Date.parse(subjectBucket(store).wallClock.deadlineAt),
    nowRef.t + DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS,
    'the wall clock was re-armed from now',
  );
});

test('the production wedge: two settled rounds then a third new HEAD hours later still dispatches', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:09:09.000Z') };
  const store = makeStore();
  const auth = makeAuthority(nowRef, store);

  await fullRound(auth, nowRef, 'round1head');
  nowRef.t += 32 * 60 * 1000;
  await fullRound(auth, nowRef, 'round2head');

  // Round 3 fix pushed 2h27m after the original round-1 deadline.
  nowRef.t = Date.parse('2026-09-09T04:36:16.000Z');
  const decision = await auth.authorize(intent('round3head'));
  assert.equal(decision.outcome, 'ALLOW');

  let posted = null;
  await auth.dispatch(decision.permit, intent('round3head'), async () => {
    posted = 'round3head';
    return { id: 'comment-round3head', createdAt: new Date(nowRef.t).toISOString() };
  });
  assert.equal(posted, 'round3head', 'the round-3 trigger is actually dispatched');
  assert.equal(subjectBucket(store).dispatchCount, 3);
});

test('a hung reviewer on the SAME in-flight HEAD past the deadline is caught (re-authorize and checkInFlightDeadline)', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:00:00.000Z') };
  const store = makeStore();
  const events = [];
  const auth = makeAuthority(nowRef, store, events);

  // Round 1 dispatched but its result never comes back.
  const d1 = await auth.authorize(intent('H1'));
  await auth.dispatch(d1.permit, intent('H1'), async () => ({
    id: 'comment-H1', createdAt: new Date(nowRef.t).toISOString(),
  }));
  const armedDeadline = subjectBucket(store).wallClock.deadlineAt;

  nowRef.t += DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS + 60_000;

  // The reattach path in prReviewController relies on this pure read.
  const check = await auth.checkInFlightDeadline({ workflowId: WF, prNumber: PR, headSha: 'H1' });
  assert.equal(check.ok, false);
  assert.equal(check.code, EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED);
  assert.ok(events.some((e) => e.code === 'EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED' && /in-flight review/.test(e.reason)));

  // A same-HEAD re-authorize (defense in depth) also rejects, before REUSE.
  await assert.rejects(
    auth.authorize(intent('H1')),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_WALL_CLOCK_EXCEEDED,
  );
  assert.equal(subjectBucket(store).wallClock.deadlineAt, armedDeadline, 'a same-HEAD retry never moved the deadline');
});

test('a stale TRIGGERED record (a lost recordResult write) does not wedge later HEADs', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:00:00.000Z') };
  const store = makeStore();
  const auth = makeAuthority(nowRef, store);

  // Round 1: triggered, but recordResult() is never applied (transient write
  // loss) — the record is stuck at TRIGGERED even though the review was seen.
  const d1 = await auth.authorize(intent('H1'));
  await auth.dispatch(d1.permit, intent('H1'), async () => ({
    id: 'comment-H1', createdAt: new Date(nowRef.t).toISOString(),
  }));

  nowRef.t += DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS + (45 * 60 * 1000);

  const decision = await auth.authorize(intent('H2'));
  assert.equal(decision.outcome, 'ALLOW', 'a genuinely new HEAD re-arms regardless of a stale historical record');
  assert.equal(
    Date.parse(subjectBucket(store).wallClock.deadlineAt),
    nowRef.t + DEFAULT_EXTERNAL_REVIEW_WALL_CLOCK_MS,
  );
});

test('re-authorizing the SAME in-flight HEAD reuses the trigger and never re-arms the wall clock', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:00:00.000Z') };
  const store = makeStore();
  const auth = makeAuthority(nowRef, store);

  const d1 = await auth.authorize(intent('H1'));
  await auth.dispatch(d1.permit, intent('H1'), async () => ({
    id: 'comment-H1', createdAt: new Date(nowRef.t).toISOString(),
  }));
  const deadlineBefore = subjectBucket(store).wallClock.deadlineAt;

  nowRef.t += 5 * 60 * 1000;
  const again = await auth.authorize(intent('H1'));
  assert.equal(again.outcome, 'REUSE', 'the same HEAD reuses its existing trigger');
  assert.equal(subjectBucket(store).wallClock.deadlineAt, deadlineBefore, 'a retry never re-arms the wall clock');

  // And once dispatched budget is spent, a same-HEAD re-authorize after result
  // ingestion is a hard duplicate (still not a re-arm).
  await auth.recordResult({ workflowId: WF, prNumber: PR, headSha: 'H1' });
  await assert.rejects(
    auth.authorize(intent('H1')),
    (err) => err.code === EXTERNAL_TRIGGER_ERROR_CODES.EXTERNAL_MODEL_TRIGGER_DUPLICATE_BLOCKED,
  );
  assert.equal(subjectBucket(store).wallClock.deadlineAt, deadlineBefore, 'still not re-armed');
});

test('a process restart does not spuriously re-arm the deadline for the SAME in-flight HEAD', async () => {
  const nowRef = { t: Date.parse('2026-09-09T02:00:00.000Z') };
  const store = makeStore();
  const auth1 = makeAuthority(nowRef, store);

  const d1 = await auth1.authorize(intent('H1'));
  await auth1.dispatch(d1.permit, intent('H1'), async () => ({
    id: 'comment-H1', createdAt: new Date(nowRef.t).toISOString(),
  }));
  const armedDeadline = Date.parse(subjectBucket(store).wallClock.deadlineAt);

  // Fresh authority (restart), same durable store, clock advanced but still
  // within the armed deadline. Resuming the SAME in-flight HEAD must not move
  // its deadline.
  nowRef.t += 20 * 60 * 1000;
  const auth2 = makeAuthority(nowRef, store);
  const again = await auth2.authorize(intent('H1'));
  assert.equal(again.outcome, 'REUSE', 'the same in-flight HEAD is reused, not re-triggered');
  assert.equal(
    Date.parse(subjectBucket(store).wallClock.deadlineAt),
    armedDeadline,
    'the restart did not move the in-flight HEAD deadline',
  );
});
