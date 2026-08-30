import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';

import { scanAndSnapshotExternalSymlinks } from '../src/orchestrator/preflight.js';
import {
  acquireWorkflowOwnership,
  ownerLockPath,
  OWNERSHIP_CODES,
} from '../src/orchestrator/workflowOwnership.js';

test('Claude P2: dangling tracked symlink blocker reports the actual link target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-readlink-regression-'));
  const linkPath = path.join(root, 'dangling-link');
  const relativeTarget = path.join('missing', 'dependency.txt');
  try {
    await symlink(relativeTarget, linkPath);
    const result = await scanAndSnapshotExternalSymlinks({
      worktreePath: root,
      candidatePaths: ['dangling-link'],
      isTrackedFn: async () => true,
    });
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].target, path.resolve(root, relativeTarget));
    assert.match(result.blockers[0].detail, /missing[\\/]dependency\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude P2: ownership initialization retry yields to the event loop instead of busy-spinning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-owner-yield-regression-'));
  const workflowId = 'wf-owner-yield-regression';
  try {
    await mkdir(ownerLockPath({ root, workflowId }), { recursive: true });
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);

    const result = await acquireWorkflowOwnership({
      root,
      workflowId,
      maxInitializingRetries: 2,
      initializingRetryMs: 25,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.code, OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING);
    assert.equal(timerFired, true, 'retry wait must yield so unrelated timers/I/O can run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
