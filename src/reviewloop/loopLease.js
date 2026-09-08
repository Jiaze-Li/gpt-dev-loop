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
//     ({ token, pid, host, acquiredAt, expiresAt, renewedAt }).
//
// Reclaim rule (safety-critical): a lock is reclaimed ONLY when its owner is
// provably gone.
//   * same host  -> the owner pid no longer exists. This is authoritative and
//     the fixed TTL is IRRELEVANT here: a slow-but-alive owner (a long chunked
//     review, a 15-minute PR wait) keeps its lock past the nominal TTL.
//   * other host -> we cannot inspect the pid, so we fall back to the TTL —
//     which a live owner keeps fresh by RENEWING it on a timer (heartbeat).
//     An expired remote lock is presumed abandoned.
//   * unreadable / malformed lock record -> treated as abandoned.

import {
  open, readFile, writeFile, unlink, mkdir, stat, rename,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LEASE_TTL_MS = 20 * 60_000;
// Renew well inside the TTL so a live owner's lock never lapses for a peer on
// another host between heartbeats.
export const DEFAULT_LEASE_RENEW_MS = 5 * 60_000;

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

function ownedBySameHost(record) {
  return Boolean(record && typeof record === 'object' && record.host && record.host === os.hostname());
}

// True only when the current lock's owner is provably gone (see the reclaim
// rule at the top of this file).
function isReclaimable(current, now) {
  if (!current || typeof current !== 'object') return true;
  if (ownedBySameHost(current)) {
    // Authoritative: the fixed TTL does not matter when we can see the pid.
    return !holderAlive(current.pid);
  }
  const expiresAt = Date.parse(current.expiresAt ?? '');
  return !Number.isFinite(expiresAt) || expiresAt < now;
}

// Acquire the durable cross-process lock. Returns { ok: true, release, renew }
// or { ok: false, heldBy }. When no `runtimeRoot` filesystem is available
// (unit tests with an in-memory persistence), returns a no-op ok lease — the
// in-process chain is still the correctness guarantee there.
export async function acquireLoopFileLease({
  runtimeRoot = null, loopId, ttlMs = DEFAULT_LEASE_TTL_MS,
  renewMs = DEFAULT_LEASE_RENEW_MS, clock = () => Date.now(),
} = {}) {
  if (!runtimeRoot || !loopId) {
    return { ok: true, release: async () => {}, renew: async () => true };
  }
  const dir = path.join(runtimeRoot, loopId);
  const lockPath = path.join(dir, 'reviewloop.lock');
  const token = randomUUID();

  const write = async () => {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify({
        token, pid: process.pid, host: os.hostname(),
        acquiredAt: new Date(clock()).toISOString(),
        renewedAt: new Date(clock()).toISOString(),
        expiresAt: new Date(clock() + ttlMs).toISOString(),
      }));
    } finally {
      await handle.close();
    }
  };

  // Extend this lock's TTL in place. Only rewrites a lock still owned by this
  // token; a no-op (returns false) once the lock is gone or was reclaimed.
  const renew = async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current?.token !== token) return false;
      current.renewedAt = new Date(clock()).toISOString();
      current.expiresAt = new Date(clock() + ttlMs).toISOString();
      await writeFile(lockPath, JSON.stringify(current));
      return true;
    } catch {
      return false;
    }
  };

  const acquired = () => {
    const timer = setInterval(() => { renew().catch(() => {}); }, Math.max(1_000, renewMs));
    if (typeof timer.unref === 'function') timer.unref();
    return {
      ok: true,
      renew,
      release: async () => {
        clearInterval(timer);
        await releaseIfOwned(lockPath, token);
      },
    };
  };

  try {
    await mkdir(dir, { recursive: true });
  } catch { /* fall through — write() will surface a real problem */ }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await write();
      return acquired();
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
      // The lock file vanished between our failed `wx` and this read — another
      // contender reclaimed it. Loop and let the exclusive `wx` create race.
      if (current === null) continue;
      if (!isReclaimable(current, clock())) {
        return { ok: false, heldBy: current };
      }
      // Provably abandoned. Reclaim is SERIALIZED behind an exclusive
      // `<lock>.reclaim` file so exactly one contender ever unlinks the stale
      // lock — never the old `unlink(path)` race where a late contender deleted
      // the winner's freshly-created replacement and then acquired its own.
      // eslint-disable-next-line no-await-in-loop
      const reclaimed = await reclaimStaleLock(lockPath, current, clock, token);
      if (!reclaimed) continue; // another contender is reclaiming / already did
      // Loop -> the exclusive `wx` create is the final arbiter of ownership.
    }
  }
  return { ok: false, heldBy: { reason: 'could not acquire the loop lease' } };
}

// Orphaned `.reclaim` guard file older than this is assumed abandoned (the
// contender that held it crashed mid-reclaim) and is force-removed.
const RECLAIM_GUARD_ORPHAN_MS = 30_000;

// Serialize stale-lock reclamation. Returns true only when THIS call unlinked
// the stale lock (so the caller should retry the exclusive `wx` create), false
// when another contender owns (or already finished) the reclaim.
async function reclaimStaleLock(lockPath, staleRecord, clock, token) {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    // Someone else is reclaiming. If their guard is ancient, they crashed. Take
    // ownership of the ORPHAN via an atomic rename to a uniquely-named victim
    // path — exactly one contender can move THIS guard file aside; every other
    // rename fails ENOENT. We then delete only our uniquely-named copy, so this
    // is NOT the pathname-`unlink` race (a peer's freshly-created replacement
    // guard is a different inode we never touch).
    try {
      const st = await stat(guardPath);
      if (clock() - st.mtimeMs <= RECLAIM_GUARD_ORPHAN_MS) return false; // fresh — yield
      const victim = `${guardPath}.${token}.orphan`;
      await rename(guardPath, victim);
      await unlink(victim).catch(() => {});
    } catch { /* lost the orphan-takeover race, or it is gone already */ }
    return false; // retry the loop: the guard slot is clear now
  }
  try {
    await guard.close();
    // Re-validate under the guard: only unlink the lock if it is STILL the exact
    // stale record we saw and it is still reclaimable. A racing contender may
    // already have replaced it with a fresh, live lock.
    let now = null;
    try { now = JSON.parse(await readFile(lockPath, 'utf8')); } catch { now = null; }
    if (now && now.token === staleRecord.token && isReclaimable(now, clock())) {
      await unlink(lockPath).catch(() => {});
      return true;
    }
    return false;
  } finally {
    await unlink(guardPath).catch(() => {});
  }
}

async function releaseIfOwned(lockPath, token) {
  try {
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current?.token === token) await unlink(lockPath);
  } catch { /* already gone / not ours */ }
}
