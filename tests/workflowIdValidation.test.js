// Codex PR #3 P1 — "Constrain workflow IDs before constructing durable paths"
// (thread 3885994346).
//
// Workflow IDs reach run/start/status/watch/wait/stop/resume/verify, the
// ownership lease, the control/stop records, lifecycle cleanup and worktree
// metadata paths — every one of them a `path.join(root, `${workflowId}...`)`.
// An unconstrained ID ("../escape", "/tmp/escape", "..\\escape") normalises
// OUTSIDE SUPERGPT_WORKTREE_ROOT. These regressions pin the central
// validateWorkflowId() grammar + the assertPathWithinRoot() containment
// defence, and prove no durable path constructor touches disk outside root
// for a malicious ID.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  validateWorkflowId,
  assertPathWithinRoot,
  WorkflowIdError,
  WORKFLOW_ID_PATTERN,
} from '../src/orchestrator/workflowId.js';
import { controlPath, stopPath } from '../src/orchestrator/workflowControl.js';
import { ownerLockPath } from '../src/orchestrator/workflowOwnership.js';
import { workflowRuntimeDirectory, supergptStop, supergptResume, supergptStatus } from '../src/orchestrator/supergpt.js';
import { supergptVerify } from '../src/orchestrator/hostVerification.js';

const MALICIOUS = [
  '../escape',
  '../../escape',
  '..\\escape',
  '..\\..\\escape',
  'a/../../escape',
  'foo/bar',
  'foo\\bar',
  '/tmp/escape',
  'C:\\temp\\escape',
  'c:/temp/escape',
  '.',
  '..',
  '',
  'a\u0000b',
  'a\tb',
  'a\nb',
  'x'.repeat(129),
  '-leading-dash',
  '.leading-dot',
];

const VALID = [
  'wf-3f8a1c2e-0b4d-4c1a-9e2f-1a2b3c4d5e6f',
  'wf-agy-3f8a1c2e-0b4d-4c1a-9e2f-1a2b3c4d5e6f',
  'my-workflow_123',
  'wf-race',
  'wf-rp-1',
  'A',
  '0',
  'a'.repeat(128),
];

test('validateWorkflowId rejects traversal / separator / absolute / control / overlong IDs', () => {
  for (const id of MALICIOUS) {
    assert.throws(
      () => validateWorkflowId(id),
      (err) => err instanceof WorkflowIdError && err.code === 'INVALID_WORKFLOW_ID',
      `expected ${JSON.stringify(id)} to be rejected`
    );
  }
});

test('validateWorkflowId accepts every generated and hand-authored safe ID', () => {
  for (const id of VALID) {
    assert.equal(validateWorkflowId(id), id, `expected ${JSON.stringify(id)} to be accepted`);
    assert.ok(WORKFLOW_ID_PATTERN.test(id));
  }
});

test('validateWorkflowId never mutates / sanitises — it throws', () => {
  assert.throws(() => validateWorkflowId('../x'), WorkflowIdError);
  assert.throws(() => validateWorkflowId(null), WorkflowIdError);
  assert.throws(() => validateWorkflowId(42), WorkflowIdError);
});

test('assertPathWithinRoot blocks escape and sibling-prefix tricks', () => {
  const root = '/home/u/.supergpt/worktrees';
  assert.throws(() => assertPathWithinRoot(root, '/home/u/.supergpt/worktrees-evil/x'), WorkflowIdError);
  assert.throws(() => assertPathWithinRoot(root, '/home/u/.supergpt/x'), WorkflowIdError);
  assert.throws(() => assertPathWithinRoot(root, path.join(root, '..', 'escape')), WorkflowIdError);
  assert.equal(assertPathWithinRoot(root, path.join(root, 'wf-1.control.json')), path.join(root, 'wf-1.control.json'));
});

test('low-level durable path constructors reject a traversal ID before building a path', () => {
  for (const bad of ['../escape', '/tmp/escape', '..\\escape', '.', '']) {
    assert.throws(() => controlPath({ root: '/r', workflowId: bad }), WorkflowIdError);
    assert.throws(() => stopPath({ root: '/r', workflowId: bad }), WorkflowIdError);
    assert.throws(() => ownerLockPath({ root: '/r', workflowId: bad }), WorkflowIdError);
    assert.throws(() => workflowRuntimeDirectory(bad), WorkflowIdError);
  }
});

test('controlPath / stopPath / ownerLockPath stay inside the root for a valid ID', () => {
  const root = '/home/u/.supergpt/worktrees';
  assert.equal(controlPath({ root, workflowId: 'wf-1' }), path.join(root, 'wf-1.control.json'));
  assert.equal(stopPath({ root, workflowId: 'wf-1' }), path.join(root, 'wf-1.stop.json'));
  assert.equal(ownerLockPath({ root, workflowId: 'wf-1' }), path.join(root, 'wf-1.owner.lock'));
});

test('public entrypoints reject a traversal ID and create/read/delete NOTHING outside root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-wfid-'));
  const canary = path.join(root, '..', `canary-${process.pid}-${Date.now()}`);
  fs.writeFileSync(canary, 'do-not-touch');
  try {
    const bad = `../canary-${process.pid}-${Date.now()}`;

    await assert.rejects(() => supergptStop({ workflowId: bad, root }), WorkflowIdError);
    await assert.rejects(() => supergptResume({ workflowId: bad, cwd: root }), WorkflowIdError);
    await assert.rejects(() => supergptVerify({ workflowId: bad, root }), WorkflowIdError);
    assert.throws(() => supergptStatus({ workflowId: bad, root }), WorkflowIdError);

    // The out-of-root canary is untouched: not deleted, not overwritten.
    assert.equal(fs.readFileSync(canary, 'utf8'), 'do-not-touch');
    // No `<root>/../<...>` stop/owner/control file was produced.
    for (const suffix of ['.stop.json', '.control.json', '.owner.lock', '.workspace.json']) {
      assert.equal(fs.existsSync(path.join(root, '..', `canary-${process.pid}-${Date.now()}${suffix}`)), false);
    }
  } finally {
    fs.rmSync(canary, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
