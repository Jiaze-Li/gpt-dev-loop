// Git Evidence Collector.
//
// Deterministic evidence collection — gathers the actual code-change
// evidence (repository context, current commit, changed files, diff,
// working-tree status) that docs/workflow/ARCHITECTURE.md §5 and
// STATE_MACHINE.md §1 REVIEWING call "Git evidence", so the Reviewer
// Adapter (src/orchestrator/adapters/gptReviewerAdapter.js) has real
// evidence to judge instead of only pass/fail test results.
//
// This module is standalone: it does not import, and is not imported by,
// the core Workflow Manager, the Executor Adapter, the Reviewer Adapter, or
// the MCP/browser bridge. A caller wires it in explicitly, then passes its
// output as the `evidence` argument those already accept.
//
// Signature: collect_evidence(context) -> Evidence

import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { GitEvidenceError, GIT_EVIDENCE_ERROR_CODES } from './errors.js';

// Phase 6.3.1: the collector only reports fact — whether an empty diff
// (DIFF_STATUS.NO_CHANGES) is acceptable for a given task is the Reviewer
// Adapter's judgment call against the Task Card's acceptance_criteria, not
// something this collector decides by throwing.
export const DIFF_STATUS = Object.freeze({
  CHANGED: 'CHANGED',
  NO_CHANGES: 'NO_CHANGES',
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

    const stdoutChunks = [];
    const stderrChunks = [];

    child.on('error', (err) => reject(err));
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function isMissingBinaryError(err) {
  return err && err.code === 'ENOENT';
}

// Splits `git diff --name-only` output into a clean list of paths.
function parseChangedFiles(nameOnlyOutput) {
  return nameOnlyOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// "git@github.com:org/repo.git" / "https://github.com/org/repo.git" -> "repo".
function deriveRepositoryName(remoteUrl, cwd) {
  if (!remoteUrl) return path.basename(cwd);
  const cleaned = remoteUrl.replace(/\.git$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

// Shapes Evidence so it is directly usable both under the field names this
// task asks for (current_commit, changed_files, git_diff, git_status,
// test_results, repository_context) and under the field names
// src/orchestrator/adapters/gptReviewerAdapter.js's renderEvidence already
// reads (head, base, diff, results, pass, status) — the Reviewer Adapter is
// not modified to learn a new evidence shape.
function shapeEvidence({ currentCommit, baseCommit, changedFiles, diff, status, gitStatus, repositoryContext, testResults }) {
  return {
    current_commit: currentCommit,
    base_commit: baseCommit ?? null,
    changed_files: changedFiles,
    git_diff: diff,
    git_status: gitStatus,
    status,
    repository_context: repositoryContext,
    test_results: testResults ?? null,

    head: currentCommit,
    base: baseCommit ?? null,
    diff,
    results: testResults?.results ?? [],
    pass: testResults?.pass,
  };
}

export function createGitEvidenceCollector({ gitBin = 'git', spawn = nodeSpawn } = {}) {
  async function git(args, cwd) {
    let result;
    try {
      result = await runGit(gitBin, args, cwd, spawn);
    } catch (err) {
      if (isMissingBinaryError(err)) {
        throw new GitEvidenceError(GIT_EVIDENCE_ERROR_CODES.GIT_UNAVAILABLE, `could not run "${gitBin}": ${err.message}`);
      }
      throw new GitEvidenceError(GIT_EVIDENCE_ERROR_CODES.GIT_UNAVAILABLE, `could not run "${gitBin} ${args.join(' ')}": ${err.message}`);
    }
    return result;
  }

  // Caller-supplied repository_context (context.repositoryContext) wins
  // outright — otherwise this fills it in from git itself. remote url
  // absence is normal (a repo with no configured remote) and not an error;
  // branch resolution failing after HEAD already resolved would be
  // unexpected, so it is reported like any other failed git command.
  async function resolveRepositoryContext(override, cwd, currentCommit) {
    if (override) {
      return {
        repository_name: override.repository_name ?? null,
        repository_url: override.repository_url ?? null,
        branch: override.branch ?? null,
        commit_sha: override.commit_sha ?? currentCommit,
      };
    }

    const branchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (branchResult.code !== 0) {
      throw new GitEvidenceError(
        GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
        `could not resolve the current branch in "${cwd}": ${branchResult.stderr.trim() || branchResult.stdout.trim()}`
      );
    }
    const branch = branchResult.stdout.trim();

    const remoteResult = await git(['remote', 'get-url', 'origin'], cwd);
    const repositoryUrl = remoteResult.code === 0 ? remoteResult.stdout.trim() : null;

    return {
      repository_name: deriveRepositoryName(repositoryUrl, cwd),
      repository_url: repositoryUrl,
      branch,
      commit_sha: currentCommit,
    };
  }

  return {
    async collect_evidence(context = {}) {
      const cwd = context.cwd ?? process.cwd();
      const baseCommit = context.baseCommit ?? null;
      const testResults = context.testResults ?? null;

      const repoCheck = await git(['rev-parse', '--is-inside-work-tree'], cwd);
      if (repoCheck.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.NOT_A_REPOSITORY,
          `"${cwd}" is not inside a Git repository: ${repoCheck.stderr.trim() || repoCheck.stdout.trim()}`
        );
      }

      const headResult = await git(['rev-parse', 'HEAD'], cwd);
      if (headResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.NOT_A_REPOSITORY,
          `could not resolve HEAD in "${cwd}": ${headResult.stderr.trim() || headResult.stdout.trim()}`
        );
      }
      const currentCommit = headResult.stdout.trim();

      const repositoryContext = await resolveRepositoryContext(context.repositoryContext, cwd, currentCommit);

      // docs/workflow/ADAPTER_INTERFACE.md §3's Gate Runner precedent: this
      // makes no judgment call, it just picks the deterministic diff range —
      // an explicit base_commit..current_commit range when one is given,
      // otherwise the working tree against HEAD.
      const diffArgs = baseCommit ? ['diff', `${baseCommit}..${currentCommit}`] : ['diff', 'HEAD'];

      const diffResult = await git(diffArgs, cwd);
      if (diffResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
          `"${gitBin} ${diffArgs.join(' ')}" failed: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`
        );
      }
      const diff = diffResult.stdout;
      // Phase 6.3.1: an empty diff is a valid evidence state (nothing
      // changed), not an error — reported via `status`, not thrown.
      const diffStatus = diff.trim().length === 0 ? DIFF_STATUS.NO_CHANGES : DIFF_STATUS.CHANGED;

      const nameOnlyResult = await git([...diffArgs, '--name-only'], cwd);
      if (nameOnlyResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
          `"${gitBin} ${[...diffArgs, '--name-only'].join(' ')}" failed: ${nameOnlyResult.stderr.trim()}`
        );
      }
      const changedFiles = parseChangedFiles(nameOnlyResult.stdout);

      const statusResult = await git(['status', '--porcelain=v1'], cwd);
      if (statusResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
          `"${gitBin} status --porcelain=v1" failed: ${statusResult.stderr.trim()}`
        );
      }

      return shapeEvidence({
        currentCommit,
        baseCommit,
        changedFiles,
        diff,
        status: diffStatus,
        gitStatus: statusResult.stdout,
        repositoryContext,
        testResults,
      });
    },
  };
}
