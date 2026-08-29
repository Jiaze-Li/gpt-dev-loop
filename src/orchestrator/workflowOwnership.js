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
// ATOMIC PRIMITIVE — exclusive DIRECTORY creation (fs.mkdirSync). The kernel
// guarantees at most one caller creates the directory; every other concurrent
// caller gets EEXIST. Crucially, *the directory's existence alone is the
// authoritative "OWNED" signal* — it does not depend on any subsequent write.
// The winner then publishes complete lease metadata into
// <workflowId>.owner.lock/lease.json via tmp-write + atomic rename, so a reader
// sees either no lease.json or the whole thing, never a torn file.
//
// A contender that sees the lock directory but a missing / partial / unreadable
// lease.json must NOT treat it as a dead owner and reclaim it — that is the
// window in which the legitimate winner is still publishing its metadata.
// During a bounded grace period it is reported as OWNER_LEASE_INITIALIZING
// (fail closed). Only after the grace period, and only through the serialized
// stale-recovery mutex, may an orphaned lock be reclaimed.
//
// lease.json holds:
//   { workflowId, ownerToken, pid, hostname, acquiredAt, runtimeRevision }
//
// ownerToken is a random 128-bit value, regenerated on every fresh acquisition
// (including stale-owner reclamation). PID alone is never authoritative because
// PIDs are reused; the token lets release() prove it is releasing *its own*
// lease and never a newer owner's.

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
  renameSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { getSuperGptSourceRevision } from './runtimeIdentity.js';

export const OWNERSHIP_CODES = Object.freeze({
  ACQUIRED: 'ACQUIRED',
  WORKFLOW_ALREADY_OWNED: 'WORKFLOW_ALREADY_OWNED',
  OWNER_SHUTTING_DOWN: 'OWNER_SHUTTING_DOWN',
  OWNER_LEASE_INITIALIZING: 'OWNER_LEASE_INITIALIZING',
  STALE_OWNER_LOCK: 'STALE_OWNER_LOCK',
});

// A lock directory with no readable lease.json younger than this is assumed to
// belong to a winner still publishing its metadata — fail closed, never steal.
// Publication is normally sub-millisecond; the window is deliberately generous.
const LEASE_INIT_GRACE_MS = 10_000;

// A reclaim mutex older than this whose holder PID is dead is itself considered
// abandoned and may be broken once (bounded, so a crash mid-reclaim does not
// wedge the workflow forever). A real reclaim is sub-second.
const RECLAIM_MUTEX_TTL_MS = 60_000;

export class WorkflowOwnershipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkflowOwnershipError';
    this.code = code ?? 'WORKFLOW_OWNERSHIP_ERROR';
  }
}

// The authoritative lock — a DIRECTORY. Its existence means OWNED.
export function ownerLockPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  if (!workflowId) throw new Error('ownerLockPath requires a workflowId');
  return path.join(root, `${workflowId}.owner.lock`);
}

function leaseJsonPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  return path.join(ownerLockPath({ root, workflowId }), 'lease.json');
}

function reclaimMutexPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  return path.join(root, `${workflowId}.owner.reclaim`);
}

function newOwnerToken() {
  return randomBytes(16).toString('hex');
}

// Read the published lease metadata. Returns null if the lock directory does
// not exist, or exists but lease.json is absent / partial / malformed / for a
// different workflow. Callers MUST distinguish "no lock dir" (ABSENT) from
// "lock dir but no readable lease" (INITIALIZING / ORPHANED) — see leaseState.
export function readOwnerLease({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const file = leaseJsonPath({ root, workflowId });
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.workflowId === workflowId && parsed.ownerToken) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Classify the on-disk ownership state.
//   { state: 'ABSENT' }
//   { state: 'OWNED', lease }          lease.json is complete and valid
//   { state: 'INITIALIZING', ageMs }   lock dir young, lease.json not yet readable
//   { state: 'ORPHANED', ageMs }       lock dir old, lease.json still not readable
function leaseState({ root, workflowId, now = Date.now() }) {
  const dir = ownerLockPath({ root, workflowId });
  if (!existsSync(dir)) return { state: 'ABSENT' };
  const lease = readOwnerLease({ root, workflowId });
  if (lease) return { state: 'OWNED', lease };
  let ageMs = 0;
  try { ageMs = now - statSync(dir).mtimeMs; } catch { ageMs = LEASE_INIT_GRACE_MS + 1; }
  // A reclaimer holding the serialized mutex is actively rewriting lease.json
  // (its rm + rename bump the dir mtime, so age alone would misread this as a
  // fresh publication). Route contenders to the mutex, not to INITIALIZING.
  if (existsSync(reclaimMutexPath({ root, workflowId }))) return { state: 'ORPHANED', ageMs, reclaiming: true };
  return { state: ageMs < LEASE_INIT_GRACE_MS ? 'INITIALIZING' : 'ORPHANED', ageMs };
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

// Publish COMPLETE lease bytes into an already-owned lock directory: write to a
// temp file, fsync, then atomic-rename to lease.json. A reader sees all-or-none.
function publishLease({ root, workflowId, lease }) {
  const finalPath = leaseJsonPath({ root, workflowId });
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
    try { fsyncSync(fd); } catch { /* fsync best-effort */ }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, finalPath);
}

function ownedResult(lease, code) {
  return {
    acquired: false,
    code,
    ownerToken: null,
    lease: lease ?? null,
    ownerPid: lease?.pid ?? null,
    acquiredAt: lease?.acquiredAt ?? null,
  };
}

function acquiredResult({ ownerToken, lease }) {
  return {
    acquired: true,
    code: OWNERSHIP_CODES.ACQUIRED,
    ownerToken,
    lease,
    ownerPid: process.pid,
    acquiredAt: lease.acquiredAt,
  };
}

// Reclaim an ORPHANED or dead-owner lock. Serialized through an atomic mkdir
// mutex so two simultaneous reclaimers cannot both wipe + republish. Returns an
// acquire-result-shaped object; the loser gets STALE_OWNER_LOCK (fail closed),
// never a wrong "acquired".
function reclaimStaleLease({ root, workflowId, runtimeRevision, staleLease, isStopRequested, _afterClaimHook }) {
  const mutex = reclaimMutexPath({ root, workflowId });
  let holdMutex = false;
  try {
    try {
      mkdirSync(mutex);
      holdMutex = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Another reclaimer holds the mutex. Only consider breaking it if it is
      // old AND its holder PID is dead; otherwise fail closed.
      let broke = false;
      try {
        const ageMs = Date.now() - statSync(mutex).mtimeMs;
        const holderPid = Number.parseInt(safeRead(path.join(mutex, 'pid')), 10);
        const holderAlive = Number.isInteger(holderPid) && holderPid > 0 && isLeaseOwnerAlive({ pid: holderPid });
        if (ageMs > RECLAIM_MUTEX_TTL_MS && !holderAlive) {
          rmSync(mutex, { recursive: true, force: true });
          mkdirSync(mutex);
          holdMutex = true;
          broke = true;
        }
      } catch { /* fall through */ }
      if (!broke) return ownedResult(staleLease, OWNERSHIP_CODES.STALE_OWNER_LOCK);
    }

    try { writeAdvisoryFile(path.join(mutex, 'pid'), String(process.pid)); } catch { /* advisory only */ }

    // Re-classify under the mutex: state may have changed while we waited.
    const st = leaseState({ root, workflowId });
    if (st.state === 'OWNED') {
      if (isLeaseOwnerAlive(st.lease)) {
        return ownedResult(
          st.lease,
          safeBool(isStopRequested) ? OWNERSHIP_CODES.OWNER_SHUTTING_DOWN : OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED,
        );
      }
      // valid lease, dead owner -> reclaim below
    } else if (st.state === 'INITIALIZING') {
      // A brand-new winner appeared and is publishing — do NOT touch it.
      return ownedResult(null, OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING);
    } else if (st.state === 'ABSENT') {
      // Lock vanished entirely — fresh claim.
      try {
        mkdirSync(ownerLockPath({ root, workflowId }));
      } catch (err) {
        if (err?.code === 'EEXIST') return ownedResult(readOwnerLease({ root, workflowId }), OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
        throw err;
      }
      const t = newOwnerToken();
      const lease = buildLease({ workflowId, ownerToken: t, runtimeRevision });
      if (typeof _afterClaimHook === 'function') _afterClaimHook();
      publishLease({ root, workflowId, lease });
      return acquiredResult({ ownerToken: t, lease });
    }

    // Reclaim: replace lease.json in place (we hold the reclaim mutex, so no
    // other reclaimer races us; the lock dir already exists so no fresh
    // fast-path contender can mkdir it).
    const token = newOwnerToken();
    const lease = buildLease({ workflowId, ownerToken: token, runtimeRevision });
    try { rmSync(leaseJsonPath({ root, workflowId }), { force: true }); } catch { /* ignore */ }
    if (typeof _afterClaimHook === 'function') _afterClaimHook();
    publishLease({ root, workflowId, lease });
    return acquiredResult({ ownerToken: token, lease });
  } finally {
    if (holdMutex) {
      try { rmSync(mutex, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function safeRead(file) {
  try { return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''; } catch { return ''; }
}

function safeBool(fn) {
  if (typeof fn !== 'function') return false;
  try { return Boolean(fn()); } catch { return false; }
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
 * / OWNER_LEASE_INITIALIZING / STALE_OWNER_LOCK. The caller MUST NOT proceed to
 * drive the workflow unless `acquired === true`.
 *
 * `_afterClaimHook` (test-only): invoked AFTER the atomic mkdir claim wins but
 * BEFORE lease.json is published — used to widen the publication window in the
 * paused-publication race regression.
 *
 * @returns {{acquired:boolean, code:string, ownerToken:(string|null), lease:object|null, ownerPid:(number|null), acquiredAt:(string|null)}}
 */
export function tryAcquireWorkflowOwnership({
  root = SUPERGPT_WORKTREE_ROOT,
  workflowId,
  runtimeRevision,
  isStopRequested,
  _afterClaimHook,
} = {}) {
  if (!workflowId) throw new Error('tryAcquireWorkflowOwnership requires a workflowId');
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const rev = runtimeRevision === undefined ? getSuperGptSourceRevision() : runtimeRevision;
  const dir = ownerLockPath({ root, workflowId });

  // Fast path: atomic exclusive directory creation IS the claim.
  try {
    mkdirSync(dir);
    const token = newOwnerToken();
    const lease = buildLease({ workflowId, ownerToken: token, runtimeRevision: rev });
    if (typeof _afterClaimHook === 'function') _afterClaimHook();
    publishLease({ root, workflowId, lease });
    return acquiredResult({ ownerToken: token, lease });
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw new WorkflowOwnershipError(
        `failed to acquire ownership lease for "${workflowId}": ${err.message}`,
        'WORKFLOW_OWNERSHIP_ERROR',
      );
    }
  }

  // Contended — the lock directory already exists. Classify it.
  const st = leaseState({ root, workflowId });

  if (st.state === 'OWNED') {
    if (isLeaseOwnerAlive(st.lease)) {
      // Live owner — includes the PID-reuse case (a recycled PID now belongs to
      // an unrelated live process): fail closed, never steal.
      const code = safeBool(isStopRequested)
        ? OWNERSHIP_CODES.OWNER_SHUTTING_DOWN
        : OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED;
      return ownedResult(st.lease, code);
    }
    // Valid lease, dead owner -> serialized stale reclamation.
    return reclaimStaleLease({ root, workflowId, runtimeRevision: rev, staleLease: st.lease, isStopRequested, _afterClaimHook });
  }

  if (st.state === 'INITIALIZING') {
    // A winner claimed the lock and is still publishing lease.json. NEVER
    // delete it. Fail closed; the caller can retry shortly.
    return {
      acquired: false,
      code: OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING,
      ownerToken: null,
      lease: null,
      ownerPid: null,
      acquiredAt: null,
    };
  }

  if (st.state === 'ABSENT') {
    // Lock dir vanished between our failed mkdir and the stat (a concurrent
    // release). One bounded retry of the fast path.
    try {
      mkdirSync(dir);
      const token = newOwnerToken();
      const lease = buildLease({ workflowId, ownerToken: token, runtimeRevision: rev });
      if (typeof _afterClaimHook === 'function') _afterClaimHook();
      publishLease({ root, workflowId, lease });
      return acquiredResult({ ownerToken: token, lease });
    } catch (err) {
      if (err?.code === 'EEXIST') {
        const raced = leaseState({ root, workflowId });
        if (raced.state === 'OWNED' && isLeaseOwnerAlive(raced.lease)) {
          return ownedResult(raced.lease, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
        }
        if (raced.state === 'INITIALIZING') {
          return { acquired: false, code: OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING, ownerToken: null, lease: null, ownerPid: null, acquiredAt: null };
        }
        return reclaimStaleLease({ root, workflowId, runtimeRevision: rev, staleLease: raced.lease ?? null, isStopRequested, _afterClaimHook });
      }
      throw new WorkflowOwnershipError(`ownership retry failed for "${workflowId}": ${err.message}`, 'WORKFLOW_OWNERSHIP_ERROR');
    }
  }

  // ORPHANED — lock dir old, no readable lease.json -> serialized reclamation.
  return reclaimStaleLease({ root, workflowId, runtimeRevision: rev, staleLease: null, isStopRequested, _afterClaimHook });
}

/**
 * Acquire ownership, transparently retrying ONLY the transient
 * OWNER_LEASE_INITIALIZING state (a winner still publishing its lease.json —
 * normally a sub-millisecond window). Every other typed outcome — success,
 * WORKFLOW_ALREADY_OWNED, OWNER_SHUTTING_DOWN, STALE_OWNER_LOCK — returns
 * immediately. Bounded so a genuinely wedged half-published lock still fails
 * closed (after which the ORPHANED grace/stale-recovery path applies).
 */
export function acquireWorkflowOwnership({
  maxInitializingRetries = 20,
  initializingRetryMs = 25,
  ...opts
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const r = tryAcquireWorkflowOwnership(opts);
    if (r.acquired || r.code !== OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING || attempt >= maxInitializingRetries) {
      return r;
    }
    const until = Date.now() + initializingRetryMs;
    while (Date.now() < until) { /* brief spin; publication window is microseconds */ }
  }
}

/**
 * Release the lease — only if `ownerToken` matches the on-disk lease. A stale
 * holder (whose lease was already reclaimed by a newer owner) is a no-op: it
 * must never delete the newer owner's lease.
 *
 * `_rm` (test-only): injectable removal, to exercise the unlink-failure path.
 *
 * @returns {{released:boolean, reason?:string, leaseStillPresent?:boolean}}
 */
export function releaseWorkflowOwnership({ root = SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken, _rm } = {}) {
  if (!workflowId) throw new Error('releaseWorkflowOwnership requires a workflowId');
  if (!ownerToken) return { released: false, reason: 'no ownerToken supplied' };
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) {
    // No published lease. Either already released, or a lock dir still
    // initializing. If the (possibly empty) lock dir is ours to drop we still
    // try, but report honestly.
    if (!existsSync(ownerLockPath({ root, workflowId }))) return { released: true };
    return { released: false, reason: 'lock directory present but no matching lease.json', leaseStillPresent: true };
  }
  if (lease.ownerToken !== ownerToken) {
    return { released: false, reason: 'lease held by a different ownerToken (newer owner) — not releasing', leaseStillPresent: true };
  }
  try {
    const rm = typeof _rm === 'function' ? _rm : rmSync;
    rm(ownerLockPath({ root, workflowId }), { recursive: true, force: true });
  } catch (err) {
    const stillPresent = existsSync(leaseJsonPath({ root, workflowId }));
    return { released: false, reason: `remove failed: ${err.message}`, leaseStillPresent: stillPresent };
  }
  if (existsSync(ownerLockPath({ root, workflowId }))) {
    return { released: false, reason: 'remove reported success but lock directory still present', leaseStillPresent: true };
  }
  return { released: true };
}

// True iff the current process holds the live lease for this workflow.
export function currentProcessHoldsLease({ root = SUPERGPT_WORKTREE_ROOT, workflowId, ownerToken = null } = {}) {
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) return false;
  if (ownerToken && lease.ownerToken === ownerToken) return true;
  return lease.pid === process.pid;
}

// For the control.json single-writer guard: is there a DIFFERENT, live process
// holding the lease right now? If so a local owner-record write must fail closed.
export function foreignLiveLeaseHolder({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const lease = readOwnerLease({ root, workflowId });
  if (!lease) return null;
  if (lease.pid === process.pid) return null;
  return isLeaseOwnerAlive(lease) ? lease : null;
}
