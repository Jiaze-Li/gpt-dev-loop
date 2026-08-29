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
// Finding 2 — abort/timeout must terminate the executor CLI's whole process
// tree (its own process group), and adapter teardown must not complete until
// the direct child has closed. A cancellation must not look like a provider
// failure (zero failover).
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

test('terminateProcessTree escalates SIGTERM -> SIGKILL after a finite grace', async () => {
  const orig = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push([pid, sig]); };
  try {
    terminateProcessTree({ pid: 77, killed: false, exitCode: null }, { graceMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    process.kill = orig;
  }
  assert.deepEqual(calls, [[-77, 'SIGTERM'], [-77, 'SIGKILL']]);
});

test('claude executor adapter: own process group + tree teardown on abort that awaits child close', async () => {
  const controller = new AbortController();
  const killSignals = [];
  let capturedOpts = null;
  let child = null;

  const spawn = (command, args, opts) => {
    capturedOpts = opts;
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    // No pid on the fake -> killProcessTree falls back to child.kill, which
    // here records the signal WITHOUT closing, so we can prove teardown waits.
    child.kill = (sig) => { killSignals.push(sig); };
    return child;
  };

  const adapter = createClaudeExecutorAdapter({ spawn, command: 'claude' });
  const p = adapter.execute(demoTaskCard(), { signal: controller.signal });
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });

  await tick();
  assert.equal(capturedOpts.detached, true, 'CLI spawned as its own process-group leader');

  controller.abort();
  await tick();
  assert.ok(killSignals.includes('SIGTERM'), 'tree teardown started on abort');
  assert.equal(settled, false, 'execute() has NOT resolved — teardown awaits the child close');

  child.emit('close', null, 'SIGTERM');
  await assert.rejects(
    p,
    (err) => err.name === 'ProviderCancelledError' && err.cancelled === true
  );
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
