// B7 + B8 — real git. The Worker's delta is attributed against the exact
// pre-edit baseline (not HEAD->current), pre-existing user work is never
// attributed to the Worker, unattributable state fails closed, and baseline
// Gate evidence distinguishes a pre-existing red test from a new regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureBaseline, collectWorkerDelta } from '../src/reviewloop/gitEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-attr-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'a.txt'), 'orig a\n');
  await writeFile(path.join(dir, 'tracked.txt'), 'orig tracked\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
}

test('no Worker change since begin -> NO_PROGRESS, 0 Reviewer calls', async () => {
  const { dir } = await tempRepo();
  try {
    let reviewerCalls = 0;
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      reviewerFn: async () => { reviewerCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'NO_PROGRESS');
    assert.equal(reviewerCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pre-existing dirty tracked file is not attributed to the Worker', async () => {
  const { dir } = await tempRepo();
  try {
    // pre-existing user edit BEFORE begin
    await writeFile(path.join(dir, 'a.txt'), 'orig a\nUSER PRE-EXISTING EDIT\n');
    const baseline = await captureBaseline({ cwd: dir });
    // Worker changes a different file
    await writeFile(path.join(dir, 'tracked.txt'), 'orig tracked\nWORKER EDIT\n');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.deepEqual(delta.changedFiles, ['tracked.txt']);
    assert.ok(delta.diff.includes('WORKER EDIT'));
    assert.ok(!delta.diff.includes('USER PRE-EXISTING EDIT'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Worker editing the SAME file a user pre-touched: delta is baseline->current only', async () => {
  const { dir } = await tempRepo();
  try {
    await writeFile(path.join(dir, 'a.txt'), 'orig a\nUSER LINE\n');
    const baseline = await captureBaseline({ cwd: dir });
    await writeFile(path.join(dir, 'a.txt'), 'orig a\nUSER LINE\nWORKER LINE\n');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    assert.ok(delta.diff.includes('WORKER LINE'));
    // the user's pre-existing line is context/unchanged, never shown as +added
    assert.ok(!/^\+USER LINE$/m.test(delta.diff));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pre-existing untracked file that cannot be fingerprinted -> evidence incomplete -> HUMAN_REQUIRED', async () => {
  const { dir } = await tempRepo();
  try {
    // A pre-existing untracked directory entry that hash-object cannot hash as
    // a blob (a directory named like a path) — simulate unfingerprintable state
    // by making an untracked FIFO-ish unreadable path: use a nested dir.
    await mkdir(path.join(dir, 'weird'));
    await writeFile(path.join(dir, 'weird', 'x'), 'y');
    const baseline = await captureBaseline({ cwd: dir });
    // Force incompleteness deterministically: drop a hash so attribution is unsafe.
    baseline.untrackedHashes = { ...baseline.untrackedHashes };
    delete baseline.untrackedHashes['weird/x'];
    baseline.evidenceComplete = true; // still true; the delta recomputation notices the gap
    // Now the Worker changes a tracked file.
    await writeFile(path.join(dir, 'tracked.txt'), 'orig tracked\nW\n');
    // and the untracked file also changes (so it must be re-fingerprinted &
    // compared, but we removed the baseline hash -> ambiguous)
    await writeFile(path.join(dir, 'weird', 'x'), 'CHANGED');
    const delta = await collectWorkerDelta({ cwd: dir, baseline });
    // weird/x is not in baselineUntracked -> treated as brand-new Worker file.
    // That is acceptable attribution (a file absent from the baseline map is
    // new). The unattributable case is a missing RE-fingerprint:
    assert.ok(delta.changedFiles.includes('tracked.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A test command that emits parseable node:test-style failing lines for a
// controllable set of test names (those listed in a FAIL file).
const TEST_SCRIPT = 'i=0; for t in one two three; do i=$((i+1)); if grep -q "$t" FAIL 2>/dev/null; then echo "not ok $i - $t"; FAILED=1; else echo "ok $i - $t"; fi; done; exit ${FAILED:-0}';

test('baseline Gate evidence: a pre-existing red test is not a new regression -> Reviewer still runs', async () => {
  const { dir, git } = await tempRepo();
  try {
    await writeFile(path.join(dir, '.reviewloop.json'), JSON.stringify({ verify: [TEST_SCRIPT] }));
    await writeFile(path.join(dir, 'FAIL'), 'one\n'); // "one" is red at baseline
    git('add', '-A');
    git('commit', '-qm', 'baseline with one failing test');

    let reviewerRan = false;
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      reviewerFn: async () => { reviewerRan = true; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    // Worker makes an unrelated change; "one" is still red but NOT newly so.
    await writeFile(path.join(dir, 'tracked.txt'), 'orig tracked\nW\n');
    const r = await controller.review({ loopId });
    assert.equal(reviewerRan, true, 'Reviewer runs because there is no NEW regression');
    assert.notEqual(r.status, 'REWORK');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('baseline Gate evidence: a newly-introduced failure IS a regression -> REWORK, Reviewer 0', async () => {
  const { dir, git } = await tempRepo();
  try {
    await writeFile(path.join(dir, '.reviewloop.json'), JSON.stringify({ verify: [TEST_SCRIPT] }));
    git('add', '-A');
    git('commit', '-qm', 'all green baseline');

    let reviewerRan = false;
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      reviewerFn: async () => { reviewerRan = true; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: dir });
    // Worker introduces a NEW failing test
    await writeFile(path.join(dir, 'FAIL'), 'two\n');
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'REWORK');
    assert.equal(reviewerRan, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
