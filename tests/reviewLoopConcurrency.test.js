// Phase 2 #5 — a reviewloop_review for a loopId is serialized:
//   * in-process: two overlapping calls -> exactly ONE model dispatch, no lost
//     update (the second call runs after the first and hits NO_PROGRESS);
//   * cross-process: a live foreign lock holder -> the call returns BUSY and
//     touches no state; a stale/expired lock is reclaimed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { acquireLoopFileLease } from '../src/reviewloop/loopLease.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function slowReviewerController(persistence, onReview) {
  return createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'SAME_FP', diff: 'diff x',
    }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'GATE', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    reviewerFn: async () => {
      onReview();
      await sleep(40);
      return { value: { findings: [] }, usage: { input_tokens: 3, output_tokens: 2 } };
    },
  });
}

test('two concurrent in-process reviewloop_review calls -> exactly one model dispatch, one round, no lost update', async () => {
  const persistence = new MemoryPersistence();
  let reviewerCalls = 0;
  const controller = slowReviewerController(persistence, () => { reviewerCalls += 1; });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

  const [a, b] = await Promise.all([
    controller.review({ loopId }),
    controller.review({ loopId }),
  ]);

  assert.equal(reviewerCalls, 1, 'the Reviewer was dispatched exactly once');
  // The first call PASSes; the second — after serialization — either hits the
  // deterministic NO_PROGRESS guard or reads the now-terminal PASS state. Never
  // a second dispatch.
  for (const s of [a.status, b.status]) assert.ok(['PASS', 'NO_PROGRESS'].includes(s), s);

  const state = await persistence.readWorkflowState(loopId);
  assert.equal(state.reviewLoop.round, 1, 'round advanced exactly once (no lost update)');
  const spend = state.reviewLoopSpend?.records ?? [];
  assert.equal(spend.filter((r) => r.role === 'reviewer').length, 1, 'exactly one durable spend record');
});

test('cross-process: a live foreign lock holder makes reviewloop_review return BUSY', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-'));
  try {
    const persistence = new Persistence(root);
    let reviewerCalls = 0;
    const controller = createReviewLoopController({
      persistence, runtimeRoot: root,
      captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
      collectWorkerDeltaFn: async () => ({ baselineHead: 'BASE', currentHead: 'BASE', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FP', diff: 'd' }),
      runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'G', failureIdentities: [], results: [] }),
      discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
      reviewerFn: async () => { reviewerCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    });
    const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });

    // Simulate another process holding the lease.
    const foreign = await acquireLoopFileLease({ runtimeRoot: root, loopId });
    assert.equal(foreign.ok, true);

    const busy = await controller.review({ loopId });
    assert.equal(busy.status, 'WAITING_FOR_REVIEW');
    assert.match(busy.reason, /another reviewloop_review is already running/);
    assert.equal(reviewerCalls, 0, 'no dispatch while another holder owns the loop');

    await foreign.release();
    const r = await controller.review({ loopId });
    assert.equal(r.status, 'PASS');
    assert.equal(reviewerCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an expired lock file from another host is reclaimed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-stale-'));
  try {
    const dir = path.join(root, 'LOOP1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'old', pid: process.pid, host: 'some-other-host',
      acquiredAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:10:00Z',
    }));
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOP1' });
    assert.equal(lease.ok, true);
    await lease.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed (truncated) lock file is reclaimed, not retried into a wedge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-malformed-'));
  try {
    const dir = path.join(root, 'LOOPM');
    fs.mkdirSync(dir, { recursive: true });
    // A process died mid-write during renew()'s in-place rewrite.
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), '{"token":"old","pi');
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOPM' });
    assert.equal(lease.ok, true, 'a lock with unparseable content has no owner and is reclaimed');
    const held = JSON.parse(fs.readFileSync(path.join(dir, 'reviewloop.lock'), 'utf8'));
    assert.equal(typeof held.token, 'string');
    assert.notEqual(held.token, 'old');
    await lease.release();
    assert.equal(fs.existsSync(path.join(dir, 'reviewloop.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty lock file (zero-length write) is reclaimed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-empty-'));
  try {
    const dir = path.join(root, 'LOOPE');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), '');
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOPE' });
    assert.equal(lease.ok, true);
    await lease.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent acquires of the same loop -> exactly one winner; the loser never reclaims the winner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-conc-'));
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOPC' })),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}`);
    // Every loser sees the winner's full record, never an empty/partial one.
    for (const loser of results.filter((r) => !r.ok)) {
      assert.equal(typeof loser.heldBy?.token, 'string', JSON.stringify(loser.heldBy));
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'LOOPC', 'reviewloop.lock'), 'utf8'));
    assert.equal(typeof onDisk.token, 'string');
    await winners[0].release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lock held by a dead pid on THIS host is reclaimed regardless of TTL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-dead-'));
  try {
    const dir = path.join(root, 'LOOP2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'old', pid: 999_999_999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(),
    }));
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOP2' });
    assert.equal(lease.ok, true);
    await lease.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lease TTL expires while the owner pid is alive on this host -> a second process still cannot enter', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-alive-'));
  try {
    const dir = path.join(root, 'LOOP3');
    fs.mkdirSync(dir, { recursive: true });
    // A lock whose fixed TTL lapsed long ago, but whose owner process (this
    // very test process) is still running on this host.
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'live-owner', pid: process.pid, host: os.hostname(),
      acquiredAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T00:10:00Z',
    }));
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOP3' });
    assert.equal(lease.ok, false, 'a live same-host owner keeps its lock past the TTL');
    assert.equal(lease.heldBy?.token, 'live-owner');
    // The lock file was NOT stolen.
    const still = JSON.parse(fs.readFileSync(path.join(dir, 'reviewloop.lock'), 'utf8'));
    assert.equal(still.token, 'live-owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a held lease renews its own expiry (heartbeat)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-renew-'));
  try {
    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'LOOP4' });
    assert.equal(lease.ok, true);
    const lockPath = path.join(root, 'LOOP4', 'reviewloop.lock');
    const before = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    await sleep(2);
    assert.equal(await lease.renew(), true);
    const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.ok(Date.parse(after.expiresAt) >= Date.parse(before.expiresAt));
    assert.ok(Date.parse(after.renewedAt) >= Date.parse(before.renewedAt));
    await lease.release();
    assert.equal(fs.existsSync(lockPath), false, 'release removes the lock');
    assert.equal(await lease.renew(), false, 'renew after release is a no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
