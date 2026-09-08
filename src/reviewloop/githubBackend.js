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
import { normalizeFindingSeverity, isBlockingSeverity } from '../orchestrator/adapters/normalizedPrReview.js';

const execFileP = promisify(nodeExecFile);

// GitHub PR review submission states (GET /pulls/{n}/reviews[].state).
const REVIEW_STATE = Object.freeze({
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  COMMENTED: 'COMMENTED',
  DISMISSED: 'DISMISSED',
  PENDING: 'PENDING',
});

// Natural-language markers that a body is calling out a blocking problem even
// without a structured findings block.
const NL_BLOCKING_RE = /\b(p1|p2|blocker|blocking|critical|must[- ]fix|major)\b/i;

function firstLine(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 200)
    ?? 'trusted reviewer comment (see PR thread)';
}

// A leading "P1:" / "**P2**" severity prefix, else null.
function severityPrefix(text) {
  const m = String(text ?? '').match(/(?:^|\n)\s*\*{0,2}\s*(P[123])\b/i);
  return m ? m[1].toUpperCase() : null;
}

// A ```json { "findings": [...] } ``` block, if present and well-formed.
function structuredFindings(body) {
  const m = String(body ?? '').match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed?.findings)) return parsed.findings;
    } catch { /* not structured */ }
  }
  return null;
}

// Turn ONE trusted review submission into { findings, dismissed, clean }.
// Fail-closed: COMMENTED / DISMISSED / an unparseable body is NEVER silently
// treated as an empty (clean) findings list.
function findingsForSubmission({ state, body }) {
  const upper = String(state ?? '').toUpperCase();
  const structured = structuredFindings(body);

  if (upper === REVIEW_STATE.DISMISSED) {
    return { findings: [], dismissed: true, clean: false };
  }
  if (upper === REVIEW_STATE.PENDING) {
    // Not a real submission — the reviewer never sent it.
    return { findings: [], dismissed: false, clean: false, pending: true };
  }
  if (upper === REVIEW_STATE.CHANGES_REQUESTED) {
    // GitHub's own review verdict. CHANGES_REQUESTED is UNCONDITIONALLY
    // blocking — a structured findings block (even an empty one, even one with
    // only non-blocking P3s) is additive detail; it can never downgrade the
    // reviewer's explicit "changes requested" verdict to clean. This branch is
    // deliberately ABOVE the generic `structured` handling below so a
    // ```json {"findings":[]}``` block can't turn CHANGES_REQUESTED into CLEAN.
    const extra = Array.isArray(structured) ? structured : [];
    const extraHasBlocking = extra.some(
      (f) => isBlockingSeverity(normalizeFindingSeverity(f?.severity ?? f?.level ?? f?.priority)),
    );
    const findings = [...extra];
    if (!extraHasBlocking) {
      findings.unshift({
        severity: severityPrefix(body) ?? 'P2',
        file: null,
        line: null,
        title: firstLine(body) || 'trusted reviewer requested changes — read the PR review thread',
      });
    }
    return { findings, dismissed: false, clean: false };
  }
  if (structured) {
    return { findings: structured, dismissed: false, clean: upper === REVIEW_STATE.APPROVED && structured.length === 0 };
  }
  if (upper === REVIEW_STATE.APPROVED) {
    // Approved with a free-text body but no structured findings: if the text
    // itself flags a blocking issue, honour it; otherwise treat as clean.
    if (NL_BLOCKING_RE.test(body ?? '')) {
      return {
        findings: [{ severity: severityPrefix(body) ?? 'P2', file: null, line: null, title: firstLine(body) }],
        dismissed: false, clean: false,
      };
    }
    return { findings: [], dismissed: false, clean: true };
  }
  // COMMENTED (or any unknown state) with no structured findings: a trusted
  // reviewer left a human-readable comment we cannot mechanically parse. That
  // is NOT a clean review — surface it as blocking so it cannot PASS silently.
  const sev = severityPrefix(body) ?? (NL_BLOCKING_RE.test(body ?? '') ? 'P2' : 'P2');
  return {
    findings: [{
      severity: sev,
      file: null,
      line: null,
      title: `trusted reviewer left an unstructured ${upper || 'COMMENTED'} review — resolve it in the PR thread: ${firstLine(body)}`,
    }],
    dismissed: false, clean: false,
  };
}

// `gh api --paginate` concatenates every page's JSON body; for a list endpoint
// that is several JSON arrays back-to-back, which `JSON.parse` cannot read as
// one value. Scan the stream for each top-level JSON value and flatten:
//   - N concatenated page arrays  -> every page's elements, in order
//   - a single page array         -> its elements
//   - `--slurp` output (one array of page arrays) -> flattened one extra level
//   - an already-flat array of objects            -> unchanged
// Empty output / an empty result set all collapse to []. This deliberately does
// NOT depend on `gh --slurp` (gh >= 2.44) so PR-review evidence aggregation
// still works on older `gh`.
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
  const topValues = scanTopLevelJsonValues(text);
  const elements = [];
  for (const value of topValues) {
    if (Array.isArray(value)) elements.push(...flatten1(value));
    else elements.push(value);
  }
  return elements;
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
      const arr = flattenPaginated(out);
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
    // Inline review comments (GET /pulls/{n}/comments). A trusted reviewer that
    // left ONLY inline comments still produced review evidence that must be
    // aggregated — it is not in any submission body.
    async listReviewComments({ prNumber }) {
      const out = await gh(['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`, '--paginate']);
      const arr = flattenPaginated(out);
      return arr.map((c) => ({
        login: c.user?.login,
        body: c.body,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        commitId: c.commit_id,
        originalCommitId: c.original_commit_id,
        pullRequestReviewId: c.pull_request_review_id,
        id: c.id,
        htmlUrl: c.html_url,
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

  // Aggregate EVERY trusted review submission and EVERY trusted inline review
  // comment for the exact PR HEAD. A later APPROVED never erases an earlier
  // CHANGES_REQUESTED / COMMENTED finding; a COMMENTED / DISMISSED / unparsed
  // review never silently reads as clean.
  async function aggregateTrustedReview({ prNumber, headSha, reviewer }) {
    const reviews = (await gh.listReviews({ prNumber })) ?? [];
    const inlineRaw = typeof gh.listReviewComments === 'function'
      ? ((await gh.listReviewComments({ prNumber })) ?? [])
      : [];

    const trustedSubs = [];
    for (const r of reviews) {
      const reviewedHead = r.commitId ?? r.headSha ?? r.commit_id ?? null;
      if (reviewedHead !== headSha) continue;
      // PENDING is a draft the reviewer never submitted — not review evidence.
      if (String(r.state ?? '').toUpperCase() === 'PENDING') continue;
      const trust = checkPrReviewTrust({
        raw: { login: r.login, headSha: reviewedHead, state: r.state, reviewId: r.id, url: r.htmlUrl },
        configuredReviewer: reviewer, currentHead: headSha, env,
      });
      if (trust.ok) trustedSubs.push({ ...r, _login: trust.review.reviewerLogin });
    }

    const trustedInline = [];
    for (const c of inlineRaw) {
      const reviewedHead = c.commitId ?? c.originalCommitId ?? c.commit_id ?? null;
      if (reviewedHead !== headSha) continue;
      const trust = checkPrReviewTrust({
        raw: { login: c.login, headSha: reviewedHead },
        configuredReviewer: reviewer, currentHead: headSha, env,
      });
      if (trust.ok) trustedInline.push(c);
    }

    if (trustedSubs.length === 0 && trustedInline.length === 0) return null;

    const findings = [];
    let anyDismissed = false;
    let anyCleanApproval = false;

    for (const sub of trustedSubs.sort((a, b) => String(a.submittedAt ?? '').localeCompare(String(b.submittedAt ?? '')))) {
      const outcome = findingsForSubmission({ state: sub.state, body: sub.body });
      if (outcome.pending) continue;
      if (outcome.dismissed) { anyDismissed = true; continue; }
      if (outcome.clean) anyCleanApproval = true;
      for (const f of outcome.findings) findings.push(f);
    }

    for (const c of trustedInline) {
      findings.push({
        severity: severityPrefix(c.body) ?? 'P2',
        file: c.path ?? null,
        line: Number.isInteger(c.line) ? c.line : null,
        title: `inline review comment: ${firstLine(c.body)}`,
      });
    }

    // A DISMISSED review with nothing else that positively clears (or blocks)
    // this HEAD is not a passing review — fail closed.
    if (anyDismissed && !anyCleanApproval && findings.length === 0) {
      return {
        login: trustedSubs[0]?._login ?? null,
        headSha, head_sha: headSha,
        status: 'failed',
        error: 'the trusted review for this HEAD was DISMISSED; a fresh review is required',
        findings: [],
      };
    }

    return {
      login: trustedSubs[0]?._login ?? trustedInline[0]?.login ?? null,
      reviewer: String(reviewer).toLowerCase(),
      reviewerLogin: trustedSubs[0]?._login ?? null,
      headSha,
      head_sha: headSha,
      state: 'AGGREGATED',
      findings,
      trustedSubmissions: trustedSubs.length,
      trustedInlineComments: trustedInline.length,
    };
  }

  const latestTrustedReview = aggregateTrustedReview;

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
