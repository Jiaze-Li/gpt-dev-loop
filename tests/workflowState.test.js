import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  WorkflowStateManager,
  readLiveWorkflowState,
  waitForWorkflowState,
  formatTransitionEvent,
  validateAcceptanceInvariants,
  captureTerminalSnapshot,
  generateTerminalAcceptanceReport,
  WORKFLOW_STAGES,
  WORKFLOW_STATUSES,
} from '../src/orchestrator/workflowState.js';

test('WorkflowStateManager: manages stages, progress, and local heartbeat with zero tokens', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'supergpt-state-test-'));
  const notifications = [];

  const manager = new WorkflowStateManager({
    workflowId: 'wf-test-123',
    root: tmpRoot,
    onStateChange: (s) => notifications.push(s.stage),
  });

  manager.startHeartbeat(50);

  // Stage transitions
  manager.startStage(WORKFLOW_STAGES.PLANNING);
  assert.equal(manager.getState().stage, WORKFLOW_STAGES.PLANNING);

  manager.startStage(WORKFLOW_STAGES.SUPERVISOR, { taskIndex: 1, taskTotal: 3, taskId: 'task-1' });
  assert.equal(manager.getState().taskId, 'task-1');

  manager.startStage(WORKFLOW_STAGES.EXECUTOR, { attempt: 1 });
  assert.equal(manager.getState().stageStatuses.executor, 'running');

  // Activity and PID tracking
  manager.recordProcessStart('executor', 12345);
  assert.equal(manager.getState().activeProcesses.length, 1);
  assert.equal(manager.getState().activeProcesses[0].pid, 12345);

  manager.recordActivity({ stream: 'stdout' });
  assert.ok(manager.getState().lastActivityAt);

  manager.recordProcessEnd('executor', 12345, 0);
  assert.equal(manager.getState().activeProcesses.length, 0);

  manager.startStage(WORKFLOW_STAGES.GATE);
  assert.equal(manager.getState().stageStatuses.executor, 'done');
  assert.equal(manager.getState().stageStatuses.gate, 'running');

  manager.startStage(WORKFLOW_STAGES.REVIEWER);
  assert.equal(manager.getState().stageStatuses.reviewer, 'running');

  manager.setDecision('PASS');
  assert.equal(manager.getState().lastDecision, 'PASS');

  // Verify live state read from disk
  await manager.persist();
  const diskState = readLiveWorkflowState({ workflowId: 'wf-test-123', root: tmpRoot });
  assert.ok(diskState);
  assert.equal(diskState.workflowId, 'wf-test-123');
  assert.equal(diskState.stage, WORKFLOW_STAGES.REVIEWER);

  // Progress UX rendering
  const progressText = manager.formatProgressBlock();
  assert.match(progressText, /SUPERGPT ⟳/);
  assert.match(progressText, /Task\s+1 \/ 3/);
  assert.match(progressText, /Heartbeat/);
  assert.match(progressText, /Last progress/);

  // Failure banner
  const failureBanner = manager.formatFailureBanner('Command failed with code 1', {
    retrying: true,
    nextAttempt: 2,
  });
  assert.match(failureBanner, /SUPERGPT · RETRYING/);
  assert.match(failureBanner, /Retrying as Attempt 2/);

  // Wait for state
  const waitPromise = waitForWorkflowState({
    workflowId: 'wf-test-123',
    root: tmpRoot,
    predicate: (s) => s.stage === WORKFLOW_STAGES.DONE,
    timeoutMs: 1000,
  });

  manager.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: 'Completed' });
  const resultState = await waitPromise;
  assert.equal(resultState.workflowStatus, WORKFLOW_STATUSES.DONE);

  manager.stopHeartbeat();
  await rm(tmpRoot, { recursive: true, force: true });
});

test('formatTransitionEvent: formats meaningful transitions cleanly with zero tokens', () => {
  assert.equal(
    formatTransitionEvent({ type: 'task_started', taskId: 't-1' }),
    '▶ TASK_STARTED: t-1'
  );
  assert.equal(
    formatTransitionEvent({ type: 'task_attempt_started', taskId: 't-1', attempt: 2 }),
    '  ↳ EXECUTOR_STARTED: t-1 (Attempt 2)'
  );
  assert.equal(
    formatTransitionEvent({ type: 'verification_finished', result: 'PASS' }),
    '  ✔ GATE_PASS'
  );
  assert.equal(
    formatTransitionEvent({ type: 'verification_finished', result: 'FAIL' }),
    '  ✖ GATE_FAIL'
  );
  assert.equal(
    formatTransitionEvent({ type: 'review_finished', decision: 'PASS' }),
    '  ✔ REVIEWER_PASS'
  );
  assert.equal(
    formatTransitionEvent({ type: 'review_finished', decision: 'REWORK', requiredChanges: ['Fix type error'] }),
    '  ↺ REVIEWER_REWORK: Fix type error'
  );
  assert.equal(
    formatTransitionEvent({ type: 'rework_requested', taskId: 't-1', attempt: 2 }),
    '  ↺ CONTINUE_REWORK: t-1 (Attempt 2)'
  );
  assert.equal(
    formatTransitionEvent({ type: 'human_required', question: 'Select DB' }),
    '⏸ HUMAN_REQUIRED: Select DB'
  );
  assert.equal(
    formatTransitionEvent({ type: 'workflow_finished', status: 'WORKFLOW_DONE', summary: 'All good' }),
    '★ WORKFLOW_DONE: All good'
  );
});

test('validateAcceptanceInvariants: catches inconsistent attempts, fabricated retries, and cross-task pollution', () => {
  // A. Task 1 PASS on attempt 1, Task 2 REWORK on attempt 1, Task 2 PASS on attempt 2
  const validTwoTaskState = {
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, executorCallId: 'exec-1', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
      { taskId: 'task-2', attempt: 1, executorCallId: 'exec-2', gateResult: 'PASS', reviewerDecision: 'REWORK', requiredChanges: ['Fix format'] },
      { taskId: 'task-2', attempt: 2, executorCallId: 'exec-3', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
  };
  assert.equal(validateAcceptanceInvariants(validTwoTaskState).valid, true);

  // B. Reviewer PASS on attempt 1 followed by fabricated same-task attempt 2
  const fabricatedRetryState = {
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, executorCallId: 'exec-1', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
      { taskId: 'task-1', attempt: 2, executorCallId: 'exec-2', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
  };
  const fabricatedRes = validateAcceptanceInvariants(fabricatedRetryState);
  assert.equal(fabricatedRes.valid, false);
  assert.match(fabricatedRes.violations[0], /received Reviewer PASS but was followed by attempt 2/);

  // C. Reviewer REWORK with empty required_changes
  const emptyReworkState = {
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, executorCallId: 'exec-1', gateResult: 'PASS', reviewerDecision: 'REWORK', requiredChanges: [] },
      { taskId: 'task-1', attempt: 2, executorCallId: 'exec-2', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
  };
  const emptyReworkRes = validateAcceptanceInvariants(emptyReworkState);
  assert.equal(emptyReworkRes.valid, false);
  assert.match(emptyReworkRes.violations[0], /has REWORK decision but required_changes is empty/);

  // D. Stale executor session reuse (non-fresh executor attempt)
  const staleExecutorState = {
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, executorCallId: 'exec-same', gateResult: 'PASS', reviewerDecision: 'REWORK', requiredChanges: ['Fix bug'] },
      { taskId: 'task-1', attempt: 2, executorCallId: 'exec-same', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
  };
  const staleExecRes = validateAcceptanceInvariants(staleExecutorState);
  assert.equal(staleExecRes.valid, false);
  assert.match(staleExecRes.violations[0], /did not use a fresh Executor/);

  // E. Accounting reconciliation mismatch
  const accountingMismatchState = {
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, executorCallId: 'exec-1', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
    tokenUsage: {
      executor: { calls: 2 },
      reviewer: { calls: 1 },
    },
  };
  const mismatchRes = validateAcceptanceInvariants(accountingMismatchState);
  assert.equal(mismatchRes.valid, false);
  assert.match(mismatchRes.violations[0], /Executor calls mismatch/);
});

test('captureTerminalSnapshot & generateTerminalAcceptanceReport: terminal snapshot guard invariants', () => {
  // 1. Report requested while REVIEWER or EXECUTOR is in flight -> cannot claim FINAL/PASS
  const inFlightState = {
    workflowId: 'wf-running-1',
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.REVIEWER,
    activeProcesses: [{ role: 'reviewer', pid: 999 }],
    taskAttempts: [],
  };
  const inFlightReport = generateTerminalAcceptanceReport({ state: inFlightState });
  assert.equal(inFlightReport.acceptance, 'ACCEPTANCE_NOT_TERMINAL');
  assert.equal(inFlightReport.valid, false);
  assert.match(inFlightReport.reason, /is non-terminal/);

  // 2. Terminal workflow state with active in-flight process -> fails closed
  const dirtyTerminalState = {
    workflowId: 'wf-dirty-1',
    workflowStatus: WORKFLOW_STATUSES.DONE,
    stage: WORKFLOW_STAGES.DONE,
    activeProcesses: [{ role: 'executor', pid: 1001 }],
    taskAttempts: [],
  };
  const dirtyReport = generateTerminalAcceptanceReport({ state: dirtyTerminalState });
  assert.equal(dirtyReport.acceptance, 'ACCEPTANCE_NOT_TERMINAL');
  assert.equal(dirtyReport.valid, false);

  // 3. Completed workflow produces stable identical report facts on repeated reads
  const completedState = {
    workflowId: 'wf-done-1',
    workflowStatus: WORKFLOW_STATUSES.DONE,
    stage: WORKFLOW_STAGES.DONE,
    activeProcesses: [],
    taskAttempts: [
      { taskId: 't-1', attempt: 1, executorCallId: 'exec-1', gateResult: 'PASS', reviewerDecision: 'PASS', requiredChanges: [] },
    ],
    tokenUsage: {
      executor: { calls: 1 },
      reviewer: { calls: 1 },
    },
  };

  const report1 = generateTerminalAcceptanceReport({ state: completedState });
  const report2 = generateTerminalAcceptanceReport({ state: completedState });
  assert.equal(report1.acceptance, 'PASS');
  assert.equal(report2.acceptance, 'PASS');
  assert.deepEqual(report1, report2);
});
