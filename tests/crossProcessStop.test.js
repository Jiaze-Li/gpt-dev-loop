// Deterministic proof for Codex finding #2: supergpt_stop works across
// processes. Workflow owner identity is persisted outside the disposable
// worktree; a stop from another process reaches the owning orchestrator via
// the durable control record; and a stale/reused owner PID is handled
// fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';

import { supergptStop } from '../src/orchestrator/supergpt.js';
import { claimOwner, readControl, isStopRequested } from '../src/orchestrator/workflowControl.js';

async function tmpRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'supergpt-xstop-'));
}

async function writeState(root, workflowId, state) {
  await writeFile(path.join(root, `${workflowId}.state.json`), JSON.stringify({ workflowId, ...state }, null, 2));
}
async function readState(root, workflowId) {
  return JSON.parse(await readFile(path.join(root, `${workflowId}.state.json`), 'utf8'));
}

test('owner identity is persisted outside the worktree and carries a live PID', async () => {
  const root = await tmpRoot();
  try {
    claimOwner({ root, workflowId: 'wf-o', pid: 4242 });
    const control = readControl({ root, workflowId: 'wf-o' });
    assert.equal(control.owner.pid, 4242);
    assert.ok(control.owner.startedAt);
    // A fresh claim clears any leftover stop flag.
    assert.equal(control.stop.requested, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stop from another process records a durable cancellation the owner can read', async () => {
  const root = await tmpRoot();
  try {
    // Owner = PID 1 (init): reliably alive, never us -> a foreign live owner.
    claimOwner({ root, workflowId: 'wf-f', pid: 1 });
    await writeState(root, 'wf-f', { workflowStatus: 'RUNNING', activeProcesses: [] });

    let tick = 0;
    const result = await supergptStop({
      workflowId: 'wf-f',
      reason: 'stop from MCP process',
      root,
      waitForOwnerMs: 5000,
      _now: () => tick * 1000,
      _sleep: async () => {
        tick += 1;
        // Simulate the owning orchestrator reacting to the stop flag: it
        // tears down its pipeline and publishes a terminal state.
        if (tick === 2) await writeState(root, 'wf-f', { workflowStatus: 'STOPPED', activeProcesses: [] });
      },
    });

    assert.equal(isStopRequested({ root, workflowId: 'wf-f' }), true);
    assert.equal(readControl({ root, workflowId: 'wf-f' }).stop.reason, 'stop from MCP process');
    assert.equal(result.ownerAcknowledged, true, 'the owning process acknowledged the stop');
    assert.deepEqual(result.pidsKilled, [], 'no fallback kill was needed when the owner responded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale/reused owner PID is handled fail-closed: children killed, state forced STOPPED', async () => {
  const root = await tmpRoot();
  // A real child we own, standing in for a live provider subprocess.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 100));
  try {
    // Owner PID is dead/never-existed -> not a live owner.
    claimOwner({ root, workflowId: 'wf-stale', pid: 999999 });
    await writeState(root, 'wf-stale', {
      workflowStatus: 'RUNNING',
      stageStatuses: { executor: 'running', reviewer: 'waiting' },
      activeProcesses: [{ role: 'executor', pid: child.pid }],
    });

    const result = await supergptStop({ workflowId: 'wf-stale', reason: 'stale owner', root, waitForOwnerMs: 1000 });

    assert.equal(result.status, 'STOPPED');
    assert.equal(result.ownerAcknowledged, false);
    assert.ok(result.pidsKilled.includes(child.pid), 'the recorded live child was terminated');

    const state = await readState(root, 'wf-stale');
    assert.equal(state.workflowStatus, 'STOPPED');
    assert.equal(state.stoppedReason, 'stale owner');
    assert.equal(state.stageStatuses.executor, 'stopped');
    assert.deepEqual(state.activeProcesses, []);

    // Child is actually gone.
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(child.pid, 0));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    await rm(root, { recursive: true, force: true });
  }
});

test('stop never signals our own PID even if it appears in activeProcesses', async () => {
  const root = await tmpRoot();
  try {
    claimOwner({ root, workflowId: 'wf-self', pid: 999999 });
    await writeState(root, 'wf-self', {
      workflowStatus: 'RUNNING',
      activeProcesses: [{ role: 'orchestrator', pid: process.pid }],
    });
    const result = await supergptStop({ workflowId: 'wf-self', reason: 'x', root, waitForOwnerMs: 100 });
    assert.deepEqual(result.pidsKilled, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
