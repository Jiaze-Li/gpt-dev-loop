// Whole-process-tree termination for spawned executor / tool CLIs.
//
// POSIX does not cascade a signal from a killed process to its descendants.
// An executor CLI (`claude`, `codex`) that has itself spawned a verification
// or tool subprocess will leave that descendant running if we only signal the
// CLI's own PID — the adapter then observes the CLI close and lets stop /
// resume / retry proceed while an orphan keeps mutating the same worktree.
//
// Spawning the CLI with `detached: true` makes it a process-group leader;
// signalling the NEGATIVE pid then reaches the whole group. This mirrors the
// Gate runner's explicit process-tree shutdown (adapters/gateRunner.js).

// Spread into a child_process spawn options object so the child leads its own
// process group. Callers must NOT `child.unref()` — teardown still awaits the
// direct child's `close`.
export const PROCESS_GROUP_SPAWN_OPTS = Object.freeze({ detached: true });

// Signal the child's whole process group, falling back to the bare child when
// the group signal is unavailable (no pid yet, already reaped, or a test fake
// without a real pid).
export function killProcessTree(child, signal = 'SIGTERM') {
  if (!child) return;
  if (child.killed || (child.exitCode !== null && child.exitCode !== undefined)) return;
  const pid = child.pid;
  if (pid !== null && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* group gone or never a leader — fall through to a direct kill */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

// Escalating teardown: SIGTERM the group now, SIGKILL it after a finite grace
// so descendants get a chance to unwind but a hung tree still dies. Returns an
// unref'd timer the caller MUST clear once the child closes.
export function terminateProcessTree(child, { graceMs = 2000, onKill = null } = {}) {
  killProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    killProcessTree(child, 'SIGKILL');
    if (typeof onKill === 'function') {
      try { onKill(); } catch { /* ignore */ }
    }
  }, graceMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
