import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { callClaude } from '../src/orchestrator/adapters/claudeSupervisorProvider.js';
import { callCodex } from '../src/orchestrator/adapters/codexSupervisorProvider.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function esrch() {
  const err = new Error('no such process group');
  err.code = 'ESRCH';
  return err;
}

function fakeChild({ pid = null } = {}) {
  const child = new EventEmitter();
  if (pid !== null) child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  return child;
}

test('Claude decision transport is plan/read-only: non-Executor roles never receive acceptEdits', async () => {
  let capturedArgs = null;
  let capturedOpts = null;
  const spawn = (command, args, opts) => {
    void command;
    capturedArgs = args;
    capturedOpts = opts;
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ result: '{"decision":"CONTINUE"}' })));
      child.emit('close', 0);
    });
    return child;
  };

  const result = await callClaude({ prompt: 'decision only', model: 'opus', spawn });
  assert.equal(result.text, '{"decision":"CONTINUE"}');
  const permissionIndex = capturedArgs.indexOf('--permission-mode');
  assert.notEqual(permissionIndex, -1);
  assert.equal(capturedArgs[permissionIndex + 1], 'plan');
  assert.equal(capturedArgs.includes('acceptEdits'), false,
    'Planner/Supervisor/Reviewer transport must never gain Executor write permission');
  assert.equal(capturedOpts.detached, true, 'decision CLI is owned as a process group');
});

test('Claude decision cancellation waits until the owned process group disappears', async () => {
  const controller = new AbortController();
  const origKill = process.kill;
  let child;
  let probes = 0;

  process.kill = (pid, signal) => {
    if (pid !== -7001) return origKill(pid, signal);
    if (signal === 0) {
      probes += 1;
      if (probes < 3) return;
      throw esrch();
    }
  };

  try {
    const spawn = () => {
      child = fakeChild({ pid: 7001 });
      return child;
    };
    const promise = callClaude({ prompt: 'decision only', spawn, signal: controller.signal });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    await tick();
    controller.abort();
    child.exitCode = 0;
    child.emit('close', null, 'SIGTERM');
    await tick();
    assert.equal(settled, false, 'direct Claude CLI close is not a teardown acknowledgement');

    await assert.rejects(promise, (err) => err.name === 'ProviderCancelledError' && err.cancelled === true);
    assert.ok(probes >= 3);
  } finally {
    process.kill = origKill;
  }
});

test('Codex decision transport remains sandbox read-only and waits for group teardown on cancellation', async () => {
  const controller = new AbortController();
  const origKill = process.kill;
  let child;
  let probes = 0;
  let capturedArgs = null;
  let capturedOpts = null;

  process.kill = (pid, signal) => {
    if (pid !== -7002) return origKill(pid, signal);
    if (signal === 0) {
      probes += 1;
      if (probes < 3) return;
      throw esrch();
    }
  };

  try {
    const spawn = (command, args, opts) => {
      void command;
      capturedArgs = args;
      capturedOpts = opts;
      child = fakeChild({ pid: 7002 });
      return child;
    };
    const promise = callCodex({ prompt: 'decision only', spawn, signal: controller.signal });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    await tick();
    assert.ok(capturedArgs.includes('read-only'), 'Codex non-Executor transport keeps read-only sandbox');
    assert.equal(capturedOpts.detached, true);

    controller.abort();
    child.exitCode = 0;
    child.emit('close', null, 'SIGTERM');
    await tick();
    assert.equal(settled, false);

    await assert.rejects(promise, (err) => err.name === 'ProviderCancelledError' && err.cancelled === true);
    assert.ok(probes >= 3);
  } finally {
    process.kill = origKill;
  }
});
