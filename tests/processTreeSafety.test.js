import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  killProcessTree,
  processGroupExists,
  terminateProcessTree,
} from '../src/orchestrator/processTree.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('pid=1 can never become POSIX kill(-1) broadcast', async () => {
  if (process.platform === 'win32') return;

  const originalKill = process.kill;
  const groupSignals = [];
  process.kill = (pid, signal) => {
    groupSignals.push([pid, signal]);
    if (pid === -1) {
      throw new Error('unsafe POSIX broadcast attempted');
    }
    return originalKill(pid, signal);
  };

  try {
    const child = fakeChild(1);

    killProcessTree(child, 'SIGTERM');
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    assert.equal(groupSignals.some(([pid]) => pid === -1), false);

    assert.equal(processGroupExists(1), false);
    assert.equal(groupSignals.some(([pid]) => pid === -1), false);

    const teardown = terminateProcessTree(child, { graceMs: 10 });
    assert.equal(teardown.pgid, null);
    await teardown.done;
    teardown.cancel();

    assert.equal(groupSignals.some(([pid]) => pid === -1), false);
  } finally {
    process.kill = originalKill;
  }
});

test('explicit pgid=1 also refuses group signalling', () => {
  if (process.platform === 'win32') return;

  const originalKill = process.kill;
  const child = fakeChild(9999);
  let broadcastAttempted = false;

  process.kill = (pid, signal) => {
    if (pid === -1) broadcastAttempted = true;
    return originalKill(pid, signal);
  };

  try {
    killProcessTree(child, 'SIGTERM', { pgid: 1 });
    assert.equal(broadcastAttempted, false);
    assert.deepEqual(child.killCalls, ['SIGTERM']);
  } finally {
    process.kill = originalKill;
  }
});
