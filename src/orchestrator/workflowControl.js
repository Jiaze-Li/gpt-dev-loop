// Durable, cross-process workflow control record.
//
// Split across purpose-scoped files in SUPERGPT_WORKTREE_ROOT (never inside a
// disposable worktree), so writers owned by DIFFERENT OS processes never
// clobber each other's fields:
//
//   <workflowId>.control.json  — written ONLY by the owning orchestrator
//     process. Carries: owner { pid, startedAt }; checkpoint (the
//     deterministic automated-loop resume point); phase
//     ('engineering' | 'delivery_ready'); summary; resumable; baseline_head
//     (the authoritative advanced task-boundary baseline commit); closeout
//     verification evidence. Single-writer: only one orchestrator owns a
//     workflow at a time, so its read-modify-write is race-free.
//
//   <workflowId>.stop.json     — the cross-process cancel record. `supergpt
//     stop` from ANY other process replaces this file; the owner polls it and
//     aborts itself. It is a standalone replace record: checkpoint writes to
//     control.json never touch it, so a stale checkpoint write can never clear
//     a stop request (P1-4). A legitimate new owner clears a stale request
//     only at the claim boundary (claimOwner).
//
// All writes are tmp-write + atomic rename so a reader never sees a torn file.

import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { isValidWorktreeFingerprint } from './hostVerification.js';
import { foreignLiveLeaseHolder } from './workflowOwnership.js';

// §6 CONTROL.JSON SINGLE-WRITER INVARIANT. Only the process holding the
// ownership lease may write owner-owned durable records (checkpoint, advanced
// baseline, closeout proof, delivery state). If a DIFFERENT live process holds
// the lease, an owner-record write from here is a bug — fail closed rather than
// silently clobbering the real owner's concurrent read-modify-write.
// stop.json is an external-control record and is exempt (never routed here).
function assertMayWriteOwnerRecord({ root, workflowId }) {
  const foreign = foreignLiveLeaseHolder({ root, workflowId });
  if (foreign) {
    throw new DurableWriteError(
      `refusing owner-record write to ${workflowId}.control.json: workflow is owned by a different live process (pid ${foreign.pid})`,
    );
  }
}

// Thrown when a correctness-critical durable write cannot be proven to have
// landed on disk. Callers of a verified writer MUST let this propagate — they
// must never continue as though persistence succeeded.
export class DurableWriteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DurableWriteError';
    this.code = 'DURABLE_WRITE_FAILED';
  }
}

export function controlPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  if (!workflowId) throw new Error('controlPath requires a workflowId');
  return path.join(root, `${workflowId}.control.json`);
}

export function stopPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  if (!workflowId) throw new Error('stopPath requires a workflowId');
  return path.join(root, `${workflowId}.stop.json`);
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// tmp-write + atomic rename: readers see either the old file or the whole new
// one, never a partial write. Atomic replacement alone does NOT solve a
// cross-process read-modify-write lost update — the file-per-concern split
// above is what does.
// `verify` may be:
//   - false/null  → best-effort: any failure is swallowed (legacy behaviour
//                   for optimisation-only fields).
//   - true        → fail-closed: on any write/rename/read-back error, or if the
//                   file does not parse, throw DurableWriteError.
//   - function    → fail-closed AND the parsed read-back must satisfy the
//                   predicate, else throw DurableWriteError.
function atomicWrite(root, file, value, { verify = null } = {}) {
  const failClosed = verify === true || typeof verify === 'function';
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, serialized, 'utf8');
    try {
      renameSync(tmp, file);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
    if (failClosed) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`read-back of ${path.basename(file)} did not parse: ${err.message}`);
      }
      const ok = typeof verify === 'function' ? verify(parsed) : parsed !== null;
      if (!ok) throw new Error(`read-back of ${path.basename(file)} failed verification`);
    }
  } catch (err) {
    if (failClosed) {
      throw err instanceof DurableWriteError
        ? err
        : new DurableWriteError(`durable write to ${path.basename(file)} failed: ${err.message}`, { cause: err });
    }
    /* best effort — control is an optimisation layer, never the sole source of truth */
  }
}

// Read the merged control view. `stop` always reflects the standalone stop
// record (falling back to a legacy embedded control.stop for pre-split files).
export function readControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const control = readJson(controlPath({ root, workflowId }));
  const stopRecord = readJson(stopPath({ root, workflowId }));
  if (control === null && stopRecord === null) return null;
  const merged = { ...(control ?? {}) };
  if (stopRecord && typeof stopRecord === 'object') {
    merged.stop = stopRecord;
  } else if (!merged.stop) {
    merged.stop = { requested: false };
  }
  return merged;
}

// Owner-only merge-write of control.json. NEVER touches the stop record.
export function writeControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}, patch = {}, { verify = false, allowNonOwner = false } = {}) {
  if (!allowNonOwner) assertMayWriteOwnerRecord({ root, workflowId });
  const file = controlPath({ root, workflowId });
  const current = readJson(file) ?? {};
  const { stop: _droppedStop, ...patchRest } = patch;
  void _droppedStop;
  // A per-write nonce makes the read-back check able to distinguish THIS
  // write's payload from a competing writer's — a same-millisecond `updatedAt`
  // collision alone would not. If the read-back nonce differs, another writer
  // replaced our file between rename and read: fail closed rather than
  // reporting a success that clobbered (or was clobbered by) their fields.
  const writeNonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const next = { ...current, ...patchRest, workflowId, updatedAt: new Date().toISOString(), controlWriteNonce: writeNonce };
  const patchedKeys = Object.keys(patchRest);
  atomicWrite(root, file, next, {
    verify: verify
      ? (parsed) => parsed !== null
        && parsed.controlWriteNonce === writeNonce
        && patchedKeys.every((k) => JSON.stringify(parsed[k]) === JSON.stringify(next[k]))
      : null,
  });
  return readControl({ root, workflowId });
}

export function claimOwner({ root = SUPERGPT_WORKTREE_ROOT, workflowId, pid = process.pid } = {}) {
  // Ownership bookkeeping, not an owner-record mutation: the atomic lease in
  // workflowOwnership.js is the real single-owner authority. Exempt from the
  // single-writer guard so the lease holder can record owner identity even
  // before its own lease read-back would be observable.
  const result = writeControl({ root, workflowId }, {
    owner: { pid, startedAt: new Date().toISOString() },
  }, { allowNonOwner: true });
  // Lifecycle boundary: a fresh claim intentionally clears a stop request left
  // over from a prior, dead run so an old flag cannot instantly cancel a
  // legitimate resume. Routine checkpoint writes never do this.
  atomicWrite(root, stopPath({ root, workflowId }), {
    requested: false,
    clearedAt: new Date().toISOString(),
    clearedBy: pid,
  });
  return result;
}

export function requestStop({ root = SUPERGPT_WORKTREE_ROOT, workflowId, reason = 'stopped by user' } = {}) {
  // Fail closed: a cross-process stop that is silently lost would let the owner
  // run to completion while the caller believes it was cancelled.
  atomicWrite(root, stopPath({ root, workflowId }), {
    requested: true,
    reason,
    requestedAt: new Date().toISOString(),
  }, { verify: (parsed) => parsed !== null && parsed.requested === true });
  return readControl({ root, workflowId });
}

export function isStopRequested({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const stopRecord = readJson(stopPath({ root, workflowId }));
  if (stopRecord && typeof stopRecord === 'object') return Boolean(stopRecord.requested);
  // Legacy pre-split control file.
  return Boolean(readJson(controlPath({ root, workflowId }))?.stop?.requested);
}

export function markDeliveryReady({ root = SUPERGPT_WORKTREE_ROOT, workflowId, summary = null } = {}) {
  return writeControl({ root, workflowId }, { phase: 'delivery_ready', summary, resumable: true });
}

// P1-1: the authoritative current task-boundary baseline commit. Persisted by
// the owner after every successful advance so a resume scopes the next task's
// Git evidence to just that task, never re-including already-accepted tasks.
export function recordAdvancedBaselineHead({ root = SUPERGPT_WORKTREE_ROOT, workflowId, head } = {}) {
  if (typeof head !== 'string' || head.trim() === '') return readControl({ root, workflowId });
  // Fail closed: if this advanced baseline is lost, a later resume scopes the
  // next task's Git evidence against a stale baseline and re-includes an
  // already-accepted task's delta.
  return writeControl({ root, workflowId }, { baseline_head: head.trim() }, { verify: true });
}

// Durable closeout proof. It intentionally survives a delivery conflict: it
// stays usable only while its command set and worktree fingerprint still
// match at the next delivery attempt.
export function recordCloseoutVerificationEvidence({ root = SUPERGPT_WORKTREE_ROOT, workflowId, evidence } = {}) {
  if (!evidence || evidence.pass !== true || !isValidWorktreeFingerprint(evidence.worktree_fingerprint)) {
    return readControl({ root, workflowId });
  }
  // Fail closed: this is durable closeout proof; a silently-lost write would
  // force an unnecessary re-verification at best and, combined with other
  // failures, an unsound delivery at worst.
  return writeControl({ root, workflowId }, { closeout_verification_evidence: evidence }, { verify: true });
}

// P2-2: delivery apply succeeded and was carried into the invocation
// workspace. Persisted BEFORE worktree cleanup so a cleanup failure can never
// turn an already-applied delivery back into a conflict on resume.
export function recordDeliveryCompleted({ root = SUPERGPT_WORKTREE_ROOT, workflowId, changedFiles = [], cleanup = null } = {}) {
  // Fail closed: this record is written BEFORE worktree cleanup precisely so a
  // cleanup failure cannot turn an applied delivery back into a conflict on
  // resume. If it is silently lost, the caller must NOT proceed to cleanup.
  return writeControl({ root, workflowId }, {
    delivery: {
      status: 'DELIVERED',
      changed_files: Array.isArray(changedFiles) ? changedFiles : [],
      cleanup: cleanup ?? { status: 'PENDING' },
      completedAt: new Date().toISOString(),
    },
  }, { verify: (parsed) => parsed !== null && parsed.delivery?.status === 'DELIVERED' });
}

export function recordDeliveryCleanup({ root = SUPERGPT_WORKTREE_ROOT, workflowId, status, error = null } = {}) {
  const current = readControl({ root, workflowId });
  const delivery = current?.delivery ?? { status: 'DELIVERED', changed_files: [] };
  return writeControl({ root, workflowId }, {
    delivery: { ...delivery, cleanup: { status, error: error ?? null, at: new Date().toISOString() } },
  });
}

export function isDeliveryCompleted(control) {
  return control?.delivery?.status === 'DELIVERED';
}

export function markResumable({ root = SUPERGPT_WORKTREE_ROOT, workflowId, resumable = true } = {}) {
  return writeControl({ root, workflowId }, { resumable });
}

export function saveCheckpoint({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}, checkpoint) {
  // Fail closed: the deterministic automated-loop resume point. A REVIEW_PENDING
  // checkpoint in particular is the only record that lets a resume skip a
  // completed Executor + Gate; a silently-lost write would replan/re-execute an
  // already-accepted task.
  return writeControl({ root, workflowId }, { checkpoint, phase: 'engineering' }, { verify: true });
}

export function clearControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  for (const file of [controlPath({ root, workflowId }), stopPath({ root, workflowId })]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function isOwnerAlive(control) {
  const pid = control?.owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}
