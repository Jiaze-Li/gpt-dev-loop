// Deterministic proof for Codex finding #4: an explicitly resumable workflow
// (HUMAN_REQUIRED, or a delivery-ready / PRESERVED marker) is never deleted
// by age-based GC, while genuinely finished/disposable stale worktrees still
// clean correctly.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { gcSuperGptResources } from '../src/orchestrator/workflowLifecycle.js';

const fakeSpawn = (command, args) => {
  const removed = args.includes('remove');
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event, cb) => { if (event === 'close') queueMicrotask(() => cb(0)); },
    _removed: removed,
  };
};

async function makeWorkflowDir(root, wfId, { status, control, resources } = {}) {
  const dir = path.join(root, `repo-${wfId}`);
  await mkdir(dir, { recursive: true });
  if (status) {
    await writeFile(path.join(root, `${wfId}.state.json`),
      JSON.stringify({ workflowId: wfId, workflowStatus: status, activeProcesses: [] }));
  }
  if (control) {
    await writeFile(path.join(root, `${wfId}.control.json`), JSON.stringify({ workflowId: wfId, ...control }));
  }
  if (resources) {
    await writeFile(path.join(root, `${wfId}.resources.json`), JSON.stringify({ workflowId: wfId, ...resources }));
  }
  // Also a workspace metadata file — the thing a resume needs.
  await writeFile(path.join(root, `${wfId}.workspace.json`), JSON.stringify({ workflow_id: wfId }));
  return dir;
}

test('a HUMAN_REQUIRED worktree older than the stale threshold is NOT collected, and stays resumable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-gc-hr-'));
  try {
    const hrDir = await makeWorkflowDir(root, 'wf-agy-hr-1', { status: 'HUMAN_REQUIRED' });
    const doneDir = await makeWorkflowDir(root, 'wf-agy-done-1', { status: 'DONE' });

    const res = await gcSuperGptResources({ root, maxAgeMs: -1, spawn: fakeSpawn });

    assert.equal(res.cleanedWorktrees.includes(hrDir), false, 'HUMAN_REQUIRED worktree preserved despite age');
    assert.ok(existsSync(hrDir));
    // Its resume inputs survive.
    assert.ok(existsSync(path.join(root, 'wf-agy-hr-1.workspace.json')));

    assert.ok(res.cleanedWorktrees.includes(doneDir), 'a finished stale worktree still cleans');
    assert.equal(existsSync(doneDir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivery-ready and PRESERVED markers also protect a stale worktree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-gc-mark-'));
  try {
    const deliveryReadyDir = await makeWorkflowDir(root, 'wf-agy-dr-1', { control: { phase: 'delivery_ready', resumable: true } });
    const preservedDir = await makeWorkflowDir(root, 'wf-agy-pr-1', { resources: { status: 'PRESERVED' } });
    const abandonedDir = await makeWorkflowDir(root, 'wf-agy-ab-1', {}); // no markers, just old

    const res = await gcSuperGptResources({ root, maxAgeMs: -1, spawn: fakeSpawn });

    assert.equal(res.cleanedWorktrees.includes(deliveryReadyDir), false);
    assert.equal(res.cleanedWorktrees.includes(preservedDir), false);
    assert.ok(existsSync(deliveryReadyDir));
    assert.ok(existsSync(preservedDir));

    // A genuinely abandoned, unmarked, stale worktree is still collected.
    assert.ok(res.cleanedWorktrees.includes(abandonedDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a finished (DONE) workflow is disposable even if a resumable marker lingers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-gc-done-'));
  try {
    const dir = await makeWorkflowDir(root, 'wf-agy-done-2', { status: 'DONE', control: { resumable: true } });
    const res = await gcSuperGptResources({ root, maxAgeMs: -1, spawn: fakeSpawn });
    assert.ok(res.cleanedWorktrees.includes(dir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
