// Automatic SuperGPT Workflow Worktree.
//
// SuperGPT owns repository isolation. Every workflow runs inside a
// dedicated, SuperGPT-managed git worktree that this module creates from
// the source repository's current HEAD — the user never has to know about,
// create, select, or approve it, and there is no opt-in flag.
//
// Invocation workspace vs. repository identity (these are separate):
//   - sourceWorkspace: the EXACT git worktree SuperGPT was invoked in
//     (`git rev-parse --show-toplevel` from sourceCwd). This is the
//     workflow's real target workspace and is never rewritten to the
//     repository's primary checkout. SuperGPT may be launched from the
//     primary checkout or from any linked worktree — both are valid.
//   - repositoryIdentity: the canonical, realpath-resolved shared git
//     common directory (`git rev-parse --git-common-dir`). Every linked
//     worktree of one repository resolves to the same value; that — NOT
//     "is this the primary checkout" — is what repo membership means.
//
// The isolated worktree passes the repo_membership invariant iff its own
// canonical git-common-dir equals the invocation workspace's. The baseline
// commit is always the invocation workspace's HEAD, never main or another
// worktree's HEAD.
//
// Why a worktree (not "run in a clean tree" / not a dirty-tree overlay):
//   - the user's own working tree may be dirty; that must NOT block a
//     workflow and must NOT leak into the Reviewer Evidence.
//   - Claude / Gates / Reviewer must never run inside the user's dirty
//     working tree — they run only inside the isolated worktree.
//   - a worktree shares the object store with the source repo (cheap) while
//     giving a fully separate, clean checkout pinned to the baseline commit.
//
// establish() fails closed BEFORE Claude ever starts if any invariant is
// false: the new checkout must belong to the intended repository, its HEAD
// must equal the captured baseline, and its working tree must be clean.
//
// Lifecycle (deliberately conservative, deterministic, documented):
//   - This module NEVER automatically deletes a worktree. Not on
//     WORKFLOW_DONE (its results have not been surfaced/applied yet — there
//     is no automatic merge/cherry-pick back into the user's branch), not
//     on HUMAN_REQUIRED, not on failure (both need the tree for
//     resume/debug). The worktree path is always reported so a human can
//     inspect or apply it.
//   - remove() is an explicit primitive for a future reaper/GC only; no
//     automatic code path calls it.
//
// Standalone: not imported by the core Workflow Manager or the adapters —
// scripts/run-agy-workflow.js wires it in explicitly.

import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default SuperGPT-managed location — outside any user working tree.
export const SUPERGPT_WORKTREE_ROOT = path.join(os.homedir(), '.supergpt', 'worktrees');

export class WorkflowWorktreeError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'WorkflowWorktreeError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const WORKFLOW_WORKTREE_ERROR_CODES = Object.freeze({
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  NOT_A_REPOSITORY: 'NOT_A_REPOSITORY',
  WORKTREE_COMMAND_FAILED: 'WORKTREE_COMMAND_FAILED',
  WORKTREE_INVARIANT_VIOLATION: 'WORKTREE_INVARIANT_VIOLATION',
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

// Canonicalize for comparison; falls back to path.resolve when the path
// does not exist on disk yet (unit tests use synthetic paths).
function normalizePath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function createWorkflowWorktree({
  gitBin = 'git',
  spawn = nodeSpawn,
  worktreeRoot = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  async function git(args, cwd) {
    let result;
    try {
      result = await runGit(gitBin, args, cwd, spawn);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.GIT_UNAVAILABLE,
          `could not run "${gitBin}": ${err.message}`
        );
      }
      throw new WorkflowWorktreeError(
        WORKFLOW_WORKTREE_ERROR_CODES.GIT_UNAVAILABLE,
        `could not run "${gitBin} ${args.join(' ')}": ${err.message}`
      );
    }
    return result;
  }

  function invariant(check, message, details) {
    throw new WorkflowWorktreeError(
      WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION,
      message,
      { check, ...(details ?? {}) }
    );
  }

  // Best-effort teardown of a worktree this module just created, used only
  // when a pre-execution invariant fails (no workflow result exists yet, so
  // nothing is lost). Never throws — cleanup failures must not mask the
  // original invariant violation.
  async function safeRemoveWorktree(worktreePath, cwd) {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], cwd);
    } catch {
      /* ignore — reported violation takes precedence */
    }
    try {
      await git(['worktree', 'prune'], cwd);
    } catch {
      /* ignore */
    }
  }

  return {
    // establish({ sourceCwd, workflowId }) ->
    //   { workflow_id, source_repo_root, source_branch, baseline_head,
    //     worktree_path }
    async establish({ sourceCwd = process.cwd(), workflowId } = {}) {
      if (typeof workflowId !== 'string' || workflowId.trim() === '') {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED,
          'establish() requires a non-empty workflowId'
        );
      }

      const insideCheck = await git(['rev-parse', '--is-inside-work-tree'], sourceCwd);
      if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== 'true') {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.NOT_A_REPOSITORY,
          `"${sourceCwd}" is not inside a Git working tree: ${insideCheck.stderr.trim() || insideCheck.stdout.trim()}`
        );
      }

      const rootResult = await git(['rev-parse', '--show-toplevel'], sourceCwd);
      if (rootResult.code !== 0) {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED,
          `could not resolve the source repository root in "${sourceCwd}": ${rootResult.stderr.trim()}`
        );
      }
      const sourceRepoRoot = rootResult.stdout.trim();

      // Repository identity of the invocation workspace: the canonical
      // shared git common dir. For the primary checkout this is
      // "<root>/.git"; for a linked worktree it points at the primary
      // checkout's ".git" — the same value every worktree of the repo
      // shares. This, not "is primary checkout", is repo membership.
      const srcCommonResult = await git(['rev-parse', '--git-common-dir'], sourceCwd);
      if (srcCommonResult.code !== 0) {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED,
          `could not resolve the source repository identity in "${sourceCwd}": ${srcCommonResult.stderr.trim()}`
        );
      }
      const repositoryIdentity = normalizePath(
        path.isAbsolute(srcCommonResult.stdout.trim())
          ? srcCommonResult.stdout.trim()
          : path.resolve(sourceCwd, srcCommonResult.stdout.trim())
      );

      const headResult = await git(['rev-parse', 'HEAD'], sourceCwd);
      if (headResult.code !== 0) {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.NOT_A_REPOSITORY,
          `could not resolve HEAD in "${sourceCwd}": ${headResult.stderr.trim()}`
        );
      }
      const baselineHead = headResult.stdout.trim();

      const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], sourceCwd);
      const sourceBranch = branchResult.code === 0 ? branchResult.stdout.trim() : 'HEAD';

      const worktreePath = path.join(worktreeRoot, `${path.basename(sourceRepoRoot)}-${workflowId}`);

      // Detached checkout pinned exactly at the baseline commit — no branch
      // name to collide with the user's branches, nothing to accidentally
      // push.
      const addResult = await git(
        ['worktree', 'add', '--detach', worktreePath, baselineHead],
        sourceRepoRoot
      );
      if (addResult.code !== 0) {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED,
          `"git worktree add --detach ${worktreePath} ${baselineHead}" failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`,
          { worktree_path: worktreePath }
        );
      }

      // Link dependency tree into isolated worktree if present in source workspace
      try {
        const srcNm = path.join(sourceRepoRoot, 'node_modules');
        const dstNm = path.join(worktreePath, 'node_modules');
        if (existsSync(srcNm) && !existsSync(dstNm)) {
          symlinkSync(srcNm, dstNm);
        }
      } catch {
        /* best-effort for synthetic or restricted test environments */
      }

      // --- mechanical invariant verification (fail closed) ---------------
      //
      // The worktree now exists on disk. Any invariant failure below is a
      // PRE-EXECUTION setup failure (no Supervisor / Claude / task work has
      // run, no workflow result exists), so the partially-created worktree
      // is torn down before the error propagates — no garbage is left
      // behind. Runtime failures after execution begins are handled by the
      // caller and DO preserve the worktree for resume/debug.
      try {
        const wtRootResult = await git(['rev-parse', '--show-toplevel'], worktreePath);
        if (wtRootResult.code !== 0) {
          invariant('worktree_toplevel', `the new worktree at "${worktreePath}" is not a usable Git working tree: ${wtRootResult.stderr.trim()}`, { worktree_path: worktreePath });
        }
        if (normalizePath(wtRootResult.stdout.trim()) !== normalizePath(worktreePath)) {
          invariant(
            'worktree_toplevel',
            `the new worktree's toplevel "${wtRootResult.stdout.trim()}" is not the expected path "${worktreePath}"`,
            { worktree_path: worktreePath }
          );
        }

        const commonDirResult = await git(['rev-parse', '--git-common-dir'], worktreePath);
        if (commonDirResult.code !== 0) {
          invariant('repo_membership', `could not resolve the worktree's shared git dir: ${commonDirResult.stderr.trim()}`, { worktree_path: worktreePath });
        }
        const isolatedIdentity = normalizePath(
          path.isAbsolute(commonDirResult.stdout.trim())
            ? commonDirResult.stdout.trim()
            : path.resolve(worktreePath, commonDirResult.stdout.trim())
        );
        // Membership rule: the isolated worktree and the invocation
        // workspace must resolve to the SAME repository identity. Neither
        // is required to be the primary checkout.
        if (isolatedIdentity !== repositoryIdentity) {
          invariant(
            'repo_membership',
            `the isolated worktree's repository identity "${isolatedIdentity}" does not match the invocation workspace's "${repositoryIdentity}"`,
            { worktree_path: worktreePath, repository_identity: repositoryIdentity, isolated_identity: isolatedIdentity }
          );
        }

        const wtHeadResult = await git(['rev-parse', 'HEAD'], worktreePath);
        if (wtHeadResult.code !== 0 || wtHeadResult.stdout.trim() !== baselineHead) {
          invariant(
            'baseline_head',
            `the new worktree's HEAD "${wtHeadResult.stdout.trim()}" does not equal the captured workflow baseline "${baselineHead}"`,
            { worktree_path: worktreePath }
          );
        }

        const wtStatusResult = await git(['status', '--porcelain=v1'], worktreePath);
        if (wtStatusResult.code !== 0) {
          invariant('clean_tree', `could not check the new worktree's status: ${wtStatusResult.stderr.trim()}`, { worktree_path: worktreePath });
        }
        if (wtStatusResult.stdout.trim() !== '') {
          invariant(
            'clean_tree',
            `the new worktree at "${worktreePath}" is not clean immediately after creation`,
            { worktree_path: worktreePath, dirty_paths: wtStatusResult.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 50) }
          );
        }
      } catch (err) {
        await safeRemoveWorktree(worktreePath, sourceRepoRoot);
        throw err;
      }

      return {
        workflow_id: workflowId,
        // The invocation workspace — the exact worktree SuperGPT was
        // launched from. NEVER rewritten to the primary checkout.
        source_workspace: sourceRepoRoot,
        source_repo_root: sourceRepoRoot,
        // Canonical shared git common dir — the repository identity every
        // linked worktree of this repo shares.
        repository_identity: repositoryIdentity,
        source_branch: sourceBranch,
        source_head: baselineHead,
        baseline_head: baselineHead,
        worktree_path: worktreePath,
      };
    },

    // Explicit teardown primitive — NOT wired into any automatic path (see
    // the module header's lifecycle note). Provided for a future GC.
    async remove(worktreePath, { force = false, sourceRepoRoot } = {}) {
      const cwd = sourceRepoRoot ?? worktreePath;
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
      const result = await git(args, cwd);
      if (result.code !== 0) {
        throw new WorkflowWorktreeError(
          WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_COMMAND_FAILED,
          `"git ${args.join(' ')}" failed: ${result.stderr.trim() || result.stdout.trim()}`
        );
      }
    },
  };
}
