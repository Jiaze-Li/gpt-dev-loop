// PR-level HUMAN_REQUIRED latch: a PR whose loop exhausts its review-round
// budget with blocking findings still open cannot be silently restarted with a
// fresh reviewloop_begin. Clearing it requires an Ed25519-signed approval from
// a key configured in the runtime environment — a Worker with shell/filesystem
// access still cannot forge it. Deterministic; zero network, zero real providers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';
import {
  readPrLatch,
  armPrLatch,
  attachSignedApproval,
  consumePrLatchForBegin,
  resolvePrLatch,
  signApproval,
  trustedApproverKeys,
  verifyApproval,
  approverKeyId,
  prLatchKey,
  PR_LATCH_STATUS,
} from '../src/reviewloop/prLatch.js';
import { readAuditChain, appendAuditEvent, expectedLatchState } from '../src/reviewloop/prLatchAudit.js';

const P1 = { severity: 'P1', file: 'a.js', title: 'bug' };
const TRUSTED = { codex: 'chatgpt-codex-connector[bot]', claude: 'claude[bot]' };
const REPO = 'test-repo:pr-latch';

// One approver keypair for the whole file.
const kp = generateKeyPairSync('ed25519');
const PRIV_PEM = kp.privateKey.export({ format: 'pem', type: 'pkcs8' });
const PUB_B64 = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const APPROVER_ENV = { REVIEWLOOP_APPROVER_PUBKEYS: PUB_B64 };

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

function makeController(persistence, prBackend, { env = {}, repoIdentity = REPO } = {}) {
  return createReviewLoopController({
    persistence,
    prBackend,
    env,
    resolveRepoIdentityFn: async () => repoIdentity,
    supervisorFn: async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
}

async function exhaust(controller, backend, { prNumber = 4 } = {}) {
  const begun = await controller.begin({ goal: 'g', cwd: '/r', prNumber });
  assert.equal(begun.status, 'READY', `exhaust: begin was ${begun.status}`);
  const { loopId } = begun;
  await controller.review({ loopId }); backend.advanceHead();
  await controller.review({ loopId }); backend.advanceHead();
  const r3 = await controller.review({ loopId });
  return { loopId, r3 };
}

// Build a controller + its backend together, run a PR to round-3 non-convergence.
async function exhaustFresh(persistence, { env = APPROVER_ENV, prNumber = 4, heads } = {}) {
  const backend = mockPrBackend(heads ? { heads } : {});
  const controller = makeController(persistence, backend, { env });
  const { loopId, r3 } = await exhaust(controller, backend, { prNumber });
  return { controller, backend, loopId, r3 };
}

// Sign a valid approval for the current latch state.
async function signFor(persistence, prNumber, { repositoryIdentity = REPO } = {}) {
  const latch = await readPrLatch(persistence, { repositoryIdentity, prNumber });
  return signApproval(PRIV_PEM, {
    repositoryIdentity, prNumber,
    exhaustedLoopId: latch.exhaustedLoopId,
    exhaustedHead: latch.exhaustedHead,
    latchCount: latch.latchCount,
  });
}

async function approve(persistence, prNumber, { repositoryIdentity = REPO, approvedBy = 'jack' } = {}) {
  const grant = await signFor(persistence, prNumber, { repositoryIdentity });
  return attachSignedApproval(persistence, {
    repositoryIdentity, prNumber, approval: grant, approvedBy,
    trustedKeys: trustedApproverKeys(APPROVER_ENV),
  });
}

test('round-3 non-convergence returns HUMAN_REQUIRED and arms a durable PR latch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const { loopId, r3 } = await exhaust(makeController(persistence, backend, { env: APPROVER_ENV }), backend);

  assert.equal(r3.status, 'HUMAN_REQUIRED');
  assert.equal(r3.latch.armed, true);
  assert.equal(r3.latch.exhaustedLoopId, loopId);

  const latch = await readPrLatch(persistence, { repositoryIdentity: REPO, prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal(latch.exhaustedLoopId, loopId);
  assert.equal(latch.exhaustedHead, 'H3');
  assert.equal(latch.round, 3);
  assert.equal(latch.maxRounds, 3);
  assert.equal(latch.latchCount, 1);
});

test('a fresh reviewloop_begin for the latched PR is refused with zero new triggers', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const controller = makeController(persistence, backend, { env: APPROVER_ENV });
  await exhaust(controller, backend);
  const triggersAfter = backend.state.triggers.length;

  const blocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(blocked.loopId, null);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.approverKeyConfigured, true);
  assert.match(blocked.reason, /signed approval/i);
  assert.equal(backend.state.triggers.length, triggersAfter);
});

test('with NO approver key configured, the latch is honestly non-clearable (fail closed)', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const controller = makeController(persistence, backend, { env: {} }); // no REVIEWLOOP_APPROVER_PUBKEYS
  await exhaust(controller, backend);

  const blocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(blocked.approverKeyConfigured, false);
  assert.match(blocked.reason, /NO configured approver key|cannot be cryptographically verified/i);

  // Even a "correctly signed" grant is worthless when the runtime trusts no key.
  const grant = await signFor(persistence, 4);
  await attachSignedApproval(persistence, {
    repositoryIdentity: REPO, prNumber: 4, approval: grant, approvedBy: 'x',
    trustedKeys: trustedApproverKeys({ REVIEWLOOP_APPROVER_PUBKEYS: grant.publicKeySpkiB64 }),
  });
  const stillBlocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(stillBlocked.status, 'HUMAN_APPROVAL_REQUIRED');
});

test('a Worker-forged approval blob in the state file does not clear the latch', async () => {
  const persistence = new MemoryPersistence();
  const backend = mockPrBackend();
  const controller = makeController(persistence, backend, { env: APPROVER_ENV });
  await exhaust(controller, backend);

  // Forge: the Worker fabricates its OWN keypair and writes an approval it signed.
  const evil = generateKeyPairSync('ed25519');
  const evilGrant = signApproval(evil.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    repositoryIdentity: REPO, prNumber: 4,
    exhaustedLoopId: (await readPrLatch(persistence, { repositoryIdentity: REPO, prNumber: 4 })).exhaustedLoopId,
    exhaustedHead: 'H3', latchCount: 1,
  });
  const key = prLatchKey(REPO, 4);
  const raw = await persistence.readWorkflowState(key);
  raw.reviewLoopPrLatch.approval = {
    approvalId: 'forged', grantedVia: 'signed-ed25519',
    approverKeyId: evilGrant.approverKeyId, payloadB64: evilGrant.payloadB64,
    signatureB64: evilGrant.signatureB64, approvedBy: 'jack', consumedByLoopId: null,
  };
  await persistence.writeWorkflowState(key, raw);

  const blocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED', 'an untrusted-key signature is rejected');
});

test('the latch survives an MCP/runtime restart, a changed HEAD, and a push', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence);

  for (const b of [mockPrBackend(), (() => { const x = mockPrBackend(); x.advanceHead(); x.advanceHead(); return x; })(), mockPrBackend({ heads: ['Hnew'] })]) {
    // eslint-disable-next-line no-await-in-loop
    const blocked = await makeController(persistence, b, { env: APPROVER_ENV }).begin({ goal: 'g', cwd: '/r', prNumber: 4 });
    assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(b.state.triggers.length, 0);
  }
});

test('a different PR and LOCAL-mode loops are unaffected', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence, { prNumber: 4 });

  const other = mockPrBackend({ results: { H1: { findings: [] } } });
  const begun5 = await makeController(persistence, other, { env: APPROVER_ENV }).begin({ goal: 'g', cwd: '/r', prNumber: 5 });
  assert.equal(begun5.status, 'READY');

  const local = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'H', baselineRef: 'H', dirtyFiles: [], untrackedHashes: {}, evidenceComplete: true }),
    collectWorkerDeltaFn: async () => ({ baselineHead: 'H', currentHead: 'H', evidenceComplete: true, noWorkerChangeYet: false, changedFiles: ['a.js'], fingerprint: 'FP', diff: 'd' }),
    runGateFn: async () => ({ verdict: 'PASS', pass: true, fingerprint: 'g', failureIdentities: [], results: [] }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo'], manifestFingerprint: 'mf' }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const lb = await local.begin({ goal: 'g', cwd: '/r' });
  assert.equal(lb.status, 'READY');
  assert.equal((await local.review({ loopId: lb.loopId })).status, 'PASS');
});

test('a valid signed approval grants exactly one new loop from round 1; PASS resolves the latch', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence);

  const g = await approve(persistence, 4);
  assert.equal(g.ok, true);

  const b2 = mockPrBackend({ heads: ['H10'], results: { H10: { findings: [] } } });
  const c2 = makeController(persistence, b2, { env: APPROVER_ENV });
  const begun = await c2.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(begun.status, 'READY');

  const blockedAgain = await c2.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
  assert.equal(blockedAgain.status, 'HUMAN_APPROVAL_REQUIRED', 'the one-shot approval is spent');

  const r1 = await c2.review({ loopId: begun.loopId });
  assert.equal(r1.round, 1);
  assert.equal(r1.status, 'PASS');

  const latch = await readPrLatch(persistence, { repositoryIdentity: REPO, prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.RESOLVED);
  assert.equal((await c2.begin({ goal: 'g2', cwd: '/r', prNumber: 4 })).status, 'READY');
});

test('an approved loop that also exhausts its rounds re-latches, needs a brand-new approval', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence);
  await approve(persistence, 4);

  const b2 = mockPrBackend({ heads: ['Ha', 'Hb', 'Hc'] });
  const c2 = makeController(persistence, b2, { env: APPROVER_ENV });
  const { r3 } = await exhaust(c2, b2);
  assert.equal(r3.status, 'HUMAN_REQUIRED');

  const latch = await readPrLatch(persistence, { repositoryIdentity: REPO, prNumber: 4 });
  assert.equal(latch.status, PR_LATCH_STATUS.ACTIVE);
  assert.equal(latch.latchCount, 2);
  assert.equal(latch.approval, null);

  // the OLD approval (latchCount 1) does not validate against latchCount 2
  const stale = signApproval(PRIV_PEM, { repositoryIdentity: REPO, prNumber: 4, exhaustedLoopId: latch.exhaustedLoopId, exhaustedHead: latch.exhaustedHead, latchCount: 1 });
  const v = verifyApproval(
    { ...stale, approverKeyId: stale.approverKeyId },
    { latch, repositoryIdentity: REPO, prNumber: 4, trustedKeys: trustedApproverKeys(APPROVER_ENV) },
  );
  assert.equal(v.ok, false);
});

test('the Worker cannot forge a bypass through ordinary begin params', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence);
  for (const args of [
    { goal: 'different', cwd: '/r', prNumber: 4, reviewer: 'claude' },
    { goal: 'g', cwd: '/r/./', prNumber: 4 },
    { goal: 'g', cwd: '/r', prNumber: 4, reviewer: 'codex' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await makeController(persistence, mockPrBackend(), { env: APPROVER_ENV }).begin(args);
    assert.equal(res.status, 'HUMAN_APPROVAL_REQUIRED', JSON.stringify(args));
  }
});

test('concurrent begins cannot both consume one signed approval', async () => {
  const persistence = new MemoryPersistence();
  await exhaustFresh(persistence);
  await approve(persistence, 4);

  const c = makeController(persistence, mockPrBackend({ heads: ['Hx'], results: { Hx: { findings: [] } } }), { env: APPROVER_ENV });
  const [a, b] = await Promise.all([
    c.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
    c.begin({ goal: 'g', cwd: '/r', prNumber: 4 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['HUMAN_APPROVAL_REQUIRED', 'READY']);
});

test('prLatchKey isolates by repository identity and PR number', () => {
  assert.notEqual(prLatchKey('repoA', 4), prLatchKey('repoB', 4));
  assert.notEqual(prLatchKey('repoA', 4), prLatchKey('repoA', 5));
  assert.match(prLatchKey('repoA', 4), /^pr-latch-[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------------------
// signature primitives
// ---------------------------------------------------------------------------
test('verifyApproval: bound to repo, PR, latchCount; rejects untrusted key and no-key runtime', () => {
  const latch = { exhaustedLoopId: 'rl-x', exhaustedHead: 'HEAD1', latchCount: 1 };
  const trusted = trustedApproverKeys(APPROVER_ENV);
  const grant = signApproval(PRIV_PEM, { repositoryIdentity: 'r', prNumber: 4, exhaustedLoopId: 'rl-x', exhaustedHead: 'HEAD1', latchCount: 1 });

  assert.equal(verifyApproval(grant, { latch, repositoryIdentity: 'r', prNumber: 4, trustedKeys: trusted }).ok, true);
  assert.equal(verifyApproval(grant, { latch, repositoryIdentity: 'r', prNumber: 5, trustedKeys: trusted }).ok, false);
  assert.equal(verifyApproval(grant, { latch: { ...latch, latchCount: 2 }, repositoryIdentity: 'r', prNumber: 4, trustedKeys: trusted }).ok, false);
  assert.equal(verifyApproval(grant, { latch, repositoryIdentity: 'r', prNumber: 4, trustedKeys: new Map() }).ok, false);

  const evil = generateKeyPairSync('ed25519');
  const evilGrant = signApproval(evil.privateKey.export({ format: 'pem', type: 'pkcs8' }), { repositoryIdentity: 'r', prNumber: 4, exhaustedLoopId: 'rl-x', exhaustedHead: 'HEAD1', latchCount: 1 });
  assert.equal(verifyApproval(evilGrant, { latch, repositoryIdentity: 'r', prNumber: 4, trustedKeys: trusted }).ok, false);
});

test('trustedApproverKeys parses base64 SPKI and PEM, ignores junk, dedups by id', () => {
  const pem = kp.publicKey.export({ format: 'pem', type: 'spki' });
  const m = trustedApproverKeys({ REVIEWLOOP_APPROVER_PUBKEYS: `${PUB_B64} , not-a-key\n${pem}` });
  assert.equal(m.size, 1);
  assert.equal([...m.keys()][0], approverKeyId(PUB_B64));
  assert.equal(trustedApproverKeys({}).size, 0);
});

// ---------------------------------------------------------------------------
// audit chain
// ---------------------------------------------------------------------------
test('audit chain: append + verify, and a hand-edited line breaks the chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-latch-audit-'));
  try {
    await appendAuditEvent(dir, { event: 'ARMED', repositoryIdentity: 'r', prNumber: 4, latchCount: 1 });
    await appendAuditEvent(dir, { event: 'APPROVAL_VERIFIED', repositoryIdentity: 'r', prNumber: 4, latchCount: 1 });
    let chain = await readAuditChain(dir);
    assert.equal(chain.ok, true);
    assert.equal(chain.entries.length, 2);
    assert.equal(expectedLatchState(chain.entries, { repositoryIdentity: 'r', prNumber: 4 }).latched, true);

    const file = path.join(dir, 'pr-latch-audit.log');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.meta = { tampered: true };
    fs.writeFileSync(file, `${JSON.stringify(first)}\n${lines[1]}\n`);
    chain = await readAuditChain(dir);
    assert.equal(chain.ok, false);
    assert.match(chain.reason, /hash mismatch|chain break/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('controller: a broken audit chain fails begin closed even if the state file looks clear', async () => {
  const { Persistence } = await import('../src/orchestrator/persistence.js');
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-latch-ctrl-'));
  try {
    const persistence = new Persistence(runtimeDir);
    process.env.REVIEWLOOP_RUNTIME_DIR = runtimeDir;
    const backend = mockPrBackend();
    const controller = createReviewLoopController({
      persistence, prBackend: backend, env: { ...APPROVER_ENV, REVIEWLOOP_RUNTIME_DIR: runtimeDir },
      runtimeRoot: runtimeDir,
      resolveRepoIdentityFn: async () => REPO,
      supervisorFn: async () => ({ value: { guidance: 'g', recommendation: 'REWORK' }, usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await exhaust(controller, backend);
    // corrupt the audit log
    const auditFile = path.join(runtimeDir, 'pr-latch-audit.log');
    fs.appendFileSync(auditFile, '{"seq":999,"prevHash":"nope","event":"RESOLVED"}\n');
    const blocked = await controller.begin({ goal: 'g', cwd: '/r', prNumber: 4 });
    assert.equal(blocked.status, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(blocked.tampered, true);
  } finally {
    delete process.env.REVIEWLOOP_RUNTIME_DIR;
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
test('CLI: keygen, then approve --key, then begin consumes exactly once', async () => {
  const { Persistence } = await import('../src/orchestrator/persistence.js');
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-latch-cli-'));
  const bin = fileURLToPath(new URL('../bin/reviewloop.js', import.meta.url));
  const keyPath = path.join(runtimeDir, 'approver.key');
  try {
    // keygen prints the pubkey line
    const kgEnv = { ...process.env, REVIEWLOOP_RUNTIME_DIR: runtimeDir };
    const kg = execFileSync('node', [bin, 'pr-latch', 'keygen', '--out', keyPath], { env: kgEnv, encoding: 'utf8' });
    const pub = kg.match(/REVIEWLOOP_APPROVER_PUBKEYS=(\S+)/)[1];
    assert.ok(fs.existsSync(keyPath));

    const env = { ...process.env, REVIEWLOOP_RUNTIME_DIR: runtimeDir, REVIEWLOOP_GH_REPO: 'acme/widgets', REVIEWLOOP_APPROVER_PUBKEYS: pub };
    const repositoryIdentity = 'github:acme/widgets';
    const persistence = new Persistence(runtimeDir);

    // approve with no latch -> non-zero
    assert.throws(() => execFileSync('node', [bin, 'pr-latch', 'approve', '4', '--key', keyPath], { env, encoding: 'utf8', stdio: 'pipe' }));

    await armPrLatch(persistence, {
      repositoryIdentity, prNumber: 4, exhaustedLoopId: 'rl-exhausted', exhaustedHead: 'DEADBEEF',
      reason: 'still 1 blocking finding(s) after 3 review round(s)', round: 3, maxRounds: 3,
    });

    const out = execFileSync('node', [bin, 'pr-latch', 'approve', '4', '--key', keyPath, '--note', 'ok'], { env, encoding: 'utf8' });
    assert.match(out, /Signed one fresh ReviewLoop budget approval for PR #4/);

    const backend = mockPrBackend({ heads: ['Hcli'], results: { Hcli: { findings: [] } } });
    const controller = createReviewLoopController({ persistence, prBackend: backend, env, resolveRepoIdentityFn: async () => repositoryIdentity });
    assert.equal((await controller.begin({ goal: 'g', cwd: '/x', prNumber: 4 })).status, 'READY');
    assert.equal((await controller.begin({ goal: 'g', cwd: '/x', prNumber: 4 })).status, 'HUMAN_APPROVAL_REQUIRED');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
