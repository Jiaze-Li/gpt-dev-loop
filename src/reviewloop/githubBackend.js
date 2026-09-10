// ReviewLoop slim PR backend — GitHub via the `gh` CLI.
//
// GitHub is a TARGET adapter, NOT a reviewer. ReviewLoop has one review engine
// (the internal Reviewer pool); this module only:
//   - resolves the repository identity
//   - resolves the PR base SHA and the current PR HEAD SHA
//   - fetches the PR base->head diff + changed-file list (Reviewer evidence)
//   - re-reads the live PR HEAD for the pre-PASS exact-HEAD recheck
//   - optionally publishes a ReviewLoop result summary comment (audit only)
//
// It NEVER edits code, commits, pushes, merges, force-pushes, posts a review
// trigger comment, or ingests a third-party review — ReviewLoop has one
// Reviewer engine and it is internal.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(nodeExecFile);

// `gh api --paginate` concatenates every page's JSON body back-to-back, which
// `JSON.parse` cannot read as one value. Scan for each top-level JSON value and
// flatten one level. Kept here because the PR-metadata reads below use it.
function scanTopLevelJsonValues(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        values.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return values;
}

export function flattenPaginated(out) {
  const text = typeof out === 'string' ? out.trim() : '';
  if (!text) return [];
  const flatten1 = (arr) => arr.flatMap((el) => (Array.isArray(el) ? el : [el]));
  const elements = [];
  for (const value of scanTopLevelJsonValues(text)) {
    if (Array.isArray(value)) elements.push(...flatten1(value));
    else elements.push(value);
  }
  return elements;
}

// Default `gh`-backed transport. Every method is overridable for tests.
export function createGhTransport({ execFile = execFileP, repo = null } = {}) {
  const base = repo ? ['-R', repo] : [];
  const gh = async (args) => {
    const { stdout } = await execFile('gh', [...base, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
  return {
    async resolveRepo() {
      const slug = repo ?? (await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
      return { nameWithOwner: slug || null };
    },
    async getPrHead({ prNumber }) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid']);
      return out.trim() || null;
    },
    async getPrBaseSha({ prNumber }) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'baseRefOid', '-q', '.baseRefOid']);
      return out.trim() || null;
    },
    // The PR's merge-base->HEAD unified diff — exactly what a reviewer sees on
    // the "Files changed" tab.
    async getPrDiff({ prNumber }) {
      return gh(['pr', 'diff', String(prNumber)]);
    },
    async getPrChangedFiles({ prNumber }) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'files', '-q', '.files[].path']);
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    },
    // Audit-only write. One PR issue comment. Never a review, never a merge.
    async postComment({ prNumber, body }) {
      const out = await gh(['pr', 'comment', String(prNumber), '--body', body]);
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
    async resolveRepo() {
      if (typeof gh.resolveRepo !== 'function') return { nameWithOwner: env?.REVIEWLOOP_GH_REPO ?? null };
      return (await gh.resolveRepo()) ?? { nameWithOwner: null };
    },
    async getPrHead({ prNumber }) {
      return gh.getPrHead({ prNumber });
    },
    async getPrBaseSha({ prNumber }) {
      if (typeof gh.getPrBaseSha !== 'function') return null;
      return gh.getPrBaseSha({ prNumber });
    },
    async getPrDiff({ prNumber, baseSha, headSha }) {
      if (typeof gh.getPrDiff !== 'function') {
        throw new Error('ReviewLoop PR backend: getPrDiff is not supported by this transport');
      }
      return gh.getPrDiff({ prNumber, baseSha, headSha });
    },
    async getPrChangedFiles({ prNumber, baseSha, headSha }) {
      if (typeof gh.getPrChangedFiles !== 'function') return [];
      return (await gh.getPrChangedFiles({ prNumber, baseSha, headSha })) ?? [];
    },
    // Optional audit publication. A failure here NEVER changes the review
    // verdict — the caller records the publication failure and moves on.
    async publishResult({ prNumber, body }) {
      if (typeof gh.postComment !== 'function') {
        return { published: false, reason: 'transport has no postComment' };
      }
      const res = await gh.postComment({ prNumber, body });
      return { published: true, commentId: res?.id ?? null };
    },
  };
}
