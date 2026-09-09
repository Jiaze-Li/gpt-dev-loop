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
//              Plus a content digest of every pre-existing untracked file.
//   delta:     `git diff <baselineStashCommit>` == exactly the tracked change
//              the Worker made since begin. Untracked files are attributed by
//              comparing current content digests against the baseline digests.
//
// Fail-closed rules:
//   * Every git command that feeds baseline / diff / HEAD / untracked
//     attribution is checked for a non-zero exit. A non-zero exit is NEVER
//     absorbed as an empty diff, an empty untracked set, or a fallback HEAD —
//     `captureBaseline` throws and `collectWorkerDelta` marks the evidence
//     incomplete so the controller fails closed (HUMAN_REQUIRED). Only an exit
//     code of 0 with genuinely empty stdout (a clean tree) is treated as "no
//     change".
//   * An untracked path is `lstat`'d BEFORE it is read or digested. A symlink,
//     FIFO, socket, or device is never followed — doing so would fold an
//     out-of-tree target's bytes into Reviewer evidence. Any such path fails
//     the evidence closed. (Mirrors the hardened collector in
//     src/adapters/gate/git-evidence/index.js.)

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { readFile as nodeReadFile, lstat as nodeLstat, open as nodeOpen } from 'node:fs/promises';
import path from 'node:path';

// O_NOFOLLOW is a POSIX flag; 0 (no-op) on platforms that lack it.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

// Per-file cap on the baseline-untracked *content* retained (beyond the digest)
// so a real baseline->current delta can be built for a Worker file that copies
// pre-existing untracked text. Larger text files, and binary files, keep only
// the digest — a brand-new Worker file then cannot be proven free of their
// bytes and fails the evidence closed.
const UNTRACKED_CONTENT_CAP_BYTES = 1_048_576;

// A brand-new Worker file "reproduces" a baseline-untracked file when it
// contains that file whole, is contained within it, or shares a contiguous run
// of at least this many consecutive non-blank lines. Short runs compare by
// exact content only (already handled by the digest match) to avoid flagging
// incidental boilerplate.
const SHARED_RUN_MIN_LINES = 6;
const SHARED_RUN_MIN_CHARS = 160;
const MAX_RUNS_INDEXED = 50_000;

function runAt(lines, start) {
  const slice = lines.slice(start, start + SHARED_RUN_MIN_LINES);
  if (slice.length < SHARED_RUN_MIN_LINES) return null;
  const joined = slice.join('\n');
  if (joined.trim().length < SHARED_RUN_MIN_CHARS) return null;
  if (slice.filter((l) => l.trim().length > 0).length < Math.ceil(SHARED_RUN_MIN_LINES / 2)) return null;
  return joined;
}

// Index the substantial contiguous line-runs of a baseline text once, so every
// candidate is a linear pass of Set lookups rather than a quadratic substring
// scan.
function indexContentRuns(text) {
  const lines = text.split('\n');
  const runs = new Set();
  for (let i = 0; i + SHARED_RUN_MIN_LINES <= lines.length && runs.size < MAX_RUNS_INDEXED; i += 1) {
    const run = runAt(lines, i);
    if (run) runs.add(run);
  }
  return runs;
}

// Does `candidate` reproduce a substantial contiguous section of the indexed
// baseline text?
function reproducesBaselineContent(candidate, baselineText, baselineRuns) {
  if (!candidate || !baselineText) return false;
  if (candidate === baselineText) return true;
  if (baselineText.length >= SHARED_RUN_MIN_CHARS
    && (candidate.includes(baselineText) || baselineText.includes(candidate))) return true;
  if (!baselineRuns.size) return false;
  const lines = candidate.split('\n');
  for (let i = 0; i + SHARED_RUN_MIN_LINES <= lines.length; i += 1) {
    if (baselineRuns.has(lines.slice(i, i + SHARED_RUN_MIN_LINES).join('\n'))) return true;
  }
  return false;
}

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
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

class GitEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitEvidenceError';
    this.code = 'REVIEWLOOP_GIT_EVIDENCE_FAILED';
  }
}

// Run a git command that MUST succeed for the evidence to be trustworthy.
async function gitOrThrow(args, cwd, spawn, context) {
  const res = await runGit(args, cwd, spawn);
  if (res.code !== 0) {
    throw new GitEvidenceError(
      `ReviewLoop ${context}: "git ${args.join(' ')}" exited ${res.code}: ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`,
    );
  }
  return res;
}

function describeSpecial(info) {
  if (info.isFIFO()) return 'FIFO';
  if (info.isSocket()) return 'socket';
  if (info.isBlockDevice()) return 'block device';
  if (info.isCharacterDevice()) return 'character device';
  if (info.isDirectory()) return 'directory';
  return 'non-regular file';
}

// lstat-guarded content digest of an untracked path. NEVER follows a symlink
// and never reads a special file. Returns one of:
//   { safe: true, digest }         regular file
//   { safe: false, reason }        symlink / FIFO / socket / device / dir
//   { unreadable: true, reason }   lstat or read failure
async function fingerprintUntracked({
  cwd, filePath, lstat, readFile, open = nodeOpen,
}) {
  const abs = path.join(cwd, filePath);
  // Fast pre-check by name: reject a symlink or a special file before opening.
  let info;
  try {
    info = await lstat(abs);
  } catch (err) {
    // ENOENT is the only "definitively absent" signal — every other lstat
    // failure (EACCES, EIO, ...) means the path may still exist and must not be
    // treated as a deletion by the caller.
    return {
      unreadable: true,
      missing: err?.code === 'ENOENT',
      reason: `cannot lstat untracked path ${filePath}: ${err?.message ?? err}`,
    };
  }
  if (info.isSymbolicLink()) {
    return { safe: false, reason: `untracked path ${filePath} is a symlink — refusing to follow or read its target` };
  }
  if (!info.isFile()) {
    return { safe: false, reason: `untracked path ${filePath} is a ${describeSpecial(info)} — refusing to read it` };
  }
  // Authoritative read: open WITHOUT following a final-component symlink, then
  // operate ONLY on the returned descriptor. A concurrent process that renames
  // the real file aside and drops a same-sized symlink in its place cannot
  // redirect us — O_NOFOLLOW makes the open fail (ELOOP), and fstat/read on the
  // fd always see the one inode we opened, not whatever the path points at now.
  let fh;
  try {
    fh = await open(abs, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return { safe: false, reason: `untracked path ${filePath} became a symlink before it could be read — refusing to follow it` };
    }
    return {
      unreadable: true,
      missing: err?.code === 'ENOENT',
      reason: `cannot open untracked file ${filePath}: ${err?.message ?? err}`,
    };
  }
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      return { safe: false, reason: `untracked path ${filePath} is not a regular file when opened — refusing to read it` };
    }
    const buf = await fh.readFile();
    const st2 = await fh.stat();
    if ((Number.isFinite(st2.ino) && Number.isFinite(st.ino) && st2.ino !== st.ino)
      || (Number.isFinite(st2.size) && st2.size !== buf.length)) {
      return { safe: false, reason: `untracked path ${filePath} changed during read — refusing to trust its contents` };
    }
    return { safe: true, digest: sha256(buf), bytes: buf };
  } catch (err) {
    return { unreadable: true, reason: `cannot read untracked file ${filePath}: ${err?.message ?? err}` };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function listUntracked(cwd, spawn, context) {
  const res = await gitOrThrow(['ls-files', '--others', '--exclude-standard', '-z'], cwd, spawn, context);
  return res.stdout.split('\0').filter(Boolean);
}

// Capture the pre-Worker baseline. Never mutates the working tree, the index,
// or the stash list.
export async function captureBaseline({
  cwd, spawn = nodeSpawn, lstat = nodeLstat, readFile = nodeReadFile, open = nodeOpen,
} = {}) {
  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, spawn);
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new GitEvidenceError(`ReviewLoop baseline: "${cwd}" is not inside a git repository`);
  }
  const headRes = await gitOrThrow(['rev-parse', 'HEAD'], cwd, spawn, 'baseline');
  const head = headRes.stdout.trim();
  if (!head) throw new GitEvidenceError(`ReviewLoop baseline: "git rev-parse HEAD" produced no SHA in "${cwd}"`);

  // A commit object snapshot of the tracked dirty state (index + worktree).
  // A non-zero exit is a real failure and must not be papered over with HEAD.
  // Exit 0 + empty stdout => the tracked tree was clean; use HEAD as the ref.
  const stashRes = await gitOrThrow(['stash', 'create', 'reviewloop-baseline'], cwd, spawn, 'baseline');
  const baselineRef = stashRes.stdout.trim() || head;

  const statusRes = await gitOrThrow(['status', '--porcelain=v1', '-z'], cwd, spawn, 'baseline');
  const dirtyFiles = statusRes.stdout.split('\0').filter(Boolean).map((raw) => ({
    path: raw.slice(3),
    status: raw.slice(0, 2).trim(),
    untracked: raw.slice(0, 2) === '??',
  }));

  const untracked = await listUntracked(cwd, spawn, 'baseline');
  const untrackedHashes = {};
  // Full text of each retained baseline-untracked file (<= cap, non-binary),
  // keyed by path. Used at review time to build an honest delta for a Worker
  // file that copies pre-existing untracked content, and to detect the leak
  // when it cannot. Binary paths are listed so review can tell "genuinely
  // uncomparable" from "content stripped after baseline".
  const untrackedContent = {};
  const untrackedContentBinary = [];
  let evidenceComplete = true;
  const incompleteReasons = [];
  for (const filePath of untracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({ cwd, filePath, lstat, readFile, open });
    if (fp.safe) {
      untrackedHashes[filePath] = fp.digest;
      if (fp.bytes && fp.bytes.includes(0)) {
        untrackedContentBinary.push(filePath);
      } else if (fp.bytes && fp.bytes.length <= UNTRACKED_CONTENT_CAP_BYTES) {
        untrackedContent[filePath] = fp.bytes.toString('utf8');
      }
    } else {
      evidenceComplete = false;
      incompleteReasons.push(fp.reason);
    }
  }

  return {
    head,
    baselineRef,
    capturedAt: new Date().toISOString(),
    dirtyFiles,
    untrackedHashes,
    untrackedContent,
    untrackedContentBinary,
    evidenceComplete,
    incompleteReasons,
  };
}

// Compute the Worker's delta since the baseline. `diff` is scoped to
// baseline->current, NOT HEAD->current, so pre-existing dirty hunks are
// excluded. Returns changedFiles attributed to the Worker only. Any git
// command failure or unsafe untracked path marks evidenceComplete=false so the
// controller fails closed rather than reviewing partial / spoofed evidence.
export async function collectWorkerDelta({
  cwd, baseline, spawn = nodeSpawn, lstat = nodeLstat, readFile = nodeReadFile, open = nodeOpen,
} = {}) {
  if (!baseline?.head) throw new Error('collectWorkerDelta: baseline.head is required');
  const baseRef = baseline.baselineRef ?? baseline.head;

  let evidenceComplete = baseline.evidenceComplete !== false;
  const incompleteReasons = [...(baseline.incompleteReasons ?? [])];
  const fail = (reason) => { evidenceComplete = false; incompleteReasons.push(reason); };

  const currentHeadRes = await runGit(['rev-parse', 'HEAD'], cwd, spawn);
  let currentHead = null;
  if (currentHeadRes.code === 0 && currentHeadRes.stdout.trim()) {
    currentHead = currentHeadRes.stdout.trim();
  } else {
    fail(`cannot resolve current HEAD: "git rev-parse HEAD" exited ${currentHeadRes.code}`);
  }

  // Tracked delta since the baseline snapshot (index + worktree vs baseRef).
  const diffRes = await runGit(['diff', baseRef], cwd, spawn);
  let trackedDiff = '';
  if (diffRes.code === 0) trackedDiff = diffRes.stdout;
  else fail(`"git diff ${baseRef}" exited ${diffRes.code}: ${(diffRes.stderr || '').trim().slice(0, 200)}`);

  const nameRes = await runGit(['diff', '--name-only', baseRef], cwd, spawn);
  let trackedChanged = [];
  if (nameRes.code === 0) {
    trackedChanged = nameRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    fail(`"git diff --name-only ${baseRef}" exited ${nameRes.code}`);
  }

  // Paths `git diff <baseRef>` renders as wholly-new additions (no blob in the
  // baseline tree). A pre-existing untracked file that the Worker renamed,
  // edited AND `git add`ed lands here — not in `currentUntracked` and not in
  // `baselineUntracked` — so the untracked rename+edit guard below never sees
  // it. Kept so that guard can also reconcile these against vanished
  // baseline-untracked paths.
  const addRes = await runGit(['diff', '--name-only', '--diff-filter=A', baseRef], cwd, spawn);
  let addedTracked = [];
  if (addRes.code === 0) {
    addedTracked = addRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    fail(`"git diff --name-only --diff-filter=A ${baseRef}" exited ${addRes.code}`);
  }

  // Untracked attribution.
  const lsRes = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd, spawn);
  let currentUntracked = new Set();
  let untrackedListingOk = false;
  if (lsRes.code === 0) {
    currentUntracked = new Set(lsRes.stdout.split('\0').filter(Boolean));
    untrackedListingOk = true;
  } else {
    fail(`"git ls-files --others" exited ${lsRes.code}`);
  }

  const baselineUntracked = baseline.untrackedHashes ?? {};
  // digest -> [baseline paths that had it], to catch a rename/copy of
  // pre-existing untracked content into a name absent from the baseline set.
  const baselineUntrackedDigests = new Map();
  for (const [p, d] of Object.entries(baselineUntracked)) {
    if (!baselineUntrackedDigests.has(d)) baselineUntrackedDigests.set(d, []);
    baselineUntrackedDigests.get(d).push(p);
  }
  const untrackedChanged = [];
  const untrackedDeleted = [];
  const modifiedUntrackedBaseline = [];
  const renamedUntrackedBaseline = [];
  const safeBytes = new Map(); // filePath -> Buffer (regular files only)

  for (const filePath of currentUntracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({ cwd, filePath, lstat, readFile, open });
    if (!fp.safe) {
      // symlink / special / unreadable — never attribute, never read.
      fail(fp.reason);
      continue;
    }
    if (!(filePath in baselineUntracked)) {
      if (baselineUntrackedDigests.has(fp.digest)) {
        // Byte-identical to a file that was untracked at baseline under another
        // name — a rename or copy of pre-existing content, not Worker-authored.
        // Emitting it whole would leak all of that pre-existing content (and the
        // old path would separately be reported deleted). Fail closed.
        renamedUntrackedBaseline.push(filePath);
        fail(`untracked file ${filePath} is byte-identical to a file that was untracked at baseline `
          + `(${baselineUntrackedDigests.get(fp.digest).join(', ')}) — a rename/copy of pre-existing content, not Worker output`);
      } else {
        safeBytes.set(filePath, fp.bytes);
        untrackedChanged.push(filePath); // brand-new regular file -> Worker output
      }
    } else if (fp.digest !== baselineUntracked[filePath]) {
      // Pre-existing untracked file whose content changed since baseline, still
      // untracked (so it never enters the trackedChanged / modifiedStagedBaseline
      // path). The baseline retained only a digest, so an honest baseline->current
      // delta cannot be built: emitting the file as Worker output would leak its
      // unchanged pre-existing sections (possibly unrelated or sensitive) to the
      // Reviewer. Fail closed — same rationale as modifiedStagedBaseline. Its
      // bytes are NOT staged for evidence emission.
      modifiedUntrackedBaseline.push(filePath);
      fail(`pre-existing untracked file ${filePath} was modified after baseline — `
        + 'only a baseline digest was retained, so its pre-existing content cannot be separated from the Worker\'s change');
    }
    // pre-existing untracked, unchanged -> NOT Worker output, excluded.
  }
  // A file that was UNTRACKED at baseline but has since been `git add`ed shows
  // up in `git diff <baseRef>` (baseRef never captured untracked content) even
  // when its bytes are unchanged from baseline — that is pre-existing user
  // work, not the Worker's. Drop any such path (in the baseline untracked set,
  // current digest still equal to the baseline digest) from the name list AND
  // re-scope the diff text so its hunks never reach the Reviewer.
  const leakedStaged = [];
  const modifiedStagedBaseline = [];
  for (const filePath of trackedChanged) {
    if (!(filePath in baselineUntracked)) continue;
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({ cwd, filePath, lstat, readFile, open });
    if (fp.safe && fp.digest === baselineUntracked[filePath]) {
      leakedStaged.push(filePath); // unchanged pre-existing user work, just staged
    } else {
      // The Worker modified a file that was UNTRACKED at baseline and then
      // staged it. `git diff <baseRef>` has no blob for it, so it is rendered
      // as a wholly-new file: the FULL pre-existing baseline content would be
      // emitted as Worker evidence (and the path also marked deleted). There is
      // no way to construct an honest baseline->current delta here — fail closed.
      modifiedStagedBaseline.push(filePath);
      fail(`pre-existing untracked file ${filePath} was modified and staged after baseline — `
        + `"git diff ${baseRef}" cannot represent it without leaking its pre-existing content as Worker evidence`);
    }
  }
  const leaked = new Set([...leakedStaged, ...modifiedStagedBaseline]);
  if (leaked.size) {
    trackedChanged = trackedChanged.filter((p) => !leaked.has(p));
    if (trackedChanged.length) {
      const scoped = await runGit(['diff', baseRef, '--', ...trackedChanged], cwd, spawn);
      if (scoped.code === 0) trackedDiff = scoped.stdout;
      else fail(`"git diff ${baseRef} -- <scoped>" exited ${scoped.code}`);
    } else {
      trackedDiff = '';
    }
  }

  // A pre-existing untracked file the Worker DELETED (git diff cannot see it).
  // Only trustworthy when the current untracked listing itself succeeded.
  if (untrackedListingOk) {
    for (const filePath of Object.keys(baselineUntracked)) {
      // A path that is now staged (leaked, unchanged) was NOT deleted — it is
      // pre-existing user work that moved from untracked to the index.
      if (currentUntracked.has(filePath) || leaked.has(filePath) || trackedChanged.includes(filePath)) continue;
      // Absent from the untracked listing but not staged/tracked. It is EITHER
      // genuinely gone OR still on disk and now git-ignored (which hides it from
      // `git ls-files --exclude-standard`). Classify it as deleted only after
      // confirming it is actually gone — otherwise a modified-then-ignored file
      // would be reported deleted while PASS proceeds without reviewing it.
      // eslint-disable-next-line no-await-in-loop
      const fp = await fingerprintUntracked({ cwd, filePath, lstat, readFile, open });
      if (fp.unreadable && fp.missing) {
        untrackedDeleted.push(filePath); // definitively absent
      } else if (fp.unreadable) {
        // Present but unreadable (EACCES, EIO, a mid-read race): NOT a deletion,
        // and its current content was never reviewed — fail closed.
        fail(`baseline-untracked file ${filePath} vanished from the untracked listing but could not be confirmed absent (${fp.reason})`);
      } else if (!fp.safe) {
        fail(fp.reason); // a symlink/special now sits where a regular file was
      } else if (fp.digest === baselineUntracked[filePath]) {
        // still present, unchanged, just newly ignored -> pre-existing user
        // work, neither deleted nor Worker output; exclude it entirely.
      } else {
        // still present, content changed, now ignored -> the same leak as a
        // modified-but-still-untracked file; fail closed.
        modifiedUntrackedBaseline.push(filePath);
        fail(`pre-existing untracked file ${filePath} was modified and then git-ignored after baseline — `
          + 'only a baseline digest was retained, so its current content cannot be separated from the pre-existing bytes');
      }
    }
  }

  // Brand-new *tracked* additions (`git diff --diff-filter=A`) that were
  // neither tracked nor untracked at baseline. A rename/copy (+ optional edit)
  // of a baseline-untracked file into a staged new name lands here — not in
  // `currentUntracked`, not in `baselineUntracked` — so none of the untracked
  // guards above see it, and `git diff <baseRef>` renders it as a wholly-new
  // file, leaking its pre-existing bytes with evidenceComplete=true. Mirror the
  // two untracked-side protections for these paths.
  const brandNewTracked = addedTracked.filter(
    (p) => trackedChanged.includes(p) && !leaked.has(p) && !(p in baselineUntracked),
  );
  const droppedTracked = new Set();

  // (1) Exact digest match against a baseline-untracked file -> a copy/rename
  //     of pre-existing content. No vanished source required (the Worker may
  //     copy without deleting the original). Mirrors the untracked
  //     `renamedUntrackedBaseline` check.
  for (const p of brandNewTracked) {
    // eslint-disable-next-line no-await-in-loop
    const fp = await fingerprintUntracked({ cwd, filePath: p, lstat, readFile, open });
    if (fp.safe && baselineUntrackedDigests.has(fp.digest)) {
      droppedTracked.add(p);
      renamedUntrackedBaseline.push(p);
      fail(`staged new file ${p} is byte-identical to a file that was untracked at baseline `
        + `(${baselineUntrackedDigests.get(fp.digest).join(', ')}) — a copy/rename of pre-existing content, not Worker output`);
    } else if (!fp.safe) {
      droppedTracked.add(p);
      fail(fp.reason);
    }
  }

  // (2) Any baseline-untracked path vanished while a brand-new file (untracked
  //     OR tracked) appeared -> a rename+edit cannot be told apart from a
  //     delete+create, and the baseline kept only digests. Fail closed and
  //     drop every candidate destination.
  if (untrackedDeleted.length && (untrackedChanged.length || brandNewTracked.length)) {
    const appeared = [...untrackedChanged, ...brandNewTracked];
    fail(`brand-new file(s) [${appeared.join(', ')}] appeared while pre-existing untracked `
      + `file(s) [${untrackedDeleted.join(', ')}] disappeared — a rename+edit cannot be distinguished from a `
      + 'delete+create and the baseline retained only digests');
    for (const p of untrackedChanged) {
      renamedUntrackedBaseline.push(p);
      safeBytes.delete(p);
    }
    for (const p of brandNewTracked) {
      if (!droppedTracked.has(p)) {
        droppedTracked.add(p);
        renamedUntrackedBaseline.push(p);
      }
    }
    // The disappeared paths are no longer "clean deletions" either — fold them
    // into the same ambiguous bucket.
    renamedUntrackedBaseline.push(...untrackedDeleted);
    untrackedChanged.length = 0;
    untrackedDeleted.length = 0;
  }

  // (3) Edited / partial copy. A brand-new Worker file (tracked addition or
  //     untracked) that reproduces a substantial contiguous section of a
  //     baseline-untracked file leaks that file's pre-existing bytes even
  //     though its digest differs and its source may still be on disk. The
  //     baseline retained capped text content for exactly this comparison; when
  //     a baseline-untracked file's content is NOT available (binary that has
  //     since vanished, oversized text, or stripped from state) the file cannot
  //     be cleared and every brand-new Worker file fails closed.
  if (Object.keys(baseline.untrackedHashes ?? {}).length) {
    const retained = baseline.untrackedContent ?? {};
    const declaredBinary = new Set(baseline.untrackedContentBinary ?? []);
    const comparableTexts = [];
    let uncomparableBaseline = null;
    for (const [bp, digest] of Object.entries(baseline.untrackedHashes ?? {})) {
      const text = retained[bp];
      if (typeof text === 'string' && sha256(Buffer.from(text, 'utf8')) === digest) {
        comparableTexts.push({ text, runs: indexContentRuns(text) });
        continue;
      }
      if (declaredBinary.has(bp)) {
        // Trust the "binary" label only if the file is still on disk AND still
        // binary; a vanished or now-text path may have been relabelled.
        // eslint-disable-next-line no-await-in-loop
        const fp = await fingerprintUntracked({ cwd, filePath: bp, lstat, readFile, open });
        if (fp.safe && fp.bytes && fp.bytes.includes(0)) continue;
      }
      uncomparableBaseline = uncomparableBaseline ?? bp;
    }

    const candidates = [
      ...untrackedChanged.map((p) => ({ p, tracked: false })),
      ...brandNewTracked.filter((p) => !droppedTracked.has(p) && trackedChanged.includes(p))
        .map((p) => ({ p, tracked: true })),
    ];
    for (const { p, tracked } of candidates) {
      let text = null;
      if (tracked) {
        // eslint-disable-next-line no-await-in-loop
        const fp = await fingerprintUntracked({ cwd, filePath: p, lstat, readFile, open });
        text = fp.safe && fp.bytes && !fp.bytes.includes(0) ? fp.bytes.toString('utf8') : null;
      } else {
        const buf = safeBytes.get(p);
        text = buf && !buf.includes(0) ? buf.toString('utf8') : null;
      }
      if (text == null) continue; // binary Worker files fail closed at emission
      const reproduced = comparableTexts.some((b) => reproducesBaselineContent(text, b.text, b.runs));
      if (reproduced || uncomparableBaseline) {
        renamedUntrackedBaseline.push(p);
        if (tracked) {
          droppedTracked.add(p);
        } else {
          safeBytes.delete(p);
          const idx = untrackedChanged.indexOf(p);
          if (idx !== -1) untrackedChanged.splice(idx, 1);
        }
        fail(reproduced
          ? `brand-new file ${p} reproduces a substantial contiguous section of a baseline-untracked file `
            + '— the baseline retained only a digest/capped content, so the pre-existing bytes cannot be '
            + 'separated from Worker authorship'
          : `brand-new file ${p} cannot be cleared: baseline-untracked file ${uncomparableBaseline} `
            + 'had no comparable content retained (binary-and-vanished, oversized, or stripped)');
      }
    }
  }

  // Re-scope the tracked diff so no dropped brand-new tracked file's bytes
  // reach the Reviewer.
  if (droppedTracked.size) {
    trackedChanged = trackedChanged.filter((p) => !droppedTracked.has(p));
    if (trackedChanged.length) {
      const scoped = await runGit(['diff', baseRef, '--', ...trackedChanged], cwd, spawn);
      if (scoped.code === 0) trackedDiff = scoped.stdout;
      else fail(`"git diff ${baseRef} -- <scoped>" exited ${scoped.code}`);
    } else {
      trackedDiff = '';
    }
  }

  const changedFiles = [
    ...new Set([
      ...trackedChanged, ...untrackedChanged, ...untrackedDeleted,
      ...modifiedUntrackedBaseline, ...renamedUntrackedBaseline,
    ]),
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
    const buf = safeBytes.get(filePath);
    if (!buf) {
      fail(`Worker-created untracked file ${filePath} could not be read for evidence`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (UNREADABLE) ---`);
      continue;
    }
    if (buf.includes(0)) {
      fail(`Worker-created untracked file ${filePath} is binary (${buf.length} bytes) — cannot be reviewed as text`);
      untrackedBlocks.push(`--- Worker untracked file ${filePath} (BINARY, ${buf.length} bytes) ---`);
      continue;
    }
    untrackedBlocks.push(`--- Worker untracked file ${filePath} (${buf.length} bytes) ---\n${buf.toString('utf8')}`);
  }
  for (const filePath of untrackedDeleted) {
    untrackedBlocks.push(`--- Worker deleted pre-existing untracked file ${filePath} ---`);
  }
  const diff = [trackedDiff, ...untrackedBlocks].filter(Boolean).join('\n');

  const fingerprint = sha256(`${currentHead ?? 'UNKNOWN_HEAD'}\n${diff}`);
  const noWorkerChangeYet = evidenceComplete
    && changedFiles.length === 0
    && currentHead != null
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
    modifiedUntrackedBaseline,
    renamedUntrackedBaseline,
    evidenceComplete,
    incompleteReasons,
    noWorkerChangeYet,
  };
}

export { sha256 as evidenceSha256, GitEvidenceError };
