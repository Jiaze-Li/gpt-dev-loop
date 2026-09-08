// Cross-process loop-lease contender. Spins on a barrier file, then races to
// acquire the ReviewLoop per-loop file lease against a pre-planted STALE lock.
// Exactly one contender across all processes may win.
//
//   LEASE_ROOT     runtimeRoot
//   LEASE_LOOP     loopId
//   LEASE_BARRIER  barrier dir (writes ready-<id>, spins until <barrier>/go)
//   LEASE_ID       this contender's id

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { acquireLoopFileLease } from '../../src/reviewloop/loopLease.js';

const root = process.env.LEASE_ROOT;
const loopId = process.env.LEASE_LOOP;
const barrierDir = process.env.LEASE_BARRIER;
const id = process.env.LEASE_ID || String(process.pid);

mkdirSync(barrierDir, { recursive: true });
writeFileSync(path.join(barrierDir, `ready-${id}`), '1');

const started = Date.now();
while (!existsSync(path.join(barrierDir, 'go'))) {
  if (Date.now() - started > 15000) { process.stdout.write(JSON.stringify({ id, error: 'barrier timeout' }) + '\n'); process.exit(2); }
}

const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId });
process.stdout.write(JSON.stringify({ id, pid: process.pid, ok: lease.ok }) + '\n');
if (lease.ok) {
  // Hold it briefly so a losing peer cannot also "win" a moment later.
  const t = Date.now();
  while (Date.now() - t < 400) { /* hold */ }
  await lease.release();
}
