// B-untracked — Worker untracked evidence is neither silently truncated nor
// silently missed:
//   - large untracked text: the FULL content reaches the Reviewer (via the
//     deterministic chunker), so a tail defect cannot be omitted
//   - binary / unreadable Worker-created file: no PASS without coverage
//   - a deleted pre-existing untracked file IS a Worker change

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureBaseline, collectWorkerDelta } from '../src/reviewloop/gitEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-untracked-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir };
}

function bench(dir, reviews) {
  const calls = { reviewer: 0, chunks: [] };
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    reviewerFn: async ({ diff }) => {
      calls.chunks.push(diff);
      const r = reviews[calls.reviewer] ?? reviews[reviews.length - 1] ?? { findings: [] };
      calls.reviewer += 1;
      return { value: r, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  return { controller, calls, cwd: dir };
}

test('a >65536-byte untracked text file is reviewed in full (tail defect not omitted)', async () => {
  const { dir } = await tempRepo();
  try {
    const big = `${'x\n'.repeat(40000)}TAIL_DEFECT_MARKER\n`; // ~80KB, marker at the very end
    assert.ok(big.length > 65536);
    const { controller, calls } = bench(dir, [{ findings: [] }]);
    const { loopId } = await controller.begin({ goal: 'add big file', cwd: dir });
    await writeFile(path.join(dir, 'big.txt'), big);
    process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS = '20000';
    try {
      const r = await controller.review({ loopId });
      assert.equal(r.status, 'PASS');
      const allChunks = calls.chunks.join('');
      assert.ok(allChunks.includes('TAIL_DEFECT_MARKER'), 'the tail of the file must reach the Reviewer');
      assert.ok(calls.reviewer > 1, 'the large file was chunked, not truncated');
    } finally {
      delete process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a binary Worker-created untracked file -> evidence incomplete -> HUMAN_REQUIRED (no PASS)', async () => {
  const { dir } = await tempRepo();
  try {
    const { controller } = bench(dir, [{ findings: [] }]);
    const { loopId } = await controller.begin({ goal: 'add asset', cwd: dir });
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 10, 0]));
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.match(r.reason, /binary|cannot reliably separate|cannot be reviewed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleting a pre-existing untracked file IS a Worker change', async () => {
  const { dir } = await tempRepo();
  try {
    await writeFile(path.join(dir, 'user-note.txt'), 'a pre-existing untracked note\n');
    const baseline = await captureBaseline({ cwd: dir });
    assert.ok('user-note.txt' in baseline.untrackedHashes);
    await unlink(path.join(dir, 'user-note.txt')); // Worker deletes it
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.ok(delta.changedFiles.includes('user-note.txt'));
    assert.ok(delta.untrackedDeleted.includes('user-note.txt'));
    assert.equal(delta.noWorkerChangeYet, false);
    assert.ok(delta.diff.includes('deleted pre-existing untracked file user-note.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unchanged pre-existing untracked file is still NOT a Worker change', async () => {
  const { dir } = await tempRepo();
  try {
    await writeFile(path.join(dir, 'user-note.txt'), 'untouched\n');
    const baseline = await captureBaseline({ cwd: dir });
    await writeFile(path.join(dir, 'worker.txt'), 'worker made this\n');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.deepEqual(delta.changedFiles, ['worker.txt']);
    assert.equal(delta.untrackedDeleted.length, 0);
    assert.ok(!delta.diff.includes('user-note.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('large untracked evidence beyond the chunk cap -> REVIEW_TOO_LARGE -> HUMAN_REQUIRED, 0 partial review', async () => {
  const { dir } = await tempRepo();
  try {
    const { controller, calls } = bench(dir, [{ findings: [] }]);
    const { loopId } = await controller.begin({ goal: 'add huge file', cwd: dir });
    await writeFile(path.join(dir, 'huge.txt'), 'y\n'.repeat(60000)); // 120KB single unit
    process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS = '2000';
    process.env.REVIEWLOOP_MAX_REVIEW_CHUNKS = '3';
    try {
      const r = await controller.review({ loopId });
      assert.equal(r.status, 'HUMAN_REQUIRED');
      assert.match(r.reason, /REVIEW_TOO_LARGE/);
      assert.equal(calls.reviewer, 0);
    } finally {
      delete process.env.REVIEWLOOP_MAX_REVIEW_DIFF_CHARS;
      delete process.env.REVIEWLOOP_MAX_REVIEW_CHUNKS;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
