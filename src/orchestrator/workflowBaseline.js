// Workflow Repository Baseline.
//
// Establishes an explicit, verifiable snapshot of the target working tree
// BEFORE any Claude execution or Reviewer review happens, so the Reviewer
// Evidence (src/adapters/gate/git-evidence/index.js) can be scoped to
// exactly what this workflow/task produced instead of whatever unrelated
// changes already happened to be sitting in the working tree.
//
// MVP policy (deliberately strict — correctness over convenience):
//   - the working tree MUST be clean at workflow start, UNLESS the caller
//     asserts it is an orchestrator-created isolated worktree
//     (isolatedWorktree: true). A dirty, non-isolated tree fails closed
//     with REPOSITORY_NOT_CLEAN before Claude ever runs.
//   - no dirty-tree overlay / three-way merge heuristics. A clean isolated
//     worktree is an acceptable requirement for now.
//
// Captures: repo root, branch, HEAD, clean/dirty status. These become the
// baseline the Git Evidence Collector diffs against.
//
// Standalone: not imported by the core Workflow Manager or the adapters —
// a caller (scripts/run-agy-workflow.js) wires it in explicitly.

import { spawn as nodeSpawn } from 'node:child_process';

export class WorkflowBaselineError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'WorkflowBaselineError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

export const WORKFLOW_BASELINE_ERROR_CODES = Object.freeze({
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  NOT_A_REPOSITORY: 'NOT_A_REPOSITORY',
  BASELINE_COMMAND_FAILED: 'BASELINE_COMMAND_FAILED',
  REPOSITORY_NOT_CLEAN: 'REPOSITORY_NOT_CLEAN',
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

export function createWorkflowBaseline({ gitBin = 'git', spawn = nodeSpawn } = {}) {
  async function git(args, cwd) {
    let result;
    try {
      result = await runGit(gitBin, args, cwd, spawn);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.GIT_UNAVAILABLE,
          `could not run "${gitBin}": ${err.message}`
        );
      }
      throw new WorkflowBaselineError(
        WORKFLOW_BASELINE_ERROR_CODES.GIT_UNAVAILABLE,
        `could not run "${gitBin} ${args.join(' ')}": ${err.message}`
      );
    }
    return result;
  }

  return {
    // establish(context) -> {
    //   repo_root, branch, head, clean, isolated_worktree, dirty_paths
    // }
    async establish(context = {}) {
      const cwd = context.cwd ?? process.cwd();
      const isolatedWorktree = context.isolatedWorktree === true;

      const insideCheck = await git(['rev-parse', '--is-inside-work-tree'], cwd);
      if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== 'true') {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.NOT_A_REPOSITORY,
          `"${cwd}" is not inside a Git working tree: ${insideCheck.stderr.trim() || insideCheck.stdout.trim()}`
        );
      }

      const rootResult = await git(['rev-parse', '--show-toplevel'], cwd);
      if (rootResult.code !== 0) {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.BASELINE_COMMAND_FAILED,
          `could not resolve the repository root in "${cwd}": ${rootResult.stderr.trim()}`
        );
      }
      const repoRoot = rootResult.stdout.trim();

      const headResult = await git(['rev-parse', 'HEAD'], cwd);
      if (headResult.code !== 0) {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.NOT_A_REPOSITORY,
          `could not resolve HEAD in "${cwd}": ${headResult.stderr.trim()}`
        );
      }
      const head = headResult.stdout.trim();

      const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      if (branchResult.code !== 0) {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.BASELINE_COMMAND_FAILED,
          `could not resolve the current branch in "${cwd}": ${branchResult.stderr.trim()}`
        );
      }
      const branch = branchResult.stdout.trim();

      const statusResult = await git(['status', '--porcelain=v1'], cwd);
      if (statusResult.code !== 0) {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.BASELINE_COMMAND_FAILED,
          `"git status --porcelain=v1" failed in "${cwd}": ${statusResult.stderr.trim()}`
        );
      }
      const dirtyPaths = statusResult.stdout
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      const clean = dirtyPaths.length === 0;

      if (!clean && !isolatedWorktree) {
        throw new WorkflowBaselineError(
          WORKFLOW_BASELINE_ERROR_CODES.REPOSITORY_NOT_CLEAN,
          `the target working tree in "${cwd}" is dirty (${dirtyPaths.length} path(s) changed) and is not an ` +
            'orchestrator-created isolated worktree. Refusing to run: the Reviewer would otherwise see the ' +
            'entire pre-existing dirty worktree as if this workflow produced it. Run in a clean tree (or a ' +
            'dedicated worktree) instead.',
          { dirty_paths: dirtyPaths.slice(0, 50) }
        );
      }

      return {
        repo_root: repoRoot,
        branch,
        head,
        clean,
        isolated_worktree: isolatedWorktree,
        dirty_paths: clean ? [] : dirtyPaths,
      };
    },
  };
}
