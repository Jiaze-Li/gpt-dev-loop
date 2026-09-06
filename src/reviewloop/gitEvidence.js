// ReviewLoop Git evidence.
//
// The Worker edits the real workspace directly, so ReviewLoop does not run in
// an isolated worktree. It still needs a trustworthy before/after boundary:
// reviewloop_begin captures the exact pre-edit state, and each review computes
// ONLY the Worker's delta since that point — pre-existing unrelated user work
// (staged, unstaged, or untracked) is never attributed to the Worker.
//
// Mechanism (non-mutating throughout):
//   baseline:  `git stash create` -> a commit object of the dirty tracked
//              state, WITHOUT touching the working tree or the stash list.
//              Plus a blob hash of every pre-existing untracked file.
//   delta:     `git diff <baselineStashCommit>` == exactly the tracked change
//              the Worker made since begin. Untracked files are attributed by
//              comparing current blob hashes against the baseline hashes.
//
// If a pre-existing untracked file cannot be safely fingerprinted, the
// baseline is marked evidenceComplete=false and the controller fails closed.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function runGit(args, cwd, spawn = nodeSpawn) {
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

async function untrackedFiles(cwd, spawn) {
  const res = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd, spawn);
  return res.stdout.split('\0').filter(Boolean);
}

async function blobHash(cwd, spawn, filePath) {
  const res = await runGit(['hash-object', '--', filePath], cwd, spawn);
  return (res.code === 0 && res.stdout.trim()) ? res.stdout.trim() : null;
}

// Capture the pre-Worker baseline. Never mutates the working tree, the index,
// or the stash list.
export async function captureBaseline({ cwd, spawn = nodeSpawn } = {}) {
  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new Error(`ReviewLoop baseline: "${cwd}" is not inside a git repository`);
  }
  const headRes = await runGit(['rev-parse', 'HEAD'], cwd, spawn);
  if (headRes.code !== 0) throw new Error(`ReviewLoop baseline: cannot resolve HEAD in "${cwd}"`);
  const head = headRes.stdout.trim();

  // A commit object snapshot of the tracked dirty state (index + worktree).
  // Empty output => the tracked tree was clean; use HEAD as the baseline ref.
  const stashRes = await runGit(['stash', 'create', 'reviewloop-baseline'], cwd, spawn);
  const baselineRef = (stashRes.code === 0 && stashRes.stdout.trim()) ? stashRes.stdout.trim() : head;

  const statusRes = await runGit(['status', '--porcelain=v1', '-z'], cwd, spawn);
  const dirtyFiles = statusRes.stdout.split('\0').filter(Boolean).map((raw) => ({
    path: raw.slice(3),
    status: raw.slice(0, 2).trim(),
    untracked: raw.slice(0, 2) === '??',
  }));

  const untracked = await untrackedFiles(cwd, spawn);
  const untrackedHashes = {};
  let evidenceComplete = true;
  const incompleteReasons = [];
  for (const filePath of untracked) {
    // eslint-disable-next-line no-await-in-loop
    const h = await blobHash(cwd, spawn, filePath);
    if (h) untrackedHashes[filePath] = h;
    else {
      evidenceComplete = false;
      incompleteReasons.push(`cannot fingerprint pre-existing untracked file ${filePath}`);
    }
  }

  return {
    head,
    baselineRef,
    capturedAt: new Date().toISOString(),
    dirtyFiles,
    untrackedHashes,
    evidenceComplete,
    incompleteReasons,
  };
}

// Compute the Worker's delta since the baseline. `diff` is scoped to
// baseline->current, NOT HEAD->current, so pre-existing dirty hunks are
// excluded. Returns changedFiles attributed to the Worker only.
export async function collectWorkerDelta({ cwd, baseline, spawn = nodeSpawn } = {}) {
  if (!baseline?.head) throw new Error('collectWorkerDelta: baseline.head is required');
  const baseRef = baseline.baselineRef ?? baseline.head;

  const currentHeadRes = await runGit(['rev-parse', 'HEAD'], cwd, spawn);
  const currentHead = currentHeadRes.stdout.trim();

  // Tracked delta since the baseline snapshot (index + worktree vs baseRef).
  const diffRes = await runGit(['diff', baseRef], cwd, spawn);
  const trackedDiff = diffRes.stdout;
  const nameRes = await runGit(['diff', '--name-only', baseRef], cwd, spawn);
  const trackedChanged = nameRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  // Untracked attribution: a file the Worker newly created, an existing
  // untracked file whose content changed, or a pre-existing untracked file the
  // Worker DELETED (git diff cannot see an untracked-file deletion).
  const currentUntracked = new Set(await untrackedFiles(cwd, spawn));
  const baselineUntracked = baseline.untrackedHashes ?? {};
  const untrackedChanged = [];
  const untrackedDeleted = [];
  let evidenceComplete = baseline.evidenceComplete !== false;
  const incompleteReasons = [...(baseline.incompleteReasons ?? [])];

  for (const filePath of currentUntracked) {
    // eslint-disable-next-line no-await-in-loop
    const h = await blobHash(cwd, spawn, filePath);
    if (!(filePath in baselineUntracked)) {
      untrackedChanged.push(filePath); // brand-new file -> Worker output
    } else if (h == null) {
      evidenceComplete = false;
      incompleteReasons.push(`cannot re-fingerprint untracked file ${filePath}`);
    } else if (h !== baselineUntracked[filePath]) {
      untrackedChanged.push(filePath); // pre-existing untracked, content changed
    }
    // pre-existing untracked, unchanged -> NOT Worker output, excluded.
  }
  for (const filePath of Object.keys(baselineUntracked)) {
    if (!currentUntracked.has(filePath)) untrackedDeleted.push(filePath);
  }

  const changedFiles = [
    ...new Set([...trackedChanged, ...untrackedChanged, ...untrackedDeleted]),
  ].sort();

  // Full worker-attributed evidence text: the tracked diff, the COMPLETE
  // content of every Worker-touched untracked text file (never truncated —
  // size is handled downstream by the deterministic diff chunker), and a
  // deletion marker for every removed pre-existing untracked file. A binary or
  // unreadable Worker-created file cannot be reviewed as text, so evidence is
  // marked incomplete and the controller fails closed (HUMAN_REQUIRED) rather
  // than letting a review PASS without covering it.
  const untrackedBlocks = [];
  for (const filePath of untrackedChanged) {
    let buf = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      buf = await readFile(path.join(cwd, filePath));
    } catch (err) {
      evidenceComplete = false;
      incompleteReasons.push(`Worker-created untracked file ${filePath} is unreadable: ${err?.message ?? err}`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (UNREADABLE) ---`);
      continue;
    }
    if (buf.includes(0)) {
      evidenceComplete = false;
      incompleteReasons.push(`Worker-created untracked file ${filePath} is binary (${buf.length} bytes) — cannot be reviewed as text`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (BINARY, ${buf.length} bytes) ---`);
      continue;
    }
    untrackedBlocks.push(`--- Worker untracked file ${filePath} (${buf.length} bytes) ---\n${buf.toString('utf8')}`);
  }
  for (const filePath of untrackedDeleted) {
    untrackedBlocks.push(`--- Worker deleted pre-existing untracked file ${filePath} ---`);
  }
  const diff = [trackedDiff, ...untrackedBlocks].filter(Boolean).join('\n');

  const fingerprint = sha256(`${currentHead}\n${diff}`);
  const noWorkerChangeYet = changedFiles.length === 0
    && currentHead === baseline.head
    && trackedDiff.trim() === '';

  return {
    baselineHead: baseline.head,
    baselineRef: baseRef,
    currentHead,
    fingerprint,
    diff,
    changedFiles,
    trackedChanged,
    untrackedChanged,
    untrackedDeleted,
    evidenceComplete,
    incompleteReasons,
    noWorkerChangeYet,
  };
}

export { sha256 as evidenceSha256 };
