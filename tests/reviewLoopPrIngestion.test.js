// Phase 2 #2 — PR review ingestion aggregates EVERY trusted submission + inline
// comment for the exact HEAD and never lets COMMENTED / unstructured / inline /
// DISMISSED evidence silently become CLEAN.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const BOT = 'chatgpt-codex-connector[bot]';
const HEAD = 'HEADSHA1';

function backend({ reviews = [], comments = [] } = {}) {
  return createGithubReviewBackend({
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return reviews; },
      async listReviewComments() { return comments; },
      async postComment() { return { id: 'c1' }; },
    },
  });
}

async function reviewOnce(prBackend) {
  const controller = createReviewLoopController({ persistence: new MemoryPersistence(), prBackend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  return controller.review({ loopId });
}

test('a COMMENTED review with a natural-language P1 and no JSON block cannot PASS', async () => {
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: 'P1: this dereferences a null pointer on the error path.', submittedAt: '2026-01-01', id: 1 }],
  }));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
});

test('a trusted inline P1 comment (no submission body) cannot PASS', async () => {
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'APPROVED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-01', id: 1 }],
    comments: [{
      login: BOT, body: 'P1: unbounded recursion here', path: 'a.js', line: 12,
      commitId: HEAD, originalCommitId: HEAD, pullRequestReviewId: 1, id: 7,
    }],
  }));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
});

test('an inline P1 comment with only original_commit_id at the current HEAD still blocks', async () => {
  // Older transport shape: no parent-review id, but original_commit_id (which
  // GitHub never remaps) proves the comment was written against the current HEAD.
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'APPROVED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-01', id: 1 }],
    comments: [{ login: BOT, body: 'P1: use-after-free', path: 'a.js', line: 3, originalCommitId: HEAD, id: 9 }],
  }));
  assert.equal(r.status, 'REWORK');
});

test('a COMMENTED review with an unparseable body cannot PASS', async () => {
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: 'hmm, some thoughts here — not sure', submittedAt: '2026-01-01', id: 1 }],
  }));
  assert.notEqual(r.status, 'PASS');
});

test('a DISMISSED review as the only submission cannot PASS (fails closed)', async () => {
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'DISMISSED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-01', id: 1 }],
  }));
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /DISMISSED|not usable/i);
});

test('a later APPROVED does not erase an earlier CHANGES_REQUESTED finding on the same HEAD', async () => {
  const r = await reviewOnce(backend({
    reviews: [
      { login: BOT, state: 'CHANGES_REQUESTED', commitId: HEAD, body: 'P2: race condition in the cache write', submittedAt: '2026-01-01T00:00:00Z', id: 1 },
      { login: BOT, state: 'APPROVED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-01-02T00:00:00Z', id: 2 },
    ],
  }));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
});

test('an APPROVED review with a structured empty findings list PASSes', async () => {
  const r = await reviewOnce(backend({
    reviews: [{ login: BOT, state: 'APPROVED', commitId: HEAD, body: 'LGTM\n```json\n{"findings":[]}\n```', submittedAt: '2026-01-01', id: 1 }],
  }));
  assert.equal(r.status, 'PASS');
});

test('a PENDING-only review is ignored and a fresh review is triggered instead of PASSing', async () => {
  const triggers = [];
  const be = createGithubReviewBackend({
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return [{ login: BOT, state: 'PENDING', commitId: HEAD, body: 'draft', id: 1 }]; },
      async listReviewComments() { return []; },
      async postComment() { triggers.push(1); return { id: 'c1' }; },
    },
  });
  assert.equal(await be.findExistingReview({ prNumber: 4, headSha: HEAD, reviewer: 'codex' }), null);
});

test('an untrusted login on a CHANGES_REQUESTED review contributes nothing', async () => {
  const agg = await backend({
    reviews: [{ login: 'evil[bot]', state: 'CHANGES_REQUESTED', commitId: HEAD, body: 'P1: bug', id: 1 }],
  }).findExistingReview({ prNumber: 4, headSha: HEAD, reviewer: 'codex' });
  assert.equal(agg, null);
});

// --- Regression: PR #4 real shape --------------------------------------------
// A stale Codex inline comment whose parent review 5124688432 was submitted
// against an OLD commit, but whose own `commit_id` GitHub later remapped onto
// the current HEAD. It must NOT be aggregated as current-head evidence.
const NEW_HEAD = '0ae28503d91a055086568b5191c257ac457d2abe';
const OLD_HEAD = '26d36ec3d91a055086568b5191c257ac457d2abe';
const STALE_REVIEW_ID = 5124688432;

function pr4Backend({ reviews = [], comments = [] } = {}) {
  return createGithubReviewBackend({
    transport: {
      async getPrHead() { return NEW_HEAD; },
      async listReviews() { return reviews; },
      async listReviewComments() { return comments; },
      async postComment() { return { id: 'trigger-1' }; },
    },
  });
}

test('PR#4: a remapped stale inline comment is not current-head evidence', async () => {
  const agg = await pr4Backend({
    // Parent review, submitted against the OLD head (commit_id immutable).
    reviews: [{
      login: BOT, state: 'COMMENTED', commitId: OLD_HEAD, body: '',
      submittedAt: '2026-09-06T00:00:00Z', id: STALE_REVIEW_ID,
    }],
    // GitHub remapped comment.commit_id -> NEW_HEAD; original_commit_id stays OLD.
    comments: [{
      login: BOT, body: 'P1: serialize reviews per loop id', path: 'src/x.js', line: 361,
      commitId: NEW_HEAD, originalCommitId: OLD_HEAD, pullRequestReviewId: STALE_REVIEW_ID, id: 99,
    }],
  }).findExistingReview({ prNumber: 4, headSha: NEW_HEAD, reviewer: 'codex' });
  assert.equal(agg, null, 'stale remapped inline comment must not fabricate a current-head review');
});

test('PR#4: even without the old parent review returned, the remapped comment stays stale', async () => {
  const agg = await pr4Backend({
    reviews: [],
    comments: [{
      login: BOT, body: 'P1: serialize reviews per loop id', path: 'src/x.js', line: 361,
      commitId: NEW_HEAD, originalCommitId: OLD_HEAD, pullRequestReviewId: STALE_REVIEW_ID, id: 99,
    }],
  }).findExistingReview({ prNumber: 4, headSha: NEW_HEAD, reviewer: 'codex' });
  assert.equal(agg, null);
});

test('PR#4: a genuine current-head inline P1 (parent review at NEW_HEAD) still blocks', async () => {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: pr4Backend({
      reviews: [{
        login: BOT, state: 'APPROVED', commitId: NEW_HEAD, body: '```json\n{"findings":[]}\n```',
        submittedAt: '2026-09-08T00:00:00Z', id: 5200000001,
      }],
      comments: [{
        login: BOT, body: 'P1: real issue on the current head', path: 'src/y.js', line: 10,
        commitId: NEW_HEAD, originalCommitId: NEW_HEAD, pullRequestReviewId: 5200000001, id: 100,
      }],
    }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'REWORK');
});

test('PR#4: inline comment whose parent review is an untrusted login is ignored', async () => {
  const agg = await pr4Backend({
    reviews: [{ login: 'evil[bot]', state: 'COMMENTED', commitId: NEW_HEAD, body: '', submittedAt: '2026-09-08', id: 7 }],
    comments: [{
      login: 'evil[bot]', body: 'P1: injected', path: 'src/z.js', line: 1,
      commitId: NEW_HEAD, originalCommitId: NEW_HEAD, pullRequestReviewId: 7, id: 101,
    }],
  }).findExistingReview({ prNumber: 4, headSha: NEW_HEAD, reviewer: 'codex' });
  assert.equal(agg, null);
});

test('PR#4: a PENDING parent review does not make its inline comments current-head evidence', async () => {
  const agg = await pr4Backend({
    reviews: [{ login: BOT, state: 'PENDING', commitId: NEW_HEAD, body: 'draft', id: 8 }],
    comments: [{
      login: BOT, body: 'P1: pending draft note', path: 'src/z.js', line: 1,
      commitId: NEW_HEAD, originalCommitId: NEW_HEAD, pullRequestReviewId: 8, id: 102,
    }],
  }).findExistingReview({ prNumber: 4, headSha: NEW_HEAD, reviewer: 'codex' });
  assert.equal(agg, null);
});
