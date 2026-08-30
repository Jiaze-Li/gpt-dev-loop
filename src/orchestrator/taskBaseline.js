// Task-boundary baseline advance.
//
// After a task is accepted, its changes are committed inside the isolated
// worktree so the NEXT task's git evidence is scoped to just that next task.
// The distinction that matters here:
//
//   - an expected clean-tree no-op (the task produced no file changes) —
//     nothing to commit, the baseline legitimately stays where it is;
//   - a REAL git failure (a rejecting pre-commit hook, missing user.email,
//     a read-only object store, an `add` error) — this must surface as a
//     typed failure, never be swallowed. Swallowing it leaves the baseline
//     pointing at the previous commit, so the next task's evidence silently
//     includes every already-accepted task's changes.

export class TaskBaselineError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TaskBaselineError';
    this.code = 'TASK_BASELINE_COMMIT_FAILED';
    if (details && typeof details === 'object') this.details = details;
  }
}

// exec(args) -> { code, stdout, stderr }  (a thin `git` runner, injected).
// On success with real changes, mutates baseline.head to the new commit and
// returns { advanced: true, head }. On a genuinely clean tree returns
// { advanced: false, reason: 'clean-tree' } and leaves baseline untouched.
export async function advanceTaskBaseline({ repoRoot, taskId, baseline, exec }) {
  if (typeof exec !== 'function') throw new TaskBaselineError('advanceTaskBaseline requires an exec runner', { taskId });

  const status = await exec(['status', '--porcelain']);
  if (status.code !== 0) {
    throw new TaskBaselineError(
      `could not read git status while advancing the baseline for task "${taskId}": ${status.stderr?.trim() || `exit ${status.code}`}`,
      { taskId, repoRoot, step: 'status' },
    );
  }
  if (status.stdout.trim() === '') {
    // Expected: this task changed no files. The baseline stays put on purpose.
    return { advanced: false, reason: 'clean-tree' };
  }

  const add = await exec(['add', '-A']);
  if (add.code !== 0) {
    throw new TaskBaselineError(
      `git add failed while advancing the baseline for task "${taskId}": ${add.stderr?.trim() || `exit ${add.code}`}`,
      { taskId, repoRoot, step: 'add' },
    );
  }

  const commit = await exec(['commit', '-m', `chore(supergpt): complete task ${taskId}`]);
  if (commit.code !== 0) {
    const detail = commit.stderr?.trim() || commit.stdout?.trim() || `exit ${commit.code}`;
    // A porcelain-dirty tree that still refuses to commit is a real failure
    // (hook / config / write error), not a clean-tree no-op.
    throw new TaskBaselineError(
      `git commit failed while advancing the baseline for task "${taskId}": ${detail}`,
      { taskId, repoRoot, step: 'commit', detail },
    );
  }

  const head = await exec(['rev-parse', 'HEAD']);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new TaskBaselineError(
      `could not resolve HEAD after committing task "${taskId}": ${head.stderr?.trim() || `exit ${head.code}`}`,
      { taskId, repoRoot, step: 'rev-parse' },
    );
  }

  const newHead = head.stdout.trim();
  if (baseline) baseline.head = newHead;
  return { advanced: true, head: newHead };
}
