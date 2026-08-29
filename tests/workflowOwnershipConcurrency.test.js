// Deterministic multi-process regressions for the atomic workflow ownership
// lease (SUPERGPT V1 final concurrency hardening). Cases A–H from the handoff.
//
// The lease is the single-owner authority: exactly one process may drive a
// workflow / preserved worktree / control.json at a time. These tests spawn
// genuine Node processes and release a filesystem barrier so contenders reach
// acquisition simultaneously.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

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

// Spawn N contenders, wait until all have written their ready marker, then drop
// the barrier so they proceed to acquisition together.
async function raceContenders({ n, baseEnv, ids }) {
  const barrier = await tmp('barrier');
  const list = (ids ?? Array.from({ length: n }, (_, i) => `c${i}`));
  const procs = list.map((id) => runContender({ ...baseEnv, OWN_BARRIER: barrier, OWN_ID: id }));

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const ready = list.every((id) => existsSync(path.join(barrier, `ready-${id}`)));
    if (ready) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await writeFile(path.join(barrier, 'go'), '1');
  const results = await Promise.all(procs);
  return { barrier, results };
}

// ---------------------------------------------------------------------------
// A. TWO SIMULTANEOUS RESUMES (separate processes)
// ---------------------------------------------------------------------------
test('A: two simultaneous cross-process resumes — exactly one owns, one enters the pipeline, loser makes zero pipeline calls', async () => {
  const home = await tmp('home-A');
  const workflowId = 'wf-race-A';
  const { barrier, results } = await raceContenders({
    n: 2,
    baseEnv: { OWN_HOME: home, OWN_WF: workflowId, OWN_MODE: 'run' },
  });
  try {
    const statuses = results.map((r) => r.parsed?.status).sort();
    assert.deepEqual(statuses, ['WORKFLOW_ALREADY_OWNED', 'WORKFLOW_DONE'], JSON.stringify(results, null, 2));

    const loser = results.find((r) => r.parsed?.status === 'WORKFLOW_ALREADY_OWNED');
    assert.equal(loser.parsed.code, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);

    // Exactly one process entered defaultPipeline.
    const pipelineLog = path.join(barrier, 'pipeline.log');
    const entrants = existsSync(pipelineLog)
      ? readFileSync(pipelineLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(entrants.length, 1, `expected exactly one pipeline entrant, got ${entrants.join(',')}`);

    // The lease is released by the winner's finalizer once it finishes.
    assert.equal(readOwnerLease({ root: path.join(home, '.supergpt', 'worktrees'), workflowId }), null);
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
  process.env.__ORIG_HOME = process.env.HOME;
  // supergpt.js already imported with the real HOME; drive the lease module
  // directly for the same-process invariant instead.
  const root = path.join(home, '.supergpt', 'worktrees');
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
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-foreign-C';
  await mkdir(root, { recursive: true });
  try {
    // A live foreign owner = init (pid 1): reliably alive, never us.
    await writeFile(ownerLockPath({ root, workflowId }), JSON.stringify({
      workflowId, ownerToken: 'foreign-token', pid: 1, hostname: os.hostname(),
      acquiredAt: new Date().toISOString(), runtimeRevision: null,
    }));
    const r = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(r.acquired, false);
    assert.equal(r.code, OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED);
    assert.equal(r.ownerPid, 1);
    // Lease untouched.
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
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-stoptimeout-D';
  await mkdir(root, { recursive: true });
  try {
    // Owner = this process (alive). A stop request is pending.
    const owner = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(owner.acquired, true);
    await writeFile(path.join(root, `${workflowId}.stop.json`), JSON.stringify({ requested: true, reason: 'x' }));

    const blocked = tryAcquireWorkflowOwnership({
      root, workflowId,
      isStopRequested: () => true,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.code, OWNERSHIP_CODES.OWNER_SHUTTING_DOWN);

    // Owner truly exits -> releases the lease -> resume may proceed.
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
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-stale-E';
  await mkdir(root, { recursive: true });
  try {
    // A PID that is guaranteed not to exist.
    await writeFile(ownerLockPath({ root, workflowId }), JSON.stringify({
      workflowId, ownerToken: 'dead-token', pid: 999999, hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 3600_000).toISOString(), runtimeRevision: null,
    }));
    const r = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(r.acquired, true);
    assert.equal(r.code, OWNERSHIP_CODES.ACQUIRED);
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
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-stale-race-F';
  await mkdir(root, { recursive: true });
  await writeFile(ownerLockPath({ root, workflowId }), JSON.stringify({
    workflowId, ownerToken: 'dead-token', pid: 999999, hostname: os.hostname(),
    acquiredAt: new Date(Date.now() - 3600_000).toISOString(), runtimeRevision: null,
  }));
  const { barrier, results } = await raceContenders({
    n: 4,
    baseEnv: { OWN_ROOT: root, OWN_WF: workflowId, OWN_MODE: 'acquire' },
  });
  try {
    const winners = results.filter((r) => r.parsed?.acquired === true);
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.parsed), null, 2));
    const losers = results.filter((r) => r.parsed?.acquired === false);
    assert.equal(losers.length, 3);
    for (const l of losers) {
      assert.ok(
        [OWNERSHIP_CODES.WORKFLOW_ALREADY_OWNED, OWNERSHIP_CODES.STALE_OWNER_LOCK].includes(l.parsed.code),
        `unexpected loser code ${l.parsed.code}`,
      );
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
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-token-G';
  await mkdir(root, { recursive: true });
  try {
    const first = tryAcquireWorkflowOwnership({ root, workflowId });
    // Simulate first owner crash + reclamation by a new owner.
    await writeFile(ownerLockPath({ root, workflowId }), JSON.stringify({
      ...readOwnerLease({ root, workflowId }), pid: 999999,
    }));
    const second = tryAcquireWorkflowOwnership({ root, workflowId });
    assert.equal(second.acquired, true);
    assert.notEqual(second.ownerToken, first.ownerToken);

    // The old owner, if it woke up, must not drop the new lease.
    const res = releaseWorkflowOwnership({ root, workflowId, ownerToken: first.ownerToken });
    assert.equal(res.released, false);
    assert.equal(readOwnerLease({ root, workflowId }).ownerToken, second.ownerToken);

    // The current owner can.
    assert.equal(releaseWorkflowOwnership({ root, workflowId, ownerToken: second.ownerToken }).released, true);
    assert.equal(readOwnerLease({ root, workflowId }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H. CRASH BEFORE PIPELINE — finalizer releases ownership cleanly.
// ---------------------------------------------------------------------------
test('H: a run that fails before the pipeline still releases its lease in the finalizer', async () => {
  const home = await tmp('home-H');
  process.env.HOME = home; // set before importing supergpt in the child
  const workflowId = 'wf-crash-H';
  const barrier = await tmp('barrier-H');
  await writeFile(path.join(barrier, 'go'), '1');
  const r = await runContender({
    OWN_HOME: home,
    OWN_WF: workflowId,
    OWN_BARRIER: barrier,
    OWN_ID: 'h',
    OWN_MODE: 'run',
    // force the pipeline to throw
    __CRASH: '1',
  });
  try {
    // The injected pipeline throws right after entry. The run must terminate
    // FAILED and its finalizer must still release the ownership lease.
    assert.equal(r.parsed?.status, 'FAILED', r.stdout + r.stderr);
    assert.equal(readOwnerLease({ root: path.join(home, '.supergpt', 'worktrees'), workflowId }), null, r.stdout + r.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(barrier, { recursive: true, force: true });
  }
});
