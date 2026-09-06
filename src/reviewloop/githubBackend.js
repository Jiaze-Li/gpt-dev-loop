// ReviewLoop production PR backend — GitHub via the `gh` CLI.
//
// Transport only. It NEVER edits code, commits, pushes, merges, or force-
// pushes. Its one write is posting a single `@codex review` / `@claude review`
// comment (postReviewTrigger), and even that is gated upstream by
// ExternalModelTriggerAuthority. All read outputs pass the ReviewLoop PR trust
// boundary (prTrust.js) before they leave this module.
//
// Real external triggers are NOT sent in the current build's test runs; this
// module is exercised through an injected `github` transport in tests.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkPrReviewTrust } from './prTrust.js';

const execFileP = promisify(nodeExecFile);

// Pull a ```json { "findings": [...] } ``` block out of a review body, else
// fall back to the review state.
function extractFindings(body, state) {
  const m = String(body ?? '').match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed?.findings)) return parsed.findings;
    } catch { /* fall through */ }
  }
  if (String(state ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
    return [{ severity: 'P2', file: null, line: null, title: 'trusted reviewer requested changes — read the PR review thread' }];
  }
  return [];
}

// Default `gh`-backed transport. Every method is overridable for tests.
export function createGhTransport({ execFile = execFileP, repo = null } = {}) {
  const base = repo ? ['-R', repo] : [];
  const gh = async (args) => {
    const { stdout } = await execFile('gh', [...base, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  };
  return {
    async getPrHead({ prNumber }) {
      const out = await gh(['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid']);
      return out.trim() || null;
    },
    async listReviews({ prNumber }) {
      const out = await gh(['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, '--paginate']);
      const arr = JSON.parse(out || '[]');
      return arr.map((r) => ({
        login: r.user?.login,
        state: r.state,
        body: r.body,
        commitId: r.commit_id,
        submittedAt: r.submitted_at,
        htmlUrl: r.html_url,
        id: r.id,
      }));
    },
    async postComment({ prNumber, body }) {
      const out = await gh(['pr', 'comment', String(prNumber), '--body', body]);
      // gh prints the comment URL; use it as the durable trigger id.
      return { id: out.trim() || `comment-${Date.now()}` };
    },
  };
}

export function createGithubReviewBackend({
  github = null,
  env = process.env,
  transport = null,
  pollIntervalMs = 20_000,
  maxWaitMs = 15 * 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const gh = transport ?? github ?? createGhTransport({ repo: env?.REVIEWLOOP_GH_REPO ?? null });

  // Every review with a matching reviewed HEAD is handed to the trust boundary
  // AS-IS (real GitHub login preserved, never pre-canonicalised). The trust
  // boundary decides identity via an exact login allowlist.
  async function latestTrustedReview({ prNumber, headSha, reviewer }) {
    const reviews = await gh.listReviews({ prNumber });
    const candidates = reviews
      .filter((r) => (r.commitId ?? r.headSha) === headSha)
      .sort((a, b) => String(b.submittedAt ?? '').localeCompare(String(a.submittedAt ?? '')));
    for (const r of candidates) {
      const raw = {
        login: r.login,
        headSha: r.commitId ?? r.headSha ?? null,
        state: r.state,
        findings: extractFindings(r.body, r.state),
        reviewId: r.id,
        url: r.htmlUrl,
      };
      const trust = checkPrReviewTrust({ raw, configuredReviewer: reviewer, currentHead: headSha, env });
      if (trust.ok) return trust.review;
    }
    return null;
  }

  return {
    async getPrHead({ prNumber }) {
      return gh.getPrHead({ prNumber });
    },

    // Trust-boundary-checked. Returns a trusted raw review for the exact
    // current HEAD, or null.
    async findExistingReview({ prNumber, headSha, reviewer }) {
      return latestTrustedReview({ prNumber, headSha, reviewer });
    },

    // The single external write. Gated upstream by ExternalModelTriggerAuthority.
    async postReviewTrigger({ prNumber, reviewer }) {
      const body = reviewer === 'claude' ? '@claude review' : '@codex review';
      return gh.postComment({ prNumber, body });
    },

    // Local zero-model polling. Returns a trust-checked raw review, or null if
    // the wall-clock budget is exhausted / the caller detaches (WAITING_FOR_REVIEW).
    async waitForReview({ prNumber, headSha, reviewer, signal, onHeartbeat }) {
      const deadline = Date.now() + maxWaitMs;
      let polls = 0;
      while (Date.now() < deadline) {
        if (signal?.aborted) return null;
        // eslint-disable-next-line no-await-in-loop
        const review = await latestTrustedReview({ prNumber, headSha, reviewer });
        if (review) return review;
        polls += 1;
        // eslint-disable-next-line no-await-in-loop
        await onHeartbeat?.(`ReviewLoop: waiting for ${reviewer} review of ${headSha.slice(0, 8)} (poll ${polls}, 0 model tokens)`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollIntervalMs);
      }
      return null;
    },
  };
}
