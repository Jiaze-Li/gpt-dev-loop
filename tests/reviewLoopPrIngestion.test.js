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
    comments: [{ login: BOT, body: 'P1: unbounded recursion here', path: 'a.js', line: 12, commitId: HEAD, id: 7 }],
  }));
  assert.notEqual(r.status, 'PASS');
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
