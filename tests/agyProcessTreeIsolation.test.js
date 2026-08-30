import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { callAgy } from '../src/agy/agyClient.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function esrch() {
  const err = new Error('no such process group');
  err.code = 'ESRCH';
  return err;
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('Agy transport owns a process group and waits for group teardown on cancellation', async () => {
  if (process.platform === 'win32') return;

  const controller = new AbortController();
  const originalKill = process.kill;
  let child;
  let capturedOptions = null;
  let probes = 0;

  process.kill = (pid, signal) => {
    if (pid !== -7010) return originalKill(pid, signal);
    if (signal === 0) {
      probes += 1;
      if (probes < 3) return;
      throw esrch();
    }
    return true;
  };

  try {
    const spawn = (_command, _args, options) => {
      capturedOptions = options;
      child = fakeChild(7010);
      return child;
    };

    const promise = callAgy({
      prompt: 'decision only',
      spawn,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    await tick();
    assert.equal(capturedOptions.detached, true, 'Agy CLI is owned as a process group');

    controller.abort();
    await tick();
    assert.equal(settled, false, 'cancellation waits for the owned group to disappear');

    await assert.rejects(
      promise,
      (err) => err?.code === 'AGY_ABORTED',
    );
    assert.ok(probes >= 3);
  } finally {
    process.kill = originalKill;
  }
});
