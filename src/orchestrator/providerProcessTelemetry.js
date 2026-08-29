// Durable, bounded provider-process exit telemetry.  This is deliberately
// stored beside (not inside) an owned worktree so delivery cleanup cannot
// erase the evidence needed to diagnose an abnormal provider exit.

import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

import { validateWorkflowId, assertPathWithinRoot } from './workflowId.js';

export const PROVIDER_PROCESS_DIAGNOSTICS_FILE = (root, workflowId) => {
  validateWorkflowId(workflowId);
  return assertPathWithinRoot(
    root,
    path.join(root, `${workflowId}.provider-processes.jsonl`),
    'provider-process telemetry'
  );
};

const TAIL_LIMIT = 4_000;

export function boundedTail(value, limit = TAIL_LIMIT) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

export function classifyProviderTermination({ exitCode, signal, timeoutInitiator, userStopped, orchestratorStopped, spawnError, protocolError } = {}) {
  if (userStopped) return 'USER_STOPPED';
  if (orchestratorStopped) return 'ORCHESTRATOR_STOPPED';
  if (timeoutInitiator === 'internal') return 'PROVIDER_TIMEOUT';
  if (spawnError) return 'PROVIDER_UNAVAILABLE';
  if (protocolError) return 'PROVIDER_PROTOCOL_ERROR';
  if (Number.isFinite(exitCode) && exitCode === 0 && !signal) return 'NORMAL_EXIT';
  if (signal) return 'EXTERNAL_TERMINATION';
  if (Number.isFinite(exitCode) && exitCode !== 0) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN_TERMINATION';
}

export function appendProviderProcessDiagnostic({ root, workflowId, record }) {
  if (!root || !workflowId) throw new Error('root and workflowId are required for provider process telemetry');
  const normalized = {
    schema: 'supergpt.provider-process-exit/v1',
    workflowId,
    role: record.role ?? null,
    taskId: record.taskId ?? null,
    attempt: record.attempt ?? null,
    provider: record.provider ?? null,
    requestedFamily: record.requestedFamily ?? null,
    resolvedModel: record.resolvedModel ?? null,
    pid: record.pid ?? null,
    startedAt: record.startedAt ?? null,
    lastActivityAt: record.lastActivityAt ?? null,
    exitedAt: record.exitedAt ?? new Date().toISOString(),
    exitCode: Number.isFinite(record.exitCode) ? record.exitCode : null,
    signal: record.signal ?? null,
    spawnError: record.spawnError ? boundedTail(String(record.spawnError)) : null,
    timeoutInitiator: record.timeoutInitiator ?? null,
    timeoutDurationMs: Number.isFinite(record.timeoutDurationMs) ? record.timeoutDurationMs : null,
    stdoutTail: boundedTail(record.stdoutTail),
    stderrTail: boundedTail(record.stderrTail),
    userStopped: Boolean(record.userStopped),
    orchestratorStopped: Boolean(record.orchestratorStopped),
  };
  normalized.classification = classifyProviderTermination(normalized);
  mkdirSync(root, { recursive: true });
  appendFileSync(PROVIDER_PROCESS_DIAGNOSTICS_FILE(root, workflowId), `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}
