// Durable, cross-process workflow control record.
//
// One JSON file per workflow at <root>/<workflowId>.control.json, kept in
// SUPERGPT_WORKTREE_ROOT (never inside a disposable worktree). It carries the
// state that must survive BOTH a process boundary and a resume:
//
//   owner       { pid, startedAt } — the orchestrator process currently
//               driving this workflow. `supergpt stop` from any other
//               process sets stop.requested here; the owner polls this file
//               and aborts itself. A dead/stale owner PID is handled
//               fail-closed by the caller.
//   stop        { requested, reason, requestedAt } — cross-process cancel.
//   checkpoint  the deterministic automated-loop resume point (history,
//               currentTaskCard, attempt, latestReviewResult).
//   phase       'engineering' | 'delivery_ready' — once every task is
//               approved and only delivery remains, resume goes straight to
//               delivery instead of replanning/re-executing accepted tasks.
//   summary     loop summary captured at delivery_ready.
//   resumable   true while the workflow is suspended and its worktree must
//               be protected from age-based GC.

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';

export function controlPath({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  if (!workflowId) throw new Error('controlPath requires a workflowId');
  return path.join(root, `${workflowId}.control.json`);
}

export function readControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const file = controlPath({ root, workflowId });
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Merge-write. Shallow-merges top-level keys so independent writers (owner
// checkpoint vs. a foreign stop request) do not clobber each other.
export function writeControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}, patch = {}) {
  const file = controlPath({ root, workflowId });
  let current = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {
      current = {};
    }
  }
  const next = { ...current, ...patch, workflowId, updatedAt: new Date().toISOString() };
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* best effort — control is an optimisation layer, never the sole source of truth */
  }
  return next;
}

export function claimOwner({ root = SUPERGPT_WORKTREE_ROOT, workflowId, pid = process.pid } = {}) {
  return writeControl({ root, workflowId }, {
    owner: { pid, startedAt: new Date().toISOString() },
    // A fresh claim clears any stop request left over from a prior, dead run
    // so an old flag cannot instantly cancel a legitimate resume.
    stop: { requested: false },
  });
}

export function requestStop({ root = SUPERGPT_WORKTREE_ROOT, workflowId, reason = 'stopped by user' } = {}) {
  return writeControl({ root, workflowId }, {
    stop: { requested: true, reason, requestedAt: new Date().toISOString() },
  });
}

export function isStopRequested({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const control = readControl({ root, workflowId });
  return Boolean(control?.stop?.requested);
}

export function markDeliveryReady({ root = SUPERGPT_WORKTREE_ROOT, workflowId, summary = null } = {}) {
  return writeControl({ root, workflowId }, { phase: 'delivery_ready', summary, resumable: true });
}

export function markResumable({ root = SUPERGPT_WORKTREE_ROOT, workflowId, resumable = true } = {}) {
  return writeControl({ root, workflowId }, { resumable });
}

export function saveCheckpoint({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}, checkpoint) {
  return writeControl({ root, workflowId }, { checkpoint, phase: 'engineering' });
}

export function clearControl({ root = SUPERGPT_WORKTREE_ROOT, workflowId } = {}) {
  const file = controlPath({ root, workflowId });
  try {
    rmSync(file, { force: true });
  } catch {
    /* best effort */
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
