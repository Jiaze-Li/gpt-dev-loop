// Deterministic multi-process regressions for the atomic workflow ownership
// lease (SUPERGPT V1 concurrency hardening). Cases A–H from the first handoff
// plus I–K from the publication-race / lifecycle follow-up.
//
// The lease is the single-owner authority: exactly one process may drive a
// workflow / preserved worktree / control.json at a time. The atomic primitive
// is exclusive DIRECTORY creation — <workflowId>.owner.lock/ existing IS
// "owned"; complete lease metadata is published into lease.json afterward and a
// contender must never treat an in-progress publication as a dead owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';

import {
  tryAcquireWorkflowOwnership,
  releaseWorkflowOwnership,
  readOwnerLease,
  ownerLockPath,
  OWNERSHIP_CODES,
} from '../src/orchestrator/workflowOwnership.js';

const CONTENDER = fileURLToPath(new URL('./fixtures/ownershipContender.mjs', import.meta.url));

async function tmp(tag) {
  return mkdtemp(path.join(os.tmpdir(), `supergpt-own-${tag}-`));
}

function worktreeRoot(home) {
  return path.join(home, '.supergpt', 'worktrees');
}

// Materialise a lock directory (+ optional lease.json) directly on disk.
function writeLeaseFixture(root, workflowId, lease, { dirAgeMs = 0 } = {}) {
  const dir = ownerLockPath({ root, workflowId });
  mkdirSync(dir, { recursive: true });
  if (lease) writeFileSync(path.join(dir, 'lease.json'), JSON.stringify(lease, null, 2));
  if (dirAgeMs > 0) {
    const when = new Date(Date.now() - dirAgeMs);
    utimesSync(dir, when, when);
  }
}

function deadLease(workflowId, extra = {}) {
  return {
    workflowId, ownerToken: 'dead-token', pid: 999999, hostname: os.hostname(),
    acquiredAt: new Date(Date.now() - 3600_000).toISOString(), runtimeRevision: null, ...extra,
  };
}

function runContender(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONTENDER], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (exitCode) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1]); } catch { /* leave null */ }
      resolve({ exitCode, parsed, stdout, stderr });
    });
  });
}

async function raceContenders({ baseEnv, ids }) {
  const barrier = await tmp('barrier');
  const procs = ids.map((id) => runContender({ ...baseEnv, OWN_BARRIER: barrier, OWN_ID: id }));
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (ids.every((id) => existsSync(path.join(barrier, `ready-${id}`)))) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await writeFile(path.join(barrier, 'go'), '1');
  return { barrier, results: await Promise.all(procs) };
}

// ---------------------------------------------------------------------------
// A. TWO SIMULTANEOUS RESUMES (separate processes)
// ---------------------------------------------------------------------------
test('A: two simultaneous cross-process resumes — exactly one owns and enters the pipeline; loser makes zero pipeline calls', async () => {
  const home = await tmp('home-A');
  const workflowId = 'wf-race-A';
  const { barrier, results } = await raceContenders({
    baseEnv: { OWN_HOME: home, OWN_WF: workflowId, OWN_MODE: 'run' },
    ids: ['a0', 'a1'],
  });
  try {
    const statuses = results.map((r) => r.parsed?.status).sort();
    assert.deepEqual(statuses, ['WORKFLOW_ALREADY_OWNED', 'WORKFLOW_DONE'], JSON.stringify(results, null, 2));
    assert.equal(results.find((r) => r.parsed?.status === 'WORKFLOW_ALREADY_OWNED').parsed.code, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);

    const pipelineLog = path.join(barrier, 'pipeline.log');
    const entrants = existsSync(pipelineLog) ? readFileSync(pipelineLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.equal(entrants.length, 1, `expected exactly one pipeline entrant, got ${entrants.join(',')}`);

    assert.equal(readOwnerLease({ root: worktreeRoot(home), workflowId }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. SAME-PROCESS DOUBLE RESUME
// ---------------------------------------------------------------------------
test('B: two concurrent same-process resumes — exactly one workflow owner', async () => {
  const home = await tmp('home-B');
  const root = worktreeRoot(home);
  const workflowId = 'wf-race-B';
  try {
    const a = tryAcquireWorkflowOwnership({ root, workflowId });
    const b = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, false);
    assert.equal(b.code, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, a.ownerToken);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. ACTIVE FOREIGN OWNER — resume rejected with no model/tool execution
// ---------------------------------------------------------------------------
test('C: an existing live foreign owner rejects a resume before any pipeline call', async () => {
  const home = await tmp('home-C');
  const root = worktreeRoot(home);
  const workflowId = 'wf-foreign-C';
  try {
    writeLeaseFixture(root, workflowId, {
      workflowId, ownerToken: 'foreign-token', pid: 1, hostname: os.hostname(),
      acquiredAt: new Date().toISOString(), runtimeRevision: null,
    });
    const r = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(r.acquired, false);
    assert.equal(r.code, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
    assert.equal(r.ownerPid, 1);
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, 'foreign-token');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D. STOP_TIMEOUT — owner still tearing down; resume cannot acquire until it
//    truly exits and releases the lease.
// ---------------------------------------------------------------------------
test('D: owner still alive after stop timeout keeps the lease; resume proceeds only once it is released', async () => {
  const home = await tmp('home-D');
  const root = worktreeRoot(home);
  const workflowId = 'wf-stoptimeout-D';
  try {
    const owner = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(owner.acquired, true);
    await writeFile(path.join(root, `${workflowId}.stop.json`), JSON.stringify({ requested: true, reason: 'x' }));

    const blocked = tryAcquireWorkflowOwnership({ root, workflowId, isStopRequested: () => true });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.code, OWNERSHIP_CODES.OWNER_SHUTTING_DOWN);

    assert.equal(releaseWorkflowOwnership({ root, workflowId, ownerToken: owner.ownerToken }).released, true);
    const resumed = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(resumed.acquired, true);
    assert.notEqual(resumed.ownerToken, owner.ownerToken);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. STALE OWNER — a dead crashed owner's lease is reclaimed deterministically.
// ---------------------------------------------------------------------------
test('E: a dead owner PID is reclaimed with a fresh ownerToken', async () => {
  const home = await tmp('home-E');
  const root = worktreeRoot(home);
  const workflowId = 'wf-stale-E';
  try {
    writeLeaseFixture(root, workflowId, deadLease(workflowId), { dirAgeMs: 3600_000 });
    const r = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(r.acquired, true);
    assert.notEqual(r.ownerToken, 'dead-token');
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, r.ownerToken);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F. TWO STALE RECLAIMERS — exactly one winner.
// ---------------------------------------------------------------------------
test('F: two processes reclaiming the same stale lease — exactly one winner', async () => {
  const home = await tmp('home-F');
  const root = worktreeRoot(home);
  const workflowId = 'wf-stale-race-F';
  writeLeaseFixture(root, workflowId, deadLease(workflowId), { dirAgeMs: 3600_000 });
  const { barrier, results } = await raceContenders({
    baseEnv: { OWN_ROOT: root, OWN_WF: workflowId, OWN_MODE: 'acquire' },
    ids: ['f0', 'f1', 'f2', 'f3'],
  });
  try {
    const winners = results.filter((r) => r.parsed?.acquired === true);
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.parsed), null, 2));
    for (const l of results.filter((r) => r.parsed?.acquired === false)) {
      assert.ok([OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED, OWNERSHIP_CODES.STALE_OWNER_LOCK].includes(l.parsed.code), `bad loser code ${l.parsed.code}`);
    }
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, winners[0].parsed.ownerToken);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G. OWNER TOKEN RELEASE — an old token cannot release a newer owner's lease.
// ---------------------------------------------------------------------------
test('G: a stale ownerToken cannot release a newer owner\'s lease', async () => {
  const home = await tmp('home-G');
  const root = worktreeRoot(home);
  const workflowId = 'wf-token-G';
  try {
    const first = tryAcquireWorkflowOwnership({ root, workflowId });
    // Simulate first owner crash: rewrite lease.json in place with a dead pid.
    writeFileSync(
      path.join(ownerLockPath({ root, workflowId }), 'lease.json'),
      JSON.stringify({ ...readOwnerLease({ root, workflowId }), pid: 999999 }),
    );
    const second = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(second.acquired, true);
    assert.notEqual(second.ownerToken, first.ownerToken);

    const res = releaseWorkflowOwnership({ root, workflowId, ownerToken: first.ownerToken });
    assert.equal(res.released, false);
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, second.ownerToken);

    assert.equal(releaseWorkflowOwnership({ root, workflowId, ownerToken: second.ownerToken }).released, true);
    assert.equal(readOwnerLease({ root, workflowId }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H. CRASH BEFORE PIPELINE — finalizer releases ownership cleanly.
// ---------------------------------------------------------------------------
test('H: a run that fails inside the pipeline still releases its lease', async () => {
  const home = await tmp('home-H');
  const workflowId = 'wf-crash-H';
  const barrier = await tmp('barrier-H');
  await writeFile(path.join(barrier, 'go'), '1');
  const r = await runContender({
    OWN_HOME: home, OWN_WF: workflowId, OWN_BARRIER: barrier, OWN_ID: 'h', OWN_MODE: 'run', __CRASH: '1',
  });
  try {
    assert.equal(r.parsed?.status, 'FAILED', r.stdout + r.stderr);
    assert.equal(readOwnerLease({ root: worktreeRoot(home), workflowId }), null, r.stdout + r.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// I. PAUSED-PUBLICATION RACE — winner A is paused AFTER the atomic mkdir claim
//    but BEFORE lease.json is published; B must not steal or delete A's lock.
// ---------------------------------------------------------------------------
test('I: a contender during A\'s metadata-publication window cannot acquire and never deletes A\'s lock', async () => {
  const home = await tmp('home-I');
  const root = worktreeRoot(home);
  const workflowId = 'wf-pubrace-I';
  const barrier = await tmp('barrier-I');
  await writeFile(path.join(barrier, 'go'), '1');
  await mkdir(root, { recursive: true });

  // A: separate Node process. Wins the mkdir claim, signals "claimed", then
  // busy-holds for 3s BEFORE publishing lease.json.
  const aProc = runContender({
    OWN_ROOT: root, OWN_WF: workflowId, OWN_BARRIER: barrier, OWN_ID: 'A',
    OWN_MODE: 'slowpublish', OWN_PUBLISH_DELAY: '3000',
  });

  // Wait until A has taken the atomic claim but not yet published.
  const claimedMarker = path.join(barrier, 'claimed-A');
  const deadline = Date.now() + 8000;
  while (!existsSync(claimedMarker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(claimedMarker), 'A never reported its atomic claim');
  assert.ok(existsSync(ownerLockPath({ root, workflowId })), 'lock dir should exist');
  assert.equal(readOwnerLease({ root, workflowId }), null, 'lease.json must not be published yet');

  // B (this process) races in while A is mid-publication.
  const b = tryAcquireWorkflowOwnership({ root, workflowId });
  assert.equal(b.acquired, false, JSON.stringify(b));
  assert.equal(b.code, OWNERSHIP_CODES.OWNER_LEASE_INITIALIZING);
  assert.ok(existsSync(ownerLockPath({ root, workflowId })), 'B must NOT have deleted A\'s lock');

  const aResult = await aProc;
  try {
    assert.equal(aResult.parsed?.acquired, true, aResult.stdout + aResult.stderr);
    const onDisk = readOwnerLease({ root, workflowId });
    assert.equal(onDisk.ownerToken, aResult.parsed.ownerToken, 'on-disk lease must be A\'s');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// J. PRE-PIPELINE-INIT FAILURE — a throw after ownership acquisition but before
//    the pipeline still releases the lease; a second run then acquires normally.
// ---------------------------------------------------------------------------
test('J: a failure during pre-pipeline init releases ownership; a later run acquires cleanly', async () => {
  const home = await tmp('home-J');
  const root = worktreeRoot(home);
  const workflowId = 'wf-initfail-J';
  const barrier = await tmp('barrier-J');
  await writeFile(path.join(barrier, 'go'), '1');
  const first = await runContender({
    OWN_HOME: home, OWN_WF: workflowId, OWN_BARRIER: barrier, OWN_ID: 'j', OWN_MODE: 'run', OWN_INIT_THROW: '1',
  });
  try {
    assert.ok(
      first.parsed?.error && /init boom/.test(first.parsed.error),
      `expected the run to reject with the injected init error, got ${first.stdout}${first.stderr}`,
    );
    assert.equal(readOwnerLease({ root, workflowId }), null, 'lease must be released after the init failure');
    assert.equal(existsSync(ownerLockPath({ root, workflowId })), false, 'lock dir must be gone');

    const second = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(second.acquired, true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K. RELEASE / UNLINK FAILURE — never silently forgotten.
// ---------------------------------------------------------------------------
test('K: a failed lease removal is surfaced, not silently dropped', async () => {
  const home = await tmp('home-K');
  const root = worktreeRoot(home);
  const workflowId = 'wf-unlinkfail-K';
  try {
    const owner = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(owner.acquired, true);

    const failed = releaseWorkflowOwnership({
      root, workflowId, ownerToken: owner.ownerToken,
      _rm: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
    });
    assert.equal(failed.released, false);
    assert.equal(failed.leaseStillPresent, true);
    assert.match(failed.reason, /remove failed/);
    // The lease is genuinely still on disk and still ours.
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, owner.ownerToken);

    // A real retry with the same token succeeds.
    assert.equal(releaseWorkflowOwnership({ root, workflowId, ownerToken: owner.ownerToken }).released, true);
    assert.equal(readOwnerLease({ root, workflowId }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
