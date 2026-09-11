// P2 — the PR verification plan is discovered from INSIDE the exact PR HEAD
// snapshot at reviewloop_begin (never the ambient user cwd, which may be on a
// different branch with different verification config entirely) and frozen
// into the objective before any review round runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewLoopController } from '../src/reviewloop/controller.js';
import {
  MemoryPersistence, mockPrBackend, prTestFakes,
} from './helpers/reviewLoopHarness.js';

function buildController({ ambientCwd, prSnapshotCwd, discovered }) {
  const backend = mockPrBackend({ heads: ['H1'] });
  const seenDiscoverCwds = [];
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    // Route the disposable PR snapshot worktree to a DIFFERENT scripted cwd
    // than the ambient one — proving `begin` freezes from the snapshot, not
    // the caller's own cwd.
    buildPrSnapshotFn: async ({ headSha, baseSha }, fn) => fn({
      worktreeDir: prSnapshotCwd, mergeBase: baseSha, headSha, baseSha,
    }),
    discoverVerificationCommandsFn: ({ cwd }) => {
      seenDiscoverCwds.push(cwd);
      return discovered(cwd);
    },
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, results: [], fingerprint: 'g1', failureIdentities: [],
    }),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  return { controller, seenDiscoverCwds };
}

test('the PR verification plan is discovered from the exact PR snapshot worktree, not the ambient cwd', async () => {
  const { controller, seenDiscoverCwds } = buildController({
    ambientCwd: '/ambient/dirty/other-branch',
    prSnapshotCwd: '/pr-snapshot/exact-head',
    discovered: (cwd) => (cwd === '/pr-snapshot/exact-head'
      ? { source: 'repo-config', commands: ['npm run pr-test'], manifestFingerprint: 'PR_MF' }
      : { source: 'repo-config', commands: ['npm run ambient-only-test'], manifestFingerprint: 'AMBIENT_MF' }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/ambient/dirty/other-branch', prNumber: 9 });
  const state = await controller._persistence.readWorkflowState(loopId);
  const plan = state.reviewLoop.objective.verificationPlan;
  assert.deepEqual(plan.commands, ['npm run pr-test']);
  assert.equal(plan.manifestFingerprint, 'PR_MF');
  // Discovery ran inside the PR snapshot worktree at least once.
  assert.ok(seenDiscoverCwds.includes('/pr-snapshot/exact-head'));
});

test('an ambient cwd with dirty/different verification config never leaks into the frozen PR Gate plan, and the Gate actually runs the frozen commands', async () => {
  const runCommands = [];
  const backend = mockPrBackend({ heads: ['H1'] });
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    buildPrSnapshotFn: async ({ headSha, baseSha }, fn) => fn({
      worktreeDir: '/pr-snapshot', mergeBase: baseSha, headSha, baseSha,
    }),
    discoverVerificationCommandsFn: ({ cwd }) => (cwd === '/pr-snapshot'
      ? { source: 'repo-config', commands: ['echo pr-frozen'], manifestFingerprint: 'PR_MF' }
      : { source: 'repo-config', commands: ['echo AMBIENT-SHOULD-NEVER-RUN'], manifestFingerprint: 'AMBIENT_MF' }),
    runGateFn: async ({ commands }) => {
      runCommands.push(...commands);
      return {
        verdict: 'PASS', pass: true, results: [], fingerprint: 'g1', failureIdentities: [],
      };
    },
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/ambient', prNumber: 9 });
  const r = await controller.review({ loopId });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(runCommands, ['echo pr-frozen']);
});

test('a later HEAD in the same loop that drifts from the frozen PR-snapshot plan still fails closed (existing frozen-plan policy)', async () => {
  const backend = mockPrBackend({ heads: ['H1', 'H2'] });
  let headManifest = 'PR_MF';
  const controller = createReviewLoopController({
    persistence: new MemoryPersistence(),
    prBackend: backend,
    ...prTestFakes(backend),
    buildPrSnapshotFn: async ({ headSha, baseSha }, fn) => fn({
      worktreeDir: '/pr-snapshot', mergeBase: baseSha, headSha, baseSha,
    }),
    discoverVerificationCommandsFn: () => ({ source: 'repo-config', commands: ['echo pr'], manifestFingerprint: headManifest }),
    runGateFn: async () => ({
      verdict: 'PASS', pass: true, results: [], fingerprint: 'g1', failureIdentities: [],
    }),
    reviewerFn: async () => ({
      value: { findings: [{ severity: 'P1', file: 'a.js', title: 'x' }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const { loopId } = await controller.begin({ goal: 'g', cwd: '/ambient', prNumber: 9 });
  const r1 = await controller.review({ loopId });
  assert.equal(r1.status, 'REWORK');
  backend.advanceHead();
  headManifest = 'PR_MF_CHANGED'; // the new HEAD's own verification config drifted
  const r2 = await controller.review({ loopId });
  assert.equal(r2.status, 'REWORK');
  assert.ok(r2.safetyEvents.some((e) => e.code === 'VERIFICATION_PLAN_DRIFT'));
});
