import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import {
  appendProviderProcessDiagnostic,
  classifyProviderTermination,
  PROVIDER_PROCESS_DIAGNOSTICS_FILE,
} from '../src/orchestrator/providerProcessTelemetry.js';
import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';
import { WorkflowLifecycleManager } from '../src/orchestrator/workflowLifecycle.js';

test('provider process telemetry classifies normal exit', () => {
  assert.equal(classifyProviderTermination({ exitCode: 0 }), 'NORMAL_EXIT');
});

test('provider process telemetry distinguishes an internal timeout from external termination', () => {
  assert.equal(classifyProviderTermination({ signal: 'SIGKILL', timeoutInitiator: 'internal' }), 'PROVIDER_TIMEOUT');
  assert.equal(classifyProviderTermination({ signal: 'SIGTERM' }), 'EXTERNAL_TERMINATION');
});

test('provider process telemetry distinguishes explicit stop from a provider crash', () => {
  assert.equal(classifyProviderTermination({ exitCode: null, signal: 'SIGTERM', userStopped: true }), 'USER_STOPPED');
  assert.equal(classifyProviderTermination({ exitCode: 1, stderrTail: 'fatal' }), 'PROVIDER_UNAVAILABLE');
});

test('non-zero provider exit preserves bounded useful diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-process-'));
  try {
    const record = appendProviderProcessDiagnostic({ root, workflowId: 'wf-process', record: {
      role: 'executor', taskId: 'task-a', attempt: 1, provider: 'claude', requestedFamily: 'claude:default', resolvedModel: 'sonnet', pid: 42,
      exitCode: 7, stderrTail: `fatal: ${'x'.repeat(5000)}`, stdoutTail: 'partial report', lastActivityAt: '2026-01-01T00:00:00.000Z',
    } });
    assert.equal(record.classification, 'PROVIDER_UNAVAILABLE');
    assert.equal(record.exitCode, 7);
    assert.match(record.stderrTail, /^…/);
    assert.equal(record.stdoutTail, 'partial report');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktree cleanup does not delete durable provider failure diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-process-'));
  const workflowId = 'wf-agy-12345678-1234-1234-1234-123456789abc';
  try {
    const state = new WorkflowStateManager({ workflowId, root });
    state.recordProviderProcessStart({ role: 'executor', taskId: 'task-a', attempt: 1, provider: 'claude', pid: 42 });
    state.recordProviderProcessExit({ pid: 42, exitCode: 1, stderrTail: 'provider crashed' });
    const lifecycle = new WorkflowLifecycleManager({ workflowId, root, sourceCwd: root });
    await lifecycle.onWorkflowDelivered();
    const raw = await readFile(PROVIDER_PROCESS_DIAGNOSTICS_FILE(root, workflowId), 'utf8');
    assert.match(raw, /provider crashed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
