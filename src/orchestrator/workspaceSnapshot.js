// Invocation Workspace Snapshot.
//
// SuperGPT must treat the EXACT workspace it was invoked in as authoritative
// user project state — not just its committed HEAD. A developer who runs
// SuperGPT with staged edits, unstaged edits, and brand-new untracked files
// expects the workflow to build on top of that work, and expects the
// Reviewer Evidence to contain ONLY what SuperGPT itself produced.
//
// This module captures the invocation workspace's dirty state (tracked
// modifications via `git diff HEAD`, plus untracked-but-not-ignored files)
// and re-applies it inside the isolated worktree as a single "workspace
// snapshot" commit on top of the baseline HEAD. After that commit:
//   - the isolated worktree is clean and pinned to the snapshot commit
//   - the snapshot commit — NOT the original HEAD — is the baseline the Git
//     Evidence Collector diffs against, so pre-existing user changes never
//     show up as SuperGPT's work
//
// Conservative guards (fail closed, before any commit):
//   - any single changed file larger than `maxFileBytes` aborts with
//     WorkspaceSnapshotError(EXCESSIVE_FILE_SIZE)
//   - the aggregate changed-file payload larger than `maxTotalBytes` aborts
//     with WorkspaceSnapshotError(EXCESSIVE_SNAPSHOT_SIZE)
//   - a patch that will not apply cleanly in the isolated worktree aborts
//     with WorkspaceSnapshotError(SNAPSHOT_APPLY_FAILED)
// A guard failure here is a PRE-EXECUTION setup failure: the caller tears the
// half-built worktree down, nothing is lost.
//
// Standalone: wired in explicitly by workflowWorktree.establish().

import { spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 5 MiB per file / 50 MiB total: generous for source trees, tight enough to
// refuse an accidental build artifact, media dump, or vendored blob.
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class WorkspaceSnapshotError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'WorkspaceSnapshotError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const WORKSPACE_SNAPSHOT_ERROR_CODES = Object.freeze({
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  SNAPSHOT_COMMAND_FAILED: 'SNAPSHOT_COMMAND_FAILED',
  EXCESSIVE_FILE_SIZE: 'EXCESSIVE_FILE_SIZE',
  EXCESSIVE_SNAPSHOT_SIZE: 'EXCESSIVE_SNAPSHOT_SIZE',
  SNAPSHOT_APPLY_FAILED: 'SNAPSHOT_APPLY_FAILED',
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

export function createWorkspaceSnapshot({
  gitBin = 'git',
  spawn = nodeSpawn,
  fs = nodeFs,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  now = () => Date.now(),
} = {}) {
  async function git(args, cwd) {
    let result;
    try {
      result = await runGit(gitBin, args, cwd, spawn);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new WorkspaceSnapshotError(
          WORKSPACE_SNAPSHOT_ERROR_CODES.GIT_UNAVAILABLE,
          `could not run "${gitBin}": ${err.message}`
        );
      }
      throw new WorkspaceSnapshotError(
        WORKSPACE_SNAPSHOT_ERROR_CODES.GIT_UNAVAILABLE,
        `could not run "${gitBin} ${args.join(' ')}": ${err.message}`
      );
    }
    return result;
  }

  function must(result, args, cwd) {
    if (result.code !== 0) {
      throw new WorkspaceSnapshotError(
        WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_COMMAND_FAILED,
        `"git ${args.join(' ')}" failed in "${cwd}": ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
    return result;
  }

  function fileSize(absPath) {
    try {
      const stat = fs.statSync(absPath);
      return stat.isFile() ? stat.size : 0;
    } catch {
      // Deleted tracked files (present in the diff, gone from disk) contribute
      // nothing to the payload budget.
      return null;
    }
  }

  function guardSizes(sourceCwd, relPaths) {
    let total = 0;
    for (const rel of relPaths) {
      const size = fileSize(path.join(sourceCwd, rel));
      if (size === null) continue;
      if (size > maxFileBytes) {
        throw new WorkspaceSnapshotError(
          WORKSPACE_SNAPSHOT_ERROR_CODES.EXCESSIVE_FILE_SIZE,
          `refusing to snapshot the invocation workspace: "${rel}" is ${size} bytes, ` +
            `over the ${maxFileBytes}-byte per-file limit`,
          { path: rel, size, max_file_bytes: maxFileBytes }
        );
      }
      total += size;
    }
    if (total > maxTotalBytes) {
      throw new WorkspaceSnapshotError(
        WORKSPACE_SNAPSHOT_ERROR_CODES.EXCESSIVE_SNAPSHOT_SIZE,
        `refusing to snapshot the invocation workspace: the changed-file payload is ${total} bytes, ` +
          `over the ${maxTotalBytes}-byte total limit`,
        { total_bytes: total, max_total_bytes: maxTotalBytes }
      );
    }
    return total;
  }

  return {
    // captureAndApply({ sourceCwd, worktreePath, baselineHead }) ->
    //   null                                  (workspace was pristine)
    //   { snapshot_commit, tracked, untracked, total_bytes }
    async captureAndApply({ sourceCwd, worktreePath, baselineHead } = {}) {
      if (!sourceCwd || !worktreePath) {
        throw new WorkspaceSnapshotError(
          WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_COMMAND_FAILED,
          'captureAndApply() requires sourceCwd and worktreePath'
        );
      }

      // Tracked modifications (staged + unstaged), relative to HEAD.
      const trackedRes = must(
        await git(['diff', '--name-only', 'HEAD'], sourceCwd),
        ['diff', '--name-only', 'HEAD'],
        sourceCwd
      );
      const tracked = splitLines(trackedRes.stdout);

      // Untracked files that are not gitignored.
      const untrackedRes = must(
        await git(['ls-files', '--others', '--exclude-standard'], sourceCwd),
        ['ls-files', '--others', '--exclude-standard'],
        sourceCwd
      );
      const untracked = splitLines(untrackedRes.stdout);

      if (tracked.length === 0 && untracked.length === 0) {
        return null;
      }

      const totalBytes = guardSizes(sourceCwd, [...tracked, ...untracked]);

      // Re-apply tracked changes as a patch against the baseline checkout.
      if (tracked.length > 0) {
        const patchArgs = ['diff', '--full-index', '--binary', 'HEAD'];
        const patchRes = must(await git(patchArgs, sourceCwd), patchArgs, sourceCwd);
        if (patchRes.stdout.trim() !== '') {
          const patchFile = path.join(
            os.tmpdir(),
            `supergpt-snapshot-${now()}-${Math.random().toString(36).slice(2)}.patch`
          );
          fs.writeFileSync(patchFile, patchRes.stdout);
          try {
            const applyArgs = ['apply', '--whitespace=nowarn', '--3way', patchFile];
            const applyRes = await git(applyArgs, worktreePath);
            if (applyRes.code !== 0) {
              throw new WorkspaceSnapshotError(
                WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_APPLY_FAILED,
                `could not re-apply the invocation workspace's tracked changes inside the isolated ` +
                  `worktree "${worktreePath}": ${applyRes.stderr.trim() || applyRes.stdout.trim()}`,
                { worktree_path: worktreePath }
              );
            }
          } finally {
            try {
              fs.rmSync(patchFile, { force: true });
            } catch {
              /* best-effort temp cleanup */
            }
          }
        }
      }

      // Copy untracked files verbatim into the worktree.
      for (const rel of untracked) {
        const src = path.join(sourceCwd, rel);
        const dst = path.join(worktreePath, rel);
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        } catch (err) {
          throw new WorkspaceSnapshotError(
            WORKSPACE_SNAPSHOT_ERROR_CODES.SNAPSHOT_APPLY_FAILED,
            `could not copy untracked file "${rel}" into the isolated worktree: ${err.message}`,
            { path: rel }
          );
        }
      }

      must(await git(['add', '-A'], worktreePath), ['add', '-A'], worktreePath);

      const statusRes = must(
        await git(['status', '--porcelain=v1'], worktreePath),
        ['status', '--porcelain=v1'],
        worktreePath
      );
      if (statusRes.stdout.trim() === '') {
        // The invocation workspace's "changes" were already present at the
        // baseline (e.g. identical content) — nothing to snapshot.
        return null;
      }

      const commitArgs = [
        '-c',
        'user.name=SuperGPT',
        '-c',
        'user.email=supergpt@localhost',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        `chore(supergpt): invocation workspace snapshot\n\n` +
          `Captured from ${sourceCwd} on top of ${baselineHead ?? 'HEAD'}.\n` +
          `Tracked files: ${tracked.length}; untracked files: ${untracked.length}.`,
      ];
      must(await git(commitArgs, worktreePath), commitArgs, worktreePath);

      const headRes = must(
        await git(['rev-parse', 'HEAD'], worktreePath),
        ['rev-parse', 'HEAD'],
        worktreePath
      );

      return {
        snapshot_commit: headRes.stdout.trim(),
        tracked: tracked.length,
        untracked: untracked.length,
        total_bytes: totalBytes,
      };
    },
  };
}
