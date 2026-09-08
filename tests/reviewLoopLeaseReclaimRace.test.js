// P1 regression — stale loop-lease reclaim must be ownership-preserving: when
// several processes simultaneously see the SAME reclaimable lock, at most ONE
// acquires the lease. The old `unlink(path)` reclaim let a late contender
// delete the winner's freshly-created replacement lock and then acquire its
// own, so two reviews ran concurrently (duplicate paid dispatch, racing state).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTENDER = fileURLToPath(new URL('./fixtures/leaseContender.mjs', import.meta.url));

function runContender(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONTENDER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ error: `bad output: ${out} / ${err}` }); }
    });
  });
}

test('N processes racing to reclaim ONE stale lock -> at most one wins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-race-'));
  const barrier = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-lease-barrier-'));
  const loopId = 'RACELOOP';
  try {
    // Pre-plant a stale lock: dead pid on THIS host -> reclaimable.
    const dir = path.join(root, loopId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'stale', pid: 999_999_999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(),
    }));

    const N = 6;
    const runs = Array.from({ length: N }, (_, i) => runContender({
      LEASE_ROOT: root, LEASE_LOOP: loopId, LEASE_BARRIER: barrier, LEASE_ID: `c${i}`,
    }));

    // Wait for every contender to reach the barrier, then release them together.
    const deadline = Date.now() + 12_000;
    while (fs.readdirSync(barrier).filter((f) => f.startsWith('ready-')).length < N) {
      if (Date.now() > deadline) throw new Error('contenders did not all reach the barrier');
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(path.join(barrier, 'go'), '1');

    const results = await Promise.all(runs);
    const winners = results.filter((r) => r.ok === true);
    assert.ok(results.every((r) => r.error === undefined), JSON.stringify(results));
    assert.ok(winners.length <= 1, `at most one winner, got ${winners.length}: ${JSON.stringify(results)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(barrier, { recursive: true, force: true });
  }
});
