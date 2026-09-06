// Per-loopId exclusive lease.
//
// Two reviewloop_review calls for the SAME loopId — two OS processes, or two
// overlapping MCP invocations in one process — must not both read the loop
// state, both run the Reviewer, both spend, and then clobber each other's
// durable state (lost update on round / reviewerCalls / findingSignatureHistory
// / the spend + reservation + information ledgers).
//
// Two layers:
//   * an in-process promise chain per loopId (serializes overlapping calls in
//     one process; the second call runs AFTER the first and then hits the
//     deterministic NO_PROGRESS guard — one dispatch, no lost update);
//   * a durable cross-process lock file `<runtimeRoot>/<loopId>/reviewloop.lock`
//     ({ token, pid, host, acquiredAt, expiresAt }). A live foreign holder ->
//     the caller is told the loop is BUSY and does nothing. A stale lock
//     (expired, or the holder pid is gone) is reclaimed.

import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LEASE_TTL_MS = 20 * 60_000;

const inProcessChains = new Map(); // loopId -> Promise

// Serialize `fn` against every other call for this loopId IN THIS PROCESS.
export function withInProcessLoopLock(loopId, fn) {
  const prev = inProcessChains.get(loopId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  // The chain tail is `run` swallowing its own result/rejection, so the next
  // caller only waits for completion, never inherits an error.
  const tail = run.then(() => {}, () => {});
  inProcessChains.set(loopId, tail);
  tail.then(() => {
    if (inProcessChains.get(loopId) === tail) inProcessChains.delete(loopId);
  });
  return run;
}

function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists but not ours to signal
  }
}

// Acquire the durable cross-process lock. Returns { ok: true, release } or
// { ok: false, heldBy }. When no `runtimeRoot` filesystem is available (unit
// tests with an in-memory persistence), returns a no-op ok lease — the
// in-process chain is still the correctness guarantee there.
export async function acquireLoopFileLease({
  runtimeRoot = null, loopId, ttlMs = DEFAULT_LEASE_TTL_MS, clock = () => Date.now(),
} = {}) {
  if (!runtimeRoot || !loopId) return { ok: true, release: async () => {} };
  const dir = path.join(runtimeRoot, loopId);
  const lockPath = path.join(dir, 'reviewloop.lock');
  const token = randomUUID();

  const write = async () => {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify({
        token, pid: process.pid, host: os.hostname(),
        acquiredAt: new Date(clock()).toISOString(),
        expiresAt: new Date(clock() + ttlMs).toISOString(),
      }));
    } finally {
      await handle.close();
    }
  };

  try {
    await mkdir(dir, { recursive: true });
  } catch { /* fall through — write() will surface a real problem */ }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await write();
      return { ok: true, release: async () => releaseIfOwned(lockPath, token) };
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        // Filesystem problem — do not silently proceed unserialised.
        return { ok: false, heldBy: { reason: `lock unavailable: ${err?.message ?? err}` } };
      }
      let current = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        current = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch { current = null; }
      const expired = current?.expiresAt && Date.parse(current.expiresAt) < clock();
      const dead = current && !holderAlive(current.pid);
      if (current && !expired && !dead) {
        return { ok: false, heldBy: current };
      }
      // Stale — reclaim and retry once.
      try {
        // eslint-disable-next-line no-await-in-loop
        await unlink(lockPath);
      } catch { /* someone else may have reclaimed it — retry will re-check */ }
    }
  }
  return { ok: false, heldBy: { reason: 'could not acquire the loop lease' } };
}

async function releaseIfOwned(lockPath, token) {
  try {
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current?.token === token) await unlink(lockPath);
  } catch { /* already gone / not ours */ }
}
