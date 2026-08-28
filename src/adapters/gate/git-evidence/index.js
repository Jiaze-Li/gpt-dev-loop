// Git Evidence Collector.
//
// Deterministic evidence collection — gathers the actual code-change
// evidence (repository context, current commit, changed files, diff,
// working-tree status) that docs/workflow/ARCHITECTURE.md §5 and
// STATE_MACHINE.md §1 REVIEWING call "Git evidence", so Reviewer
// providers have real evidence to judge instead of only pass/fail test results.
//
// Signature: collect_evidence(context) -> Evidence

import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { GitEvidenceError, GIT_EVIDENCE_ERROR_CODES } from './errors.js';

// Untracked task-produced files under this many bytes have their full text
// folded into the evidence diff; larger ones (and binary ones) are reported
// as safe metadata only (path + byte size + reason), never contents.
export const DEFAULT_MAX_UNTRACKED_TEXT_BYTES = 131_072;

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
function shapeEvidence({ currentCommit, baseCommit, changedFiles, diff, status, gitStatus, repositoryContext, testResults, untrackedFiles, baseline, trackedChangedFiles }) {
  const untracked = untrackedFiles ?? [];
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  return {
    current_commit: currentCommit,
    base_commit: baseCommit ?? null,
    changed_files: changedFiles,
    git_diff: diff,
    git_status: gitStatus,
    status,
    repository_context: repositoryContext,
    test_results: testResults ?? null,
    untracked_files: untracked,
    baseline: baseline ?? null,

    head: currentCommit,
    base: baseCommit ?? null,
    diff,
    results: testResults?.results ?? [],
    pass: testResults?.pass,

    // Metadata-only diagnostics (never contents). Safe to log.
    diagnostics: {
      tracked_changed_files: (trackedChangedFiles ?? changedFiles).length,
      untracked_task_files: untracked.length,
      untracked_task_files_included: untracked.filter((f) => f.included).length,
      diff_chars: diff.length,
      diff_bytes: diffBytes,
    },
  };
}

// "one\ntwo" -> a unified-diff add hunk for a brand-new file.
function renderNewFileHunk(relPath, text) {
  const lines = text.split('\n');
  // A trailing newline yields a final empty element; git shows it as the
  // usual "\ No newline" only when absent — for evidence purposes a plain
  // per-line "+" rendering is enough and stays deterministic.
  const bodyLines = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const count = bodyLines.length;
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${count} @@`,
    ...bodyLines.map((line) => `+${line}`),
  ].join('\n');
}

function renderOmittedFileNote(relPath, bytes, reason) {
  return [
    `diff --git a/${relPath} b/${relPath}`,
    `new file (${reason}, ${bytes} bytes) — contents omitted from evidence`,
  ].join('\n');
}

// git ls-files --others --exclude-standard -z, then classify each path.
async function collectUntrackedFiles({ git, cwd, repoRoot, readFile, stat, maxBytes }) {
  const listResult = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (listResult.code !== 0) {
    throw new GitEvidenceError(
      GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
      `"git ls-files --others --exclude-standard -z" failed: ${listResult.stderr.trim()}`
    );
  }
  const isAuxiliary = (p) => p.startsWith('.supergpt_auxiliary') || p.startsWith('.supergpt/') || p.startsWith('.supergpt\\') || p === '.supergpt';
  const relPaths = listResult.stdout.split('\0').map((p) => p.trim()).filter(Boolean).filter((p) => !isAuxiliary(p)).sort();
  const files = [];
  for (const relPath of relPaths) {
    const absPath = path.resolve(repoRoot ?? cwd, relPath);
    let size;
    try {
      const info = await stat(absPath);
      size = info.size;
    } catch {
      files.push({ path: relPath, bytes: null, binary: null, included: false, reason: 'unreadable' });
      continue;
    }
    if (size > maxBytes) {
      files.push({ path: relPath, bytes: size, binary: null, included: false, reason: 'oversized' });
      continue;
    }
    let buffer;
    try {
      buffer = await readFile(absPath);
    } catch {
      files.push({ path: relPath, bytes: size, binary: null, included: false, reason: 'unreadable' });
      continue;
    }
    if (buffer.includes(0)) {
      files.push({ path: relPath, bytes: buffer.length, binary: true, included: false, reason: 'binary' });
      continue;
    }
    files.push({ path: relPath, bytes: buffer.length, binary: false, included: true, text: buffer.toString('utf8') });
  }
  return files;
}

export function createGitEvidenceCollector({
  gitBin = 'git',
  spawn = nodeSpawn,
  readFile = nodeReadFile,
  stat = nodeStat,
  maxUntrackedTextBytes = DEFAULT_MAX_UNTRACKED_TEXT_BYTES,
} = {}) {
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
      // A Workflow Baseline (src/orchestrator/workflowBaseline.js) pins the
      // pre-execution snapshot the Reviewer Evidence must be scoped to: the
      // diff is taken against baseline.head (never a bare "git diff HEAD"
      // over an unknown-cleanliness tree), and untracked task-produced files
      // are folded in. `baseCommit` remains the legacy explicit-range knob.
      const baseline = context.baseline ?? null;
      const baseCommit = context.baseCommit ?? (baseline ? baseline.head : null);
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
      // baseline mode: working tree vs baseline.head (captures every tracked
      //   change since the baseline, staged or not).
      // legacy explicit-range mode: base_commit..current_commit.
      // default mode: working tree vs HEAD (unchanged historical behavior).
      let diffArgs;
      if (baseline) {
        diffArgs = ['diff', baseline.head];
      } else if (context.baseCommit) {
        diffArgs = ['diff', `${context.baseCommit}..${currentCommit}`];
      } else {
        diffArgs = ['diff', 'HEAD'];
      }

      const diffResult = await git(diffArgs, cwd);
      if (diffResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
          `"${gitBin} ${diffArgs.join(' ')}" failed: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`
        );
      }
      const trackedDiff = diffResult.stdout;

      const nameOnlyResult = await git([...diffArgs, '--name-only'], cwd);
      if (nameOnlyResult.code !== 0) {
        throw new GitEvidenceError(
          GIT_EVIDENCE_ERROR_CODES.DIFF_COMMAND_FAILED,
          `"${gitBin} ${[...diffArgs, '--name-only'].join(' ')}" failed: ${nameOnlyResult.stderr.trim()}`
        );
      }
      const isAuxiliary = (p) => p.startsWith('.supergpt_auxiliary') || p.startsWith('.supergpt/') || p.startsWith('.supergpt\\') || p === '.supergpt';
      const trackedChangedFiles = parseChangedFiles(nameOnlyResult.stdout).filter((p) => !isAuxiliary(p));

      // Untracked task-produced files are only collected in baseline mode —
      // that is the only mode where "untracked" reliably means "this
      // workflow made it" (a clean/isolated baseline was proven upstream).
      let untrackedFiles = [];
      let untrackedDiff = '';
      if (baseline) {
        untrackedFiles = await collectUntrackedFiles({
          git,
          cwd,
          repoRoot: baseline.repo_root ?? cwd,
          readFile,
          stat,
          maxBytes: maxUntrackedTextBytes,
        });
        untrackedDiff = untrackedFiles
          .map((file) =>
            file.included
              ? renderNewFileHunk(file.path, file.text)
              : renderOmittedFileNote(file.path, file.bytes ?? 0, file.reason ?? 'omitted')
          )
          .join('\n');
      }

      const diff = [trackedDiff.trimEnd(), untrackedDiff.trimEnd()].filter(Boolean).join('\n\n') +
        (trackedDiff || untrackedDiff ? '\n' : '');

      // Phase 6.3.1: an empty diff is a valid evidence state (nothing
      // changed), not an error — reported via `status`, not thrown.
      const diffStatus =
        trackedDiff.trim().length === 0 && untrackedFiles.length === 0
          ? DIFF_STATUS.NO_CHANGES
          : DIFF_STATUS.CHANGED;

      const changedFiles = [...trackedChangedFiles, ...untrackedFiles.map((f) => f.path)];

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
        trackedChangedFiles,
        diff,
        status: diffStatus,
        gitStatus: statusResult.stdout,
        repositoryContext,
        testResults,
        untrackedFiles,
        baseline: baseline
          ? { branch: baseline.branch, head: baseline.head, clean: baseline.clean, isolated_worktree: baseline.isolated_worktree ?? false }
          : null,
      });
    },
  };
}
