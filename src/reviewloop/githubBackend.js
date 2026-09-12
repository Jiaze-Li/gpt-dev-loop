// ReviewLoop slim PR backend — GitHub via the `gh` CLI.
//
// GitHub is a TARGET adapter, NOT a reviewer. ReviewLoop has one review engine
// (the internal Reviewer pool) that reviews the PR's merge-base->HEAD diff via
// LOCAL git inside an isolated exact-snapshot worktree (see prEvidence.js /
// prWorktree.js). This module only:
//   - resolves the repository identity (for the begin-time cwd<->PR check)
//   - resolves the PR base SHA and the current PR HEAD SHA
//   - optionally publishes a ReviewLoop result summary comment (audit only)
//
// It NEVER edits code, commits, pushes, merges, force-pushes, posts a review
// trigger comment, ingests a third-party review, or serves the PR diff as
// Reviewer evidence — ReviewLoop has one Reviewer engine and it is internal,
// and its evidence is bound to explicit fetched SHAs, never a live API call.
//
// Every method takes an explicit `cwd` (the loop's own repository root) and
// scopes its `gh`/git invocation to it — NEVER to the MCP process's own
// (accidental) working directory.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(nodeExecFile);

// Default `gh`-backed transport. Every method is overridable for tests.
// `repo` is an explicit REVIEWLOOP_GH_REPO override (`-R owner/name`); when
// absent, every call is scoped via `cwd` so `gh` infers the repository from
// that directory's own git remote — never from the MCP process's cwd.
export function createGhTransport({ execFile = execFileP, repo = null } = {}) {
  const gh = async (args, cwd) => {
    const base = repo ? ['-R', repo] : [];
    const { stdout } = await execFile('gh', [...base, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
  return {
    async resolveRepo({ cwd } = {}) {
      const slug = repo ?? (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd)).trim();
      return { nameWithOwner: slug || null };
    },
    async getPrHead({ prNumber, cwd } = {}) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid'], cwd);
      return out.trim() || null;
    },
    async getPrBaseSha({ prNumber, cwd } = {}) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'baseRefOid', '-q', '.baseRefOid'], cwd);
      return out.trim() || null;
    },
    // Audit-only write. One PR issue comment. Never a review, never a merge.
    async postComment({ prNumber, body, cwd } = {}) {
      const out = await gh(['pr', 'comment', String(prNumber), '--body', body], cwd);
      return { id: out.trim() || `comment-${Date.now()}` };
    },
  };
}

export function createGithubReviewBackend({
  github = null,
  env = process.env,
  transport = null,
} = {}) {
  const gh = transport ?? github ?? createGhTransport({ repo: env?.REVIEWLOOP_GH_REPO ?? null });

  return {
    async resolveRepo({ cwd, prNumber } = {}) {
      if (typeof gh.resolveRepo !== 'function') return { nameWithOwner: env?.REVIEWLOOP_GH_REPO ?? null };
      return (await gh.resolveRepo({ cwd, prNumber })) ?? { nameWithOwner: null };
    },
    async getPrHead({ prNumber, cwd } = {}) {
      return gh.getPrHead({ prNumber, cwd });
    },
    async getPrBaseSha({ prNumber, cwd } = {}) {
      if (typeof gh.getPrBaseSha !== 'function') return null;
      return gh.getPrBaseSha({ prNumber, cwd });
    },
    // Optional audit publication. A failure here NEVER changes the review
    // verdict — the caller records the publication failure and moves on.
    async publishResult({ prNumber, body, cwd } = {}) {
      if (typeof gh.postComment !== 'function') {
        return { published: false, reason: 'transport has no postComment' };
      }
      const res = await gh.postComment({ prNumber, body, cwd });
      return { published: true, commentId: res?.id ?? null };
    },
  };
}
