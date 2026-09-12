// ReviewLoop PR repository identity — fail closed.
//
// `reviewloop_begin({ cwd, prNumber })` must PROVE `cwd`'s repository is the
// SAME repository the PR belongs to before it may register a PR loop. Two
// independently-derived identities are compared:
//   (1) cwd's own git "origin" remote, canonicalized to "owner/name" —
//       derived from plain git, never from `gh` or any env override.
//   (2) the repository `prBackend.resolveRepo({ cwd, prNumber })` reports —
//       the production backend resolves this FROM `cwd` (or an explicit
//       REVIEWLOOP_GH_REPO override), so a mismatch here means the override
//       (or an ambient `gh` context) disagrees with cwd's own remote.
// cwd not being a git repository, having no "origin" remote, an
// unparseable/non-GitHub remote, or GitHub reporting no identity at all are
// ALL treated as "cannot prove identity" — never as an implicit match.
//
// This module never trusts the MCP process's own working directory: every
// check is scoped to the `cwd` the caller explicitly passed.

import { spawn as nodeSpawn } from 'node:child_process';

function runGit(args, cwd, spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    const out = [];
    const errChunks = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => resolve({ code: 127, stdout: '', stderr: String(err?.message ?? err) }));
    child.on('close', (code) => resolve({
      code: code ?? 0,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    }));
  });
}

// Accepts `git@github.com:owner/name.git`, `https://github.com/owner/name.git`,
// `https://github.com/owner/name`, `ssh://git@github.com/owner/name.git`, ...
// Returns the canonical "owner/name" (lowercase-compared by the caller) or
// null when the remote is not a recognizable GitHub owner/name.
export function canonicalizeGitHubRemote(url) {
  const s = String(url ?? '').trim().replace(/\.git$/i, '');
  const m = s.match(/github\.com[:/]+([^/]+)\/([^/]+?)\/?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export async function resolveCwdRepositoryIdentity({ cwd, spawn = nodeSpawn } = {}) {
  if (!cwd) return { ok: false, reason: 'no cwd was provided' };
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: `"${cwd}" is not inside a git repository` };
  }
  // The LITERAL configured remote URL — never `git remote get-url`, which
  // silently applies any local `url.<base>.insteadOf` rewrite and could make
  // the identity check compare against a redirected target rather than the
  // remote the repository actually declares.
  const remote = await runGit(['config', '--get', 'remote.origin.url'], cwd, spawn);
  if (remote.code !== 0 || !remote.stdout.trim()) {
    return { ok: false, reason: `cannot resolve the git "origin" remote URL for "${cwd}"` };
  }
  const canonical = canonicalizeGitHubRemote(remote.stdout.trim());
  if (!canonical) {
    return { ok: false, reason: `the "origin" remote ("${remote.stdout.trim()}") is not a recognizable GitHub owner/name` };
  }
  return { ok: true, nameWithOwner: canonical };
}

// Prove `cwd`'s repository is the exact repository PR #prNumber belongs to.
// Returns { ok: true, nameWithOwner } or { ok: false, reason }. NEVER throws —
// every failure mode (unresolvable cwd identity, unresolvable PR identity, a
// GitHub call failure, a genuine mismatch) is reported as `{ ok: false }` so
// the caller can fail `reviewloop_begin` closed with one consistent path.
export async function assertPrRepositoryIdentity({
  cwd, prBackend, prNumber, spawn = nodeSpawn,
} = {}) {
  const cwdIdentity = await resolveCwdRepositoryIdentity({ cwd, spawn });
  if (!cwdIdentity.ok) {
    return { ok: false, reason: `cannot prove the local repository identity: ${cwdIdentity.reason}` };
  }
  if (!prBackend || typeof prBackend.resolveRepo !== 'function') {
    return { ok: false, reason: 'the PR backend does not support repository identity resolution' };
  }
  let prRepo;
  try {
    prRepo = await prBackend.resolveRepo({ cwd, prNumber });
  } catch (err) {
    return { ok: false, reason: `cannot resolve the PR's GitHub repository identity: ${err?.message ?? err}` };
  }
  const prName = prRepo?.nameWithOwner ? String(prRepo.nameWithOwner) : null;
  if (!prName) {
    return { ok: false, reason: 'GitHub reported no repository identity for this PR' };
  }
  if (prName.toLowerCase() !== cwdIdentity.nameWithOwner.toLowerCase()) {
    return {
      ok: false,
      reason: `cwd repository "${cwdIdentity.nameWithOwner}" does not match the PR's repository "${prName}"`,
    };
  }
  return { ok: true, nameWithOwner: prName };
}
