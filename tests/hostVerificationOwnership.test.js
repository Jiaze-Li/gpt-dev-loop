import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFICATION_KIND,
  classifyVerificationCommand,
  classifyVerificationBatch,
  assertNoNestedWorkflowLaunch,
  HostVerificationSequencer,
} from '../src/orchestrator/hostVerification.js';

test('local deterministic checks stay in the Executor verification domain', () => {
  for (const cmd of ['node --test tests/foo.test.js', 'npm run lint', 'npm test', 'tsc --noEmit']) {
    assert.equal(classifyVerificationCommand(cmd), VERIFICATION_KIND.EXECUTOR_VERIFICATION, cmd);
  }
});

test('host-state checks auto-classify as HOST_VERIFICATION', () => {
  const hostCmds = [
    'npm run doctor',
    'node scripts/wait.js --cross-workflow',
    'curl -s http://localhost:8080/api/status',
    'node scripts/usage-tracker.js --all-workflows',
    'node scripts/runtime-readiness.js',
    'supergpt_status --json',
  ];
  for (const cmd of hostCmds) {
    assert.equal(classifyVerificationCommand(cmd), VERIFICATION_KIND.HOST_VERIFICATION, cmd);
  }
});

test('benchmark / E2E host checks classify as LONG_RUNNING_HOST_VERIFICATION', () => {
  assert.equal(classifyVerificationCommand('npm run benchmark'), VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION);
  assert.equal(classifyVerificationCommand('node tests/e2e/host-resources.js'), VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION);
  assert.equal(
    classifyVerificationCommand('node scripts/probe.js', { estimatedDurationMs: 10 * 60 * 1000 }),
    VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION,
  );
});

test('a batch of only local commands is a NORMAL_GATE with no host verification', () => {
  const result = classifyVerificationBatch(['npm test', 'npm run lint']);
  assert.equal(result.kind, VERIFICATION_KIND.NORMAL_GATE);
  assert.equal(result.requiresHostVerification, false);
  assert.equal(result.hostCommands.length, 0);
  assert.equal(result.normalGateCommands.length, 2);
});

test('a batch mixing local and host commands splits the two domains', () => {
  const result = classifyVerificationBatch(['npm test', 'npm run doctor', 'npm run benchmark']);
  assert.equal(result.kind, VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION);
  assert.equal(result.requiresHostVerification, true);
  assert.equal(result.longRunning, true);
  assert.deepEqual(result.normalGateCommands.map((e) => e.command), ['npm test']);
  assert.deepEqual(result.hostCommands.map((e) => e.command), ['npm run doctor', 'npm run benchmark']);
});

test('internal roles may not launch or wait on a top-level workflow', () => {
  for (const role of ['executor', 'planner', 'supervisor', 'reviewer', 'gate']) {
    assert.throws(
      () => assertNoNestedWorkflowLaunch({ role, operation: 'supergpt_start' }),
      /NESTED_WORKFLOW_FORBIDDEN/,
      role,
    );
  }
  assert.equal(assertNoNestedWorkflowLaunch({ role: 'front-agent', operation: 'supergpt_start' }), true);
});

test('sequencer enforces Executor -> NORMAL_GATE PASS -> Host Verification -> evidence -> Reviewer', () => {
  const seq = new HostVerificationSequencer({ requiresHostVerification: true });
  const evidence = { evidenceId: 'ev-abc', hash: 'deadbeef' };

  assert.throws(() => seq.normalGatePassed(), /OUT_OF_ORDER/);
  seq.executorComplete();

  assert.throws(() => seq.beginHostVerification(), /OUT_OF_ORDER/);
  assert.throws(() => seq.normalGatePassed({ pass: false }), /NORMAL_GATE_NOT_PASSED/);
  seq.normalGatePassed({ pass: true });

  assert.throws(() => seq.assertReviewerMayStart(), /before host verification evidence/);
  assert.throws(() => seq.recordEvidence(evidence), /OUT_OF_ORDER/);

  seq.beginHostVerification();
  assert.throws(() => seq.recordEvidence({}), /HOST_EVIDENCE_INVALID/);
  seq.recordEvidence(evidence);

  assert.equal(seq.assertReviewerMayStart(), true);
});

test('sequencer without host verification only requires Executor -> NORMAL_GATE PASS', () => {
  const seq = new HostVerificationSequencer({ requiresHostVerification: false });
  seq.executorComplete().normalGatePassed({ pass: true });
  assert.equal(seq.assertReviewerMayStart(), true);
});
