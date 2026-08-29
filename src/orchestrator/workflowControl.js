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
function atomicWrite(root, file, value) {
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch {
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
export function writeControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}, patch = {}) {
  const file = controlPath({ root, workflowId });
  const current = readJson(file) ?? {};
  const { stop: _droppedStop, ...patchRest } = patch;
  void _droppedStop;
  const next = { ...current, ...patchRest, workflowId, updatedAt: new Date().toISOString() };
  atomicWrite(root, file, next);
  return readControl({ root, workflowId });
}

export function claimOwner({ root = SUPERGPT_WORKTREE_ROOT, workflowId, pid = process.pid } = {}) {
  const result = writeControl({ root, workflowId }, {
    owner: { pid, startedAt: new Date().toISOString() },
  });
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
  atomicWrite(root, stopPath({ root, workflowId }), {
    requested: true,
    reason,
    requestedAt: new Date().toISOString(),
  });
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
  return writeControl({ root, workflowId }, { baseline_head: head.trim() });
}

// Durable closeout proof. It intentionally survives a delivery conflict: it
// stays usable only while its command set and worktree fingerprint still
// match at the next delivery attempt.
export function recordCloseoutVerificationEvidence({ root = SUPERGPT_WORKTREE_ROOT, workflowId, evidence } = {}) {
  if (!evidence || evidence.pass !== true || !isValidWorktreeFingerprint(evidence.worktree_fingerprint)) {
    return readControl({ root, workflowId });
  }
  return writeControl({ root, workflowId }, { closeout_verification_evidence: evidence });
}

// P2-2: delivery apply succeeded and was carried into the invocation
// workspace. Persisted BEFORE worktree cleanup so a cleanup failure can never
// turn an already-applied delivery back into a conflict on resume.
export function recordDeliveryCompleted({ root = SUPERGPT_WORKTREE_ROOT, workflowId, changedFiles = [], cleanup = null } = {}) {
  return writeControl({ root, workflowId }, {
    delivery: {
      status: 'DELIVERED',
      changed_files: Array.isArray(changedFiles) ? changedFiles : [],
      cleanup: cleanup ?? { status: 'PENDING' },
      completedAt: new Date().toISOString(),
    },
  });
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
  return writeControl({ root, workflowId }, { checkpoint, phase: 'engineering' });
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
