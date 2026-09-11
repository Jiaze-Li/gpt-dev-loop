// ReviewLoop PR-target evidence — bound to explicit, fetched commit SHAs.
//
// The PR target's primary review evidence is the diff between the PR's
// merge-base with its declared base SHA and its exact reviewed HEAD SHA:
//
//   merge-base(prBaseSha, reviewedHeadSha) .. reviewedHeadSha
//
// computed with LOCAL `git diff` against commit objects that
// prWorktree.js has already verified are present (fetching them by exact SHA
// when necessary) — NEVER a live `gh pr diff`, which reflects whatever
// GitHub's API currently renders for the PR and is not provably bound to one
// frozen SHA pair. `cwd` here is expected to be the isolated exact-snapshot
// worktree (see prWorktree.js `withPrSnapshotWorktree`), so this module never
// needs a PR backend at all.
//
// This module produces a delta record shaped exactly like the LOCAL Worker
// delta (src/reviewloop/gitEvidence.js `collectWorkerDelta`) so the ONE
// unified controller path (deterministic Gate -> chunked Reviewer routing ->
// convergence) consumes it unchanged.
//
// Fail-closed rules (mirrors the LOCAL evidence collector):
//   * mergeBase or headSha missing                    -> evidence incomplete
//   * `git diff <mergeBase>..<headSha>` fails          -> evidence incomplete
//   * `git diff --name-only` fails                     -> evidence incomplete
//   * a binary / submodule hunk in the diff            -> evidence incomplete
//     (its changed bytes never render as text, so a CLEAN review could PASS an
//      unreviewed change)
// An incomplete delta makes the controller fail closed (HUMAN_REQUIRED) rather
// than send partial evidence to the Reviewer.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

// Build the PR merge-base->HEAD delta via LOCAL git, against two explicit,
// already-fetched SHAs. `cwd` must have both `mergeBase` and `headSha`
// present as real commit objects (prWorktree.js guarantees this before
// calling in).
export async function collectPrDelta({
  cwd, mergeBase, headSha, spawn = nodeSpawn,
} = {}) {
  const incompleteReasons = [];
  let evidenceComplete = true;
  const fail = (reason) => { evidenceComplete = false; incompleteReasons.push(reason); };

  if (!mergeBase) fail('the PR merge-base could not be resolved');
  if (!headSha) fail('the PR reviewed HEAD SHA could not be resolved');

  let diff = '';
  let changedFiles = [];

  if (mergeBase && headSha) {
    const range = `${mergeBase}..${headSha}`;
    const diffRes = await runGit(['diff', range], cwd, spawn);
    if (diffRes.code === 0) {
      diff = diffRes.stdout;
    } else {
      fail(`"git diff ${range}" exited ${diffRes.code}: ${(diffRes.stderr || '').trim().slice(0, 200)}`);
    }

    // NUL-delimited: a changed path may legally contain a newline (or a
    // leading/trailing space). Newline-splitting or trimming would mis-slice
    // the path; `-z` also disables git's octal path-quoting so the bytes are
    // literal.
    const nameRes = await runGit(['diff', '-z', '--name-only', range], cwd, spawn);
    if (nameRes.code === 0) {
      changedFiles = nameRes.stdout.split('\0').filter(Boolean).sort();
    } else {
      fail(`"git diff -z --name-only ${range}" exited ${nameRes.code}`);
    }
  }

  // Structural, from git's own output — a binary or submodule hunk cannot be
  // reviewed as text.
  for (const line of diff.split('\n')) {
    if (/^Binary files .+ differ$/.test(line)) {
      fail(`the PR diff changes a binary file — "${line.trim()}" — whose bytes never render as text`);
    }
  }
  if (/^[+-]Subproject commit [0-9a-f]+/m.test(diff)
    || /^(?:index [0-9a-f]+\.\.[0-9a-f]+ |new file mode |deleted file mode )160000\b/m.test(diff)) {
    fail('the PR diff changes a git submodule (gitlink) — ReviewLoop cannot review inside a submodule');
  }

  const fingerprint = sha256(`${headSha ?? 'UNKNOWN_HEAD'}\n${diff}`);
  const noWorkerChangeYet = evidenceComplete
    && mergeBase != null && headSha != null
    && (mergeBase === headSha || diff.trim() === '');

  return {
    baselineHead: mergeBase,
    baseSha: mergeBase,
    mergeBase,
    currentHead: headSha,
    reviewedHeadSha: headSha,
    fingerprint,
    diff,
    changedFiles,
    evidenceComplete,
    incompleteReasons,
    noWorkerChangeYet,
  };
}
