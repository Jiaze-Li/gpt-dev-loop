// Host Gate Verification subsystem for SuperGPT.
//
// Trusted zero-model control-plane operation:
//   supergpt_verify({ workflowId })
// Runs the frozen pending/closeout Gate verification commands on the host inside the
// preserved isolated worktree, captures structured gate evidence, persists it durably
// under workflow runtime state, assigns an immutable hash/id, and invalidates on worktree mutation.

import { execSync as nodeExecSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { createGateRunner } from './adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../adapters/gate/git-evidence/index.js';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { readLiveWorkflowState } from './workflowState.js';

export function getHostEvidenceDir(workflowId, root = SUPERGPT_WORKTREE_ROOT) {
  return path.join(root, workflowId, 'host_evidence');
}

/**
 * Computes a fingerprint/hash of the worktree git state (HEAD + status porcelain)
 * to detect worktree modifications after evidence capture.
 */
export function computeWorktreeFingerprint(worktreePath, execSync = nodeExecSync) {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return crypto.createHash('sha256').update(`${head}\n${status}`).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * Executes trusted host gate verification.
 * NO arbitrary command input permitted from frontend.
 */
export async function supergptVerify({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  execSync = nodeExecSync,
  gateRunner: injectedGateRunner = null,
} = {}) {
  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('supergptVerify requires a valid workflowId');
  }

  const metaPath = path.join(root, `${workflowId}.workspace.json`);
  if (!existsSync(metaPath)) {
    throw new Error(`Workflow workspace metadata not found for "${workflowId}" at ${metaPath}`);
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    throw new Error(`Corrupted workspace metadata for "${workflowId}": ${err.message}`);
  }

  const worktreePath = meta.isolated_worktree_path || meta.worktree_path;
  if (!worktreePath || !existsSync(worktreePath)) {
    throw new Error(`Isolated worktree path does not exist for workflow "${workflowId}": ${worktreePath}`);
  }

  // Load frozen verification commands from metadata / state
  const state = readLiveWorkflowState({ workflowId, root });
  let commandsToRun = [];

  if (state?.evidence?.failingGateCommand) {
    commandsToRun.push(state.evidence.failingGateCommand);
  }

  // Also include frozen closeout commands or task verification commands if present
  if (Array.isArray(meta.closeout_verification_commands) && meta.closeout_verification_commands.length > 0) {
    for (const cmd of meta.closeout_verification_commands) {
      if (!commandsToRun.includes(cmd)) commandsToRun.push(cmd);
    }
  }

  if (commandsToRun.length === 0 && Array.isArray(state?.pendingVerificationCommands)) {
    commandsToRun = [...state.pendingVerificationCommands];
  }

  // Fallback to closeout commands or swift test/npm test from repository context
  if (commandsToRun.length === 0) {
    commandsToRun = ['swift test'];
  }

  // Deduplicate commands
  commandsToRun = [...new Set(commandsToRun.filter(Boolean))];

  const gateRunner = injectedGateRunner || createGateRunner({
    gitEvidenceCollector: createGitEvidenceCollector(),
    cwd: worktreePath,
    baseline: { head: meta.baseline_head || 'HEAD', clean: true, repo_root: worktreePath },
  });

  const capturedAt = new Date().toISOString();
  const worktreeFingerprint = computeWorktreeFingerprint(worktreePath, execSync);

  // Run gate verification on the host in the isolated worktree
  const evidence = await gateRunner.run(commandsToRun);

  const rawPayload = JSON.stringify({
    workflowId,
    worktree: worktreePath,
    commands: commandsToRun,
    results: evidence.results || [],
    pass: Boolean(evidence.pass),
    capturedAt,
    worktreeFingerprint,
  });

  const hash = crypto.createHash('sha256').update(rawPayload).digest('hex');
  const evidenceId = `ev-${hash.slice(0, 16)}`;

  const hostEvidence = {
    workflowId,
    evidenceId,
    pass: Boolean(evidence.pass),
    commands: commandsToRun,
    results: evidence.results || [],
    capturedAt,
    worktree: worktreePath,
    worktreeFingerprint,
    hash,
    evidence,
  };

  // Persist durably under workflow runtime state
  const evidenceDir = getHostEvidenceDir(workflowId, root);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, 'latest.json'), JSON.stringify(hostEvidence, null, 2), 'utf8');
  writeFileSync(path.join(evidenceDir, `${evidenceId}.json`), JSON.stringify(hostEvidence, null, 2), 'utf8');

  return hostEvidence;
}

/**
 * Reads and validates persisted host gate evidence.
 * If worktree changed or evidence is malformed, rejects as stale/invalid.
 */
export function getValidHostEvidence({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  execSync = nodeExecSync,
} = {}) {
  if (!workflowId) return null;
  const latestPath = path.join(getHostEvidenceDir(workflowId, root), 'latest.json');
  if (!existsSync(latestPath)) return null;

  let hostEvidence;
  try {
    hostEvidence = JSON.parse(readFileSync(latestPath, 'utf8'));
  } catch {
    return null;
  }

  if (!hostEvidence || !hostEvidence.evidenceId || !hostEvidence.hash || !hostEvidence.worktree) {
    return null;
  }

  // Verify hash integrity
  const rawPayload = JSON.stringify({
    workflowId: hostEvidence.workflowId,
    worktree: hostEvidence.worktree,
    commands: hostEvidence.commands,
    results: hostEvidence.results || [],
    pass: hostEvidence.pass,
    capturedAt: hostEvidence.capturedAt,
    worktreeFingerprint: hostEvidence.worktreeFingerprint,
  });
  const computedHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
  if (computedHash !== hostEvidence.hash) {
    return null; // Forged or tampered evidence rejected
  }

  // Verify worktree has not changed since evidence capture
  const currentFingerprint = computeWorktreeFingerprint(hostEvidence.worktree, execSync);
  if (currentFingerprint !== hostEvidence.worktreeFingerprint) {
    return {
      stale: true,
      reason: 'WORKTREE_MUTATED_AFTER_VERIFICATION',
      hostEvidence,
    };
  }

  return {
    stale: false,
    valid: true,
    hostEvidence,
  };
}
