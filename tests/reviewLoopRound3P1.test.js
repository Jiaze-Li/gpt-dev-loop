// Regressions for the three round-3 Codex P1 findings on a5ac714:
//   - objective baseline must be covered by the integrity fingerprint
//   - a baseline-untracked file that was later `git add`ed must not leak into
//     the Worker delta
//   - the review-time Gate mutating tracked files must trigger a delta re-collect

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReviewObjective, rehydrateObjective, assertObjectiveNotWeakened } from '../src/reviewloop/objective.js';
import { collectWorkerDelta, evidenceSha256 } from '../src/reviewloop/gitEvidence.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

// A fake fs/promises FileHandle for the O_NOFOLLOW read path in gitEvidence.
function fakeOpen(bytes, { ino = 5, size } = {}) {
  const st = { isSymbolicLink: () => false, isFile: () => true, ino, size: size ?? bytes.length };
  return async () => ({ stat: async () => st, readFile: async () => bytes, close: async () => {} });
}

test('a persisted objective whose baseline was swapped is rejected on rehydrate', () => {
  const obj = createReviewObjective({
    loopId: 'L', goal: 'do the thing', mode: 'LOCAL',
    baseline: { head: 'AAAA', baselineRef: 'AAAA', untrackedHashes: { 'x.txt': 'h1' }, evidenceComplete: true, capturedAt: 't0', dirtyFiles: [] },
  });
  const tampered = JSON.parse(JSON.stringify(obj));
  tampered.baseline.head = 'BBBB'; // point the diff boundary at a different commit
  assert.throws(() => rehydrateObjective(tampered), /weakened|fingerprint/);
});

test('assertObjectiveNotWeakened flags a baseline swap even without a fingerprint change', () => {
  const original = { goal: 'g', mode: 'LOCAL', blockingSeverities: ['P1', 'P2'], maxReviewRounds: 3, constraints: [], baseline: { head: 'AAAA', baselineRef: 'AAAA', untrackedHashes: {}, evidenceComplete: true } };
  const candidate = { ...original, baseline: { ...original.baseline, head: 'BBBB' } };
  assert.throws(() => assertObjectiveNotWeakened(original, candidate), /baseline changed/);
});

test('a baseline-untracked file that was later staged does not leak into the Worker delta', async () => {
  const { default: events } = await import('node:events');
  const digest = evidenceSha256(Buffer.from('unchanged bytes'));
  const scripted = (_cmd, cmdArgs) => {
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    const key = cmdArgs.join(' ');
    queueMicrotask(() => {
      if (key.includes('rev-parse')) child.stdout.emit('data', Buffer.from('HEADSHA\n'));
      else if (key.includes('--name-only')) child.stdout.emit('data', Buffer.from('leak.txt\0'));
      else if (key.includes('diff')) child.stdout.emit('data', Buffer.from('diff --git a/leak.txt b/leak.txt\n+staged'));
      else if (key.includes('ls-files')) child.stdout.emit('data', Buffer.from(''));
      else if (key.includes('status')) child.stdout.emit('data', Buffer.from(''));
      child.emit('close', 0);
    });
    return child;
  };
  const regular = {
    isSymbolicLink: () => false, isFile: () => true, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isDirectory: () => false,
    ino: 5, dev: 1, size: 15,
  };
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'HEADSHA', baselineRef: 'REF', untrackedHashes: { 'leak.txt': digest }, evidenceComplete: true },
    spawn: scripted,
    lstat: async () => regular,
    readFile: async () => Buffer.from('unchanged bytes'),
    open: fakeOpen(Buffer.from('unchanged bytes'), { ino: 5, size: 15 }),
  });
  assert.ok(!delta.changedFiles.includes('leak.txt'), JSON.stringify(delta.changedFiles));
  assert.doesNotMatch(delta.diff, /leak\.txt/);
  assert.equal(delta.evidenceComplete, true);
});

test('a baseline-untracked file that was MODIFIED and then staged fails the evidence closed', async () => {
  const { default: events } = await import('node:events');
  const baselineDigest = evidenceSha256(Buffer.from('original pre-existing content'));
  const scripted = (_cmd, cmdArgs) => {
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    const key = cmdArgs.join(' ');
    queueMicrotask(() => {
      if (key.includes('rev-parse')) child.stdout.emit('data', Buffer.from('HEADSHA\n'));
      else if (key.includes('--name-only')) child.stdout.emit('data', Buffer.from('secrets.env\0'));
      else if (key.includes('diff')) child.stdout.emit('data', Buffer.from('diff --git a/secrets.env b/secrets.env\n+SECRET=1'));
      else if (key.includes('ls-files')) child.stdout.emit('data', Buffer.from(''));
      else if (key.includes('status')) child.stdout.emit('data', Buffer.from(''));
      child.emit('close', 0);
    });
    return child;
  };
  const regular = {
    isSymbolicLink: () => false, isFile: () => true, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isDirectory: () => false,
    ino: 9, dev: 1, size: 12,
  };
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'HEADSHA', baselineRef: 'REF', untrackedHashes: { 'secrets.env': baselineDigest }, evidenceComplete: true },
    spawn: scripted,
    lstat: async () => regular,
    readFile: async () => Buffer.from('now different'),
    open: fakeOpen(Buffer.from('now different'), { ino: 9, size: 12 }),
  });
  assert.equal(delta.evidenceComplete, false);
  assert.ok((delta.incompleteReasons ?? []).some((r) => /modified and staged after baseline/.test(r)), JSON.stringify(delta.incompleteReasons));
  assert.doesNotMatch(delta.diff, /SECRET/);
  assert.deepEqual(delta.untrackedDeleted, []);
});

test('a review-time Gate that mutates tracked files re-collects the Worker delta before review', async () => {
  let reviewerDiff = null;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre-gate diff' }),
    collectPostGateDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js', '__snapshots__/a.snap'], fingerprint: 'POST', diff: 'post-gate diff with snapshot' }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run snapshot'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
    reviewerFn: async ({ diff }) => { reviewerDiff = diff; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.match(reviewerDiff, /post-gate diff/);
  assert.ok((r.safetyEvents ?? []).some((e) => e.code === 'GATE_MUTATED_TRACKED_FILES'));
});

test('a post-Gate re-collect that comes back evidence-incomplete fails closed', async () => {
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre' }),
    collectPostGateDeltaFn: async () => ({ evidenceComplete: false, incompleteReasons: ['git diff failed'], fingerprint: 'POST', diff: '', changedFiles: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run snapshot'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /post-Gate/);
});

test('a Gate that reverts the Worker delta back to baseline re-triggers the no-change guard (no empty-diff PASS)', async () => {
  let reviewerRan = false;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre' }),
    collectPostGateDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: true, changedFiles: [], fingerprint: 'POST-EMPTY', diff: '' }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run format'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
    reviewerFn: async () => { reviewerRan = true; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'NO_PROGRESS');
  assert.equal(reviewerRan, false);
});

test('a mutating Gate is re-run over the post-Gate tree until the delta stabilises (Reviewer + Gate judge the same tree)', async () => {
  const gateTrees = [];
  let postCalls = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre' }),
    // First recollect: the Gate reformatted a.js (fingerprint FMT1). Second
    // recollect (after the Gate re-runs): idempotent, still FMT1 -> stable.
    collectPostGateDeltaFn: async () => {
      postCalls += 1;
      return { baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FMT1', diff: 'formatted a.js' };
    },
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm test && npm run format'], manifestFingerprint: 'mf' }),
    runGateFn: async () => { gateTrees.push('run'); return { verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }; },
    reviewerFn: async ({ diff }) => ({ value: { findings: [], reviewedDiff: diff }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.ok(gateTrees.length >= 2, `the Gate was re-run over the post-mutation tree (runs=${gateTrees.length})`);
  assert.ok(postCalls >= 2, `the delta was re-collected after the Gate re-run (calls=${postCalls})`);
});

test('a Gate that never stops mutating the tree fails closed (HUMAN_REQUIRED), never reaches the Reviewer', async () => {
  let n = 0;
  let reviewerRan = false;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre' }),
    collectPostGateDeltaFn: async () => { n += 1; return { baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: `MUT${n}`, diff: `mutation ${n}` }; },
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run codegen'], manifestFingerprint: 'mf' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
    reviewerFn: async () => { reviewerRan = true; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'HUMAN_REQUIRED');
  assert.match(r.reason, /never converged/);
  assert.equal(reviewerRan, false);
});

for (const [label, postFn] of [
  ['throws', async () => { throw new Error('git ls-files exploded'); }],
  ['returns null', async () => null],
  ['returns no fingerprint', async () => ({ evidenceComplete: true, changedFiles: [], diff: '' })],
  ['is incomplete with the same fingerprint as the pre-Gate delta',
    async () => ({ evidenceComplete: false, incompleteReasons: ['second git ls-files failed'], fingerprint: 'PRE', diff: 'pre', changedFiles: [] })],
]) {
  test(`a post-Gate re-collect that ${label} fails closed (no stale pre-Gate evidence reaches the Reviewer)`, async () => {
    let reviewerRan = false;
    const controller = createReviewLoopController({
      persistence: new MemoryPersistence(),
      captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'PRE', diff: 'pre' }),
      collectPostGateDeltaFn: postFn,
      discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run snapshot'], manifestFingerprint: 'mf' }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }),
      reviewerFn: async () => { reviewerRan = true; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'HUMAN_REQUIRED');
    assert.match(r.reason, /post-Gate/);
    assert.equal(reviewerRan, false);
  });
}
