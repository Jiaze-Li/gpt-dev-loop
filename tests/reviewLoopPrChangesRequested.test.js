// Independent re-verification #4 — a GitHub CHANGES_REQUESTED review verdict is
// UNCONDITIONALLY blocking. A structured ```json {"findings":[]}``` block (or
// one carrying only non-blocking P3s) is additive detail — it can never
// downgrade the reviewer's explicit "changes requested" to CLEAN / PASS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { normalizeProviderReview } from '../src/orchestrator/adapters/normalizedPrReview.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const BOT = 'chatgpt-codex-connector[bot]';
const HEAD = 'HEADSHA1';

function backend(reviews) {
  return createGithubReviewBackend({
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return reviews; },
      async listReviewComments() { return []; },
      async postComment() { return { id: 'c1' }; },
    },
  });
}

async function reviewOnce(prBackend) {
  const controller = createReviewLoopController({ persistence: new MemoryPersistence(), prBackend });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  return controller.review({ loopId });
}

test('CHANGES_REQUESTED + structured {findings:[]} -> REWORK, never PASS', async () => {
  const r = await reviewOnce(backend([{
    login: BOT, state: 'CHANGES_REQUESTED', commitId: HEAD,
    body: 'Please address the concurrency issue.\n```json\n{"findings":[]}\n```',
    submittedAt: '2026-01-01', id: 1,
  }]));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
});

test('CHANGES_REQUESTED with only a P3 structured finding still blocks', async () => {
  const r = await reviewOnce(backend([{
    login: BOT, state: 'CHANGES_REQUESTED', commitId: HEAD,
    body: '```json\n{"findings":[{"severity":"P3","file":"a.js","title":"nit: naming"}]}\n```',
    submittedAt: '2026-01-01', id: 1,
  }]));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'REWORK');
});

test('normalizeProviderReview: an explicit CHANGES_REQUESTED github state is blocking on an empty findings list', () => {
  const n = normalizeProviderReview({
    raw: { review_state: 'CHANGES_REQUESTED', findings: [], head_sha: HEAD },
    reviewer: 'codex', provider: 'codex', currentPrHead: HEAD,
  });
  assert.equal(n.status, 'ACTIONABLE');
  assert.ok(n.blocking.length >= 1);
});
