// User-visible safety / cost event projection.
//
// REAL MODEL CALLS = 0. No provider, no SuperGPT workflow, no network — this
// suite only exercises the pure event model, the WorkflowStateManager
// persistence hook, and the terminal projection invariant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SAFETY_EVENT_CODES,
  SAFETY_SEVERITY,
  makeSafetyEvent,
  summarizeSafetyEvents,
  formatBlockingSafetyReason,
  safetyCodeForAdapterError,
  classifyVerificationPermissionBlocked,
} from '../src/orchestrator/safetyEvents.js';
import { WorkflowStateManager, WORKFLOW_STATUSES } from '../src/orchestrator/workflowState.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

test('makeSafetyEvent: produces the full stable shape', () => {
  const ev = makeSafetyEvent({
    code: SAFETY_EVENT_CODES.EXECUTOR_BUDGET_EXCEEDED,
    severity: SAFETY_SEVERITY.BLOCKING,
    role: 'executor',
    taskId: 't-1',
    attempt: 2,
    reason: 'cacheCreation=900000/200000',
    repeatCount: null,
    actionTaken: 'workflow halted',
  });
  assert.deepEqual(Object.keys(ev).sort(), [
    'actionTaken', 'at', 'attempt', 'code', 'reason', 'repeatCount', 'role', 'severity', 'taskId',
  ]);
  assert.equal(ev.severity, 'BLOCKING');
  assert.equal(ev.attempt, 2);
  assert.match(ev.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('makeSafetyEvent: rejects an unknown code or severity', () => {
  assert.throws(() => makeSafetyEvent({ code: 'NOPE', severity: 'WARNING' }), /unknown safety event code/);
  assert.throws(
    () => makeSafetyEvent({ code: SAFETY_EVENT_CODES.EXECUTOR_BUDGET_EXCEEDED, severity: 'LOUD' }),
    /unknown severity/,
  );
});

test('summarizeSafetyEvents: blockingSafetyEvent is the most recent BLOCKING', () => {
  const events = [
    makeSafetyEvent({ code: SAFETY_EVENT_CODES.FRONT_AGENT_POLLING_REGRESSION, severity: 'WARNING' }),
    makeSafetyEvent({ code: SAFETY_EVENT_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED, severity: 'BLOCKING', reason: 'first' }),
    makeSafetyEvent({ code: SAFETY_EVENT_CODES.EXECUTOR_BUDGET_EXCEEDED, severity: 'BLOCKING', reason: 'latest' }),
  ];
  const s = summarizeSafetyEvents(events);
  assert.equal(s.safetyEvents.length, 3);
  assert.equal(s.hasBlocking, true);
  assert.equal(s.hasWarnings, true);
  assert.equal(s.blockingSafetyEvent.reason, 'latest');
  assert.equal(s.warningSafetyEvents.length, 1);
});

test('summarizeSafetyEvents: empty / all-warning input yields a null blockingSafetyEvent', () => {
  assert.equal(summarizeSafetyEvents([]).blockingSafetyEvent, null);
  const warn = summarizeSafetyEvents([makeSafetyEvent({ code: SAFETY_EVENT_CODES.FRONT_AGENT_POLLING_REGRESSION, severity: 'WARNING' })]);
  assert.equal(warn.blockingSafetyEvent, null);
  assert.equal(warn.hasWarnings, true);
});

test('formatBlockingSafetyReason: one line carrying code + reason + action', () => {
  const line = formatBlockingSafetyReason(makeSafetyEvent({
    code: SAFETY_EVENT_CODES.EXECUTOR_BUDGET_EXCEEDED,
    severity: 'BLOCKING',
    role: 'executor',
    reason: 'cacheCreation=900000/200000',
    actionTaken: 'workflow halted — HUMAN_REQUIRED',
  }));
  assert.match(line, /SAFETY\[BLOCKING] EXECUTOR_BUDGET_EXCEEDED/);
  assert.match(line, /cacheCreation=900000\/200000/);
  assert.match(line, /workflow halted/);
});

test('safetyCodeForAdapterError: maps first-batch adapter errors, ignores others', () => {
  assert.equal(
    safetyCodeForAdapterError(new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED, 'x')),
    'REVIEWER_CONTEXT_BUDGET_EXCEEDED',
  );
  assert.equal(
    safetyCodeForAdapterError(new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT, 'x')),
    null,
  );
  assert.equal(safetyCodeForAdapterError(new Error('plain')), null);
});

test('classifyVerificationPermissionBlocked: WARNING when another approved path remains', () => {
  const r = classifyVerificationPermissionBlocked({
    approvedCommands: ['npm test', 'node check.js'],
    deniedCommands: ['npm test'],
  });
  assert.equal(r.severity, 'WARNING');
  assert.equal(r.hasAltPath, true);
  assert.deepEqual(r.remainingApprovedCommands, ['node check.js']);
});

test('classifyVerificationPermissionBlocked: BLOCKING when every approved command is denied', () => {
  const r = classifyVerificationPermissionBlocked({
    approvedCommands: ['npm test'],
    deniedCommands: ['npm test'],
  });
  assert.equal(r.severity, 'BLOCKING');
  assert.equal(r.hasAltPath, false);
});

test('WorkflowStateManager.recordSafetyEvent: persists to state.json and survives a terminal transition', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'safety-state-'));
  try {
    const mgr = new WorkflowStateManager({ workflowId: 'wf-agy-test-safety1', kind: 'INTERNAL_TEST', root });
    assert.deepEqual(mgr.getSafetyEvents(), []);

    mgr.recordSafetyEvent({
      code: SAFETY_EVENT_CODES.VERIFICATION_PERMISSION_BLOCKED,
      severity: 'WARNING',
      role: 'executor',
      taskId: 't-1',
      attempt: 1,
      repeatCount: 3,
      reason: 'node verify.js repeatedly denied',
      actionTaken: 'other approved verification path still available; workflow continues',
    });

    mgr.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: 'done' });

    const persisted = JSON.parse(readFileSync(path.join(root, 'wf-agy-test-safety1.state.json'), 'utf8'));
    assert.equal(persisted.workflowStatus, 'DONE');
    assert.equal(persisted.safetyEvents.length, 1);
    assert.equal(persisted.safetyEvents[0].code, 'VERIFICATION_PERMISSION_BLOCKED');
    assert.equal(persisted.safetyEvents[0].repeatCount, 3);

    // Terminal projection invariant: an event recorded internally MUST be
    // visible to the terminal channel. A broken projection would fail here.
    const projection = summarizeSafetyEvents(persisted.safetyEvents);
    assert.equal(projection.safetyEvents.length, 1, 'internal record must not be user-invisible');
    assert.equal(projection.blockingSafetyEvent, null);
    assert.equal(projection.hasWarnings, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WorkflowStateManager.recordSafetyEvent: a BLOCKING event projects as blockingSafetyEvent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'safety-state-'));
  try {
    const mgr = new WorkflowStateManager({ workflowId: 'wf-agy-test-safety2', kind: 'INTERNAL_TEST', root });
    mgr.recordSafetyEvent({
      code: SAFETY_EVENT_CODES.EXECUTOR_BUDGET_EXCEEDED,
      severity: 'BLOCKING',
      role: 'executor',
      taskId: 't-1',
      attempt: 1,
      reason: 'cacheCreation=900000/200000',
      actionTaken: 'workflow halted — HUMAN_REQUIRED',
    });
    mgr.transitionTerminal(WORKFLOW_STATUSES.HUMAN_REQUIRED, { reason: 'stopped' });

    const persisted = JSON.parse(readFileSync(path.join(root, 'wf-agy-test-safety2.state.json'), 'utf8'));
    const projection = summarizeSafetyEvents(persisted.safetyEvents);
    assert.ok(projection.blockingSafetyEvent, 'BLOCKING event must reach the terminal projection');
    assert.equal(projection.blockingSafetyEvent.code, 'EXECUTOR_BUDGET_EXCEEDED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
