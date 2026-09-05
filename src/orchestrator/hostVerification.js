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
import { validateWorkflowId, assertPathWithinRoot } from './workflowId.js';

// Closeout is a workflow-level assertion, never an implementation task.  A
// stable identity prevents a task's otherwise-identical host evidence from
// authorising final delivery.
export const CLOSEOUT_VERIFICATION_ID = '__supergpt_closeout__';

export function getHostEvidenceDir(workflowId, root = SUPERGPT_WORKTREE_ROOT) {
  validateWorkflowId(workflowId);
  return assertPathWithinRoot(root, path.join(root, workflowId, 'host_evidence'), 'host evidence directory');
}

/**
 * Deterministically computes SHA-256 hash of a list of commands.
 */
export function hashCommandSet(commands = []) {
  const normalized = Array.isArray(commands) ? commands.map((c) => String(c).trim()).filter(Boolean) : [];
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function isValidWorktreeFingerprint(value) {
  return typeof value === 'string' && value.trim().length > 0;
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
  validateWorkflowId(workflowId);

  const metaPath = assertPathWithinRoot(root, path.join(root, `${workflowId}.workspace.json`), 'workspace metadata');
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
  if (!isValidWorktreeFingerprint(hostEvidence.worktreeFingerprint)) {
    return {
      stale: true,
      valid: false,
      reason: 'WORKTREE_FINGERPRINT_UNAVAILABLE',
      hostEvidence,
    };
  }

  const currentFingerprint = computeWorktreeFingerprint(hostEvidence.worktree, execSync);
  if (!isValidWorktreeFingerprint(currentFingerprint)) {
    return {
      stale: true,
      valid: false,
      reason: 'WORKTREE_FINGERPRINT_UNAVAILABLE',
      hostEvidence,
    };
  }

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

// ---------------------------------------------------------------------------
// Executor / Host Verification ownership boundary
//
// A Task Card's verification_commands are split into two ownership domains:
//   * EXECUTOR_VERIFICATION / NORMAL_GATE — fast, local, deterministic checks the
//     Executor and the ordinary Gate own. Short budget (~120s).
//   * HOST_VERIFICATION / LONG_RUNNING_HOST_VERIFICATION — trusted control-plane
//     checks that touch shared host state (doctor, benchmark workflows, waiting on
//     another workflow, Dashboard/API/UsageTracker reads, runtime readiness, real
//     host-resource E2E). These are never run by an internal Executor session.
//
// Enforced execution order:
//   Executor -> NORMAL_GATE PASS -> Host Verification -> evidence -> Reviewer
// ---------------------------------------------------------------------------

export const VERIFICATION_KIND = Object.freeze({
  EXECUTOR_VERIFICATION: 'EXECUTOR_VERIFICATION',
  NORMAL_GATE: 'NORMAL_GATE',
  HOST_VERIFICATION: 'HOST_VERIFICATION',
  LONG_RUNNING_HOST_VERIFICATION: 'LONG_RUNNING_HOST_VERIFICATION',
});

const KIND_RANK = Object.freeze({
  EXECUTOR_VERIFICATION: 0,
  NORMAL_GATE: 1,
  HOST_VERIFICATION: 2,
  LONG_RUNNING_HOST_VERIFICATION: 3,
});

export const NORMAL_GATE_BUDGET_MS = 120 * 1000;
export const LONG_RUNNING_HOST_VERIFICATION_MIN_BUDGET_MS = 15 * 60 * 1000;
export const LONG_RUNNING_HOST_VERIFICATION_MAX_BUDGET_MS = 30 * 60 * 1000;
export const DEFAULT_LONG_RUNNING_HOST_VERIFICATION_BUDGET_MS = 20 * 60 * 1000;
export const DEFAULT_LIVENESS_STALL_THRESHOLD_MS = 5 * 60 * 1000;

// Markers that force a command out of the Executor/Gate domain because it reads
// or mutates shared host state that a sandboxed local check cannot own.
const HOST_VERIFICATION_MATCHERS = [
  /\bdoctor\b/,
  /\bbenchmark\b/,
  /\bsupergpt[_-](?:start|run|watch|wait|resume|stop|plan|route|prepare|status|dashboard|verify)\b/,
  /\bsupergpt\s+(?:start|run|watch|wait|resume|stop|plan|route|prepare|status|dashboard|verify)\b/,
  /localhost:\d+/,
  /127\.0\.0\.1/,
  /\b0\.0\.0\.0\b/,
  /--all-?workflows\b/,
  /cross[-_ ]?workflow/,
  /usage[-_ ]?tracker/,
  /\breadiness\b/,
  /health[-_ ]?check/,
  /\be2e\b/,
  /end[-_ ]to[-_ ]end/,
];

// Among host-verification commands, these additionally imply a long wall-clock.
const LONG_RUNNING_MATCHERS = [
  /\bbenchmark\b/,
  /\be2e\b/,
  /end[-_ ]to[-_ ]end/,
  /--long\b/,
];

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Classifies a single verification command into a VERIFICATION_KIND.
 * A caller-supplied estimatedDurationMs beyond the NORMAL_GATE budget also forces
 * host verification (long-running when it exceeds the budget).
 */
export function classifyVerificationCommand(command, { estimatedDurationMs = null } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return VERIFICATION_KIND.EXECUTOR_VERIFICATION;
  const lower = cmd.toLowerCase();

  const overBudget = Number.isFinite(estimatedDurationMs) && estimatedDurationMs > NORMAL_GATE_BUDGET_MS;
  const isHost = overBudget || HOST_VERIFICATION_MATCHERS.some((re) => re.test(lower));
  if (!isHost) return VERIFICATION_KIND.EXECUTOR_VERIFICATION;

  const isLong = overBudget || LONG_RUNNING_MATCHERS.some((re) => re.test(lower));
  return isLong
    ? VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION
    : VERIFICATION_KIND.HOST_VERIFICATION;
}

/**
 * Classifies a batch of verification commands. A non-empty batch is at least a
 * NORMAL_GATE; the batch kind is the most privileged kind any command requires.
 */
export function classifyVerificationBatch(commands = [], opts = {}) {
  const list = Array.isArray(commands) ? commands : [commands];
  const perCommand = list
    .map((c) => String(c ?? '').trim())
    .filter(Boolean)
    .map((command) => ({ command, kind: classifyVerificationCommand(command, opts) }));

  let kind = perCommand.length > 0 ? VERIFICATION_KIND.NORMAL_GATE : VERIFICATION_KIND.EXECUTOR_VERIFICATION;
  for (const entry of perCommand) {
    if (KIND_RANK[entry.kind] > KIND_RANK[kind]) kind = entry.kind;
  }

  const hostCommands = perCommand.filter((e) => KIND_RANK[e.kind] >= KIND_RANK.HOST_VERIFICATION);
  const normalGateCommands = perCommand.filter((e) => KIND_RANK[e.kind] < KIND_RANK.HOST_VERIFICATION);

  return {
    kind,
    perCommand,
    hostCommands,
    normalGateCommands,
    requiresHostVerification: hostCommands.length > 0,
    longRunning: kind === VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION,
  };
}

const INTERNAL_WORKFLOW_ROLES = new Set(['executor', 'planner', 'supervisor', 'reviewer', 'gate']);

/**
 * Fails closed if an internal workflow role attempts to launch, wait on, or
 * manage another top-level SuperGPT workflow.
 */
export function assertNoNestedWorkflowLaunch({ role, operation = 'unknown' } = {}) {
  const normalized = String(role || '').trim().toLowerCase();
  if (INTERNAL_WORKFLOW_ROLES.has(normalized)) {
    throw new Error(
      `NESTED_WORKFLOW_FORBIDDEN: internal role "${normalized}" must not invoke top-level workflow operation "${operation}"`,
    );
  }
  return true;
}

/**
 * Small state machine enforcing:
 *   Executor -> NORMAL_GATE PASS -> Host Verification -> evidence -> Reviewer
 */
export class HostVerificationSequencer {
  constructor({ requiresHostVerification = false } = {}) {
    this.requiresHostVerification = Boolean(requiresHostVerification);
    this._done = new Set();
  }

  executorComplete() {
    this._done.add('EXECUTOR');
    return this;
  }

  normalGatePassed(gateResult = { pass: true }) {
    if (!this._done.has('EXECUTOR')) {
      throw new Error('OUT_OF_ORDER: NORMAL_GATE cannot run before the Executor has finished');
    }
    if (gateResult && gateResult.pass === false) {
      throw new Error('NORMAL_GATE_NOT_PASSED: Host Verification is gated behind a passing NORMAL_GATE');
    }
    this._done.add('NORMAL_GATE');
    return this;
  }

  beginHostVerification() {
    if (!this._done.has('NORMAL_GATE')) {
      throw new Error('OUT_OF_ORDER: Host Verification requires a passing NORMAL_GATE first');
    }
    this._done.add('HOST_VERIFICATION_STARTED');
    return this;
  }

  recordEvidence(hostEvidence) {
    if (this.requiresHostVerification && !this._done.has('HOST_VERIFICATION_STARTED')) {
      throw new Error('OUT_OF_ORDER: host evidence recorded before Host Verification ran');
    }
    if (!hostEvidence || !hostEvidence.evidenceId || !hostEvidence.hash) {
      throw new Error('HOST_EVIDENCE_INVALID: evidence must carry an evidenceId and integrity hash');
    }
    this._done.add('EVIDENCE');
    return this;
  }

  assertReviewerMayStart() {
    if (!this._done.has('EXECUTOR')) {
      throw new Error('OUT_OF_ORDER: Reviewer cannot run before the Executor has finished');
    }
    if (!this._done.has('NORMAL_GATE')) {
      throw new Error('OUT_OF_ORDER: Reviewer cannot run before NORMAL_GATE PASS');
    }
    if (this.requiresHostVerification && !this._done.has('EVIDENCE')) {
      throw new Error('OUT_OF_ORDER: Reviewer cannot run before host verification evidence exists');
    }
    return true;
  }
}

/**
 * Resolves the wall-clock budget for a verification kind, clamping a requested
 * long-running budget into the supported 15-30 minute window.
 */
export function resolveHostVerificationBudgetMs(kind, requestedMs = null) {
  if (kind !== VERIFICATION_KIND.LONG_RUNNING_HOST_VERIFICATION) {
    return NORMAL_GATE_BUDGET_MS;
  }
  if (!Number.isFinite(requestedMs)) {
    return DEFAULT_LONG_RUNNING_HOST_VERIFICATION_BUDGET_MS;
  }
  return Math.min(
    Math.max(requestedMs, LONG_RUNNING_HOST_VERIFICATION_MIN_BUDGET_MS),
    LONG_RUNNING_HOST_VERIFICATION_MAX_BUDGET_MS,
  );
}

/**
 * Liveness judgement for an in-flight (long-running) Host Verification.
 *
 * Returns { decision: 'CONTINUE' | 'STUCK', reason, ... }. The verification is
 * only declared stuck when the process is dead, the total budget is exhausted,
 * or no heartbeat / progress / stage advance has occurred for stallThresholdMs.
 */
export function evaluateHostVerificationLiveness({
  now = Date.now(),
  startedAt,
  budgetMs = DEFAULT_LONG_RUNNING_HOST_VERIFICATION_BUDGET_MS,
  processAlive = true,
  heartbeatAt = null,
  lastProgressAt = null,
  stage = null,
  previousStage = null,
  stallThresholdMs = DEFAULT_LIVENESS_STALL_THRESHOLD_MS,
} = {}) {
  const started = toEpochMs(startedAt);
  const elapsedMs = Number.isFinite(started) ? now - started : null;

  if (!processAlive) {
    return { decision: 'STUCK', reason: 'PROCESS_DEAD', elapsedMs };
  }

  if (Number.isFinite(elapsedMs) && elapsedMs >= budgetMs) {
    return { decision: 'STUCK', reason: 'BUDGET_EXHAUSTED', elapsedMs, budgetMs };
  }

  // A stage transition is itself proof of forward progress.
  if (stage != null && previousStage != null && stage !== previousStage) {
    return { decision: 'CONTINUE', reason: 'STAGE_ADVANCED', elapsedMs, stage };
  }

  const signals = [toEpochMs(heartbeatAt), toEpochMs(lastProgressAt), started].filter((v) => Number.isFinite(v));
  const lastSignal = signals.length > 0 ? Math.max(...signals) : null;
  const sinceSignalMs = Number.isFinite(lastSignal) ? now - lastSignal : null;

  if (Number.isFinite(sinceSignalMs) && sinceSignalMs >= stallThresholdMs) {
    return { decision: 'STUCK', reason: 'NO_PROGRESS', elapsedMs, sinceSignalMs, stallThresholdMs };
  }

  return { decision: 'CONTINUE', reason: 'WITHIN_BUDGET', elapsedMs, sinceSignalMs };
}

// ---------------------------------------------------------------------------
// Controlled Host Acceptance
//
// A workflow may only be delivered when a single, immutable evidence bundle
// binds ALL of:
//   * the workflow identity
//   * the isolated worktree HEAD and content fingerprint the evidence was cut from
//   * the exact verification commands that ran on the host
//   * the deterministic Gate result
//   * the Reviewer result
//   * the approved (active) acceptance version
//
// The bundle carries its own integrity hash and is persisted next to the host
// gate evidence. It is re-validated — never trusted from disk alone — before
// the terminal acceptance judgement and again before Safe Result Delivery.
// ANY drift (HEAD, fingerprint, acceptance version, commands) invalidates it
// and fails delivery closed.
// ---------------------------------------------------------------------------

export const CONTROLLED_ACCEPTANCE_STATUS = 'ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION';

export const CONTROLLED_ACCEPTANCE_INVALID_REASONS = Object.freeze({
  MISSING: 'CONTROLLED_ACCEPTANCE_MISSING',
  MALFORMED: 'CONTROLLED_ACCEPTANCE_MALFORMED',
  HASH_MISMATCH: 'CONTROLLED_ACCEPTANCE_HASH_MISMATCH',
  WORKFLOW_MISMATCH: 'WORKFLOW_ID_MISMATCH',
  HEAD_DRIFT: 'WORKTREE_HEAD_DRIFT',
  FINGERPRINT_DRIFT: 'WORKTREE_FINGERPRINT_DRIFT',
  FINGERPRINT_UNAVAILABLE: 'WORKTREE_FINGERPRINT_UNAVAILABLE',
  ACCEPTANCE_VERSION_DRIFT: 'ACCEPTANCE_VERSION_DRIFT',
  COMMANDS_MISMATCH: 'COMMANDS_MISMATCH',
  GATE_NOT_PASSED: 'GATE_NOT_PASSED',
  REVIEWER_NOT_PASSED: 'REVIEWER_NOT_PASSED',
});

// Same authority model as the acceptance version chain: an Executor can never
// mint controlled acceptance, only an explicit human decision or the trusted
// orchestrator control plane.
export const CONTROLLED_ACCEPTANCE_APPROVERS = Object.freeze({
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  CONTROLLED_ORCHESTRATOR: 'CONTROLLED_ORCHESTRATOR',
});

const AUTHORIZED_CONTROLLED_APPROVERS = new Set(Object.values(CONTROLLED_ACCEPTANCE_APPROVERS));

export class ControlledAcceptanceError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ControlledAcceptanceError';
    this.code = code;
  }
}

const CONTROLLED_ACCEPTANCE_FILENAME = 'controlled_acceptance.json';

function normalizeCommands(commands) {
  return (Array.isArray(commands) ? commands : [])
    .map((c) => String(c ?? '').trim())
    .filter(Boolean);
}

// Accepts either a structured gate/review result ({ pass }, { decision }) or a
// bare 'PASS' string. Anything else is not a pass.
function isPassResult(result) {
  if (result == null) return false;
  if (typeof result === 'string') return result.trim().toUpperCase() === 'PASS';
  if (typeof result === 'boolean') return result;
  if (typeof result === 'object') {
    if (result.pass === true) return true;
    const decision = String(result.decision ?? result.result ?? result.status ?? '').toUpperCase();
    return decision === 'PASS';
  }
  return false;
}

function summarizeResult(result) {
  if (result == null) return { pass: false };
  if (typeof result === 'string' || typeof result === 'boolean') {
    return { pass: isPassResult(result), decision: String(result) };
  }
  return {
    pass: isPassResult(result),
    decision: result.decision ?? result.result ?? result.status ?? (result.pass === true ? 'PASS' : 'FAIL'),
    ...(result.evidenceId ? { evidenceId: result.evidenceId } : {}),
    ...(Number.isFinite(result.attempt) ? { attempt: result.attempt } : {}),
  };
}

// Canonical, order-stable payload the bundle hash is computed over. Fields not
// listed here are presentation only and can never authorise delivery.
function controlledAcceptancePayload(bundle) {
  return JSON.stringify({
    status: bundle.status,
    workflowId: bundle.workflowId,
    worktree: bundle.worktree,
    head: bundle.head ?? null,
    worktreeFingerprint: bundle.worktreeFingerprint,
    verificationCommands: bundle.verificationCommands,
    commandsHash: bundle.commandsHash,
    gate: bundle.gate,
    reviewer: bundle.reviewer,
    acceptanceVersion: bundle.acceptanceVersion,
    acceptanceVersions: bundle.acceptanceVersions,
    approvedBy: bundle.approvedBy,
    approvedAt: bundle.approvedAt,
    reason: bundle.reason,
  });
}

export function hashControlledHostAcceptance(bundle) {
  return crypto.createHash('sha256').update(controlledAcceptancePayload(bundle)).digest('hex');
}

/**
 * Reads the current HEAD of an isolated worktree. Returns null when the
 * revision cannot be read (a non-repository or removed worktree).
 */
export function readWorktreeHead(worktreePath, execSync = nodeExecSync) {
  if (!worktreePath) return null;
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return head || null;
  } catch {
    return null;
  }
}

/**
 * Mints a controlled Host Acceptance evidence bundle. Fails closed at creation:
 * a bundle can only exist for a passing Gate, a passing Reviewer, a resolvable
 * acceptance version, a real worktree fingerprint, and an authorized approver.
 */
export function buildControlledHostAcceptance({
  workflowId,
  worktree,
  head = null,
  worktreeFingerprint,
  verificationCommands = [],
  gate,
  reviewer,
  acceptanceVersion,
  acceptanceVersions = null,
  approvedBy = CONTROLLED_ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
  reason = 'Host verification evidence supersedes local acceptance for delivery.',
  approvedAt = new Date().toISOString(),
} = {}) {
  if (!workflowId || typeof workflowId !== 'string') {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED,
      'controlled host acceptance requires a workflowId',
    );
  }
  if (!worktree || typeof worktree !== 'string') {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED,
      'controlled host acceptance requires the isolated worktree path',
    );
  }
  if (!isValidWorktreeFingerprint(worktreeFingerprint)) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_UNAVAILABLE,
      'controlled host acceptance requires a computed worktree fingerprint',
    );
  }
  if (!AUTHORIZED_CONTROLLED_APPROVERS.has(approvedBy)) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED,
      `controlled host acceptance rejected: "${approvedBy}" is not an authorized approver`,
    );
  }
  if (!isPassResult(gate)) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.GATE_NOT_PASSED,
      'controlled host acceptance requires a passing Gate result',
    );
  }
  if (!isPassResult(reviewer)) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.REVIEWER_NOT_PASSED,
      'controlled host acceptance requires a passing Reviewer result',
    );
  }
  const version = Number(acceptanceVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.ACCEPTANCE_VERSION_DRIFT,
      'controlled host acceptance requires the approved active acceptance version',
    );
  }

  const commands = normalizeCommands(verificationCommands);
  const bundle = {
    status: CONTROLLED_ACCEPTANCE_STATUS,
    workflowId,
    worktree,
    head: head ?? null,
    worktreeFingerprint,
    verificationCommands: commands,
    commandsHash: hashCommandSet(commands),
    gate: summarizeResult(gate),
    reviewer: summarizeResult(reviewer),
    acceptanceVersion: version,
    acceptanceVersions: acceptanceVersions ?? null,
    approvedBy,
    approvedAt,
    reason,
  };
  bundle.hash = hashControlledHostAcceptance(bundle);
  bundle.acceptanceId = `cha-${bundle.hash.slice(0, 16)}`;
  return bundle;
}

/**
 * Re-validates a controlled Host Acceptance bundle against the CURRENT
 * workflow/worktree/acceptance context. Never trusts the persisted record.
 *
 * Returns { valid, status, reason, bundle } — `reason` is null only when valid.
 */
export function validateControlledHostAcceptance({
  bundle,
  workflowId = null,
  head = undefined,
  worktreeFingerprint = null,
  acceptanceVersion = null,
  verificationCommands = null,
} = {}) {
  const fail = (reason) => ({ valid: false, status: CONTROLLED_ACCEPTANCE_STATUS, reason, bundle: bundle ?? null });

  if (!bundle || typeof bundle !== 'object') return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.MISSING);
  if (bundle.status !== CONTROLLED_ACCEPTANCE_STATUS || !bundle.hash || !bundle.workflowId || !bundle.worktree) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED);
  }

  const { hash, acceptanceId, ...rest } = bundle;
  if (hashControlledHostAcceptance(rest) !== hash) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.HASH_MISMATCH);
  }

  if (!isPassResult(bundle.gate)) return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.GATE_NOT_PASSED);
  if (!isPassResult(bundle.reviewer)) return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.REVIEWER_NOT_PASSED);

  if (workflowId && bundle.workflowId !== workflowId) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.WORKFLOW_MISMATCH);
  }

  if (!isValidWorktreeFingerprint(bundle.worktreeFingerprint)) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_UNAVAILABLE);
  }
  if (worktreeFingerprint !== null && worktreeFingerprint !== undefined) {
    if (!isValidWorktreeFingerprint(worktreeFingerprint)) {
      return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_UNAVAILABLE);
    }
    if (worktreeFingerprint !== bundle.worktreeFingerprint) {
      return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_DRIFT);
    }
  }

  // `head === undefined` means the caller did not observe a HEAD at all; a
  // caller that did (including a null read from a vanished worktree) must match
  // the HEAD the evidence was cut from.
  if (head !== undefined && String(head ?? '') !== String(bundle.head ?? '')) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.HEAD_DRIFT);
  }

  if (acceptanceVersion !== null && acceptanceVersion !== undefined
    && Number(acceptanceVersion) !== Number(bundle.acceptanceVersion)) {
    return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.ACCEPTANCE_VERSION_DRIFT);
  }

  if (Array.isArray(verificationCommands)) {
    const expected = normalizeCommands(verificationCommands);
    const actual = normalizeCommands(bundle.verificationCommands);
    const same = expected.length === actual.length && expected.every((c, i) => c === actual[i]);
    if (!same || bundle.commandsHash !== hashCommandSet(expected)) {
      return fail(CONTROLLED_ACCEPTANCE_INVALID_REASONS.COMMANDS_MISMATCH);
    }
  }

  return { valid: true, status: CONTROLLED_ACCEPTANCE_STATUS, reason: null, bundle };
}

export function getControlledAcceptancePath(workflowId, root = SUPERGPT_WORKTREE_ROOT) {
  return path.join(getHostEvidenceDir(workflowId, root), CONTROLLED_ACCEPTANCE_FILENAME);
}

export function persistControlledHostAcceptance({ workflowId, bundle, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  if (!workflowId || !bundle) {
    throw new ControlledAcceptanceError(
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED,
      'persistControlledHostAcceptance requires workflowId and bundle',
    );
  }
  const dir = getHostEvidenceDir(workflowId, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, CONTROLLED_ACCEPTANCE_FILENAME), JSON.stringify(bundle, null, 2), 'utf8');
  if (bundle.acceptanceId) {
    writeFileSync(path.join(dir, `${bundle.acceptanceId}.json`), JSON.stringify(bundle, null, 2), 'utf8');
  }
  return bundle;
}

export function readControlledHostAcceptance({ workflowId, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  if (!workflowId) return null;
  let filePath;
  try {
    filePath = getControlledAcceptancePath(workflowId, root);
  } catch {
    return null;
  }
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads the persisted controlled Host Acceptance bundle and re-validates it
 * against the live worktree (HEAD + content fingerprint) and the supplied
 * active acceptance version. This is the single call terminal judgement and
 * delivery both make; it never returns valid evidence for a drifted worktree.
 */
export function getValidControlledHostAcceptance({
  workflowId,
  root = SUPERGPT_WORKTREE_ROOT,
  acceptanceVersion = null,
  verificationCommands = null,
  execSync = nodeExecSync,
} = {}) {
  const bundle = readControlledHostAcceptance({ workflowId, root });
  if (!bundle) {
    return { valid: false, status: CONTROLLED_ACCEPTANCE_STATUS, reason: CONTROLLED_ACCEPTANCE_INVALID_REASONS.MISSING, bundle: null };
  }
  const worktree = bundle.worktree;
  const head = readWorktreeHead(worktree, execSync);
  const fingerprint = computeWorktreeFingerprint(worktree, execSync);
  return validateControlledHostAcceptance({
    bundle,
    workflowId,
    head,
    worktreeFingerprint: fingerprint,
    acceptanceVersion,
    verificationCommands,
  });
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
