// B5 — no silent diff truncation. A ReviewLoop PASS means every review-
// relevant changed line was covered by an independent Reviewer call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkDiffForReview } from '../src/reviewloop/diffChunker.js';
import { makeHarness } from './helpers/reviewLoopHarness.js';

function bigDiff(files, linesPerFile) {
  return files.map((f) => {
    const hunk = Array.from({ length: linesPerFile }, (_, i) => `+line ${i} of ${f}`).join('\n');
    return `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +1,${linesPerFile} @@\n${hunk}`;
  }).join('\n');
}

test('a small diff is one chunk that carries the whole text', () => {
  const { chunks, oversized } = chunkDiffForReview('diff --git a/x b/x\n+hello');
  assert.equal(oversized, false);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('hello'));
});

test('a large multi-file diff is split into chunks that together cover every file', () => {
  const diff = bigDiff(['a.js', 'b.js', 'c.js', 'd.js'], 400);
  const { chunks, oversized } = chunkDiffForReview(diff, { env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '6000' } });
  assert.equal(oversized, false);
  assert.ok(chunks.length > 1);
  const joined = chunks.map((c) => c.text).join('');
  for (const f of ['a.js', 'b.js', 'c.js', 'd.js']) assert.ok(joined.includes(f), `${f} covered`);
  // an issue on the last file, past char 12000, is present in some chunk
  assert.ok(joined.includes('line 399 of d.js'));
});

test('oversized evidence that cannot be chunked within the cap -> not chunked', () => {
  const diff = bigDiff(Array.from({ length: 40 }, (_, i) => `f${i}.js`), 200);
  const { oversized, reason } = chunkDiffForReview(diff, {
    env: { REVIEWLOOP_MAX_REVIEW_DIFF_CHARS: '2000', REVIEWLOOP_MAX_REVIEW_CHUNKS: '3' },
  });
  assert.equal(oversized, true);
  assert.match(reason, /review chunks/);
});

test('controller reviews every chunk and only PASSes when all chunks are covered', async () => {
  const diff = bigDiff(['a.js', 'b.js', 'c.js'], 500);
  const harness = makeHarness({
    deltas: [{ fingerprint: 'big', diff, changedFiles: ['a.js', 'b.js', 'c.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'g' }],
    reviews: [{ findings: [] }],
  });
  process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS = '6000';
  try {
    const { loopId } = await harness.controller.begin({ goal: 'g', cwd: '/r' });
    const r = await harness.controller.review({ loopId });
    assert.equal(r.status, 'PASS');
    assert.ok(harness.calls.reviewer > 1, `expected multiple chunk reviews, got ${harness.calls.reviewer}`);
  } finally {
    delete process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS;
  }
});

test('a malformed review of ANY chunk fails the whole review closed (no PASS)', async () => {
  const diff = bigDiff(['a.js', 'b.js'], 500);
  const harness = makeHarness({
    deltas: [{ fingerprint: 'big', diff, changedFiles: ['a.js', 'b.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'g' }],
    reviews: [{ findings: [] }, { malformed: true, reason: 'chunk 2 unparseable' }],
  });
  process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS = '6000';
  try {
    const { loopId } = await harness.controller.begin({ goal: 'g', cwd: '/r' });
    const r = await harness.controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
  } finally {
    delete process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS;
  }
});

test('REVIEW_TOO_LARGE -> HUMAN_REQUIRED, never PASS', async () => {
  const diff = bigDiff(Array.from({ length: 30 }, (_, i) => `f${i}.js`), 300);
  const harness = makeHarness({
    deltas: [{ fingerprint: 'big', diff, changedFiles: ['f0.js'] }],
    gates: [{ verdict: 'PASS', fingerprint: 'g' }],
    reviews: [{ findings: [] }],
  });
  process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS = '2000';
  process.env.REVIEWLOOP_MAX_REVIEW_CHUNKS = '2';
  try {
    const { loopId } = await harness.controller.begin({ goal: 'g', cwd: '/r' });
    const r = await harness.controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.match(r.reason, /REVIEW_TOO_LARGE/);
    assert.equal(harness.calls.reviewer, 0, 'no partial review is performed');
  } finally {
    delete process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS;
    delete process.env.REVIEWLOOP_MAX_REVIEW_CHUNKS;
  }
});

