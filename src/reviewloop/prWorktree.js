// ReviewLoop PR-target isolated disposable worktree.
//
// A PR review round needs the Reviewer's diff identity, the deterministic
// Gate, and the verification-manifest drift check to all run against the
// SAME exact commit (the round's live-observed PR HEAD) — never the user's
// own ambient cwd, which can be on a different branch, dirty, mid-rebase, or
// simply stale relative to the PR. `withPrSnapshotWorktree` builds a
// throwaway `git worktree` checked out DETACHED at that exact SHA, hands the
// caller its path plus the PR's merge-base with its declared base SHA, and
// ALWAYS tears the worktree down again — on success, on failure, and on a
// thrown error — leaving the user's own worktree, index, and HEAD completely
// untouched.
//
// Fail-closed rules:
//   * cwd must already be inside a git repository.
//   * baseSha and headSha must both resolve to a real, fetchable commit. A
//     commit missing from the local object database is fetched by exact SHA
//     (GitHub reachable-SHA1 fetch) and, for the HEAD SHA only, additionally
//     via `refs/pull/<prNumber>/head` — never invented, never skipped.
//   * `git merge-base baseSha headSha` must resolve to a real common
//     ancestor. No fallback to HEAD, no fallback to baseSha itself.
//   * `git worktree add` must succeed. On any failure above, or here,
//     PrSnapshotError is thrown and NO worktree is left behind.
//   * Teardown (`git worktree remove --force` + a best-effort filesystem
//     `rm -rf` + `git worktree prune`) runs in a `finally` — it happens
//     whether the caller's callback resolved or threw.
//
// This module never commits, pushes, force-pushes, or mutates any ref in the
// user's own repository (`git worktree add --detach` never touches a branch).

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  rm as fsRm, symlink as fsSymlink, stat as fsStat, mkdir as fsMkdir,
} from 'node:fs/promises';

export class PrSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrSnapshotError';
    this.code = 'REVIEWLOOP_PR_SNAPSHOT_FAILED';
  }
}

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

async function commitPresent({ cwd, sha, spawn }) {
  const res = await runGit(['cat-file', '-e', `${sha}^{commit}`], cwd, spawn);
  return res.code === 0;
}

// Fetch a specific commit into the local object database WITHOUT touching any
// branch/ref the user's own worktree relies on. Tries (1) fetch-by-exact-SHA
// (GitHub.com and most modern git servers permit fetching any reachable SHA),
// then, for the PR's own HEAD only, (2) `refs/pull/<n>/head` — a ref GitHub
// always publishes for an open PR regardless of SHA-fetch support.
async function ensureCommitFetched({
  cwd, sha, remote, prNumber, tryPrHeadRef, spawn,
}) {
  if (await commitPresent({ cwd, sha, spawn })) return;
  const bySha = await runGit(['fetch', '--no-tags', remote, sha], cwd, spawn);
  if (bySha.code === 0 && await commitPresent({ cwd, sha, spawn })) return;
  if (tryPrHeadRef && prNumber != null) {
    const byPrHead = await runGit(['fetch', '--no-tags', remote, `refs/pull/${prNumber}/head`], cwd, spawn);
    if (byPrHead.code === 0 && await commitPresent({ cwd, sha, spawn })) return;
  }
  throw new PrSnapshotError(
    `commit ${sha} could not be fetched from remote "${remote}"`
      + (tryPrHeadRef && prNumber != null ? ` (tried the exact SHA and refs/pull/${prNumber}/head)` : ' (tried the exact SHA)'),
  );
}

// Best-effort: share the user's own installed dependencies with the disposable
// worktree so an npm-based Gate does not fail on "module not found" for a
// directory (node_modules) that is untracked by git and therefore absent from
// any fresh checkout. Read-only from the worktree's side (a symlink), never
// writes into the user's own directory, and never affects Reviewer evidence
// identity (node_modules is never part of a git diff). Failure here is never
// fatal — it just leaves the Gate to fail on its own if dependencies are truly
// unavailable.
async function linkSharedDependencyDirs({ userCwd, worktreeDir }) {
  for (const name of ['node_modules']) {
    try {
      const st = await fsStat(path.join(userCwd, name));
      if (!st.isDirectory()) continue;
      // eslint-disable-next-line no-await-in-loop
      await fsSymlink(path.join(userCwd, name), path.join(worktreeDir, name), 'dir');
    } catch { /* best-effort only */ }
  }
}

// Fingerprint of an isolated PR worktree's exact tracked + untracked state.
// Used to PROVE the deterministic Gate did not mutate the exact reviewed
// snapshot: called once immediately before the Gate runs and once immediately
// after, and the two results compared. `node_modules` (the top-level
// convenience symlink `linkSharedDependencyDirs` adds so an npm-based Gate can
// find dependencies) is excluded — it is ReviewLoop's own read-only
// convenience, never part of the reviewed source, and never git-diffable.
//
// Deliberately fails closed: a `git status` failure returns `{ ok: false }`
// rather than a fabricated "clean" result — the caller must treat an
// unverifiable snapshot state exactly like a proven mutation (never certify on
// a best-effort basis).
export async function worktreeSnapshotFingerprint({ worktreeDir, spawn = nodeSpawn } = {}) {
  const res = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'],
    worktreeDir,
    spawn,
  );
  if (res.code !== 0) {
    return { ok: false, reason: `"git status" failed inside the PR snapshot worktree (exit ${res.code}): ${(res.stderr || res.stdout || '').trim().slice(0, 300)}` };
  }
  // `--porcelain=v1 -z`: each changed path is its own NUL-terminated "XY PATH"
  // token (a rename additionally emits its old path as its own following
  // token — harmless here: we only need a stable multiset to detect ANY
  // change between the pre- and post-Gate captures, never to interpret it).
  const entries = res.stdout.split('\0').filter(Boolean).filter((entry) => {
    const p = entry.slice(3);
    return p !== 'node_modules' && !p.startsWith('node_modules/');
  }).sort();
  return { ok: true, entries };
}

// True when the two captures differ — i.e. something changed the worktree's
// tracked or (non-node_modules) untracked state between them.
export function worktreeSnapshotMutated(pre, post) {
  if (pre.entries.length !== post.entries.length) return true;
  return pre.entries.some((e, i) => e !== post.entries[i]);
}

async function teardownWorktree({ cwd, worktreeDir, spawn }) {
  const remove = await runGit(['worktree', 'remove', '--force', worktreeDir], cwd, spawn);
  if (remove.code !== 0) {
    // The worktree metadata may already be inconsistent (e.g. the process was
    // killed mid-round on a prior attempt). Best-effort filesystem cleanup
    // either way — this must never throw and mask the caller's real
    // result/error.
    try { await fsRm(worktreeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { await runGit(['worktree', 'prune'], cwd, spawn); } catch { /* best effort */ }
}

// Build an isolated worktree checked out DETACHED at `headSha`, compute its
// merge-base with `baseSha`, invoke `fn({ worktreeDir, mergeBase, headSha,
// baseSha })`, and ALWAYS tear the worktree down again before returning
// (success) or rethrowing (failure). Never mutates cwd's own working tree,
// index, HEAD, or any branch ref.
export async function withPrSnapshotWorktree({
  cwd, baseSha, headSha, prNumber = null, remote = 'origin', spawn = nodeSpawn,
} = {}, fn) {
  if (!cwd) throw new PrSnapshotError('a repository cwd is required to build an exact PR snapshot worktree');
  if (!baseSha) throw new PrSnapshotError('the PR base SHA is required to build an exact PR snapshot worktree');
  if (!headSha) throw new PrSnapshotError('the PR HEAD SHA is required to build an exact PR snapshot worktree');

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new PrSnapshotError(`"${cwd}" is not inside a git repository`);
  }

  await ensureCommitFetched({
    cwd, sha: baseSha, remote, prNumber, tryPrHeadRef: false, spawn,
  });
  await ensureCommitFetched({
    cwd, sha: headSha, remote, prNumber, tryPrHeadRef: true, spawn,
  });

  const mergeBaseRes = await runGit(['merge-base', baseSha, headSha], cwd, spawn);
  if (mergeBaseRes.code !== 0 || !mergeBaseRes.stdout.trim()) {
    throw new PrSnapshotError(
      `"git merge-base ${baseSha} ${headSha}" failed (exit ${mergeBaseRes.code}) — no common ancestor is reachable locally`,
    );
  }
  const mergeBase = mergeBaseRes.stdout.trim();

  const root = path.join(tmpdir(), 'reviewloop-pr-worktrees');
  try { await fsMkdir(root, { recursive: true }); } catch { /* best effort; worktree add will surface a real failure */ }
  const worktreeDir = path.join(root, randomUUID());

  const addRes = await runGit(['worktree', 'add', '--detach', '--quiet', worktreeDir, headSha], cwd, spawn);
  if (addRes.code !== 0) {
    throw new PrSnapshotError(
      `"git worktree add ${worktreeDir} ${headSha}" failed (exit ${addRes.code}): `
        + `${(addRes.stderr || addRes.stdout || '').trim().slice(0, 400)}`,
    );
  }

  try {
    await linkSharedDependencyDirs({ userCwd: cwd, worktreeDir });
    return await fn({
      worktreeDir, mergeBase, headSha, baseSha,
    });
  } finally {
    await teardownWorktree({ cwd, worktreeDir, spawn });
  }
}
