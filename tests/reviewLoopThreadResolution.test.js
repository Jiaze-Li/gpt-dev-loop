// GitHub review-thread resolution as a first-class part of the ReviewLoop PR
// lifecycle. Deterministic; zero real provider calls, zero network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

const BOT = 'chatgpt-codex-connector[bot]';

// A trusted aggregated review for `head` with the given inline findings. Mirrors
// the shape the real githubBackend emits (durable thread identity per finding).
function review(head, findings = []) {
  return {
    login: BOT,
    headSha: head,
    head_sha: head,
    review_id: `rev-${head}`,
    findings: findings.map((f, i) => ({
      severity: f.severity ?? 'P1',
      file: f.file ?? 'a.js',
      line: f.line ?? 1,
      title: f.title ?? 'bug X',
      reviewId: `rev-${head}`,
      commentId: `c-${head}-${i}`,
      threadNodeId: f.threadNodeId ?? `T-${head}-${i}`,
      reviewedHead: head,
      reviewerLogin: BOT,
    })),
  };
}

// Default live enumeration: one pure-Codex thread per finding across every
// review this backend can serve. Tests that need a different live shape (human
// reply, missing thread, throwing enumeration) pass `threads` explicitly.
function defaultThreads(results, existing) {
  const nodes = [];
  const seen = new Set();
  for (const rv of [...Object.values(results), ...Object.values(existing)]) {
    for (const f of rv?.findings ?? []) {
      if (seen.has(f.threadNodeId)) continue;
      seen.add(f.threadNodeId);
      nodes.push({
        threadNodeId: f.threadNodeId,
        isResolved: false,
        comments: [{ authorLogin: BOT, commentDatabaseId: f.commentId }],
      });
    }
  }
  return nodes;
}

function mockBackend({
  heads = ['H1'], results = {}, existing = {}, threads, reviewer = 'codex',
  resolveFail = () => false,
} = {}) {
  if (threads === undefined) threads = defaultThreads(results, existing);
  const state = {
    headIdx: 0, triggers: [], resolved: [], threadListCalls: 0, resolveAttempts: [],
  };
  const backend = {
    state,
    async getPrHead() { return heads[Math.min(state.headIdx, heads.length - 1)]; },
    advanceHead() { state.headIdx += 1; },
    async findExistingReview({ headSha }) { return existing[headSha] ?? null; },
    async postReviewTrigger({ headSha }) { state.triggers.push(headSha); return { id: `comment-${headSha}` }; },
    async waitForReview({ headSha }) { return results[headSha] ?? null; },
    async resolveReviewThread({ threadNodeId }) {
      state.resolveAttempts.push(threadNodeId);
      if (resolveFail(threadNodeId, state)) throw new Error('GraphQL 502 from GitHub');
      state.resolved.push(threadNodeId);
      return { threadNodeId, resolved: true };
    },
  };
  if (threads !== undefined) {
    backend.listReviewThreads = async () => {
      state.threadListCalls += 1;
      return typeof threads === 'function' ? threads(state) : threads;
    };
  }
  return backend;
}

function build(prBackend) {
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({
    persistence,
    prBackend,
    supervisorFn: async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  return { controller, persistence };
}

async function managedThreads(persistence, loopId) {
  return (await persistence.readWorkflowState(loopId)).reviewLoop.managedThreads;
}

// 1. P1 on H1 -> fixed -> trusted clean review on H2 -> H1 thread resolved.
test('P1 on H1 cleared by a trusted clean review on H2 resolves the H1 thread', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'null deref' }]), H2: review('H2', []) },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });

  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  assert.deepEqual((await managedThreads(persistence, loopId)).map((m) => m.status), ['OPEN']);

  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
  const mts = await managedThreads(persistence, loopId);
  assert.equal(mts[0].status, 'RESOLVED');
  assert.equal(mts[0].resolvedOnHead, 'H2');
  assert.equal(mts[0].verificationReviewId, 'rev-H2');
});

test('scope check treats the GraphQL bare bot slug as the allowlisted "<slug>[bot]" reviewer', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'null deref' }]), H2: review('H2', []) },
    threads: [
      // GraphQL Actor.login for a Bot has no "[bot]" suffix, unlike the REST allowlist entry.
      { threadNodeId: 'T-H1-0', isResolved: false, isOutdated: false, comments: [
        { authorLogin: 'chatgpt-codex-connector', commentDatabaseId: 'c-H1-0' },
      ] },
    ],
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
});

// 2. P1 on H1 -> SAME finding on H2 -> H1 thread remains unresolved.
test('the same blocking finding recurring on H2 keeps the H1 thread unresolved', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: {
      H1: review('H1', [{ title: 'same bug' }]),
      H2: review('H2', [{ title: 'same bug' }]),
    },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK');
  assert.deepEqual(backend.state.resolved, []);
  const mts = await managedThreads(persistence, loopId);
  // The H1 thread stays unresolved; the recurrence on H2 is tracked as its own
  // new open thread (treated as a normal finding).
  assert.equal(mts.find((m) => m.threadNodeId === 'T-H1-0').status, 'OPEN');
  assert.equal(mts.find((m) => m.threadNodeId === 'T-H2-0').status, 'OPEN');
});

// 3. P1 on H1 -> DIFFERENT P1 on H2 -> H1 resolved, H2 remains open.
test('a different P1 on H2 resolves the H1 thread and leaves the H2 thread open', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: {
      H1: review('H1', [{ title: 'bug one' }]),
      H2: review('H2', [{ title: 'bug two' }]),
    },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
  const mts = await managedThreads(persistence, loopId);
  assert.equal(mts.find((m) => m.threadNodeId === 'T-H1-0').status, 'RESOLVED');
  assert.equal(mts.find((m) => m.threadNodeId === 'T-H2-0').status, 'OPEN');
});

// 4. A clean 👍 on the exact H2 trigger (a trusted review with no findings)
//    resolves cleared H1 findings.
test('a clean trusted review with no findings on H2 resolves the cleared H1 thread', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]) },
    // H2: no waitForReview result, but a pre-existing clean review is found.
    existing: { H2: review('H2', []) },
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
});

// 5. A stale-head review cannot resolve anything.
test('a review bound to a stale head never resolves a prior thread', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: {
      H1: review('H1', [{ title: 'bug' }]),
      // The "H2" wait returns a review still stamped to H1 — stale.
      H2: review('H1', []),
    },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.notEqual(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'OPEN');
});

// 6. An untrusted reviewer cannot resolve anything.
test('an untrusted review on H2 cannot resolve the H1 thread', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: {
      H1: review('H1', [{ title: 'bug' }]),
      H2: { ...review('H2', []), login: 'evil-codex[bot]' },
    },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.notEqual(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'OPEN');
});

// 7. An unrelated / human thread is never resolved.
test('only the ReviewLoop-managed thread is resolved — a human thread is untouched', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-H1-0', isResolved: false, comments: [{ authorLogin: BOT, commentDatabaseId: 'c-H1-0' }] },
      { threadNodeId: 'T-HUMAN', isResolved: false, comments: [{ authorLogin: 'Jiaze-Li', commentDatabaseId: 'c-human' }] },
    ],
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
  assert.ok(!backend.state.resolved.includes('T-HUMAN'));
});

// 7b. A managed thread whose live enumeration shows a non-reviewer comment is
//     NOT resolved (fail closed), and PASS is withheld.
test('a managed thread that live enumeration shows carrying a human comment is not resolved', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-H1-0', isResolved: false, comments: [
        { authorLogin: BOT, commentDatabaseId: 'c-H1-0' },
        { authorLogin: 'Jiaze-Li', commentDatabaseId: 'c-x' },
      ] },
    ],
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolved, []);
});

// 7c. Live enumeration throws -> resolveReviewThread is never called, PASS withheld.
test('a throwing live thread enumeration fails closed: no resolve call, no PASS', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: () => { throw new Error('GraphQL 502 from GitHub'); },
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolveAttempts, []);
  assert.deepEqual(backend.state.resolved, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'RESOLVE_FAILED');
});

// 7d. Live enumeration returns null / unverifiable -> fails closed.
test('a null (unverifiable) live thread enumeration fails closed', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: null,
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolveAttempts, []);
});

// 7e. The managed thread is absent from a successful live enumeration -> fails closed.
test('a managed thread missing from the live enumeration is not resolved', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-SOMETHING-ELSE', isResolved: false, comments: [{ authorLogin: BOT }] },
    ],
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolveAttempts, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'RESOLVE_FAILED');
});

// 7e-ii. GitHub reports the managed thread outdated -> scope check fails closed.
test('an outdated live thread is not resolved', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-H1-0', isResolved: false, isOutdated: true, comments: [{ authorLogin: BOT, commentDatabaseId: 'c-H1-0' }] },
    ],
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolved, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'RESOLVE_FAILED');
});

// 7e-iii. The thread's comment list was truncated (paging) -> fails closed:
// a human reply past the first comment page cannot be ruled out.
test('a truncated-comment live thread is not resolved', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-H1-0', isResolved: false, commentsTruncated: true, comments: [{ authorLogin: BOT, commentDatabaseId: 'c-H1-0' }] },
    ],
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.deepEqual(backend.state.resolved, []);
});

// 7f. An already-resolved live thread is recorded as success with no mutation.
test('an already-resolved live thread is recorded RESOLVED without a resolve mutation', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    threads: [
      { threadNodeId: 'T-H1-0', isResolved: true, comments: [{ authorLogin: BOT }] },
    ],
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolveAttempts, []);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'RESOLVED');
});

// 8. Restart between the H1 REWORK and the H2 review preserves thread identity.
test('restart between H1 REWORK and H2 review preserves durable thread identity', async () => {
  const persistence = new MemoryPersistence();
  const b1 = mockBackend({ heads: ['H1', 'H2'], results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) } });
  const c1 = createReviewLoopController({ persistence, prBackend: b1 });
  const { loopId } = await c1.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await c1.review({ loopId });
  const before = (await managedThreads(persistence, loopId))[0];
  assert.deepEqual(
    { threadNodeId: before.threadNodeId, reviewId: before.reviewId, commentId: before.commentId, head: before.head, reviewerLogin: before.reviewerLogin },
    { threadNodeId: 'T-H1-0', reviewId: 'rev-H1', commentId: 'c-H1-0', head: 'H1', reviewerLogin: BOT },
  );

  // Fresh process: new controller + new backend, same persistence.
  // The H1 thread still exists on the PR (unresolved) — the live enumeration
  // returns it even though the H2 clean review introduces no new threads.
  const b2 = mockBackend({
    heads: ['H2'],
    results: { H2: review('H2', []) },
    threads: [{ threadNodeId: 'T-H1-0', isResolved: false, comments: [{ authorLogin: BOT }] }],
  });
  const c2 = createReviewLoopController({ persistence, prBackend: b2 });
  const r = await c2.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(b2.state.resolved, ['T-H1-0']);
  const after = (await managedThreads(persistence, loopId))[0];
  assert.equal(after.threadNodeId, 'T-H1-0');
  assert.equal(after.status, 'RESOLVED');
});

// 9. A GitHub resolve failure cannot produce a false PASS.
test('a GitHub resolve failure withholds PASS and reports HUMAN_REQUIRED', async () => {
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    resolveFail: () => true,
  });
  const { controller, persistence } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'HUMAN_REQUIRED');
  assert.match(r2.reason, /PASS withheld/);
  assert.match(r2.reason, /infrastructure\/retry/);
  assert.equal((await managedThreads(persistence, loopId))[0].status, 'RESOLVE_FAILED');
  // The retry inside the PASS gate means at least two attempts were made.
  assert.ok(backend.state.resolveAttempts.length >= 2);
});

test('a transient resolve failure that clears on the PASS-gate retry still PASSes', async () => {
  let calls = 0;
  const backend = mockBackend({
    heads: ['H1', 'H2'],
    results: { H1: review('H1', [{ title: 'bug' }]), H2: review('H2', []) },
    resolveFail: () => { calls += 1; return calls === 1; },
  });
  const { controller } = build(backend);
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  await controller.review({ loopId });
  backend.advanceHead();
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'PASS');
  assert.deepEqual(backend.state.resolved, ['T-H1-0']);
});

// Transport: enumerate + resolve by node id, and the safety boundary.
test('the gh transport exposes review-thread enumeration + resolution and nothing that writes code', async () => {
  const { createGhTransport } = await import('../src/reviewloop/githubBackend.js');
  const calls = [];
  const t = createGhTransport({
    repo: 'o/r',
    execFile: async (_bin, args) => {
      calls.push(args.join(' '));
      if (args.includes('graphql') && args.some((a) => a.startsWith('query=mutation'))) {
        return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'TID', isResolved: true } } } }) };
      }
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
          { id: 'TID', isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 42, author: { login: 'x' }, pullRequestReview: { databaseId: 7 }, path: 'a.js', originalCommit: { oid: 'H1' }, commit: { oid: 'H2' } }] } },
        ] } } } } }) };
      }
      return { stdout: '' };
    },
  });
  const threads = await t.listReviewThreads({ prNumber: 4 });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadNodeId, 'TID');
  assert.equal(threads[0].comments[0].commentDatabaseId, '42');
  assert.equal(threads[0].comments[0].reviewDatabaseId, '7');
  assert.equal(threads[0].commentsTruncated, false);
  const res = await t.resolveReviewThread({ threadNodeId: 'TID' });
  assert.deepEqual(res, { threadNodeId: 'TID', resolved: true });

  const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/reviewloop/threadResolution.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /git push|gh pr merge|forcePush|--force|commit -m/);
});

test('parseReviewThreadPages flags a thread whose comments connection is truncated', async () => {
  const { createGhTransport } = await import('../src/reviewloop/githubBackend.js');
  const t = createGhTransport({
    repo: 'o/r',
    execFile: async (_bin, args) => {
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
          { id: 'T1', isResolved: false, isOutdated: false, comments: { pageInfo: { hasNextPage: true }, totalCount: 140, nodes: [{ databaseId: 1, author: { login: 'x' } }] } },
          { id: 'T2', isResolved: false, isOutdated: false, comments: { pageInfo: { hasNextPage: false }, totalCount: 2, nodes: [{ databaseId: 2, author: { login: 'x' } }, { databaseId: 3, author: { login: 'y' } }] } },
        ] } } } } }) };
      }
      return { stdout: '' };
    },
  });
  const threads = await t.listReviewThreads({ prNumber: 4 });
  assert.equal(threads.find((x) => x.threadNodeId === 'T1').commentsTruncated, true);
  assert.equal(threads.find((x) => x.threadNodeId === 'T2').commentsTruncated, false);
});

test('resolveReviewThread fails closed when GitHub does not confirm resolution', async () => {
  const { createGhTransport } = await import('../src/reviewloop/githubBackend.js');
  const t = createGhTransport({
    repo: 'o/r',
    execFile: async () => ({ stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'TID', isResolved: false } } } }) }),
  });
  await assert.rejects(() => t.resolveReviewThread({ threadNodeId: 'TID' }), /did not confirm/);
});
