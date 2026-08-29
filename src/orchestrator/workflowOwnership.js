// Atomic, filesystem-backed workflow ownership lease.
//
// The single-owner / single-writer invariant for a workflow (one orchestrator
// process driving one preserved worktree and its durable control.json) cannot
// be enforced by a check-then-claim sequence: across two OS processes the read
// and the write are not atomic, so two concurrent `supergpt resume` calls can
// both observe "unowned" and both start driving the same workflow.
//
// This module replaces that with a genuinely atomic claim:
//
//   tryAcquireWorkflowOwnership(workflowId) -> exactly one winner
//
// Atomic primitive: exclusive file creation via fs.openSync(path, 'wx')
// (O_CREAT | O_EXCL). The kernel guarantees that at most one caller creates
// the file; every other concurrent caller gets EEXIST. There is no window
// between "does it exist" and "create it" — the test-and-create is one syscall.
//
// The lease file is <root>/<workflowId>.owner.lock and holds:
//   { workflowId, ownerToken, pid, hostname, acquiredAt, runtimeRevision }
//
// ownerToken is a random 128-bit value, regenerated on every fresh acquisition
// (including stale-owner reclamation). PID alone is never authoritative because
// PIDs are reused; the token lets release() prove it is releasing *its own*
// lease and never a newer owner's.
//
// Stale-owner recovery (a crashed owner leaves the file behind) is serialized
// through a second atomic primitive — exclusive directory creation
// (fs.mkdirSync, also atomic / EEXIST on contention) — so two processes racing
// to reclaim the same dead lease still produce exactly one winner. If the
// reclaim cannot be performed safely, this fails closed with STALE_OWNER_LOCK
// rather than deleting another process's artifact on a hunch.

import path from 'node:path';
import os from 'node:os';
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { getSuperGptSourceRevision } from './runtimeIdentity.js';

export const OWNERSHIP_CODES = Object.freeze({
  ACQUIRED: 'ACQUIRED',
  WORKFLOW_ALREADY_OWNED: 'WORKFLOW_ALREADY_OWNED',
  OWNER_SHUTTING_DOWN: 'OWNER_SHUTTING_DOWN',
  STALE_OWNER_LOCK: 'STALE_OWNER_LOCK',
});

// A reclaim mutex older than this whose holder PID is dead is itself considered
// abandoned and may be broken once (bounded, so a crash mid-reclaim does not
// wedge the workflow forever). Kept generous: a real reclaim is sub-second.
const RECLAIM_MUTEX_TTL_MS = 60_000;

export class WorkflowOwnershipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkflowOwnershipError';
    this.code = code ?? 'WORKFLOW_OWNERSHIP_ERROR';
  }
}

export function ownerLockPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  if (!workflowId) throw new Error('ownerLockPath requires a workflowId');
  return path.join(root, `${workflowId}.owner.lock`);
}

function reclaimMutexPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  return path.join(root, `${workflowId}.owner.reclaim`);
}

function newOwnerToken() {
  return randomBytes(16).toString('hex');
}

export function readOwnerLease({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const file = ownerLockPath({ root, workflowId });
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.workflowId === workflowId) return parsed;
    return null;
  } catch {
    return null;
  }
}

// Is the process that holds `lease` demonstrably alive? A live owner must NEVER
// have its lease stolen, so this errs toward "alive": an EPERM from kill(0)
// means the PID exists but is owned by another user — still alive.
export function isLeaseOwnerAlive(lease) {
  const pid = lease?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // A lease recorded on a different host cannot be liveness-checked here; treat
  // as alive (fail closed) — we must not steal another machine's lease.
  if (lease.hostname && lease.hostname !== os.hostname()) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function writeLeaseExclusive(file, lease) {
  // 'wx' => O_CREAT | O_EXCL: atomic test-and-create. Throws EEXIST if another
  // process won the race.
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
    try { fsyncSync(fd); } catch { /* fsync best-effort; create already won */ }
  } finally {
    closeSync(fd);
  }
}

function buildLease({ workflowId, ownerToken, runtimeRevision }) {
  return {
    workflowId,
    ownerToken,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    runtimeRevision: runtimeRevision ?? null,
  };
}

function ownedResult(lease, code) {
  return {
    acquired: false,
    code,
    ownerToken: null,
    lease,
    ownerPid: lease?.pid ?? null,
    acquiredAt: lease?.acquiredAt ?? null,
  };
}

// Attempt to reclaim a lease whose recorded owner PID is dead. Serialized via
// an atomic mkdir mutex so two simultaneous reclaimers cannot both delete +
// recreate. Returns an acquire-result-shaped object.
function reclaimStaleLease({ root, workflowId, runtimeRevision, staleLease, isStopRequested }) {
  const mutex = reclaimMutexPath({ root, workflowId });
  let holdMutex = false;
  try {
    try {
      mkdirSync(mutex);
      holdMutex = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Another reclaimer holds the mutex. Only consider breaking it if it is
      // old AND we can confirm nothing live is behind it; otherwise fail closed.
      let brokeIt = false;
      try {
        const ageMs = Date.now() - statSync(mutex).mtimeMs;
        const holderPidRaw = existsSync(path.join(mutex, 'pid'))
          ? readFileSync(path.join(mutex, 'pid'), 'utf8').trim()
          : '';
        const holderPid = Number.parseInt(holderPidRaw, 10);
        const holderAlive = Number.isInteger(holderPid) && holderPid > 0
          ? isLeaseOwnerAlive({ pid: holderPid })
          : false;
        if (ageMs > RECLAIM_MUTEX_TTL_MS && !holderAlive) {
          rmSync(mutex, { recursive: true, force: true });
          mkdirSync(mutex);
          holdMutex = true;
          brokeIt = true;
        }
      } catch {
        /* fall through to fail-closed */
      }
      if (!brokeIt) {
        return ownedResult(staleLease, OWNERSHIP_CODES.STALE_OWNER_LOCK);
      }
    }

    try { writeAdvisoryFile(path.join(mutex, 'pid'), String(process.pid)); } catch { /* advisory only */ }

    // Re-read under the mutex: the lease may have changed since our first read.
    const current = readOwnerLease({ root, workflowId });
    if (current && isLeaseOwnerAlive(current)) {
      // Someone (re)acquired a live lease while we waited for the mutex.
      return ownedResult(
        current,
        isStopRequested?.() ? OWNERSHIP_CODES.OWNER_SHUTTING_DOWN : OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED,
      );
    }

    const lockFile = ownerLockPath({ root, workflowId });
    try { rmSync(lockFile, { force: true }); } catch { /* ignore */ }

    const ownerToken = newOwnerToken();
    const lease = buildLease({ workflowId, ownerToken, runtimeRevision });
    try {
      writeLeaseExclusive(lockFile, lease);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        const raced = readOwnerLease({ root, workflowId });
        return ownedResult(raced, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
      }
      throw err;
    }
    return { acquired: true, code: OWNERSHIP_CODES.ACQUIRED, ownerToken, lease, ownerPid: process.pid, acquiredAt: lease.acquiredAt };
  } finally {
    if (holdMutex) {
      try { rmSync(mutex, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// Advisory (non-authoritative) marker file writer for the reclaim mutex.
function writeAdvisoryFile(file, contents) {
  const fd = openSync(file, 'w', 0o600);
  try { writeSync(fd, contents); } finally { closeSync(fd); }
}

/**
 * Atomically acquire the ownership lease for `workflowId`.
 *
 * Exactly one concurrent caller succeeds. Losers get a typed result with
 * `acquired: false` and a `code` of WORKFLOW_ALREADY_OWNED / OWNER_SHUTTING_DOWN
 * / STALE_OWNER_LOCK. The caller MUST NOT proceed to drive the workflow unless
 * `acquired === true`.
 *
 * @returns {{acquired:boolean, code:string, ownerToken:(string|null), lease:object|null, ownerPid:(number|null), acquiredAt:(string|null)}}
 */
export function tryAcquireWorkflowOwnership({
  root = SUPERGPT_WORKTREE_ROOT,
  workflowId,
  runtimeRevision,
  isStopRequested,
} = {}) {
  if (!workflowId) throw new Error('tryAcquireWorkflowOwnership requires a workflowId');
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const rev = runtimeRevision === undefined ? getSuperGptSourceRevision() : runtimeRevision;
  const lockFile = ownerLockPath({ root, workflowId });

  // Fast path: exclusive create.
  const ownerToken = newOwnerToken();
  const lease = buildLease({ workflowId, ownerToken, runtimeRevision: rev });
  try {
    writeLeaseExclusive(lockFile, lease);
    return { acquired: true, code: OWNERSHIP_CODES.ACQUIRED, ownerToken, lease, ownerPid: process.pid, acquiredAt: lease.acquiredAt };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw new WorkflowOwnershipError(
        `failed to acquire ownership lease for "${workflowId}": ${err.message}`,
        'WORKFLOW_OWNERSHIP_ERROR',
      );
    }
  }

  // Contended. Inspect the incumbent.
  const incumbent = readOwnerLease({ root, workflowId });
  if (!incumbent) {
    // File vanished (or is torn) between EEXIST and read — a competing release
    // or a corrupt artifact. One bounded retry of the fast path.
    try {
      const retryToken = newOwnerToken();
      const retryLease = buildLease({ workflowId, ownerToken: retryToken, runtimeRevision: rev });
      writeLeaseExclusive(lockFile, retryLease);
      return { acquired: true, code: OWNERSHIP_CODES.ACQUIRED, ownerToken: retryToken, lease: retryLease, ownerPid: process.pid, acquiredAt: retryLease.acquiredAt };
    } catch (err2) {
      if (err2?.code === 'EEXIST') {
        const raced = readOwnerLease({ root, workflowId });
        if (raced && isLeaseOwnerAlive(raced)) return ownedResult(raced, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
        // still stale — fall through to reclaim with whatever we can read
        return reclaimStaleLease({ root, workflowId, runtimeRevision: rev, staleLease: raced ?? { workflowId }, isStopRequested });
      }
      throw new WorkflowOwnershipError(`ownership retry failed for "${workflowId}": ${err2.message}`, 'WORKFLOW_OWNERSHIP_ERROR');
    }
  }

  if (isLeaseOwnerAlive(incumbent)) {
    // Live owner — includes the PID-reuse case (a recycled PID now belongs to
    // an unrelated live process): we fail closed and never steal.
    const code = typeof isStopRequested === 'function' && safeBool(isStopRequested)
      ? OWNERSHIP_CODES.OWNER_SHUTTING_DOWN
      : OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED;
    return ownedResult(incumbent, code);
  }

  // Recorded owner PID is dead → serialized stale reclamation.
  return reclaimStaleLease({ root, workflowId, runtimeRevision: rev, staleLease: incumbent, isStopRequested });
}

function safeBool(fn) {
  try { return Boolean(fn()); } catch { return false; }
}

/**
 * Release the lease — only if `ownerToken` matches the on-disk lease. A stale
 * holder (whose lease was already reclaimed by a newer owner) is a no-op: it
 * must never delete the newer owner's lease.
 *
 * @returns {{released:boolean, reason?:string}}
 */
export function releaseWorkflowOwnership({ root = SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken } = {}) {
  if (!workflowId) throw new Error('releaseWorkflowOwnership requires a workflowId');
  if (!ownerToken) return { released: false, reason: 'no ownerToken supplied' };
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) return { released: false, reason: 'no lease on disk' };
  if (lease.ownerToken !== ownerToken) {
    return { released: false, reason: 'lease held by a different ownerToken (newer owner) — not releasing' };
  }
  try {
    rmSync(ownerLockPath({ root, workflowId }), { force: true });
  } catch (err) {
    return { released: false, reason: `unlink failed: ${err.message}` };
  }
  return { released: true };
}

// True iff the current process holds the live lease for this workflow. Used by
// the control.json single-writer guard.
export function currentProcessHoldsLease({ root = SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken = null } = {}) {
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) return false;
  if (ownerToken && lease.ownerToken === ownerToken) return true;
  return lease.pid === process.pid;
}

// For the control.json guard: is there a DIFFERENT, live process holding the
// lease right now? If so a local write must fail closed.
export function foreignLiveLeaseHolder({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) return null;
  if (lease.pid === process.pid) return null;
  return isLeaseOwnerAlive(lease) ? lease : null;
}
