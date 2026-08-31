// Preflight and capability checking subsystem for SuperGPT.
//
// Zero-model-token, deterministic checks run before an Executor attempt begins.
// Evaluates toolchains, command availability, workspace permissions, external symlinks,
// and required environment variables without invoking an LLM.

import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  accessSync,
  constants,
} from 'node:fs';

import {
  deriveSafeRecommendation,
  sanitizeRecommendationText,
  HUMAN_REQUIRED_ACTION_CODES,
} from './humanRequiredPolicy.js';

export { HUMAN_REQUIRED_ACTION_CODES, sanitizeRecommendationText };

export const FAILURE_CATEGORIES = Object.freeze({
  IMPLEMENTATION: 'IMPLEMENTATION',
  VERIFICATION: 'VERIFICATION',
  ENVIRONMENT: 'ENVIRONMENT',
  CAPABILITY: 'CAPABILITY',
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  PROVIDER: 'PROVIDER',
  REVIEW: 'REVIEW',
});

export const PREFLIGHT_BLOCKER_TYPES = Object.freeze({
  COMMAND_UNAVAILABLE: 'COMMAND_UNAVAILABLE',
  COMMAND_PERMISSION: 'COMMAND_PERMISSION',
  FILE_UNREADABLE: 'FILE_UNREADABLE',
  SYMLINK_OUTSIDE_WORKSPACE: 'SYMLINK_OUTSIDE_WORKSPACE',
  TOOLCHAIN_UNAVAILABLE: 'TOOLCHAIN_UNAVAILABLE',
  ENVIRONMENT_MISSING: 'ENVIRONMENT_MISSING',
  WORKSPACE_PERMISSION: 'WORKSPACE_PERMISSION',
  OTHER_ENVIRONMENT: 'OTHER_ENVIRONMENT',
});

const KNOWN_TOOLCHAINS = new Set([
  'swift',
  'npm',
  'node',
  'pytest',
  'python',
  'python3',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'javac',
  'java',
  'mvn',
  'gradle',
  'make',
  'cmake',
  'clang',
  'gcc',
  'deno',
  'bun',
]);

function isSubpath(parent, target) {
  const rel = path.relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Safely resolves the canonical realpath of a target, returning null if it does not exist.
 */
function safeRealpath(p) {
  if (!p || typeof p !== 'string') return null;
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  }
}

/**
 * Checks if target is contained within parent directory based on canonical realpaths.
 */
function isContained(parent, target) {
  if (!parent || !target) return false;
  const parentReal = safeRealpath(parent) || path.resolve(parent);
  const targetReal = safeRealpath(target) || path.resolve(target);
  const rel = path.relative(parentReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Extracts task-relevant candidate file paths from a task card or options.
 */
export function getTaskCandidatePaths(taskCard = null, candidatePaths = null) {
  const result = new Set();
  if (Array.isArray(candidatePaths)) {
    for (const p of candidatePaths) {
      if (typeof p === 'string' && p.trim()) result.add(p.trim());
    }
  }
  if (taskCard && typeof taskCard === 'object') {
    // Note: allowed_files is a write-scope permission, not proof that the file
    // is required task input. Only inspect paths referenced by read_targets,
    // required_files, context_files, external_dependencies, or verification requirements.
    const fields = [
      'read_targets',
      'required_files',
      'context_files',
      'external_dependencies',
      'verification_files',
      'task_relevant_paths',
    ];
    for (const field of fields) {
      const val = taskCard[field];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && item.trim()) result.add(item.trim());
        }
      } else if (typeof val === 'string' && val.trim()) {
        result.add(val.trim());
      }
    }
  }
  return [...result];
}

/**
 * Checks whether a given path is git-tracked in the working tree.
 */
export async function isGitTracked(relPath, { cwd = process.cwd(), gitBin = 'git', isTrackedFn = null } = {}) {
  if (typeof isTrackedFn === 'function') {
    return Boolean(await isTrackedFn(relPath, cwd));
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn(gitBin, ['ls-files', '--error-unmatch', '--', relPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Extract executable command names from a shell command string.
 * Handles environment prefix (e.g. `FOO=1 bar`), subshell/chaining (`cd x && y`), etc.
 */
export function splitShellSubCommands(commandStr) {
  if (typeof commandStr !== 'string' || !commandStr.trim()) return [];
  const subCommands = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let isEscaped = false;

  for (let i = 0; i < commandStr.length; i++) {
    const char = commandStr[i];

    if (isEscaped) {
      current += char;
      isEscaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      isEscaped = true;
      current += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (char === '`' && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += char;
      continue;
    }

    // If inside quotes, don't split
    if (inSingleQuote || inDoubleQuote || inBacktick) {
      current += char;
      continue;
    }

    // Check for logical operators outside quotes: &&, ||, |, ;, &
    if (char === ';') {
      if (current.trim()) subCommands.push(current.trim());
      current = '';
      continue;
    }

    if (char === '&') {
      if (commandStr[i + 1] === '&') {
        if (current.trim()) subCommands.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      if (current.trim()) subCommands.push(current.trim());
      current = '';
      continue;
    }

    if (char === '|') {
      if (commandStr[i + 1] === '|') {
        if (current.trim()) subCommands.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      if (current.trim()) subCommands.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    subCommands.push(current.trim());
  }

  return subCommands;
}

export function extractExecutablesFromCommand(commandStr) {
  if (typeof commandStr !== 'string' || !commandStr.trim()) return [];
  const executables = [];
  const subCommands = splitShellSubCommands(commandStr);

  for (const rawSub of subCommands) {
    const match = rawSub.trim().match(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([^\s]+)/);
    if (!match) continue;
    let cmd = match[2];
    if (!cmd) continue;

    cmd = cmd.replace(/^['"`]|['"`]$/g, '');

    // Ignore shell builtins and keywords that don't require external PATH binaries
    if (['cd', 'echo', 'true', 'false', 'test', 'export', 'set', 'unset', 'read', 'exit', 'if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'return', 'exec', '{', '}'].includes(cmd)) {
      continue;
    }
    executables.push(cmd);
  }

  return executables;
}

/**
 * Check if an executable exists in PATH or at specified file path and is executable.
 */
export function checkExecutable(nameOrPath, { cwd = process.cwd(), env = process.env, customPathList = null } = {}) {
  if (!nameOrPath || typeof nameOrPath !== 'string') {
    return { available: false, executable: false, path: null, error: 'Empty executable name' };
  }

  // Absolute or relative path specified
  if (nameOrPath.includes(path.sep) || nameOrPath.startsWith('.')) {
    const resolved = path.resolve(cwd, nameOrPath);
    if (!existsSync(resolved)) {
      return { available: false, executable: false, path: resolved, error: `File not found: ${resolved}` };
    }
    try {
      accessSync(resolved, constants.X_OK);
      return { available: true, executable: true, path: resolved, error: null };
    } catch (err) {
      return { available: true, executable: false, path: resolved, error: `Permission denied: ${err.message}` };
    }
  }

  // PATH lookup
  const pathDirs = customPathList || (env.PATH ? env.PATH.split(path.delimiter) : []);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, nameOrPath);
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate);
        if (st.isDirectory()) continue;
        accessSync(candidate, constants.X_OK);
        return { available: true, executable: true, path: candidate, error: null };
      } catch (err) {
        return { available: true, executable: false, path: candidate, error: `Permission denied: ${err.message}` };
      }
    }
  }

  return { available: false, executable: false, path: null, error: `Executable '${nameOrPath}' not found in PATH` };
}

/**
 * Task-relevant tracked-symlink resolution and safe auxiliary snapshotting.
 *
 * A symlink may be snapshotted only if:
 * 1. it is required by the current task;
 * 2. it is git-tracked;
 * 3. its final realpath is a regular readable file;
 * 4. its final realpath is inside sourceWorkspace OR an explicitly approved externalReadRoot.
 */
export async function scanAndSnapshotExternalSymlinks({
  worktreePath,
  taskCard = null,
  candidatePaths = null,
  sourceWorkspace = null,
  externalReadRoots = [],
  approvedExternalRoots = [],
  auxiliaryRoot = null,
  gitBin = 'git',
  isTrackedFn = null,
} = {}) {
  const snapshots = [];
  const blockers = [];
  const effectiveAuxRoot = auxiliaryRoot || path.join(worktreePath, '.supergpt_auxiliary', 'snapshots');

  const taskPaths = getTaskCandidatePaths(taskCard, candidatePaths);
  if (taskPaths.length === 0) {
    return { snapshots, blockers };
  }

  const allApprovedRoots = [
    ...(Array.isArray(externalReadRoots) ? externalReadRoots : externalReadRoots ? [externalReadRoots] : []),
    ...(Array.isArray(approvedExternalRoots) ? approvedExternalRoots : approvedExternalRoots ? [approvedExternalRoots] : []),
    ...(Array.isArray(taskCard?.external_read_roots) ? taskCard.external_read_roots : taskCard?.external_read_roots ? [taskCard.external_read_roots] : []),
    ...(Array.isArray(taskCard?.approved_external_roots) ? taskCard.approved_external_roots : taskCard?.approved_external_roots ? [taskCard.approved_external_roots] : []),
  ];

  const worktreeReal = safeRealpath(worktreePath) || path.resolve(worktreePath);

  for (const relPath of taskPaths) {
    const fullPath = path.resolve(worktreePath, relPath);
    let lstat = null;
    try {
      lstat = lstatSync(fullPath);
    } catch {
      // Path does not exist on disk
      continue;
    }

    const isDirectSymlink = lstat.isSymbolicLink();
    const finalRealpath = safeRealpath(fullPath);

    // If it is neither a direct symlink nor resolving to an external destination, skip
    const isExternal = finalRealpath ? !isContained(worktreeReal, finalRealpath) : isDirectSymlink;
    if (!isDirectSymlink && !isExternal) {
      continue;
    }

    const relSymlink = path.relative(worktreePath, fullPath) || relPath;

    // Condition 1: Required by current task (satisfied via taskPaths)

    // Condition 2: Git-tracked
    const tracked = await isGitTracked(relSymlink, { cwd: worktreePath, gitBin, isTrackedFn });
    if (!tracked) {
      // Untracked symlinks are untrusted context: never snapshotted
      continue;
    }

    // Condition 3: Final realpath is a regular readable file
    if (!finalRealpath || !existsSync(finalRealpath)) {
      let unresolvedTarget = finalRealpath || fullPath;
      try {
        if (isDirectSymlink) {
          unresolvedTarget = path.resolve(path.dirname(fullPath), readlinkSync(fullPath));
        }
      } catch {}
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        target: unresolvedTarget,
        detail: `Symlink '${relSymlink}' points outside the worktree to non-existent target '${unresolvedTarget}'.`,
        remediation: 'Ensure the external dependency exists and is accessible.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    let st;
    try {
      st = statSync(finalRealpath);
    } catch (err) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: relSymlink,
        target: finalRealpath,
        detail: `External symlink target '${finalRealpath}' is unreadable: ${err.message}`,
        remediation: 'Grant read access to the symlink target.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${relSymlink}`,
      });
      continue;
    }

    if (!st.isFile()) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        target: finalRealpath,
        detail: `External symlink target '${finalRealpath}' is not a regular file and cannot be snapshotted safely.`,
        remediation: 'Use a regular file or link within the worktree.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    // Condition 4: Inside sourceWorkspace OR an explicitly approved externalReadRoot
    let approvedRoot = null;
    if (sourceWorkspace && isContained(sourceWorkspace, finalRealpath)) {
      approvedRoot = safeRealpath(sourceWorkspace) || path.resolve(sourceWorkspace);
    } else {
      for (const root of allApprovedRoots) {
        if (root && isContained(root, finalRealpath)) {
          approvedRoot = safeRealpath(root) || path.resolve(root);
          break;
        }
      }
    }

    if (!approvedRoot) {
      // Unapproved external target -> Immediately report HUMAN_REQUIRED blocker with suggested root
      const suggestedRoot = path.dirname(finalRealpath);
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        target: finalRealpath,
        suggested_external_root: suggestedRoot,
        detail: `External symlink '${relSymlink}' points to unapproved external target '${finalRealpath}'. Suggested external root: '${suggestedRoot}'.`,
        remediation: `Add '${suggestedRoot}' to approved externalReadRoots or relocate the dependency into the repository.`,
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    // Approved external target: copy bytes into workflow-controlled auxiliary storage with full provenance
    try {
      const content = readFileSync(finalRealpath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const snapshotDir = path.join(effectiveAuxRoot, hash.slice(0, 12));
      mkdirSync(snapshotDir, { recursive: true });
      const snapshotFile = path.join(snapshotDir, path.basename(finalRealpath));
      writeFileSync(snapshotFile, content, { mode: 0o444 });

      snapshots.push({
        original_path: relSymlink,
        original_symlink_path: relSymlink,
        resolved_source_realpath: finalRealpath,
        resolved_source_path: finalRealpath,
        approved_root: approvedRoot,
        sha256: hash,
        content_hash: hash,
        snapshot_path: path.relative(worktreePath, snapshotFile),
        absolute_snapshot_path: snapshotFile,
        timestamp: new Date().toISOString(),
        captured_timestamp: new Date().toISOString(),
        size: content.length,
        bytes: content.length,
        read_only: true,
      });
    } catch (err) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: relSymlink,
        target: finalRealpath,
        detail: `Failed to snapshot external symlink '${relSymlink}': ${err.message}`,
        remediation: 'Ensure external target file is readable.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${relSymlink}`,
      });
    }
  }

  return { snapshots, blockers };
}

/**
 * Deterministic, zero-model-token preflight check for a task before execution.
 */
export async function runPreflight({
  taskCard,
  cwd = process.cwd(),
  sourceWorkspace = null,
  externalReadRoots = [],
  approvedExternalRoots = [],
  candidatePaths = null,
  auxiliaryRoot = null,
  env = process.env,
  executableChecker = checkExecutable,
  gitBin = 'git',
  isTrackedFn = null,
} = {}) {
  const blockers = [];
  const snapshots = [];

  // 1. Workspace directory existence & permissions
  if (!existsSync(cwd)) {
    blockers.push({
      type: PREFLIGHT_BLOCKER_TYPES.WORKSPACE_PERMISSION,
      resource: cwd,
      detail: `Workspace directory '${cwd}' does not exist.`,
      remediation: 'Ensure the isolated worktree directory is created before running preflight.',
      fingerprint: `${PREFLIGHT_BLOCKER_TYPES.WORKSPACE_PERMISSION}:${cwd}`,
    });
    return { status: 'BLOCKED', blockers, snapshots };
  }

  try {
    accessSync(cwd, constants.R_OK | constants.W_OK);
  } catch (err) {
    blockers.push({
      type: PREFLIGHT_BLOCKER_TYPES.WORKSPACE_PERMISSION,
      resource: cwd,
      detail: `Workspace directory '${cwd}' is not readable and writable: ${err.message}`,
      remediation: 'Fix directory permissions for the workspace.',
      fingerprint: `${PREFLIGHT_BLOCKER_TYPES.WORKSPACE_PERMISSION}:${cwd}`,
    });
  }

  // 2. Verification executables check
  const verificationCommands = Array.isArray(taskCard?.verification_commands)
    ? taskCard.verification_commands
    : [];

  for (const cmdStr of verificationCommands) {
    const executables = extractExecutablesFromCommand(cmdStr);
    for (const exe of executables) {
      const check = executableChecker(exe, { cwd, env });
      if (!check.available) {
        const isToolchain = KNOWN_TOOLCHAINS.has(exe);
        const type = isToolchain
          ? PREFLIGHT_BLOCKER_TYPES.TOOLCHAIN_UNAVAILABLE
          : PREFLIGHT_BLOCKER_TYPES.COMMAND_UNAVAILABLE;
        blockers.push({
          type,
          resource: exe,
          detail: `Required verification executable '${exe}' was not found in PATH for command: ${cmdStr}`,
          remediation: `Install the '${exe}' toolchain or ensure it is accessible in PATH.`,
          fingerprint: `${type}:${exe}`,
        });
      } else if (!check.executable) {
        blockers.push({
          type: PREFLIGHT_BLOCKER_TYPES.COMMAND_PERMISSION,
          resource: exe,
          detail: `Verification binary '${exe}' is present at '${check.path}' but not executable.`,
          remediation: `Grant execute permission (chmod +x) to '${check.path}'.`,
          fingerprint: `${PREFLIGHT_BLOCKER_TYPES.COMMAND_PERMISSION}:${exe}`,
        });
      }
    }
  }

  // 3. Required repository files / read targets check
  const requiredFiles = Array.isArray(taskCard?.read_targets)
    ? taskCard.read_targets
    : Array.isArray(taskCard?.required_files)
    ? taskCard.required_files
    : [];

  for (const fileRel of requiredFiles) {
    const fullPath = path.resolve(cwd, fileRel);
    let exists = existsSync(fullPath);
    if (!exists) {
      try {
        const l = lstatSync(fullPath);
        if (l.isSymbolicLink()) {
          const rp = safeRealpath(fullPath);
          if (rp && existsSync(rp)) {
            exists = true;
          }
        }
      } catch {}
    }
    if (!exists) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: fileRel,
        detail: `Required task input file '${fileRel}' does not exist.`,
        remediation: 'Ensure the file is created or tracked in the repository.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${fileRel}`,
      });
    } else {
      try {
        const targetToAccess = safeRealpath(fullPath) || fullPath;
        accessSync(targetToAccess, constants.R_OK);
      } catch (err) {
        blockers.push({
          type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
          resource: fileRel,
          detail: `Required task input file '${fileRel}' is not readable: ${err.message}`,
          remediation: 'Fix read permissions on the file.',
          fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${fileRel}`,
        });
      }
    }
  }

  // 4. Required environment variables check (without leaking secrets)
  const requiredEnv = Array.isArray(taskCard?.required_environment)
    ? taskCard.required_environment
    : Array.isArray(taskCard?.required_env)
    ? taskCard.required_env
    : [];

  for (const envKey of requiredEnv) {
    if (typeof envKey === 'string' && (env[envKey] === undefined || env[envKey] === '')) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.ENVIRONMENT_MISSING,
        resource: envKey,
        detail: `Required environment variable '${envKey}' is missing or empty.`,
        remediation: `Define '${envKey}' in the environment before starting execution.`,
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.ENVIRONMENT_MISSING}:${envKey}`,
      });
    }
  }

  // 5. Tracked symlinks & external dependencies scan
  const symlinkResult = await scanAndSnapshotExternalSymlinks({
    worktreePath: cwd,
    taskCard,
    candidatePaths,
    sourceWorkspace,
    externalReadRoots,
    approvedExternalRoots,
    auxiliaryRoot,
    gitBin,
    isTrackedFn,
  });

  if (symlinkResult.snapshots.length > 0) {
    snapshots.push(...symlinkResult.snapshots);
  }
  if (symlinkResult.blockers.length > 0) {
    blockers.push(...symlinkResult.blockers);
  }

  return {
    status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    snapshots,
  };
}

/**
 * Structured evidence package builder for HUMAN_REQUIRED decision surface.
 */
export function buildHumanRequiredEvidence({
  workflowId,
  taskCard = null,
  taskId = null,
  taskName = null,
  attempt = 1,
  stage = 'UNKNOWN',
  blockerCategory = FAILURE_CATEGORIES.ENVIRONMENT,
  rootCause = 'Environment or capability blocker encountered',
  preflightResult = null,
  failingGateCommand = null,
  exitCode = null,
  stdoutTail = null,
  stderrTail = null,
  latestGateResult = null,
  latestReviewerDecision = null,
  latestReviewerRequiredChanges = null,
  blockerFingerprint = null,
  blockerCount = 1,
  remediationAttempted = null,
  filesInvolved = [],
  recommendedAction = null,
  availableChoices = null,
  history = [],
} = {}) {
  const resolvedTaskId = taskId ?? taskCard?.task_id ?? null;
  const resolvedTaskName = taskName ?? taskCard?.goal ?? null;

  const isExternalRoot = blockerFingerprint?.startsWith('SYMLINK_OUTSIDE_WORKSPACE') ||
    preflightResult?.blockers?.some((b) => b.type === PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
  const isVerifBlocker = Boolean(failingGateCommand) ||
    blockerCategory === FAILURE_CATEGORIES.ENVIRONMENT ||
    blockerCategory === FAILURE_CATEGORIES.CAPABILITY ||
    blockerCategory === FAILURE_CATEGORIES.VERIFICATION ||
    preflightResult?.blockers?.some((b) =>
      b.type === PREFLIGHT_BLOCKER_TYPES.TOOLCHAIN_UNAVAILABLE ||
      b.type === PREFLIGHT_BLOCKER_TYPES.COMMAND_UNAVAILABLE ||
      b.type === PREFLIGHT_BLOCKER_TYPES.COMMAND_PERMISSION
    );

  const safePolicy = deriveSafeRecommendation({
    blockerCategory,
    failingGateCommand,
    rootCause,
    isExternalRootBlocker: isExternalRoot,
    isVerificationOrToolchainBlocker: isVerifBlocker,
  });

  const finalActionCode = safePolicy.actionCode;
  const finalRecommendedAction = sanitizeRecommendationText(recommendedAction || safePolicy.recommendedAction);
  const finalAvailableChoices = Array.isArray(availableChoices) && availableChoices.length > 0
    ? availableChoices.map(sanitizeRecommendationText)
    : safePolicy.availableChoices;

  return {
    workflowId: workflowId ?? null,
    taskId: resolvedTaskId,
    taskName: resolvedTaskName,
    attempt,
    stage,
    blockerCategory,
    actionCode: finalActionCode,
    rootCause,
    preflightResult: preflightResult ?? null,
    failingGateCommand: failingGateCommand ?? null,
    exitCode: exitCode ?? null,
    stdoutTail: stdoutTail ?? null,
    stderrTail: stderrTail ?? null,
    latestGateResult: latestGateResult ?? null,
    latestReviewerDecision: latestReviewerDecision ?? null,
    latestReviewerRequiredChanges: latestReviewerRequiredChanges ?? null,
    blockerFingerprint: blockerFingerprint ?? null,
    blockerCount,
    remediationAttempted: remediationAttempted ?? null,
    filesInvolved: Array.isArray(filesInvolved) ? filesInvolved : [],
    recommendedAction: finalRecommendedAction,
    availableChoices: finalAvailableChoices,
    attemptHistorySummary: Array.isArray(history) ? history : [],
  };
}
