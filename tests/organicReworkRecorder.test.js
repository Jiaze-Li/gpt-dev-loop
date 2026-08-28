import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import {
  OrganicReworkRecorder,
  REWORK_VERIFICATION_STATUSES,
} from '../src/orchestrator/organicReworkRecorder.js';

test('OrganicReworkRecorder: PASS-only workflow produces no REWORK evidence', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-1',
      requiredChanges: [],
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.NOT_YET_OBSERVED);
    assert.equal(status.verifiedRecord, null);
    assert.deepEqual(recorder._readAllRecords(), []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: real REWORK opens evidence record and marks OBSERVED IN PROGRESS', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['Fix type check'],
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS);
    assert.equal(status.inProgressRecord.workflowId, 'wf-1');
    assert.equal(status.inProgressRecord.taskId, 'task-1');

    const records = recorder._readAllRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].reworkLiveVerified, false);
    assert.deepEqual(records[0].initialAttempt.requiredChanges, ['Fix type check']);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: same-task retry with fresh Executor and Reviewer PASS marks LIVE VERIFIED', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    // Attempt 1: REWORK
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['Fix input validation'],
    });

    // Attempt 2: Same task, fresh Executor callId, Gate PASS, fresh Reviewer PASS
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 2,
      executorCallId: 'call-exe-2',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-2',
      requiredChanges: [],
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.LIVE_VERIFIED);
    assert.ok(status.verifiedRecord);
    assert.equal(status.verifiedRecord.workflowId, 'wf-1');
    assert.equal(status.verifiedRecord.taskId, 'task-1');
    assert.equal(status.verifiedRecord.convergence.finalAttempt, 2);
    assert.equal(status.verifiedRecord.convergence.executorCallId, 'call-exe-2');
    assert.equal(status.verifiedRecord.convergence.reviewerCallId, 'call-rev-2');

    const records = recorder._readAllRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].reworkLiveVerified, true);
    assert.equal(records[0].retryAttempts.length, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: different task does not get mistaken for retry', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    // Task 1: REWORK
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['Fix task 1'],
    });

    // Task 2: PASS (different task)
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-2',
      attempt: 1,
      executorCallId: 'call-exe-2',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-2',
      requiredChanges: [],
    });

    // Task 1 should still be in progress, not verified
    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS);
    assert.equal(status.inProgressRecord.taskId, 'task-1');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: repeated REWORK remains pending until convergence', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    // Attempt 1: REWORK
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['First issue'],
    });

    // Attempt 2: Still REWORK
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 2,
      executorCallId: 'call-exe-2',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-2',
      requiredChanges: ['Second issue'],
    });

    assert.equal(recorder.getVerificationStatus().status, REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS);

    // Attempt 3: Converges with PASS
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 3,
      executorCallId: 'call-exe-3',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-3',
      requiredChanges: [],
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.LIVE_VERIFIED);
    assert.equal(status.verifiedRecord.convergence.finalAttempt, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: non-convergence flag prevents LIVE VERIFIED marking', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-1',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['Fix syntax'],
    });

    // Attempt 2 with nonConvergence = true
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 2,
      executorCallId: 'call-exe-2',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-2',
      requiredChanges: [],
      nonConvergence: true,
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('OrganicReworkRecorder: duplicate/reused executorCallId fails closed (does not mark LIVE VERIFIED)', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rework-rec-test-'));
  try {
    const recorder = new OrganicReworkRecorder({ root: tmpDir, fileName: 'evidence.jsonl' });

    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 1,
      executorCallId: 'call-exe-SAME',
      gateResult: 'PASS',
      reviewerDecision: 'REWORK',
      reviewerCallId: 'call-rev-1',
      requiredChanges: ['Fix type'],
    });

    // Attempt 2 illegally reusing the exact same callId
    recorder.observeAttempt({
      workflowId: 'wf-1',
      taskId: 'task-1',
      attempt: 2,
      executorCallId: 'call-exe-SAME',
      gateResult: 'PASS',
      reviewerDecision: 'PASS',
      reviewerCallId: 'call-rev-2',
      requiredChanges: [],
    });

    const status = recorder.getVerificationStatus();
    assert.equal(status.status, REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
