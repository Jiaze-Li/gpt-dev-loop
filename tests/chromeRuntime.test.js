import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ChromeRuntime, clearStaleSingletonLock } from '../src/bridge/chromeRuntime.js';
import { ChromeUnavailableError, RequestTimeoutError } from '../src/bridge/errors.js';

// The lock is a symlink whose target never exists as a real file, so
// fs.existsSync (which follows symlinks) always reports false for it even
// when the link itself is still present. lstatSync checks the link itself.
function lockLinkExists(dir) {
  try {
    fs.lstatSync(path.join(dir, 'SingletonLock'));
    return true;
  } catch {
    return false;
  }
}

function makeFakeContext() {
  let closed = false;
  const page = {
    isClosed: () => closed,
  };
  return {
    page,
    isClosed: () => closed,
    pages: () => [page],
    newPage: async () => page,
    close: async () => {
      closed = true;
    },
  };
}

function makeLauncher() {
  const contexts = [];
  const launchPersistentContext = async (profileDir) => {
    const context = makeFakeContext();
    contexts.push({ profileDir, context });
    return context;
  };
  return { launchPersistentContext, contexts };
}

test('ChromeRuntime launches the persistent context once and reuses it across calls', async () => {
  const { launchPersistentContext, contexts } = makeLauncher();
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );

  await runtime.run(async (page) => page);
  await runtime.run(async (page) => page);

  assert.equal(contexts.length, 1);
  await runtime.close();
});

test('ChromeRuntime serializes calls in FIFO order', async () => {
  const { launchPersistentContext } = makeLauncher();
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );

  const order = [];
  const slow = runtime.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('slow');
  });
  const fast = runtime.run(async () => {
    order.push('fast');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow', 'fast']);
  await runtime.close();
});

test('ChromeRuntime rebuilds the context after a task throws', async () => {
  const { launchPersistentContext, contexts } = makeLauncher();
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );

  await assert.rejects(() =>
    runtime.run(async () => {
      throw new Error('boom');
    })
  );
  await runtime.run(async (page) => page);

  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].context.isClosed(), true);
  await runtime.close();
});

test('ChromeRuntime hides the window by default and exposes show/hide controls to tasks', async () => {
  const { launchPersistentContext } = makeLauncher();
  const calls = [];
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile' },
    {
      launchPersistentContext,
      hideWindow: async () => calls.push('hide'),
      showWindow: async () => calls.push('show'),
    }
  );

  await runtime.run(async (page, controls) => {
    await controls.showWindow();
    await controls.hideWindow();
  });

  assert.deepEqual(calls, ['hide', 'show', 'hide']);
  await runtime.close();
});

test('ChromeRuntime skips hiding the window when backgroundWindow is false', async () => {
  const { launchPersistentContext } = makeLauncher();
  const calls = [];
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    {
      launchPersistentContext,
      hideWindow: async () => calls.push('hide'),
      showWindow: async () => calls.push('show'),
    }
  );

  await runtime.run(async (page, controls) => {
    await controls.hideWindow();
  });

  assert.deepEqual(calls, []);
  await runtime.close();
});

test('ChromeRuntime rejects further calls after close', async () => {
  const { launchPersistentContext } = makeLauncher();
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );
  await runtime.close();
  await assert.rejects(() => runtime.run(async () => {}), ChromeUnavailableError);
});

test('clearStaleSingletonLock removes a lock left by a process that is no longer running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-loop-lock-'));
  const deadPid = 999999; // out of range for a real pid on macOS/Linux
  fs.symlinkSync(`test-host-${deadPid}`, path.join(dir, 'SingletonLock'));

  clearStaleSingletonLock(dir);

  assert.equal(lockLinkExists(dir), false);
});

test('clearStaleSingletonLock refuses to remove a lock held by a live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-loop-lock-'));
  fs.symlinkSync(`test-host-${process.pid}`, path.join(dir, 'SingletonLock'));

  assert.throws(() => clearStaleSingletonLock(dir), ChromeUnavailableError);
  assert.equal(lockLinkExists(dir), true);
});

test('clearStaleSingletonLock is a no-op when there is no lock file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-loop-lock-'));
  assert.doesNotThrow(() => clearStaleSingletonLock(dir));
});

test('clearStaleSingletonLock refuses to remove a lock in an unrecognized format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-loop-lock-'));
  fs.symlinkSync('not-a-pid-suffix', path.join(dir, 'SingletonLock'));

  assert.throws(() => clearStaleSingletonLock(dir), ChromeUnavailableError);
  assert.equal(lockLinkExists(dir), true);
});

test('a request-level timeout poisons the runtime so the next call gets a fresh context', async () => {
  const { launchPersistentContext, contexts } = makeLauncher();
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );

  // Simulates askGpt's withTimeout firing while a task is still executing:
  // the task itself completes successfully (the "success race" case), but
  // the runtime must still be rebuilt because the caller already moved on.
  await runtime.run(async () => {
    runtime.poison();
    return 'late reply, caller already timed out';
  });
  await runtime.run(async (page) => page);

  assert.equal(contexts.length, 2, 'poisoning must force a fresh context on the next call');
  assert.equal(contexts[0].context.isClosed(), true);
  await runtime.close();
});

test('close() during an in-flight launch discards the context instead of adopting it', async () => {
  const contexts = [];
  let releaseLaunch;
  const launchGate = new Promise((resolve) => {
    releaseLaunch = resolve;
  });
  const launchPersistentContext = async (profileDir) => {
    await launchGate;
    const context = makeFakeContext();
    contexts.push({ profileDir, context });
    return context;
  };
  const runtime = new ChromeRuntime(
    { profileDir: '/tmp/fake-profile', backgroundWindow: false },
    { launchPersistentContext }
  );

  const runPromise = runtime.run(async (page) => page);
  // Let the queued task start and reach the gated launch call before closing.
  await Promise.resolve();
  const closePromise = runtime.close();
  releaseLaunch();

  await assert.rejects(runPromise, ChromeUnavailableError);
  await closePromise;

  assert.equal(contexts.length, 1, 'the context that finished launching after close() should still be observed');
  assert.equal(contexts[0].context.isClosed(), true, 'it must be closed rather than left running in the background');
});

test('withTimeout rejects with RequestTimeoutError and invokes onTimeout exactly once', async () => {
  const { withTimeout } = await import('../src/bridge/chromeRuntime.js');
  const calls = [];
  const neverResolves = new Promise(() => {});

  await assert.rejects(
    () => withTimeout(neverResolves, 20, 'timed out', () => calls.push('timeout')),
    RequestTimeoutError
  );
  assert.deepEqual(calls, ['timeout']);
});
