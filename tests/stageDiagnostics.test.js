import test from 'node:test';
import assert from 'node:assert/strict';

import { createStageStore } from '../extension/stageDiagnostics.js';

// Fake clock + fake timer plumbing so TTL expiry is deterministic (no real
// waiting) — mirrors the pattern the rest of this codebase uses for
// timing-sensitive pure modules.
function makeFakeTimers() {
  let currentTime = 0;
  const scheduled = new Map();
  let nextToken = 1;
  return {
    now: () => currentTime,
    schedule: (fn, ms) => {
      const token = nextToken++;
      scheduled.set(token, { fn, dueAt: currentTime + ms });
      return token;
    },
    cancel: (token) => {
      scheduled.delete(token);
    },
    advance(ms) {
      currentTime += ms;
      for (const [token, entry] of [...scheduled.entries()]) {
        if (entry.dueAt <= currentTime) {
          scheduled.delete(token);
          entry.fn();
        }
      }
    },
  };
}

test('init() then get() returns exactly requestId/tabId/stage/timestamp', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.init('req-1', 42, 'background request received');
  const record = store.get('req-1');

  assert.deepEqual(record, { requestId: 'req-1', tabId: 42, stage: 'background request received', timestamp: 0 });
});

test('update() on an unknown requestId is a silent no-op', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.update('never-init', 'composer found');
  assert.equal(store.get('never-init'), null);
  assert.equal(store.size(), 0);
});

test('update() advances stage and timestamp for a tracked request', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.init('req-1', 42, 'background request received');
  timers.advance(1000);
  store.update('req-1', 'composer found');

  assert.deepEqual(store.get('req-1'), { requestId: 'req-1', tabId: 42, stage: 'composer found', timestamp: 1000 });
});

test('get() on an unknown requestId returns null', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ now: timers.now, schedule: timers.schedule, cancel: timers.cancel });
  assert.equal(store.get('nope'), null);
});

test('TTL is a sliding window: repeated update()s before the TTL elapses keep the record alive', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ ttlMs: 1000, now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.init('req-1', 42, 'background request received');
  timers.advance(900);
  store.update('req-1', 'relay started'); // rearms the TTL from t=900
  timers.advance(900); // t=1800, i.e. 900ms after the last update — still under 1000ms TTL
  assert.deepEqual(store.get('req-1'), { requestId: 'req-1', tabId: 42, stage: 'relay started', timestamp: 900 });
});

test('a record expires ttlMs after its LAST update, independent of the original request still being tracked anywhere else', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ ttlMs: 1000, now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.init('req-1', 42, 'background request received');
  timers.advance(1001);

  assert.equal(store.get('req-1'), null);
  assert.equal(store.size(), 0);
});

test('multiple in-flight requests are tracked independently', () => {
  const timers = makeFakeTimers();
  const store = createStageStore({ now: timers.now, schedule: timers.schedule, cancel: timers.cancel });

  store.init('req-1', 42, 'background request received');
  store.init('req-2', 43, 'background request received');
  store.update('req-1', 'composer found');

  assert.equal(store.get('req-1').stage, 'composer found');
  assert.equal(store.get('req-2').stage, 'background request received');
});
