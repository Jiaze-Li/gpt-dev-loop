// PR-target snapshot correctness — exercised against REAL git (temp bare
// "remote" + a real clone), never fakes, so the production
// prWorktree.js / prEvidence.js / prIdentity.js implementations themselves
// are proven, not just the controller's injection points.
//
//   A. production PR evidence never depends on a live `gh pr diff`.
//   B. explicit base/head SHAs never leak an old HEAD's evidence onto a new one.
//   C. the Gate's cwd (the isolated worktree) is checked out at reviewedHeadSha.
//   D. a dirty/foreign user cwd never affects the PR Gate or evidence.
//   E/F. repository identity: mismatch and unresolvable both fail closed.
//   + worktree lifecycle: teardown always runs; a bad SHA fails closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  withPrSnapshotWorktree, PrSnapshotError, worktreeSnapshotFingerprint, worktreeSnapshotMutated,
} from '../src/reviewloop/prWorktree.js';
import { collectPrDelta } from '../src/reviewloop/prEvidence.js';
import { assertPrRepositoryIdentity, resolveCwdRepositoryIdentity } from '../src/reviewloop/prIdentity.js';

const execFileP = promisify(nodeExecFile);
async function git(args, cwd) {
  const { stdout } = await execFileP('git', args, { cwd });
  return stdout.trim();
}

// A real bare "remote" + a real local repo with TWO commits (base, then a PR
// commit on a branch), plus a SEPARATE clone that only has `main` — exactly
// the "reviewer's checkout does not yet have the PR HEAD" situation
// ensureCommitFetched must recover from via a real fetch.
async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rl-pr-git-'));
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const reviewer = path.join(root, 'reviewer');

  await execFileP('git', ['init', '--bare', '-q', remote]);
  await execFileP('git', ['init', '-q', author]);
  await git(['config', 'user.email', 't@t.com'], author);
  await git(['config', 'user.name', 't'], author);
  await git(['remote', 'add', 'origin', remote], author);
  await writeFile(path.join(author, 'f.txt'), 'base\n');
  await git(['add', 'f.txt'], author);
  await git(['commit', '-q', '-m', 'base'], author);
  await git(['branch', '-M', 'main'], author);
  await git(['push', '-q', 'origin', 'main'], author);
  const baseSha = await git(['rev-parse', 'HEAD'], author);

  await git(['checkout', '-q', '-b', 'pr1'], author);
  await writeFile(path.join(author, 'f.txt'), 'changed-by-pr\n');
  await git(['add', 'f.txt'], author);
  await git(['commit', '-q', '-m', 'pr change'], author);
  await git(['push', '-q', 'origin', 'pr1'], author);
  const headSha = await git(['rev-parse', 'HEAD'], author);

  // A second PR head, so a test can prove an OLD head's evidence never leaks
  // onto a NEW one (test B).
  await writeFile(path.join(author, 'f.txt'), 'changed-again-by-pr\n');
  await git(['add', 'f.txt'], author);
  await git(['commit', '-q', '-m', 'pr change 2'], author);
  await git(['push', '-q', 'origin', 'pr1'], author);
  const headSha2 = await git(['rev-parse', 'HEAD'], author);

  // The reviewer's own checkout: --no-local forces a real (non-hardlink)
  // transport, and --single-branch main means it does NOT already have the
  // PR commits — ensureCommitFetched must fetch them for real.
  await execFileP('git', ['clone', '-q', '--no-local', '--single-branch', '--branch', 'main', remote, reviewer]);
  await git(['config', 'user.email', 't@t.com'], reviewer);
  await git(['config', 'user.name', 't'], reviewer);

  // Give `origin` a GitHub-shaped URL (what resolveCwdRepositoryIdentity's
  // canonicalizer expects) while transparently redirecting every git
  // operation for that URL back to the real local bare repo — `insteadOf`
  // rewrites at fetch/push time; `git remote get-url` still reports the
  // literal configured URL.
  const githubUrl = 'https://github.com/acme/widgets.git';
  await git(['remote', 'set-url', 'origin', githubUrl], reviewer);
  await git(['config', `url.${remote}.insteadOf`, githubUrl], reviewer);

  return {
    root, remote, cwd: reviewer, baseSha, headSha, headSha2, nameWithOwner: 'acme/widgets',
  };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

test('A: prWorktree/prEvidence never invoke `gh pr diff` — no live-API evidence path exists in production source', async () => {
  const gh = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/reviewloop/githubBackend.js', import.meta.url), 'utf8',
  ));
  const evidence = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/reviewloop/prEvidence.js', import.meta.url), 'utf8',
  ));
  assert.doesNotMatch(gh, /getPrDiff|getPrChangedFiles/);
  assert.doesNotMatch(gh, /'pr',\s*'diff'/);
  // prEvidence.js never shells out to the `gh` binary at all (only `git`) —
  // its doc comment mentions "gh pr diff" in prose (what it deliberately does
  // NOT do), so check for an actual `gh` invocation, not the prose.
  assert.doesNotMatch(evidence, /spawn\(\s*['"]gh['"]/);
  assert.doesNotMatch(evidence, /execFile\(\s*['"]gh['"]/);
});

test('B/C/D: exact-SHA evidence, Gate on the exact worktree HEAD, and a dirty/foreign cwd never leaks in', async () => {
  const fx = await makeFixture();
  try {
    // Make the reviewer's own ambient cwd dirty and on an unrelated branch —
    // this must have ZERO effect on the PR round.
    await writeFile(path.join(fx.cwd, 'f.txt'), 'DIRTY UNRELATED USER EDIT\n');

    let observedWorktreeHead = null;
    const result = await withPrSnapshotWorktree({
      cwd: fx.cwd, baseSha: fx.baseSha, headSha: fx.headSha,
    }, async ({ worktreeDir, mergeBase, headSha }) => {
      // C: the worktree is checked out at the EXACT reviewed HEAD.
      observedWorktreeHead = await git(['rev-parse', 'HEAD'], worktreeDir);
      // D: the worktree's own file content reflects the PR commit, NEVER the
      // dirty edit made in the user's own ambient cwd.
      const content = await import('node:fs').then((fs) => fs.promises.readFile(path.join(worktreeDir, 'f.txt'), 'utf8'));
      assert.equal(content, 'changed-by-pr\n');
      const delta = await collectPrDelta({ cwd: worktreeDir, mergeBase, headSha });
      return delta;
    });

    assert.equal(observedWorktreeHead, fx.headSha, 'the Gate/evidence worktree is checked out at the exact reviewedHeadSha');
    assert.equal(result.evidenceComplete, true);
    assert.match(result.diff, /changed-by-pr/);
    assert.doesNotMatch(result.diff, /DIRTY UNRELATED USER EDIT/, 'the ambient dirty cwd never leaks into PR evidence');
    assert.deepEqual(result.changedFiles, ['f.txt']);

    // B: a DIFFERENT (older->newer) explicit HEAD produces DIFFERENT evidence —
    // the first head's diff never silently becomes the second head's diff.
    const result2 = await withPrSnapshotWorktree({
      cwd: fx.cwd, baseSha: fx.baseSha, headSha: fx.headSha2,
    }, async ({ worktreeDir, mergeBase, headSha }) => collectPrDelta({ cwd: worktreeDir, mergeBase, headSha }));
    assert.match(result2.diff, /changed-again-by-pr/);
    assert.notEqual(result.fingerprint, result2.fingerprint, 'two different exact HEADs never share a fingerprint');
    assert.notEqual(result.diff, result2.diff);

    // Worktree teardown: no leftover disposable worktree registered against
    // the repo — only the main checkout itself remains.
    const list = await git(['worktree', 'list', '--porcelain'], fx.cwd);
    const worktreeCount = list.split('\n').filter((l) => l.startsWith('worktree ')).length;
    assert.equal(worktreeCount, 1, `expected only the main worktree, got:\n${list}`);
  } finally {
    await cleanup(fx.root);
  }
});

test('a PR HEAD SHA that cannot be fetched fails the worktree build closed (no silent fallback)', async () => {
  const fx = await makeFixture();
  try {
    await assert.rejects(
      () => withPrSnapshotWorktree({
        cwd: fx.cwd, baseSha: fx.baseSha, headSha: '0000000000000000000000000000000000dead',
      }, async () => 'should never run'),
      PrSnapshotError,
    );
    // The failed attempt left no worktree behind.
    const list = await git(['worktree', 'list', '--porcelain'], fx.cwd);
    const worktreeCount = list.split('\n').filter((l) => l.startsWith('worktree ')).length;
    assert.equal(worktreeCount, 1, 'no disposable worktree survives a failed snapshot build');
  } finally {
    await cleanup(fx.root);
  }
});

test('worktree teardown runs even when the callback throws', async () => {
  const fx = await makeFixture();
  try {
    await assert.rejects(
      () => withPrSnapshotWorktree({
        cwd: fx.cwd, baseSha: fx.baseSha, headSha: fx.headSha,
      }, async () => { throw new Error('boom mid-round'); }),
      /boom mid-round/,
    );
    const list = await git(['worktree', 'list', '--porcelain'], fx.cwd);
    const worktreeCount = list.split('\n').filter((l) => l.startsWith('worktree ')).length;
    assert.equal(worktreeCount, 1, 'the worktree is torn down even after a thrown error');
  } finally {
    await cleanup(fx.root);
  }
});

test('E: cwd repository identity mismatch against the PR backend fails closed', async () => {
  const fx = await makeFixture();
  try {
    const prBackend = { async resolveRepo() { return { nameWithOwner: 'someoneelse/other-repo' }; } };
    const check = await assertPrRepositoryIdentity({ cwd: fx.cwd, prBackend, prNumber: 1 });
    assert.equal(check.ok, false);
    assert.match(check.reason, /does not match/);
  } finally {
    await cleanup(fx.root);
  }
});

test('F: cwd that is not a git repository at all fails repository identity closed', async () => {
  const nonRepo = await mkdtemp(path.join(tmpdir(), 'rl-not-a-repo-'));
  try {
    const identity = await resolveCwdRepositoryIdentity({ cwd: nonRepo });
    assert.equal(identity.ok, false);
    const prBackend = { async resolveRepo() { return { nameWithOwner: 'acme/repo' }; } };
    const check = await assertPrRepositoryIdentity({ cwd: nonRepo, prBackend, prNumber: 1 });
    assert.equal(check.ok, false);
    assert.match(check.reason, /cannot prove the local repository identity/);
  } finally {
    await rm(nonRepo, { recursive: true, force: true });
  }
});

test('F2: GitHub reporting no repository identity for the PR fails closed', async () => {
  const fx = await makeFixture();
  try {
    const prBackend = { async resolveRepo() { return { nameWithOwner: null }; } };
    const check = await assertPrRepositoryIdentity({ cwd: fx.cwd, prBackend, prNumber: 1 });
    assert.equal(check.ok, false);
    assert.match(check.reason, /no repository identity/);
  } finally {
    await cleanup(fx.root);
  }
});

test('worktreeSnapshotFingerprint: a real clean worktree fingerprints empty; a tracked edit and a new untracked file both register; node_modules is excluded', async () => {
  const fx = await makeFixture();
  try {
    await withPrSnapshotWorktree({
      cwd: fx.cwd, baseSha: fx.baseSha, headSha: fx.headSha,
    }, async ({ worktreeDir }) => {
      const clean = await worktreeSnapshotFingerprint({ worktreeDir });
      assert.equal(clean.ok, true);
      assert.deepEqual(clean.entries, []);

      // Simulate a Gate that behaves like a formatter: edits a tracked file.
      await writeFile(path.join(worktreeDir, 'f.txt'), 'formatter rewrote this\n');
      const trackedEdit = await worktreeSnapshotFingerprint({ worktreeDir });
      assert.equal(trackedEdit.ok, true);
      assert.ok(trackedEdit.entries.length > 0);
      assert.ok(worktreeSnapshotMutated(clean, trackedEdit));

      // Revert, then simulate a Gate that writes a new untracked snapshot file.
      await execFileP('git', ['checkout', '--', 'f.txt'], { cwd: worktreeDir });
      await writeFile(path.join(worktreeDir, 'generated.snap'), 'snapshot output\n');
      const untrackedAdd = await worktreeSnapshotFingerprint({ worktreeDir });
      assert.ok(untrackedAdd.entries.length > 0);
      assert.ok(worktreeSnapshotMutated(clean, untrackedAdd));
      await rm(path.join(worktreeDir, 'generated.snap'));

      // node_modules is ReviewLoop's own shared-dependency convenience
      // symlink — never part of the reviewed snapshot.
      const { symlink: fsSymlink } = await import('node:fs/promises');
      const fakeNodeModules = path.join(fx.cwd, 'node_modules');
      await import('node:fs/promises').then((m) => m.mkdir(fakeNodeModules, { recursive: true }));
      await fsSymlink(fakeNodeModules, path.join(worktreeDir, 'node_modules'), 'dir');
      const withNodeModules = await worktreeSnapshotFingerprint({ worktreeDir });
      assert.deepEqual(withNodeModules.entries, [], 'node_modules must never register as a mutation');
      assert.ok(!worktreeSnapshotMutated(clean, withNodeModules));
    });
  } finally {
    await cleanup(fx.root);
  }
});
