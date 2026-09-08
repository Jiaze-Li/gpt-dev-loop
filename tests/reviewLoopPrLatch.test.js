// PR-level HUMAN_REQUIRED latch: a PR whose loop exhausts its review-round
// budget with blocking findings still open cannot be silently restarted with a
// fresh reviewloop_begin. Only an explicit one-shot human approval grants a new
// budget. Deterministic; zero network, zero real providers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readPrLatch,
  grantPrLatchApproval,
  armPrLatch,
  consumePrLatchForBegin,
  resolvePrLatch,
  isBeginBlocked,
  resolveRepositoryIdentity,
  prLatchKey,
  PR_LATCH_STATUS,
} from '../src/reviewloop/prLatch.js';

const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };
const TRUSTED = { codex: 'chatgpt-codex-connector[bot]', claude: 'claude[bot]' };

function stamp(raw, headSha, reviewer = 'codex') {
  if (!raw) return raw;
  return { login: TRUSTED[reviewer], headSha, head_sha: headSha, ...raw };
}

function mockPrBackend({ heads = ['H1', 'H2', 'H3', 'H4', 'H5'], results = {}, reviewer = 'codex' } = {}) {
  const state = { headIdx: 0, triggers: [], waits: 0 };
  return {
    state,
    async getPrHead() { return heads[Math.min(state.headIdx, heads.length - 1)]; },
    advanceHead() { state.headIdx += 1; },
    async findExistingReview() { return null; },
    async postReviewTrigger({ headSha }) { state.triggers.push(headSha); return { id: `c-${headSha}` }; },
    async waitForReview({ headSha }) { state.waits += 1; return stamp(results[headSha] ?? { findings: [P1] }, headSha, reviewer); },
  };
}

function makeController(persistence, prBackend, { repoIdentity = 'test-repo:pr-latch' } = {}) {
  return createReviewLoopController({
    persistence,
    prBackend,
    resolveRepoIdentityFn: async () => repoIdentity,
    supervisorFn: async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

// Drive a PR loop to round-3 non-convergence.
async function exhaust(controller, backend, { prNumber = 4, goal = 'g', cwd = '/r' } = {}) {
  const begun = await controller.begin({ goal, cwd, prNumber });
  assert.equal(begun.status, 'READY');
  const { loopId } = begun;
  await controller.review({ loopId }); backend.advanceHead();
  await controller.review({ loopId }); backend.advanceHead();
  const r3 = await controller.review({ loopId });
  return { loopId, r3 };
}

test('round-3 non-convergence returns HUMAN_REQUIRED and arms a durable PR latch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const controller = makeController(persistence, backend);
  const { loopId, r3 } = await exhaust(controller, backend);

  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.ok(r3.latch, 'the HUMAN_REQUIRED result carries latch metadata');
  assert.equal(r3.latch.armed, true);
  assert.equal(r3.latch.exhaustedLoopId, loopId);

  const latch = await readPrLatch(persistence, { repositoryIdentity: 'test-repo:pr-latch', prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal(latch.exhaustedLoopId, loopId);
  assert.equal(latch.exhaustedHead, 'H3');
  assert.equal(latch.round, 3);
  assert.equal(latch.maxRounds, 3);
  assert.ok(latch.reason);
  assert.ok(latch.createdAt);
  assert.equal(latch.latchCount, 1);
});

test('a fresh reviewloop_begin for the latched PR is refused with zero new triggers', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const controller = makeController(persistence, backend);
  await exhaust(controller, backend);
  const triggersAfterExhaust = backend.state.triggers.length;

  const blocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(blocked.loopId, null);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /pr-latch approve 4/);
  assert.equal(backend.state.triggers.length, triggersAfterExhaust, 'no new review trigger from a blocked begin');
});

test('the latch survives an MCP/runtime restart (new controller, same persistence)', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  const fresh = makeController(persistence, mockPrBackend());
  const blocked = await fresh.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
});

test('the latch is not cleared by a changed PR HEAD', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  const b2 = mockPrBackend();
  b2.advanceHead(); b2.advanceHead(); b2.advanceHead(); // PR HEAD is now H4
  const blocked = await makeController(persistence, b2).begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
});

test('editing code and pushing a new HEAD does not clear the latch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);
  // "Worker edits + pushes" == a new commit. Still blocked.
  const b2 = mockPrBackend({ heads: ['Hnew'] });
  const blocked = await makeController(persistence, b2).begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(b2.state.triggers.length, 0);
});

test('a different PR is unaffected by another PR being latched', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend, { prNumber: 4 });

  const other = mockPrBackend({ results: { H1: { findings: [] } } });
  const begun = await makeController(persistence, other).begin({ goal: 'g', cwd: '/r', prNumber: 5 });
  assert.equal(begun.status, 'READY');
  assert.ok(begun.loopId);
});

test('LOCAL-mode loops are never touched by a PR latch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend, { prNumber: 4 });

  const local = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FP', diff: 'd' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo'], manifestFingerprint: 'mf' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const begun = await local.begin({ goal: 'g', cwd: '/r' });
  assert.equal(begun.status, 'READY');
  const r = await local.review({ loopId: begun.loopId });
  assert.equal(r.status, 'PASS');
});

test('an explicit human approval grants exactly one new loop starting at round 1', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  const grant = await grantPrLatchApproval(persistence, {
    repositoryIdentity: 'test-repo:pr-latch', prNumber: 4, approvedBy: 'jack', note: 'reviewed manually',
  });
  assert.equal(grant.ok, true);

  const b2 = mockPrBackend({ heads: ['H10'], results: { H10: { findings: [] } } });
  const c2 = makeController(persistence, b2);
  const begun = await c2.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(begun.status, 'READY', 'approval let exactly one new loop begin');
  assert.ok(begun.loopId);

  // A SECOND begin (same approval) is refused again.
  const blockedAgain = await c2.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blockedAgain.status, 'HUMAN_APPROVAL_REQUIRED');

  // The approved loop runs a fresh budget from round 1.
  const r1 = await c2.review({ loopId: begun.loopId });
  assert.equal(r1.round, 1);
  assert.equal(r1.status, 'PASS');

  // PASS clears the latch — the PR is back to normal.
  const latch = await readPrLatch(persistence, { repositoryIdentity: 'test-repo:pr-latch', prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.RESOLVED);
  const begun2 = await c2.begin({ goal: 'g2', cwd: '/r', prNumber: 4 });
  assert.equal(begun2.status, 'READY');
});

test('an approved loop that also exhausts its rounds re-latches the PR', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  await grantPrLatchApproval(persistence, {
    repositoryIdentity: 'test-repo:pr-latch', prNumber: 4, approvedBy: 'jack',
  });

  const b2 = mockPrBackend({ heads: ['Ha', 'Hb', 'Hc'] }); // every review still blocking
  const c2 = makeController(persistence, b2);
  const { r3 } = await exhaust(c2, b2);
  assert.equal(r3.status, 'HUMAN_REQUIRED');

  const latch = await readPrLatch(persistence, { repositoryIdentity: 'test-repo:pr-latch', prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal(latch.latchCount, 2, 'the PR re-latched');
  assert.equal(latch.approval, null, 'the re-latch requires a brand-new approval');

  const blocked = await c2.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
});

test('the Worker cannot forge a bypass through ordinary begin params', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  // Different reviewer, different goal, different cwd string — same repo + PR.
  for (const args of [
    { goal: 'totally different goal', cwd: '/r', prNumber: 4, reviewer: 'claude' },
    { goal: 'g', cwd: '/r/./', prNumber: 4 },
    { goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await makeController(persistence, mockPrBackend()).begin(args);
    assert.equal(res.status, 'HUMAN_APPROVAL_REQUIRED', JSON.stringify(args));
  }
});

test('concurrent begins cannot both consume one human approval', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  await exhaust(makeController(persistence, backend), backend);

  await grantPrLatchApproval(persistence, {
    repositoryIdentity: 'test-repo:pr-latch', prNumber: 4, approvedBy: 'jack',
  });

  const c = makeController(persistence, mockPrBackend({ heads: ['Hx'], results: { Hx: { findings: [] } } }));
  const [a, b] = await Promise.all([
    c.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
    c.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['HUMAN_APPROVAL_REQUIRED', 'READY'], 'exactly one begin consumed the approval');

  const latch = await readPrLatch(persistence, { repositoryIdentity: 'test-repo:pr-latch', prNumber: 4 });
  assert.equal(latch.approval.consumedByLoopId, (a.status === 'READY' ? a.loopId : b.loopId));
});

test('prLatchKey isolates by repository identity and PR number', () => {
  assert.notEqual(prLatchKey('repoA', 4), prLatchKey('repoB', 4));
  assert.notEqual(prLatchKey('repoA', 4), prLatchKey('repoA', 5));
  assert.equal(prLatchKey('repoA', 4), prLatchKey('repoA', 4));
  assert.match(prLatchKey('repoA', 4), /^pr-latch-[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------------------
// prLatch state-machine unit tests (no controller)
// ---------------------------------------------------------------------------
const REPO = 'unit-repo';
const clk = () => Date.parse('2026-09-08T12:00:00Z');

test('arm -> begin blocked; grant -> begin consumes exactly once; consume again blocked', async () => {
  const p = new MemoryPersistence();
  await armPrLatch(p, {
    repositoryIdentity: REPO, prNumber: 7, exhaustedLoopId: 'rl-old', exhaustedHead: 'HEADAAA',
    reason: 'still 2 blocking finding(s) after 3 review round(s)', round: 3, maxRounds: 3, clock: clk,
  });
  assert.equal(isBeginBlocked(await readPrLatch(p, { repositoryIdentity: REPO, prNumber: 7 })), true);
  assert.equal((await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 7, newLoopId: 'rl-new' })).allowed, false);

  const g = await grantPrLatchApproval(p, { repositoryIdentity: REPO, prNumber: 7, approvedBy: 'jack', clock: clk });
  assert.equal(g.ok, true);
  // a second grant while one is pending is refused
  assert.equal((await grantPrLatchApproval(p, { repositoryIdentity: REPO, prNumber: 7, approvedBy: 'jack', clock: clk })).ok, false);

  const c1 = await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 7, newLoopId: 'rl-approved', clock: clk });
  assert.equal(c1.allowed, true);
  assert.equal(c1.consumedApprovalId, g.approvalId);
  const c2 = await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 7, newLoopId: 'rl-approved-2', clock: clk });
  assert.equal(c2.allowed, false, 'the one-shot approval is spent');
});

test('grant while CONSUMED supersedes an abandoned approved loop', async () => {
  const p = new MemoryPersistence();
  await armPrLatch(p, { repositoryIdentity: REPO, prNumber: 8, exhaustedLoopId: 'rl-x', exhaustedHead: 'H', reason: 'r', round: 3, maxRounds: 3, clock: clk });
  const g1 = await grantPrLatchApproval(p, { repositoryIdentity: REPO, prNumber: 8, approvedBy: 'jack', clock: clk });
  await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 8, newLoopId: 'rl-abandoned', clock: clk });

  const g2 = await grantPrLatchApproval(p, { repositoryIdentity: REPO, prNumber: 8, approvedBy: 'jack', note: 'previous loop stalled', clock: clk });
  assert.equal(g2.ok, true);
  assert.equal(g2.supersededLoopId, 'rl-abandoned');
  assert.notEqual(g2.approvalId, g1.approvalId);
  const latch = await readPrLatch(p, { repositoryIdentity: REPO, prNumber: 8 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal((await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 8, newLoopId: 'rl-retry', clock: clk })).allowed, true);
});

test('resolvePrLatch clears the block; re-arm bumps latchCount and drops the stale approval', async () => {
  const p = new MemoryPersistence();
  await armPrLatch(p, { repositoryIdentity: REPO, prNumber: 9, exhaustedLoopId: 'rl-1', exhaustedHead: 'H1', reason: 'r', round: 3, maxRounds: 3, clock: clk });
  await grantPrLatchApproval(p, { repositoryIdentity: REPO, prNumber: 9, approvedBy: 'jack', clock: clk });
  await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 9, newLoopId: 'rl-2', clock: clk });
  await resolvePrLatch(p, { repositoryIdentity: REPO, prNumber: 9, byLoopId: 'rl-2', clock: clk });

  let latch = await readPrLatch(p, { repositoryIdentity: REPO, prNumber: 9 });
  assert.equal(latch.status, PR_LATCH_STATUS.RESOLVED);
  assert.equal(isBeginBlocked(latch), false);
  assert.equal((await consumePrLatchForBegin(p, { repositoryIdentity: REPO, prNumber: 9, newLoopId: 'rl-3', clock: clk })).allowed, true);

  await armPrLatch(p, { repositoryIdentity: REPO, prNumber: 9, exhaustedLoopId: 'rl-3', exhaustedHead: 'H9', reason: 'r2', round: 3, maxRounds: 3, clock: clk });
  latch = await readPrLatch(p, { repositoryIdentity: REPO, prNumber: 9 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal(latch.latchCount, 2);
  assert.equal(latch.approval, null);
});

test('resolveRepositoryIdentity honours REVIEWLOOP_GH_REPO and falls back to path', async () => {
  assert.equal(
    await resolveRepositoryIdentity({ cwd: '/x', env: { REVIEWLOOP_GH_REPO: 'owner/repo' } }),
    'github:owner/repo',
  );
  const failing = async () => { throw new Error('no'); };
  assert.equal(
    await resolveRepositoryIdentity({ cwd: '/x/y', env: {}, execFile: failing }),
    'path:/x/y',
  );
});

test('CLI: pr-latch approve is refused with no latch, then grants a one-shot approval that begin consumes', async () => {
  const { Persistence } = await import('../src/orchestrator/persistence.js');
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-latch-cli-'));
  const bin = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
  const env = { ...process.env, REVIEWLOOP_RUNTIME_DIR: runtimeDir, REVIEWLOOP_GH_REPO: 'acme/widgets' };
  const repositoryIdentity = 'github:acme/widgets';
  try {
    // no latch -> approve exits non-zero
    assert.throws(() => execFileSync('node', [bin, 'pr-latch', 'approve', '4'], { env, encoding: 'utf8', stdio: 'pipe' }));

    // arm a latch, then approve via the CLI
    const persistence = new Persistence(runtimeDir);
    await armPrLatch(persistence, {
      repositoryIdentity, prNumber: 4, exhaustedLoopId: 'rl-exhausted', exhaustedHead: 'DEADBEEF',
      reason: 'still 1 blocking finding(s) after 3 review round(s)', round: 3, maxRounds: 3,
    });

    const approveOut = execFileSync('node', [bin, 'pr-latch', 'approve', '4', '--note', 'looks fine'], { env, encoding: 'utf8' });
    assert.match(approveOut, /Approved one fresh ReviewLoop budget for PR #4/);

    const statusOut = execFileSync('node', [bin, 'pr-latch', 'status', '4'], { env, encoding: 'utf8' });
    assert.match(statusOut, /pendingApproval=/);

    // the controller now lets exactly one begin through
    const backend = mockPrBackend({ heads: ['Hcli'], results: { Hcli: { findings: [] } } });
    const controller = createReviewLoopController({ persistence, prBackend: backend, resolveRepoIdentityFn: async () => repositoryIdentity });
    const begun = await controller.begin({ goal: 'g', cwd: '/whatever', prNumber: 4 });
    assert.equal(begun.status, 'READY');
    const blocked = await controller.begin({ goal: 'g', cwd: '/whatever', prNumber: 4 });
    assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
