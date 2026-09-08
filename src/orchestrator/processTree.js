// Whole-process-tree termination for spawned executor / tool CLIs.
//
// POSIX does not cascade a signal from a killed process to its descendants.
// An executor CLI (`claude`, `codex`) or Gate shell that has itself spawned a
// verification / tool subprocess will leave that descendant running if we only
// signal the direct child's PID.
//
// Spawning with `detached: true` makes the child a process-group leader on
// POSIX. We snapshot that PGID and keep targeting the NEGATIVE pid even after
// the direct child exits: the leader exiting does NOT imply the rest of the
// group is gone. Teardown is complete only once the owned group no longer
// exists. This is the invariant stop/resume/retry rely on.

const POSIX_PROCESS_GROUPS = process.platform !== 'win32';

// POSIX kill(2) gives pid == -1 special broadcast semantics: it signals every
// process the caller is permitted to signal, rather than process-group 1.
// A fake/injected child with pid=1 must therefore NEVER become a negative
// process-group target. Other positive ids retain ordinary -PGID semantics.
function safeProcessGroupId(value) {
  return Number.isInteger(value) && value > 1 ? value : null;
}

// Spread into child_process.spawn options. Callers must NOT child.unref(): they
// still await the direct child's close event in addition to the group teardown.
export const PROCESS_GROUP_SPAWN_OPTS = Object.freeze({ detached: true });

function groupIdFor(child) {
  if (!POSIX_PROCESS_GROUPS) return null;
  return safeProcessGroupId(child?.pid);
}

function directChildExited(child) {
  return Boolean(
    !child ||
    child.killed ||
    (child.exitCode !== null && child.exitCode !== undefined)
  );
}

// `kill(-pgid, 0)` probes the group without signalling it.
export function processGroupExists(pgid) {
  const safePgid = safeProcessGroupId(pgid);
  if (!POSIX_PROCESS_GROUPS || safePgid === null) return false;
  try {
    process.kill(-safePgid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    // EPERM still proves something with that PGID exists. For any other
    // unexpected error, fail closed and keep treating the group as alive.
    return true;
  }
}

// Signal the owned process group first. Crucially, this does NOT short-circuit
// merely because the direct child has exited: descendants can outlive the
// leader while remaining members of the same process group.
export function killProcessTree(child, signal = 'SIGTERM', { pgid = groupIdFor(child) } = {}) {
  const safePgid = safeProcessGroupId(pgid);
  if (!child && safePgid === null) return;

  if (safePgid !== null) {
    try {
      process.kill(-safePgid, signal);
      return;
    } catch (err) {
      if (err?.code === 'ESRCH') return;
      // If process-group signalling is unavailable, fall back to the direct
      // child only when it is still alive.
    }
  }

  // Invalid/special PGIDs (especially 1) are never converted to negative kill
  // targets. The direct-child fallback is intentionally narrower and cannot
  // acquire POSIX broadcast semantics.
  if (directChildExited(child)) return;
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

// Escalating, awaitable teardown.
//
// Returns { pgid, done, cancel }. `done` resolves only after the POSIX process
// group no longer exists. A direct-child `close` MUST NOT call cancel(): that
// is exactly the race this helper prevents. `cancel()` is only for abandoning a
// teardown before it started to matter (currently unused by production code).
//
// POSIX escalation/poll timers intentionally remain REF'D while `done` is
// pending. A Promise by itself does not keep Node alive; unref'ing these timers
// would let the owner process exit after the leader closes but before surviving
// descendants receive SIGKILL.
//
// On platforms where POSIX process groups are unavailable, we retain the
// previous best-effort direct-child fallback; callers still await child close.
// `hardBoundMs` is the FINAL bound after SIGKILL: in a container whose PID 1
// never reaps orphans, a zombie descendant keeps the process group "alive"
// forever, so `processGroupExists()` would poll true indefinitely and `done`
// would never resolve — an unbounded await that defeats the Gate timeout and
// keeps the review lease held. After SIGKILL we have done everything POSIX
// allows; once this bound elapses we resolve `done` regardless, with
// `confirmed:false`, so the caller stops waiting (the Gate command is already
// FAIL/timedOut — fail-closed).
export function terminateProcessTree(
  child,
  {
    graceMs = 2000, pollMs = 25, hardBoundMs = 10_000, onKill = null,
    probeGroup = processGroupExists,
  } = {}
) {
  const pgid = groupIdFor(child);
  let escalationTimer = null;
  let pollTimer = null;
  let hardBoundTimer = null;
  let settled = false;
  let confirmedGone = false;
  let resolveDone;

  const done = new Promise((resolve) => { resolveDone = resolve; });

  const clearTimers = () => {
    if (escalationTimer) clearTimeout(escalationTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (hardBoundTimer) clearTimeout(hardBoundTimer);
    escalationTimer = null;
    pollTimer = null;
    hardBoundTimer = null;
  };

  const finish = ({ confirmed = true } = {}) => {
    if (settled) return;
    settled = true;
    confirmedGone = confirmed;
    clearTimers();
    resolveDone({ confirmed });
  };

  killProcessTree(child, 'SIGTERM', { pgid });

  // Without a verifiable process group, direct-child close remains the caller's
  // teardown acknowledgement. Still retain a bounded SIGKILL fallback; `done`
  // is immediately resolved because there is no group-existence primitive to
  // await on this platform/test fake.
  if (!pgid) {
    escalationTimer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL', { pgid: null });
      if (typeof onKill === 'function') {
        try { onKill(); } catch { /* ignore */ }
      }
    }, graceMs);
    if (typeof escalationTimer.unref === 'function') escalationTimer.unref();
    resolveDone({ confirmed: false });
    return {
      pgid: null,
      done,
      cancel: () => {
        if (escalationTimer) clearTimeout(escalationTimer);
        escalationTimer = null;
      },
    };
  }

  const pollUntilGone = () => {
    if (settled) return;
    if (!probeGroup(pgid)) {
      finish();
      return;
    }
    pollTimer = setTimeout(pollUntilGone, pollMs);
  };

  escalationTimer = setTimeout(() => {
    // Use the snapshotted PGID directly. The leader may already have exited;
    // child.exitCode / child.killed must not suppress this SIGKILL.
    killProcessTree(child, 'SIGKILL', { pgid });
    if (typeof onKill === 'function') {
      try { onKill(); } catch { /* ignore */ }
    }
    // FINAL bound: SIGKILL has been delivered to the whole group. If a zombie
    // descendant keeps the group nominally alive, stop waiting after this bound
    // rather than polling forever — resolve `done` with confirmed:false.
    hardBoundTimer = setTimeout(() => finish({ confirmed: false }), Math.max(0, hardBoundMs));
    if (typeof hardBoundTimer.unref === 'function') hardBoundTimer.unref();
    pollUntilGone();
  }, graceMs);

  // Resolve early if every member exits cleanly during the TERM grace period.
  pollUntilGone();

  return {
    pgid,
    done,
    cancel: () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveDone({ confirmed: false });
    },
    get confirmed() { return confirmedGone; },
  };
}
