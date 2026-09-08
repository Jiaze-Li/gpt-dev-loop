// V2 PR-mode correctness/liveness defect regressions + this round's fresh Codex
// review findings. Deterministic; zero real provider calls, zero network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import { terminateProcessTree } from '../src/orchestrator/processTree.js';
import { runGate, GATE_VERDICTS } from '../src/reviewloop/gatePolicy.js';
import { checkMcpServerBinding } from '../scripts/doctor.js';
import { installGlobal } from '../bin/install-plugin.js';

const BOT = 'chatgpt-codex-connector[bot]';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const WRAPPER = [
  '', '### 💡 Codex Review', '',
  'Here are some automated review suggestions for this pull request.', '',
  `**Reviewed commit:** \`${HEAD.slice(0, 10)}\``, '',
  '<details> <summary>ℹ️ About Codex in GitHub</summary></details>',
].join('\n');

function badge(sev) {
  return `**<sub><sub>![${sev} Badge](https://img.shields.io/badge/${sev}-orange?style=flat)</sub></sub>  ${sev} finding title**\n\nBody text here.\n\nUseful? React with 👍 / 👎.`;
}

function backend({
  reviews = [], comments = [], reactions = [], head = HEAD, heads = null,
} = {}) {
  let call = 0;
  return createGithubReviewBackend({
    pollIntervalMs: 1,
    maxWaitMs: 50,
    sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() {
        if (Array.isArray(heads)) { const h = heads[Math.min(call, heads.length - 1)]; call += 1; return h; }
        return head;
      },
      async listReviews() { return reviews; },
      async listReviewComments() { return comments; },
      async listIssueCommentReactions() { return reactions; },
      async postComment() { return { id: 'https://github.com/o/r/pull/4#issuecomment-999' }; },
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Codex wrapper + 6 inline findings -> exactly 6 findings, 4 P1 + 2 P2.
// ---------------------------------------------------------------------------
test('Codex wrapper + 6 inline findings parse to exactly 6 findings (4×P1 + 2×P2), not all P2', async () => {
  const REVIEW_ID = 5139035349;
  const inline = ['P1', 'P1', 'P1', 'P1', 'P2', 'P2'].map((sev, i) => ({
    login: BOT, body: badge(sev), path: `src/f${i}.js`, line: 10 + i,
    commitId: HEAD, originalCommitId: HEAD, pullRequestReviewId: REVIEW_ID, id: 100 + i,
  }));
  const agg = await backend({
    reviews: [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: REVIEW_ID }],
    comments: inline,
  }).findExistingReview({ prNumber: 4, headSha: HEAD, reviewer: 'codex' });

  assert.ok(agg, 'aggregated review produced');
  assert.equal(agg.findings.length, 6, 'exactly the 6 real inline findings, no synthetic wrapper finding');
  const p1 = agg.findings.filter((f) => f.severity === 'P1').length;
  const p2 = agg.findings.filter((f) => f.severity === 'P2').length;
  assert.equal(p1, 4, '4 P1 badges parsed as P1');
  assert.equal(p2, 2, '2 P2 badges parsed as P2');
});

// ---------------------------------------------------------------------------
// 2. Wrapper-only -> not PASS, not a synthetic P2, no duplicate trigger.
// ---------------------------------------------------------------------------
test('a Codex wrapper submission with no inline findings and no 👍 is not a reviewed state', async () => {
  const agg = await backend({
    reviews: [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: 1 }],
  }).findExistingReview({ prNumber: 4, headSha: HEAD, reviewer: 'codex' });
  assert.equal(agg, null, 'wrapper-only is neither CLEAN nor a synthetic blocker — keep waiting');
});

test('wrapper-only during obtainReview -> WAITING_FOR_REVIEW, exactly one trigger posted', async () => {
  const posts = [];
  const be = createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 20, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: 1 }]; },
      async listReviewComments() { return []; },
      async listIssueCommentReactions() { return []; },
      async postComment() { posts.push(1); return { id: 'https://x#issuecomment-1' }; },
    },
  });
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({ persistence, prBackend: be });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'WAITING_FOR_REVIEW');
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'WAITING_FOR_REVIEW');
  assert.equal(posts.length, 1, 'no duplicate trigger for the same HEAD');
});

// ---------------------------------------------------------------------------
// 3. Exact current trigger + trusted Codex bot 👍 -> CLEAN -> PASS.
// ---------------------------------------------------------------------------
test('a +1 by the trusted Codex bot on the exact current trigger comment -> PASS', async () => {
  const be = createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 20, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: 1 }]; },
      async listReviewComments() { return []; },
      async listIssueCommentReactions({ commentId }) {
        assert.match(String(commentId), /issuecomment-777/);
        return [{ content: '+1', login: BOT }];
      },
      async postComment() { return { id: 'https://github.com/o/r/pull/4#issuecomment-777' }; },
    },
  });
  const controller = createReviewLoopController({ persistence: new MemoryPersistence(), prBackend: be });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
});

// ---------------------------------------------------------------------------
// 4. user 👍 / untrusted bot 👍 / eyes / old-trigger 👍 -> never PASS.
// ---------------------------------------------------------------------------
for (const [label, reactions] of [
  ['the PR author', [{ content: '+1', login: 'Jiaze-Li' }]],
  ['an untrusted bot', [{ content: '+1', login: 'evil-codex[bot]' }]],
  ['an eyes reaction from the bot', [{ content: 'eyes', login: BOT }]],
]) {
  test(`a 👍/reaction by ${label} on the trigger comment does NOT PASS`, async () => {
    const agg = await backend({
      reviews: [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: 1 }],
      reactions,
    }).findExistingReview({ prNumber: 4, headSha: HEAD, reviewer: 'codex', triggerCommentId: 'https://x#issuecomment-1' });
    assert.equal(agg, null);
  });
}

test('a +1 on an OLD trigger comment (not this HEAD) does not PASS the new HEAD', async () => {
  // The controller only forwards triggerCommentId when pendingExternalTrigger.head
  // matches the current HEAD, so an old-round trigger id is simply never passed.
  const be = createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 10, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() { return HEAD_B; },
      async listReviews() { return []; },
      async listReviewComments() { return []; },
      // The 👍 exists ONLY on the OLD trigger comment, never on the new one.
      async listIssueCommentReactions({ commentId }) {
        return /issuecomment-OLD/.test(String(commentId)) ? [{ content: '+1', login: BOT }] : [];
      },
      async postComment() { return { id: 'https://x#issuecomment-new' }; },
    },
  });
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({ persistence, prBackend: be });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  // Plant a stale pending trigger for a different HEAD.
  const st = await persistence.readWorkflowState(loopId);
  st.reviewLoop.pendingExternalTrigger = { head: HEAD, reviewer: 'codex', status: 'TRIGGERED', commentId: 'https://x#issuecomment-OLD' };
  await persistence.updateWorkflowState(loopId, { reviewLoop: st.reviewLoop });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS');
});

// ---------------------------------------------------------------------------
// 5. Restart: pending trigger keeps its commentId; resume does not re-trigger.
// ---------------------------------------------------------------------------
test('after a restart the pending trigger keeps its exact comment id and resume does not re-trigger', async () => {
  const posts = [];
  let reacted = false;
  const mk = () => createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 15, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() { return HEAD; },
      async listReviews() { return [{ login: BOT, state: 'COMMENTED', commitId: HEAD, body: WRAPPER, submittedAt: '2026-09-08', id: 1 }]; },
      async listReviewComments() { return []; },
      async listIssueCommentReactions() { return reacted ? [{ content: '+1', login: BOT }] : []; },
      async postComment() { posts.push(1); return { id: 'https://github.com/o/r/pull/4#issuecomment-abc' }; },
    },
  });
  const persistence = new MemoryPersistence();
  const c1 = createReviewLoopController({ persistence, prBackend: mk() });
  const { loopId } = await c1.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const w = await c1.review({ loopId });
  assert.equal(w.status, 'WAITING_FOR_REVIEW');
  const persisted = await persistence.readWorkflowState(loopId);
  assert.match(String(persisted.reviewLoop.pendingExternalTrigger.commentId), /issuecomment-abc/);

  // Fresh controller (process restart). The 👍 has now landed.
  reacted = true;
  const c2 = createReviewLoopController({ persistence, prBackend: mk() });
  const r = await c2.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.equal(posts.length, 1, 'resume reused the persisted trigger — never posted a second one');
});

// ---------------------------------------------------------------------------
// 6. HEAD moves A -> B mid-wait: an A review/reaction never certifies B.
// ---------------------------------------------------------------------------
test('PR HEAD moving during the wait invalidates the stale-commit review', async () => {
  let polls = 0;
  const be = createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 60, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() { polls += 1; return polls <= 1 ? HEAD : HEAD_B; },
      async listReviews() {
        // A clean-looking APPROVED for the OLD head A.
        return [{ login: BOT, state: 'APPROVED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-09-08', id: 1 }];
      },
      async listReviewComments() { return []; },
      async listIssueCommentReactions() { return []; },
      async postComment() { return { id: 'https://x#issuecomment-1' }; },
    },
  });
  const persistence = new MemoryPersistence();
  const controller = createReviewLoopController({ persistence, prBackend: be });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  // The A review must NOT be accepted as a verdict for B. With A's review clean
  // but B never reviewed, the loop keeps waiting for B.
  assert.notEqual(r.status, 'PASS');
  assert.ok(['WAITING_FOR_REVIEW', 'HUMAN_REQUIRED'].includes(r.status), r.status);
});

// ---------------------------------------------------------------------------
// 8. A cancelled LOCAL review does not continue into paid Gate / Reviewer spend.
// ---------------------------------------------------------------------------
test('cancelling a LOCAL reviewloop_review stops it before the Reviewer is dispatched', async () => {
  const ac = new AbortController();
  let reviewerCalls = 0;
  let gateCalls = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => ({ head: 'H', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({
      baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false,
      changedFiles: ['a.js'], fingerprint: 'FP', diff: 'diff',
    }),
    discoverVerificationCommandsFn: () => ({ source: 'test', commands: ['echo'] }),
    runGateFn: async ({ signal }) => {
      gateCalls += 1;
      // The Gate observes the cancellation and fails closed.
      ac.abort();
      return { verdict: signal?.aborted ? 'FAIL' : 'PASS', pass: false, fingerprint: 'G', failureIdentities: ['cancelled'], results: [], evidence: { results: [], pass: false } };
    },
    reviewerFn: async () => { reviewerCalls += 1; return { value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  const r = await controller.review({ loopId, signal: ac.signal });
  assert.ok(gateCalls >= 1);
  assert.equal(reviewerCalls, 0, 'no Reviewer dispatch after cancellation');
  assert.equal(r.status, 'HUMAN_REQUIRED');
  const st = await controller._persistence.readWorkflowState(loopId);
  const spend = st.reviewLoopSpend?.records ?? [];
  assert.equal(spend.filter((x) => x.role === 'reviewer').length, 0, 'zero paid Reviewer spend records');
});

// ---------------------------------------------------------------------------
// 9. Gate zombie teardown is hard-bounded (never an unbounded await).
// ---------------------------------------------------------------------------
test('terminateProcessTree resolves done() even if the process group never reports gone', async () => {
  // A fake child whose "group" (pid) always looks alive: processGroupExists
  // would poll true forever without the hard bound.
  const fakeChild = { pid: 2_000_000_123, killed: false, exitCode: null, kill() {} };
  const started = Date.now();
  const tree = terminateProcessTree(fakeChild, {
    graceMs: 5, pollMs: 2, hardBoundMs: 40, probeGroup: () => true,
  });
  const res = await tree.done;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `done resolved in ${elapsed}ms (bounded)`);
  assert.equal(res?.confirmed, false, 'teardown reported as unconfirmed (fail closed), not silently ok');
});

// ---------------------------------------------------------------------------
// Round-2 Codex findings on this change.
// ---------------------------------------------------------------------------
test('a transient failure to re-confirm the live PR HEAD does NOT accept the cached review (fail closed)', async () => {
  let headCalls = 0;
  const be = createGithubReviewBackend({
    pollIntervalMs: 1, maxWaitMs: 10, sleep: () => Promise.resolve(),
    transport: {
      async getPrHead() {
        headCalls += 1;
        // begin() + the initial currentHead read succeed; every RECHECK fails.
        if (headCalls <= 2) return HEAD;
        throw new Error('transient 502 from GitHub');
      },
      async listReviews() {
        return [{ login: BOT, state: 'APPROVED', commitId: HEAD, body: '```json\n{"findings":[]}\n```', submittedAt: '2026-09-08', id: 1 }];
      },
      async listReviewComments() { return []; },
      async listIssueCommentReactions() { return []; },
      async postComment() { return { id: 'https://x#issuecomment-1' }; },
    },
  });
  const controller = createReviewLoopController({ persistence: new MemoryPersistence(), prBackend: be });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' });
  const r = await controller.review({ loopId });
  assert.notEqual(r.status, 'PASS', 'a clean review is never accepted while the live HEAD cannot be confirmed');
  assert.ok(['WAITING_FOR_REVIEW', 'HUMAN_REQUIRED'].includes(r.status), r.status);
});

test('an ancient orphan .reclaim guard never permanently blocks lease acquisition', async () => {
  const { acquireLoopFileLease } = await import('../src/reviewloop/loopLease.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-orphan-guard-'));
  try {
    const dir = path.join(root, 'L');
    fs.mkdirSync(dir, { recursive: true });
    // Stale lock (dead pid, this host) + an ANCIENT orphan reclaim guard.
    fs.writeFileSync(path.join(dir, 'reviewloop.lock'), JSON.stringify({
      token: 'stale', pid: 999_999_999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(),
    }));
    const guard = path.join(dir, 'reviewloop.lock.reclaim');
    fs.writeFileSync(guard, '');
    fs.utimesSync(guard, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    const lease = await acquireLoopFileLease({ runtimeRoot: root, loopId: 'L' });
    assert.equal(lease.ok, true, 'the ancient orphan guard was cleared and the stale lock reclaimed');
    await lease.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Gate teardown bound keeps a short timed-out Gate well under 5s even with a stuck group', async () => {
  // A runner-injected fake cannot exercise the real spawn path; assert the
  // bound directly: graceMs(1000) + hardBoundMs(1500) < 5000.
  const started = Date.now();
  const tree = terminateProcessTree(
    { pid: 2_000_000_999, killed: false, exitCode: null, kill() {} },
    { graceMs: 1000, hardBoundMs: 1500, pollMs: 20, probeGroup: () => true },
  );
  await tree.done;
  assert.ok(Date.now() - started < 4000, 'bounded teardown resolved well under the 5s Gate contract');
});

test('a persisted objective with its fingerprint field removed is rejected (not treated as valid)', async () => {
  const { createReviewObjective, rehydrateObjective } = await import('../src/reviewloop/objective.js');
  const obj = createReviewObjective({ loopId: 'L', goal: 'do the thing', mode: 'LOCAL' });
  const tampered = JSON.parse(JSON.stringify(obj));
  delete tampered.fingerprint;
  tampered.blockingSeverities = ['P1']; // silently drop P2
  assert.throws(() => rehydrateObjective(tampered), /no integrity fingerprint|weakened/);
});

test('an untracked file swapped for a symlink between lstat and read fails closed', async () => {
  const { collectWorkerDelta } = await import('../src/reviewloop/gitEvidence.js');
  const regular = {
    isSymbolicLink: () => false, isFile: () => true, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isDirectory: () => false,
    ino: 111, dev: 1, size: 5,
  };
  const symlinked = { ...regular, isSymbolicLink: () => true, isFile: () => false, ino: 222 };
  let lstatCall = 0;
  let readCalls = 0;
  // Drive collectWorkerDelta with a scripted git that reports exactly one
  // untracked path, then a lstat that flips regular -> symlink across the read.
  const { default: events } = await import('node:events');
  const scripted = (_cmd, cmdArgs) => {
    const child = new events.EventEmitter();
    child.stdout = new events.EventEmitter();
    child.stderr = new events.EventEmitter();
    const key = cmdArgs.join(' ');
    queueMicrotask(() => {
      if (key.includes('ls-files --others')) child.stdout.emit('data', Buffer.from('leak\0'));
      if (key.includes('rev-parse')) child.stdout.emit('data', Buffer.from('HEADSHA\n'));
      if (key.includes('diff')) child.stdout.emit('data', Buffer.from(''));
      if (key.includes('status')) child.stdout.emit('data', Buffer.from(''));
      child.emit('close', 0);
    });
    return child;
  };
  const delta = await collectWorkerDelta({
    cwd: '/repo',
    baseline: { head: 'HEADSHA', baselineRef: 'HEADSHA', untrackedHashes: {}, evidenceComplete: true },
    spawn: scripted,
    lstat: async () => { lstatCall += 1; return lstatCall === 1 ? regular : symlinked; },
    readFile: async () => { readCalls += 1; return Buffer.from('12345'); },
    // The path passed the by-name pre-check as a regular file, then a symlink
    // was swapped in before the authoritative open: O_NOFOLLOW makes open fail
    // with ELOOP and the bytes are never read.
    open: async () => { const e = new Error('ELOOP: too many symbolic links'); e.code = 'ELOOP'; throw e; },
  });
  assert.equal(delta.evidenceComplete, false, 'a mid-read swap fails the evidence closed');
  assert.equal(readCalls, 0, 'the swapped-in symlink target was never read');
  assert.ok((delta.incompleteReasons ?? []).some((r) => /changed during read|symlink/i.test(r)), JSON.stringify(delta.incompleteReasons));
});

// ---------------------------------------------------------------------------
// 10. baseline Gate mutation is NOT attributed to the Worker delta.
// ---------------------------------------------------------------------------
test('a baseline Gate that mutates a tracked file re-captures the baseline (no Worker mis-attribution)', async () => {
  let gateRuns = 0;
  const baselines = [
    { head: 'H', capturedAt: 't0', dirtyFiles: [], evidenceComplete: true },
    { head: 'H', capturedAt: 't1', dirtyFiles: ['snapshot.json'], evidenceComplete: true },
  ];
  let capIdx = 0;
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    captureBaselineFn: async () => baselines[Math.min(capIdx++, baselines.length - 1)],
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['npm run snapshot'], manifestFingerprint: 'mf' }),
    runGateFn: async () => { gateRuns += 1; return { verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [], evidence: { results: [], pass: true } }; },
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/r' });
  assert.equal(gateRuns, 1, 'baseline Gate ran at begin');
  assert.equal(capIdx, 2, 'baseline was captured a second time AFTER the baseline Gate');
  const st = await controller._persistence.readWorkflowState(loopId);
  assert.deepEqual(st.reviewLoop.objective.baseline.dirtyFiles, ['snapshot.json'],
    'the objective baseline reflects the post-Gate tree');
});

// ---------------------------------------------------------------------------
// 12. doctor detects a stale MCP path and accepts the current one.
// ---------------------------------------------------------------------------
test('checkMcpServerBinding warns on a stale gpt-dev-loop MCP path and passes the current one', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-doctor-home-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-doctor-cfg-'));
  try {
    const expected = path.resolve(new URL('../bin/reviewloop-mcp.js', import.meta.url).pathname);

    const staleExec = (cmd) => {
      if (/^claude mcp get/.test(cmd)) return `reviewloop:\n  Command: node\n  Args: /old/gpt-dev-loop/bin/reviewloop-mcp.js\n`;
      throw new Error('not registered');
    };
    fs.mkdirSync(path.join(cfgDir), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { reviewloop: { command: 'node', args: ['/old/gpt-dev-loop/bin/reviewloop-mcp.js'] } },
    }));
    const stale = checkMcpServerBinding({ execSync: staleExec, homeDir: home, configDir: cfgDir });
    assert.equal(stale.ok, false);
    assert.ok(stale.issues.some((i) => /claude/.test(i) && /install-global/.test(i)));
    assert.ok(stale.issues.some((i) => /agy/.test(i)));

    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { reviewloop: { command: 'node', args: [expected] } },
    }));
    const currentExec = (cmd) => {
      if (/^claude mcp get/.test(cmd)) return `reviewloop:\n  Command: node\n  Args: ${expected}\n`;
      throw new Error('not registered');
    };
    const good = checkMcpServerBinding({ execSync: currentExec, homeDir: home, configDir: cfgDir });
    assert.equal(good.ok, true, JSON.stringify(good.issues));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. install rollback must not lose the user's legacy skill.
// ---------------------------------------------------------------------------
test('a failing install rolls back without deleting the legacy SuperGPT skill', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-inst-home-'));
  const cfgDir = path.join(home, '.gemini', 'config');
  const legacySkillDir = path.join(cfgDir, 'skills', 'supergpt');
  try {
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(path.join(legacySkillDir, 'SKILL.md'), 'the user legacy skill');
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'user gemini rules\n');

    // Force a failure AFTER the legacy-skill deletion point used to run: make
    // the claude policy path unwritable by pointing it at a directory.
    const claudeDir = path.join(home, '.claude', 'CLAUDE.md');
    fs.mkdirSync(claudeDir, { recursive: true });

    let threw = false;
    try {
      await installGlobal({
        configDir: cfgDir,
        homeDir: home,
        execFileSync: (command, args = []) => {
          if (args[0] === '--version') return `${command} test\n`;
          if (args.includes('mcp')) return 'ok\n';
          return '';
        },
      });
    } catch { threw = true; }

    assert.equal(threw, true, 'install failed as engineered');
    assert.equal(fs.existsSync(path.join(legacySkillDir, 'SKILL.md')), true,
      'the legacy skill survived the rolled-back install');
    assert.equal(fs.readFileSync(path.join(legacySkillDir, 'SKILL.md'), 'utf8'), 'the user legacy skill');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
