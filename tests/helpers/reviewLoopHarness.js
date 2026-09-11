// Deterministic in-memory harness for ReviewLoop controller tests.
// Zero real provider calls, zero git, zero filesystem.

import { createHash } from 'node:crypto';
import { createReviewLoopController } from '../../src/reviewloop/controller.js';

function sha256(v) { return createHash('sha256').update(String(v)).digest('hex'); }

export class MemoryPersistence {
  constructor() { this._state = new Map(); }
  async readWorkflowState(id) { return this._state.get(id) ? JSON.parse(JSON.stringify(this._state.get(id))) : null; }
  async writeWorkflowState(id, s) { this._state.set(id, JSON.parse(JSON.stringify(s))); }
  async updateWorkflowState(id, patch) {
    const cur = (await this.readWorkflowState(id)) ?? {};
    const next = { ...cur, ...patch };
    this._state.set(id, JSON.parse(JSON.stringify(next)));
    return next;
  }
}

// A scripted world the tests drive.
export function makeHarness({
  baseline = { head: 'BASE', capturedAt: 't0', dirtyFiles: [], evidenceComplete: true, baselineDiffText: '' },
  deltas = [],           // one per review() call: { fingerprint, diff, changedFiles }
  gates = [],            // one per review() call: { verdict, fingerprint, failureIdentities }
  reviews = [],          // one per reviewer call: { findings: [...] }
  supervisorReplies = [],// one per supervisor call
  prBackend = null,
} = {}) {
  const calls = { reviewer: 0, supervisor: 0, gate: 0, delta: 0, baseline: 0 };
  const persistence = new MemoryPersistence();

  const controller = createReviewLoopController({
    persistence,
    prBackend,
    captureBaselineFn: async () => { calls.baseline += 1; return baseline; },
    collectWorkerDeltaFn: async () => {
      const d = deltas[calls.delta] ?? deltas[deltas.length - 1] ?? { fingerprint: `fp${calls.delta}`, diff: 'diff', changedFiles: ['a.js'] };
      calls.delta += 1;
      return { baselineHead: baseline.head, currentHead: baseline.head, evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false, ...d };
    },
    runGateFn: async () => {
      const g = gates[calls.gate] ?? gates[gates.length - 1] ?? { verdict: 'PASS', fingerprint: `gate${calls.gate}`, failureIdentities: [] };
      calls.gate += 1;
      return { pass: g.verdict === 'PASS', results: [], baselineDiff: null, ...g };
    },
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo test'] }),
    reviewerFn: async () => {
      const r = reviews[calls.reviewer] ?? reviews[reviews.length - 1] ?? { findings: [] };
      calls.reviewer += 1;
      return { value: r, usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-reviewer' };
    },
    supervisorFn: async () => {
      const s = supervisorReplies[calls.supervisor] ?? { guidance: 'try X', recommendation: 'REWORK' };
      calls.supervisor += 1;
      return { value: s, usage: { input_tokens: 8, output_tokens: 4 }, model: 'test-supervisor' };
    },
  });

  return { controller, persistence, calls };
}

export const finding = (severity, file = 'a.js', title = 't') => ({ severity, file, line: 1, title });

// Deterministic slim PR backend for the ONE unified review engine. No external
// reviewer, no trigger, no polling — just PR-snapshot metadata + the base->HEAD
// diff, exactly what src/reviewloop/githubBackend.js exposes.
export function mockPrBackend({
  base = 'BASE',
  heads = ['H1'],
  diffByHead = {},
  filesByHead = {},
  repo = 'acme/repo',
  // Per-getPrHead-call script (1-indexed by call count, clamped). Lets a test
  // move the PR HEAD mid-review to exercise the exact-HEAD recheck.
  headScript = null,
  // Every getPrHead call returns a brand-new SHA — the HEAD never settles.
  movingHead = false,
} = {}) {
  const state = {
    headIdx: 0, headReads: 0, published: [], diffReads: 0,
  };
  const head = () => {
    if (movingHead) return `MH${state.headReads}`;
    if (headScript) return headScript[Math.min(state.headReads, headScript.length - 1)];
    return heads[Math.min(state.headIdx, heads.length - 1)];
  };
  return {
    state,
    head,
    advanceHead() { state.headIdx += 1; },
    async resolveRepo() { return { nameWithOwner: repo }; },
    async getPrHead() { const h = head(); state.headReads += 1; return h; },
    async getPrBaseSha() { return base; },
    async getPrDiff({ headSha } = {}) {
      state.diffReads += 1;
      const h = headSha ?? head();
      return diffByHead[h]
        ?? `diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n@@ -1 +1 @@\n-old\n+new-at-${h}\n`;
    },
    async getPrChangedFiles({ headSha } = {}) { return filesByHead[headSha ?? head()] ?? ['f.js']; },
    async publishResult({ body }) { state.published.push(body); return { published: true, commentId: 'pub-1' }; },
  };
}

// ---- deterministic fakes for the snapshot-correctness injection points ----
// Production PR reviews build an isolated `git worktree` at the exact HEAD
// and diff explicit fetched SHAs (prWorktree.js / prEvidence.js) — real git,
// deliberately NOT exercised by these fast in-memory controller tests. These
// fakes give the controller the SAME shaped result without touching git, so
// a test can still assert exact-HEAD binding, drift detection, and repository
// identity fail-closed behaviour deterministically.

// resolvePrRepositoryIdentityFn — cwd repo == PR repo, by construction here.
export function fakePrRepositoryIdentity(nameWithOwner = 'acme/repo') {
  return async () => ({ ok: true, nameWithOwner });
}

// buildPrSnapshotFn — no real worktree; the callback just runs against the
// scripted `cwd`/`headSha` directly. `mergeBase` is the PR's declared base SHA
// (tests never need a real merge-base computation).
export function fakePrSnapshot() {
  return async ({ cwd, baseSha, headSha }, fn) => fn({
    worktreeDir: cwd, mergeBase: baseSha, headSha, baseSha,
  });
}

// collectPrDeltaFn — pulls the scripted diff/changed-files straight from the
// mockPrBackend's per-head maps, keyed EXACTLY by the snapshot's headSha (so a
// test can prove an old HEAD's evidence never leaks onto a new HEAD).
export function fakeCollectPrDelta(prBackend) {
  return async ({ mergeBase, headSha }) => {
    const diff = await prBackend.getPrDiff({ headSha });
    const changedFiles = await prBackend.getPrChangedFiles({ headSha });
    const fingerprint = sha256(`${headSha}\n${diff}`);
    const noWorkerChangeYet = mergeBase === headSha || String(diff ?? '').trim() === '';
    return {
      baselineHead: mergeBase, baseSha: mergeBase, mergeBase,
      currentHead: headSha, reviewedHeadSha: headSha,
      fingerprint, diff, changedFiles,
      evidenceComplete: true, incompleteReasons: [], noWorkerChangeYet,
    };
  };
}

// Bundle all three injection points for one mockPrBackend — spread this into
// createReviewLoopController({ prBackend, ...prTestFakes(prBackend) }).
export function prTestFakes(prBackend, { repo = 'acme/repo' } = {}) {
  return {
    resolvePrRepositoryIdentityFn: fakePrRepositoryIdentity(repo),
    buildPrSnapshotFn: fakePrSnapshot(),
    collectPrDeltaFn: fakeCollectPrDelta(prBackend),
  };
}
