// Phase 2 #1 — the deterministic Gate's verification plan is FROZEN at
// reviewloop_begin. A Worker that rewrites .reviewloop.json or the package.json
// test script afterwards cannot weaken the Gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { createReviewLoopController } from '../src/reviewloop/controller.js';
import { createReviewObjective, rehydrateObjective } from '../src/reviewloop/objective.js';
import { MemoryPersistence } from './helpers/reviewLoopHarness.js';

function repo({ reviewloopJson, pkg } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-frozen-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 't@t.co');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  if (reviewloopJson) fs.writeFileSync(path.join(dir, '.reviewloop.json'), JSON.stringify(reviewloopJson));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

function controller(extra = {}) {
  return createReviewLoopController({
    persistence: new MemoryPersistence(),
    reviewerFn: async () => ({ value: { findings: [] }, usage: { input_tokens: 1, output_tokens: 1 } }),
    ...extra,
  });
}

test('rewriting .reviewloop.json to a weaker command after begin -> review is blocked (drift), not PASS', async () => {
  const dir = repo({ reviewloopJson: { verify: ['sh -c "exit 1"'] } });
  try {
    const ctl = controller();
    const { loopId } = await ctl.begin({ goal: 'g', cwd: dir });
    // Worker weakens the Gate and makes a code change.
    fs.writeFileSync(path.join(dir, '.reviewloop.json'), JSON.stringify({ verify: ['true'] }));
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    const r = await ctl.review({ loopId });
    assert.equal(r.status, 'REWORK');
    assert.match(r.reason, /verification configuration was changed after reviewloop_begin/);
    assert.ok(r.safetyEvents.some((e) => e.code === 'VERIFICATION_PLAN_DRIFT' && e.severity === 'BLOCKING'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged .reviewloop.json -> the frozen Gate still runs and a clean change PASSes', async () => {
  const dir = repo({ reviewloopJson: { verify: ['true'] } });
  try {
    const ctl = controller();
    const { loopId } = await ctl.begin({ goal: 'g', cwd: dir });
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    const r = await ctl.review({ loopId });
    assert.equal(r.status, 'PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the FROZEN command runs even after .reviewloop.json is deleted (Gate still FAILs)', async () => {
  const dir = repo({ reviewloopJson: { verify: ['sh -c "exit 3"'] } });
  try {
    const ctl = controller();
    const { loopId } = await ctl.begin({ goal: 'g', cwd: dir });
    fs.rmSync(path.join(dir, '.reviewloop.json'));
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    const r = await ctl.review({ loopId });
    // drift (config removed) blocks; even if it did not, the frozen exit-3
    // command would FAIL the Gate. Either way: not PASS.
    assert.notEqual(r.status, 'PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rewriting the package.json test script after begin -> drift blocks the review', async () => {
  const dir = repo({ pkg: { name: 't', scripts: { test: 'node --test tests/*.test.js' } } });
  try {
    const ctl = controller();
    const { loopId } = await ctl.begin({ goal: 'g', cwd: dir });
    const state = await ctl._persistence.readWorkflowState(loopId);
    assert.equal(state.reviewLoop.objective.verificationPlan.source, 'package.json');
    // Worker neuters the test script.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'echo ok' } }, null, 2));
    fs.writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
    const r = await ctl.review({ loopId });
    assert.equal(r.status, 'REWORK');
    assert.match(r.reason, /verification configuration was changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the frozen verification plan is part of the tamper-checked objective fingerprint', () => {
  const o = createReviewObjective({
    loopId: 'L', goal: 'g', mode: 'LOCAL',
    verificationPlan: { source: 'repo-config', commands: ['npm test'], manifestFingerprint: 'abc123', frozenAt: 't0' },
  });
  const serialized = JSON.parse(JSON.stringify(o));
  // tamper: weaken the frozen commands
  serialized.verificationPlan.commands = ['true'];
  assert.throws(() => rehydrateObjective(serialized), /weakened/i);
});
