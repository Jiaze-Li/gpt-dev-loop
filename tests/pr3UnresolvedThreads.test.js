// Deterministic regressions for the three PR #3 review threads that were still
// unresolved:
//
//   P1 (resultDelivery.js:275)          — reject symlinked delivery destinations
//   P1 (claudeExecutorAdapter.js:229)   — terminate the executor's whole process tree
//   P2 (supergpt.js:1266)               — bounded WORKFLOW_NOT_FOUND for supergpt_watch

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createResultDelivery, ResultDeliveryError } from '../src/orchestrator/resultDelivery.js';
import { killProcessTree, terminateProcessTree } from '../src/orchestrator/processTree.js';
import { createClaudeExecutorAdapter } from '../src/orchestrator/adapters/claudeExecutorAdapter.js';
import { createGateRunner } from '../src/orchestrator/adapters/gateRunner.js';
import { supergptWatch } from '../src/orchestrator/supergpt.js';

const tick = () => new Promise((r) => setImmediate(r));

function demoTaskCard() {
  return {
    task_id: 'demo-task',
    repository_context: { repository_name: 'r', repository_url: null, branch: 'main', commit_sha: 'c' },
    goal: 'g', context: 'c', scope: 's',
    allowed_files: ['src/**'], forbidden_files: [],
    acceptance_criteria: ['ok'], verification_commands: ['npm test'], completion_signal: 'DONE',
  };
}

function esrch() {
  const err = new Error('no such process group');
  err.code = 'ESRCH';
  return err;
}

// ===========================================================================
// Finding 1 — a symlinked destination component must fail closed, and the
// approved bytes must never be written through the link (existsSync follows it
// and reports "available").
// ===========================================================================

test('symlink delivery: a dangling symlink AT the destination path is a conflict, not "available"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-sym-a-'));
  try {
    const wt = path.join(dir, 'wt');
    const src = path.join(dir, 'src');
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(wt, 'a.txt'), 'approved\n');
    // Dangling symlink: existsSync(src/a.txt) === false, lstat says symlink.
    fs.symlinkSync(path.join(dir, 'outside-target'), path.join(src, 'a.txt'));
    assert.equal(fs.existsSync(path.join(src, 'a.txt')), false, 'existsSync follows the dangling link');

    const delivery = createResultDelivery();
    const delta = {
      worktreePath: wt,
      baselineHead: 'BASE',
      changedPaths: ['a.txt'],
      untrackedFiles: ['a.txt'],
      patch: '',
    };

    await assert.rejects(
      () => delivery.deliverApprovedDelta({ delta, sourceWorkspace: src }),
      (err) => err instanceof ResultDeliveryError && /symlink/i.test(err.message)
    );
    // The approved bytes were NOT written through the link.
    assert.equal(fs.existsSync(path.join(dir, 'outside-target')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink delivery: a symlinked PARENT directory is a conflict for both check and deliver', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-sym-b-'));
  try {
    const wt = path.join(dir, 'wt');
    const src = path.join(dir, 'src');
    const escape = path.join(dir, 'escape');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(escape, { recursive: true });
    fs.writeFileSync(path.join(wt, 'sub', 'x.txt'), 'approved\n');
    // src/sub -> ../escape : a copy to src/sub/x.txt lands outside src.
    fs.symlinkSync(escape, path.join(src, 'sub'));

    const delivery = createResultDelivery();

    // Fake git: only ls-tree / hash-object are reached before the symlink gate
    // short-circuits this path.
    const spawn = (command, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(''));
        child.emit('close', 0);
      });
      void command;
      void args;
      void opts;
      return child;
    };
    const gitDelivery = createResultDelivery({ spawn });

    const delta = {
      worktreePath: wt,
      baselineHead: 'BASE',
      changedPaths: ['sub/x.txt'],
      untrackedFiles: ['sub/x.txt'],
      patch: '',
    };

    const report = await gitDelivery.checkDeliveryConflicts({ delta, sourceWorkspace: src });
    assert.equal(report.safe, false);
    assert.ok(report.conflicts.some((c) => c.reason === 'symlinked-destination'));

    await assert.rejects(
      () => delivery.deliverApprovedDelta({ delta, sourceWorkspace: src }),
      (err) => err instanceof ResultDeliveryError && /symlink/i.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(escape, 'x.txt')), false, 'nothing written through the symlinked parent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Finding 2 — abort/timeout must terminate the whole owned process group. The
// subtle regression locked here is: the direct CLI/shell leader can exit from
// SIGTERM while a descendant ignores TERM. Leader close MUST NOT cancel the
// later SIGKILL or let stop/resume/retry proceed before the group is gone.
// ===========================================================================

test('killProcessTree signals the negative pid (the whole process group)', () => {
  const orig = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  try {
    killProcessTree({ pid: 4242, killed: false, exitCode: null }, 'SIGTERM');
  } finally {
    process.kill = orig;
  }
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('terminateProcessTree still SIGKILLs descendants after the group leader has already exited', async () => {
  const orig = process.kill;
  const calls = [];
  let groupAlive = true;
  const child = { pid: 77, killed: false, exitCode: null, kill() {} };

  process.kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 0) {
      if (groupAlive) return;
      throw esrch();
    }
    if (sig === 'SIGKILL') groupAlive = false;
  };

  try {
    const termination = terminateProcessTree(child, { graceMs: 15, pollMs: 2 });
    // The leader exits promptly on TERM, but another group member survives.
    child.exitCode = 0;

    let done = false;
    termination.done.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(done, false, 'leader exit alone must not acknowledge teardown');

    await termination.done;
    assert.equal(groupAlive, false);
    assert.ok(calls.some(([pid, sig]) => pid === -77 && sig === 'SIGTERM'));
    assert.ok(calls.some(([pid, sig]) => pid === -77 && sig === 'SIGKILL'),
      'SIGKILL still targets the snapshotted PGID after leader exit');
  } finally {
    process.kill = orig;
  }
});

test('claude executor: child close does not settle cancellation until its process group disappears', async () => {
  const controller = new AbortController();
  const orig = process.kill;
  let child = null;
  let capturedOpts = null;
  let probes = 0;

  process.kill = (pid, sig) => {
    if (pid !== -5151) return orig(pid, sig);
    if (sig === 0) {
      probes += 1;
      // Keep a descendant alive through the immediate probe and one poll,
      // then model its eventual clean TERM exit before escalation is needed.
      if (probes < 3) return;
      throw esrch();
    }
    // TERM is accepted but does not immediately remove the whole group.
  };

  try {
    const spawn = (command, args, opts) => {
      void command;
      void args;
      capturedOpts = opts;
      child = new EventEmitter();
      child.pid = 5151;
      child.killed = false;
      child.exitCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      return child;
    };

    const adapter = createClaudeExecutorAdapter({ spawn, command: 'claude' });
    const p = adapter.execute(demoTaskCard(), { signal: controller.signal });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });

    await tick();
    assert.equal(capturedOpts.detached, true, 'CLI spawned as its own process-group leader');

    controller.abort();
    child.exitCode = 0;
    child.emit('close', null, 'SIGTERM');
    await tick();
    assert.equal(settled, false,
      'direct child close is not enough while the owned process group still exists');

    await assert.rejects(
      p,
      (err) => err.name === 'ProviderCancelledError' && err.cancelled === true
    );
    assert.ok(probes >= 3, 'adapter waited until group-existence probe reported ESRCH');
  } finally {
    process.kill = orig;
  }
});

test('gate cancellation uses the same group-disappearance acknowledgement', async () => {
  const controller = new AbortController();
  const orig = process.kill;
  let child = null;
  let probes = 0;
  let evidenceCalls = 0;

  process.kill = (pid, sig) => {
    if (pid !== -6161) return orig(pid, sig);
    if (sig === 0) {
      probes += 1;
      if (probes < 3) return;
      throw esrch();
    }
  };

  try {
    const spawn = () => {
      child = new EventEmitter();
      child.pid = 6161;
      child.killed = false;
      child.exitCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    };
    const gate = createGateRunner({
      spawn,
      gitEvidenceCollector: {
        collect_evidence() {
          evidenceCalls += 1;
          return { pass: true };
        },
      },
    });

    const p = gate.run(['long-running-check'], { signal: controller.signal });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick();

    controller.abort();
    child.exitCode = 0;
    child.emit('close', null, 'SIGTERM');
    await tick();
    assert.equal(settled, false, 'Gate also waits beyond direct shell close');

    await assert.rejects(p, (err) => err.code === 'GATE_CANCELLED');
    assert.ok(probes >= 3);
    assert.equal(evidenceCalls, 0, 'cancelled Gate never produces review evidence');
  } finally {
    process.kill = orig;
  }
});

// ===========================================================================
// Finding 3 — supergpt_watch of a validly formatted but nonexistent workflow
// id must terminate with WORKFLOW_NOT_FOUND after a finite startup grace,
// instead of polling a fabricated STARTING state until the client cancels.
// ===========================================================================

test('supergptWatch: a valid but nonexistent workflow id terminates with WORKFLOW_NOT_FOUND', async () => {
  const started = Date.now();
  const res = await supergptWatch({
    workflowId: 'wf-nonexistent-abc123',
    _readState: () => null,
    _isKnown: () => false,
    startupGraceMs: 40,
    intervalMs: 5,
  });
  assert.equal(res.status, 'WORKFLOW_NOT_FOUND');
  assert.equal(res.canonicalProgress, null);
  assert.ok(Date.now() - started < 5000, 'watch returned promptly, it did not hang');
});

test('supergptWatch: a known workflow that has not published state yet is tolerated within the grace', async () => {
  let known = false;
  setTimeout(() => { known = true; }, 15);
  const doneState = {
    workflowId: 'wf-starting-abc123',
    workflowStatus: 'DONE',
    stage: 'DONE',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };
  const res = await supergptWatch({
    workflowId: 'wf-starting-abc123',
    _readState: () => (known ? doneState : null),
    _isKnown: () => known,
    startupGraceMs: 2000,
    intervalMs: 5,
  });
  assert.equal(res.status, 'DONE');
});
