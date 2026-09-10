// ReviewLoop PR-target evidence.
//
// The PR target's primary review evidence is the ACTUAL diff of the pull
// request: `prBaseSha -> reviewedHeadSha`. It is NOT "what the Worker changed
// since reviewloop_begin" — a PR is reviewed as the PR, base to exact HEAD.
//
// This module produces a delta record shaped exactly like the LOCAL Worker
// delta (src/reviewloop/gitEvidence.js `collectWorkerDelta`) so the ONE
// unified controller path (deterministic Gate -> chunked Reviewer routing ->
// convergence) consumes it unchanged.
//
// Fail-closed rules (mirrors the LOCAL evidence collector):
//   * base or head SHA missing / unresolvable        -> evidence incomplete
//   * the PR diff text cannot be fetched              -> evidence incomplete
//   * the changed-file list cannot be fetched         -> evidence incomplete
//   * a binary / submodule hunk in the PR diff        -> evidence incomplete
//     (its changed bytes never render as text, so a CLEAN review could PASS an
//      unreviewed change)
// An incomplete delta makes the controller fail closed (HUMAN_REQUIRED) rather
// than send partial evidence to the Reviewer.

import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// Build the PR base->head delta via the slim PR backend. `prBackend` must
// expose getPrBaseSha / getPrHead / getPrDiff / getPrChangedFiles.
export async function collectPrDelta({
  prBackend, prNumber, baseSha, headSha,
} = {}) {
  const incompleteReasons = [];
  let evidenceComplete = true;
  const fail = (reason) => { evidenceComplete = false; incompleteReasons.push(reason); };

  const base = baseSha || null;
  const head = headSha || null;
  if (!base) fail('PR base SHA could not be resolved');
  if (!head) fail('PR HEAD SHA could not be resolved');

  let diff = '';
  let changedFiles = [];

  if (base && head) {
    try {
      diff = String((await prBackend.getPrDiff({ prNumber, baseSha: base, headSha: head })) ?? '');
    } catch (err) {
      fail(`could not fetch the PR diff: ${err?.message ?? err}`);
    }
    try {
      const files = await prBackend.getPrChangedFiles({ prNumber, baseSha: base, headSha: head });
      changedFiles = Array.isArray(files) ? files.map(String).filter(Boolean).sort() : [];
    } catch (err) {
      fail(`could not fetch the PR changed-file list: ${err?.message ?? err}`);
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

  const fingerprint = sha256(`${head ?? 'UNKNOWN_HEAD'}\n${diff}`);
  const noWorkerChangeYet = evidenceComplete
    && base != null && head != null
    && (base === head || diff.trim() === '');

  return {
    baselineHead: base,
    baseSha: base,
    currentHead: head,
    reviewedHeadSha: head,
    fingerprint,
    diff,
    changedFiles,
    evidenceComplete,
    incompleteReasons,
    noWorkerChangeYet,
  };
}
