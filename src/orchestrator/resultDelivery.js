// Safe Result Delivery.
//
// When a workflow reaches WORKFLOW_DONE, the approved changes live only in
// SuperGPT's isolated worktree, pinned on top of the invocation workspace
// snapshot baseline. This module carries them back into the exact workspace
// SuperGPT was launched from — WITHOUT a manual copy/merge, without touching
// the user's own in-flight edits, and failing closed the moment the two
// diverge in a way that cannot be reconciled mechanically.
//
// Four primitives (all pure except for git/fs, all injectable for tests):
//
//   calculateApprovedDelta({ worktreePath, baselineHead })
//     Everything the workflow produced on top of the baseline: a single
//     unified patch for tracked changes (committed + uncommitted) plus the
//     list of new untracked files. This is exactly the SuperGPT-authored
//     surface — the snapshot baseline already excludes the user's own
//     pre-existing dirty work.
//
//   checkDeliveryConflicts({ delta, sourceWorkspace })
//     Fail-closed gate. A conflict is any of:
//       - a delta path that also has uncommitted / untracked changes in the
//         invocation workspace (overlapping edit)
//       - a new file the delta creates that already exists on disk there
//         (creation collision)
//       - a patch that will not `git apply --check` cleanly in the
//         invocation workspace
//     Unrelated dirty files in the workspace are NOT conflicts.
//
//   deliverApprovedDelta({ delta, sourceWorkspace })
//     Applies the patch and copies the new files into the invocation
//     workspace as unstaged changes. Never commits — the user reviews and
//     commits. Unrelated dirty changes are left untouched because the patch
//     only touches the delta's own hunks.
//
//   cleanupDeliveredWorktree({ worktreePath, sourceRepoRoot })
//     Removes the now-delivered isolated worktree and prunes its admin
//     entry. Only ever called after a safe, successful delivery.
//
// deliverWorkflowResult() wires the four together with the fail-closed
// policy: conflict -> HUMAN_REQUIRED, worktree preserved; safe -> deliver
// then clean up.

import { spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ResultDeliveryError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'ResultDeliveryError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const RESULT_DELIVERY_ERROR_CODES = Object.freeze({
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  DELIVERY_COMMAND_FAILED: 'DELIVERY_COMMAND_FAILED',
});

function runGit(gitBin, args, cwd, spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errChunks = [];
    child.on('error', (err) => reject(err));
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => errChunks.push(chunk));
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function createResultDelivery({
  gitBin = 'git',
  spawn = nodeSpawn,
  fs = nodeFs,
  now = () => Date.now(),
} = {}) {
  async function git(args, cwd) {
    let result;
    try {
      result = await runGit(gitBin, args, cwd, spawn);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new ResultDeliveryError(
          RESULT_DELIVERY_ERROR_CODES.GIT_UNAVAILABLE,
          `could not run "${gitBin}": ${err.message}`
        );
      }
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.GIT_UNAVAILABLE,
        `could not run "${gitBin} ${args.join(' ')}": ${err.message}`
      );
    }
    return result;
  }

  function must(result, args, cwd) {
    if (result.code !== 0) {
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
        `"git ${args.join(' ')}" failed in "${cwd}": ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
    return result;
  }

  function withPatchFile(patch, fn) {
    const patchFile = path.join(
      os.tmpdir(),
      `supergpt-delivery-${now()}-${Math.random().toString(36).slice(2)}.patch`
    );
    fs.writeFileSync(patchFile, patch);
    return Promise.resolve()
      .then(() => fn(patchFile))
      .finally(() => {
        try {
          fs.rmSync(patchFile, { force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      });
  }

  async function calculateApprovedDelta({ worktreePath, baselineHead } = {}) {
    if (!worktreePath || !baselineHead) {
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
        'calculateApprovedDelta() requires worktreePath and baselineHead'
      );
    }

    // Tracked changes the workflow produced (committed since the baseline
    // AND anything still uncommitted in the worktree), relative to the
    // snapshot baseline.
    const nameArgs = ['diff', '--name-status', '--no-renames', baselineHead, '--', '.'];
    const nameRes = must(await git(nameArgs, worktreePath), nameArgs, worktreePath);
    const trackedChanges = splitLines(nameRes.stdout).map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { status: '?', path: line }
        : { status: line.slice(0, tab).trim(), path: line.slice(tab + 1).trim() };
    });

    const patchArgs = ['diff', '--full-index', '--binary', '--no-renames', baselineHead, '--', '.'];
    const patchRes = must(await git(patchArgs, worktreePath), patchArgs, worktreePath);
    const patch = patchRes.stdout;

    const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
    const untrackedRes = must(await git(untrackedArgs, worktreePath), untrackedArgs, worktreePath);
    const untrackedFiles = splitLines(untrackedRes.stdout);

    const changedPaths = [
      ...new Set([...trackedChanges.map((c) => c.path), ...untrackedFiles]),
    ];

    return {
      worktreePath,
      baselineHead,
      trackedChanges,
      untrackedFiles,
      patch,
      changedPaths,
      isEmpty: patch.trim() === '' && untrackedFiles.length === 0,
    };
  }

  async function checkDeliveryConflicts({ delta, sourceWorkspace } = {}) {
    if (!delta || !sourceWorkspace) {
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
        'checkDeliveryConflicts() requires delta and sourceWorkspace'
      );
    }

    const dirtyArgs = ['diff', '--name-only', 'HEAD'];
    const dirtyRes = must(await git(dirtyArgs, sourceWorkspace), dirtyArgs, sourceWorkspace);
    const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
    const untrackedRes = must(await git(untrackedArgs, sourceWorkspace), untrackedArgs, sourceWorkspace);
    const sourceDirty = new Set([...splitLines(dirtyRes.stdout), ...splitLines(untrackedRes.stdout)]);

    const conflicts = [];
    const seen = new Set();
    const add = (conflictPath, reason, detail) => {
      const key = `${conflictPath}::${reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      conflicts.push(detail ? { path: conflictPath, reason, detail } : { path: conflictPath, reason });
    };

    for (const changedPath of delta.changedPaths) {
      if (sourceDirty.has(changedPath)) add(changedPath, 'overlapping-edit');
    }

    for (const rel of delta.untrackedFiles) {
      if (fs.existsSync(path.join(sourceWorkspace, rel))) add(rel, 'creation-collision');
    }

    if (delta.patch && delta.patch.trim() !== '') {
      const checkRes = await withPatchFile(delta.patch, (patchFile) =>
        git(['apply', '--check', '--whitespace=nowarn', patchFile], sourceWorkspace)
      );
      if (checkRes.code !== 0) {
        add('', 'patch-does-not-apply', checkRes.stderr.trim() || checkRes.stdout.trim());
      }
    }

    return { safe: conflicts.length === 0, conflicts };
  }

  async function deliverApprovedDelta({ delta, sourceWorkspace } = {}) {
    if (!delta || !sourceWorkspace) {
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
        'deliverApprovedDelta() requires delta and sourceWorkspace'
      );
    }

    if (delta.patch && delta.patch.trim() !== '') {
      const applyRes = await withPatchFile(delta.patch, (patchFile) =>
        git(['apply', '--whitespace=nowarn', patchFile], sourceWorkspace)
      );
      if (applyRes.code !== 0) {
        throw new ResultDeliveryError(
          RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
          `could not apply the approved delta into "${sourceWorkspace}": ${applyRes.stderr.trim() || applyRes.stdout.trim()}`,
          { source_workspace: sourceWorkspace }
        );
      }
    }

    for (const rel of delta.untrackedFiles) {
      const src = path.join(delta.worktreePath, rel);
      const dst = path.join(sourceWorkspace, rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (err) {
        throw new ResultDeliveryError(
          RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
          `could not copy delivered file "${rel}" into "${sourceWorkspace}": ${err.message}`,
          { path: rel }
        );
      }
    }

    return { delivered: delta.changedPaths, source_workspace: sourceWorkspace };
  }

  async function cleanupDeliveredWorktree({ worktreePath, sourceRepoRoot } = {}) {
    if (!worktreePath) {
      throw new ResultDeliveryError(
        RESULT_DELIVERY_ERROR_CODES.DELIVERY_COMMAND_FAILED,
        'cleanupDeliveredWorktree() requires worktreePath'
      );
    }
    const cwd = sourceRepoRoot ?? worktreePath;
    const removeArgs = ['worktree', 'remove', '--force', worktreePath];
    must(await git(removeArgs, cwd), removeArgs, cwd);
    const pruneArgs = ['worktree', 'prune'];
    must(await git(pruneArgs, cwd), pruneArgs, cwd);
    return { removed: worktreePath };
  }

  return {
    calculateApprovedDelta,
    checkDeliveryConflicts,
    deliverApprovedDelta,
    cleanupDeliveredWorktree,
  };
}

// End-to-end fail-closed policy for a WORKFLOW_DONE result. Returns a plain
// report object; never throws for a conflict (that is a normal outcome).
// A thrown ResultDeliveryError from git/fs propagates to the caller, which
// treats it the same as a conflict — HUMAN_REQUIRED, worktree preserved.
export async function deliverWorkflowResult({ worktree, delivery = createResultDelivery() } = {}) {
  const delta = await delivery.calculateApprovedDelta({
    worktreePath: worktree.worktree_path,
    baselineHead: worktree.baseline_head,
  });

  const sourceWorkspace = worktree.source_workspace ?? worktree.source_repo_root;
  const conflictReport = await delivery.checkDeliveryConflicts({ delta, sourceWorkspace });
  if (!conflictReport.safe) {
    return {
      status: 'HUMAN_REQUIRED',
      conflicts: conflictReport.conflicts,
      changed_files: delta.changedPaths,
      worktree_preserved: true,
    };
  }

  await delivery.deliverApprovedDelta({ delta, sourceWorkspace });
  await delivery.cleanupDeliveredWorktree({
    worktreePath: worktree.worktree_path,
    sourceRepoRoot: worktree.source_repo_root ?? sourceWorkspace,
  });

  return {
    status: 'DELIVERED',
    changed_files: delta.changedPaths,
    worktree_preserved: false,
  };
}
