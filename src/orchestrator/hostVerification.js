// Host Gate Verification subsystem for SuperGPT.
//
// Trusted zero-model control-plane operation:
//   supergpt_verify({ workflowId })
// Runs the frozen pending/closeout Gate verification commands on the host inside the
// preserved isolated worktree, captures structured gate evidence, persists it durably
// under workflow runtime state, assigns an immutable hash/id, and invalidates on worktree mutation.

import { execSync as nodeExecSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { createGateRunner } from './adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../adapters/gate/git-evidence/index.js';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';
import { readLiveWorkflowState } from './workflowState.js';

// Closeout is a workflow-level assertion, never an implementation task.  A
// stable identity prevents a task's otherwise-identical host evidence from
// authorising final delivery.
export const CLOSEOUT_VERIFICATION_ID = '__supergpt_closeout__';

export function getHostEvidenceDir(workflowId, root = SUPERGPT_WORKTREE_ROOT) {
  return path.join(root, workflowId, 'host_evidence');
}

/**
 * Deterministically computes SHA-256 hash of a list of commands.
 */
export function hashCommandSet(commands = []) {
  const normalized = Array.isArray(commands) ? commands.map((c) => String(c).trim()).filter(Boolean) : [];
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Computes a deterministic full relevant-worktree content fingerprint:
 * - HEAD revision
 * - Tracked files and tree state (git ls-files -s)
 * - Deterministic hash of working tree dirty/staged/untracked content
 * - Mode/type and link targets
 * - Excludes runtime auxiliary directories (.git, host_evidence, persistence, node_modules)
 */
export function computeWorktreeFingerprint(worktreePath, execSync = nodeExecSync) {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Tracked index state (stage + mode + object hash + path)
    const stagedIndex = execSync('git ls-files --stage', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Modified, staged, and untracked (non-ignored) file paths via NUL-separated records and -uall
    const statusBuffer = execSync('git status --porcelain=v1 -z -uall', {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const fileEntries = [];
    let i = 0;
    while (i < statusBuffer.length) {
      if (i + 2 > statusBuffer.length) break;
      const statusCode = statusBuffer.subarray(i, i + 2).toString('utf8');
      i += 3; // skip status code (2 bytes) and following space (1 byte)
      const end = statusBuffer.indexOf(0, i);
      if (end === -1) break;
      let filePath = statusBuffer.subarray(i, end).toString('utf8');
      i = end + 1;

      // In case of rename/copy (R or C), git porcelain -z emits original path as the next NUL-terminated record
      if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
        const origEnd = statusBuffer.indexOf(0, i);
        if (origEnd !== -1) {
          i = origEnd + 1;
        }
      }

      // Exclude runtime auxiliary / evidence directories
      if (
        filePath.startsWith('host_evidence/') ||
        filePath.startsWith('persistence/') ||
        filePath.startsWith('.supergpt/') ||
        filePath.startsWith('node_modules/')
      ) {
        continue;
      }

      const fullPath = path.join(worktreePath, filePath);
      let fileContentHash = 'ABSENT';
      let modeOrType = 'NONE';

      if (existsSync(fullPath)) {
        try {
          const lstat = lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            modeOrType = 'SYMLINK';
            fileContentHash = readlinkSync(fullPath);
          } else if (lstat.isDirectory()) {
            modeOrType = 'DIR';
            fileContentHash = 'DIR';
          } else {
            modeOrType = `MODE_${(lstat.mode || 0).toString(8)}`;
            const buf = readFileSync(fullPath);
            fileContentHash = crypto.createHash('sha256').update(buf).digest('hex');
          }
        } catch {
          fileContentHash = 'UNREADABLE';
        }
      }

      fileEntries.push({
        path: filePath,
        status: statusCode,
        mode: modeOrType,
        contentHash: fileContentHash,
      });
    }

    // Deterministic sort by path
    fileEntries.sort((a, b) => a.path.localeCompare(b.path));

    const payload = JSON.stringify({
      head,
      stagedIndex,
      fileEntries,
    });

    return crypto.createHash('sha256').update(payload).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * Executes trusted host gate verification.
 * NO arbitrary command input permitted from frontend.
 * Restricted to valid workflow states (HUMAN_REQUIRED with frozen pending_verification).
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

  const state = readLiveWorkflowState({ workflowId, root });
  if (!state) {
    throw new Error(`Workflow runtime state not found for "${workflowId}"`);
  }

  // Restrict supergpt_verify strictly to HUMAN_REQUIRED workflow state
  if (state.workflowStatus !== 'HUMAN_REQUIRED') {
    throw new Error(`INVALID_WORKFLOW_STATE: supergpt_verify may execute only when workflowStatus is HUMAN_REQUIRED, but current status is "${state.workflowStatus}"`);
  }

  // Load exact frozen pending verification context
  const pending = state.pending_verification || state.pendingVerification || null;
  const pendingCommands = Array.isArray(pending?.commands)
    ? pending.commands
    : (Array.isArray(state.pendingVerificationCommands) ? state.pendingVerificationCommands : null);

  if (!pendingCommands || pendingCommands.length === 0) {
    throw new Error(`NO_PENDING_HOST_VERIFICATION: Workflow "${workflowId}" has no frozen pending verification context`);
  }

  const taskId = pending?.task_id || pending?.taskId || state.taskId || 'unknown-task';
  const verificationIdentity = pending?.verification_identity || pending?.verificationIdentity || taskId;
  const generation = pending?.generation ?? state.attempt ?? 1;
  const commandsToRun = pendingCommands.map((c) => String(c).trim()).filter(Boolean);
  const commandsHash = pending?.commands_hash || pending?.commandsHash || hashCommandSet(commandsToRun);

  const gateRunner = injectedGateRunner || createGateRunner({
    gitEvidenceCollector: createGitEvidenceCollector(),
    cwd: worktreePath,
    baseline: { head: meta.baseline_head || 'HEAD', clean: true, repo_root: worktreePath },
  });

  // Run gate verification on the host in the isolated worktree
  const evidence = await gateRunner.run(commandsToRun);
  // The proof represents the bytes which actually passed, not the bytes
  // present before a command potentially generated/modified output.
  const capturedAt = new Date().toISOString();
  const worktreeFingerprint = computeWorktreeFingerprint(worktreePath, execSync);

  const rawPayload = JSON.stringify({
    workflowId,
    taskId,
    verificationIdentity,
    generation,
    worktree: worktreePath,
    commands: commandsToRun,
    commandsHash,
    results: evidence.results || [],
    pass: Boolean(evidence.pass),
    capturedAt,
    worktreeFingerprint,
  });

  const hash = crypto.createHash('sha256').update(rawPayload).digest('hex');
  const evidenceId = `ev-${hash.slice(0, 16)}`;

  const hostEvidence = {
    workflowId,
    taskId,
    verificationIdentity,
    generation,
    evidenceId,
    pass: Boolean(evidence.pass),
    commands: commandsToRun,
    commandsHash,
    results: evidence.results || [],
    capturedAt,
    worktree: worktreePath,
    worktreeFingerprint,
    hash,
    evidence,
    consumed: false,
  };

  // Persist durably under workflow runtime state
  const evidenceDir = getHostEvidenceDir(workflowId, root);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, 'latest.json'), JSON.stringify(hostEvidence, null, 2), 'utf8');
  writeFileSync(path.join(evidenceDir, `${evidenceId}.json`), JSON.stringify(hostEvidence, null, 2), 'utf8');

  return hostEvidence;
}

/**
 * Reads and validates persisted host gate evidence against a task card and worktree state.
 * If worktree changed, evidence is malformed, or does not match the task/commands, rejects.
 */
export function getValidHostEvidence({
  workflowId,
  taskId = null,
  verificationIdentity = null,
  verificationCommands = null,
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

  if (hostEvidence.consumed === true) {
    return {
      stale: true,
      valid: false,
      reason: 'EVIDENCE_ALREADY_CONSUMED',
      hostEvidence,
    };
  }

  // Verify hash integrity
  const rawPayload = JSON.stringify({
    workflowId: hostEvidence.workflowId,
    taskId: hostEvidence.taskId,
    verificationIdentity: hostEvidence.verificationIdentity,
    generation: hostEvidence.generation,
    worktree: hostEvidence.worktree,
    commands: hostEvidence.commands,
    commandsHash: hostEvidence.commandsHash,
    results: hostEvidence.results || [],
    pass: hostEvidence.pass,
    capturedAt: hostEvidence.capturedAt,
    worktreeFingerprint: hostEvidence.worktreeFingerprint,
  });
  const computedHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
  if (computedHash !== hostEvidence.hash) {
    return null; // Forged or tampered evidence rejected
  }

  // If taskId check is requested:
  if (taskId && hostEvidence.taskId && hostEvidence.taskId !== taskId) {
    return {
      stale: true,
      valid: false,
      reason: 'TASK_ID_MISMATCH',
      hostEvidence,
    };
  }

  if (verificationIdentity && hostEvidence.verificationIdentity !== verificationIdentity) {
    return { stale: true, valid: false, reason: 'VERIFICATION_IDENTITY_MISMATCH', hostEvidence };
  }

  // If verificationCommands check is requested:
  if (Array.isArray(verificationCommands)) {
    const expectedNormalized = verificationCommands.map((c) => String(c).trim()).filter(Boolean);
    const actualNormalized = (hostEvidence.commands || []).map((c) => String(c).trim()).filter(Boolean);
    const expectedHash = hashCommandSet(expectedNormalized);

    const matchesCommands =
      expectedNormalized.length === actualNormalized.length &&
      expectedNormalized.every((cmd, idx) => cmd === actualNormalized[idx]);

    if (!matchesCommands || hostEvidence.commandsHash !== expectedHash) {
      return {
        stale: true,
        valid: false,
        reason: 'COMMANDS_MISMATCH',
        hostEvidence,
      };
    }
  }

  // Verify worktree has not changed since evidence capture
  const currentFingerprint = computeWorktreeFingerprint(hostEvidence.worktree, execSync);
  if (currentFingerprint !== hostEvidence.worktreeFingerprint) {
    return {
      stale: true,
      valid: false,
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

/**
 * Marks a persisted host gate evidence record as consumed so it cannot satisfy subsequent tasks.
 */
export function markHostEvidenceConsumed({
  workflowId,
  evidenceId = null,
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  if (!workflowId) return;
  const evidenceDir = getHostEvidenceDir(workflowId, root);
  const latestPath = path.join(evidenceDir, 'latest.json');
  if (!existsSync(latestPath)) return;

  try {
    const hostEvidence = JSON.parse(readFileSync(latestPath, 'utf8'));
    if (evidenceId && hostEvidence.evidenceId !== evidenceId) return;
    hostEvidence.consumed = true;
    writeFileSync(latestPath, JSON.stringify(hostEvidence, null, 2), 'utf8');
    if (hostEvidence.evidenceId) {
      const specificPath = path.join(evidenceDir, `${hostEvidence.evidenceId}.json`);
      if (existsSync(specificPath)) {
        writeFileSync(specificPath, JSON.stringify(hostEvidence, null, 2), 'utf8');
      }
    }
  } catch {
    /* best effort */
  }
}
