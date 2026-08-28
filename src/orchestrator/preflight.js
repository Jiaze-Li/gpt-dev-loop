// Preflight and capability checking subsystem for SuperGPT.
//
// Zero-model-token, deterministic checks run before an Executor attempt begins.
// Evaluates toolchains, command availability, workspace permissions, external symlinks,
// and required environment variables without invoking an LLM.

import path from 'node:path';
import crypto from 'node:crypto';
import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  accessSync,
  constants,
} from 'node:fs';

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
 * Extract executable command names from a shell command string.
 * Handles environment prefix (e.g. `FOO=1 bar`), subshell/chaining (`cd x && y`), etc.
 */
export function extractExecutablesFromCommand(commandStr) {
  if (typeof commandStr !== 'string' || !commandStr.trim()) return [];
  const executables = [];

  // Split on logical operators (&&, ||, ;, |)
  const subCommands = commandStr.split(/&&|\|\||;|\|/);

  for (const rawSub of subCommands) {
    const tokens = rawSub.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // Skip environment assignments (e.g., `FOO=bar`, `PATH=...`)
    let cmdIdx = 0;
    while (cmdIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cmdIdx])) {
      cmdIdx += 1;
    }
    if (cmdIdx >= tokens.length) continue;

    const cmd = tokens[cmdIdx];
    // Ignore shell builtins that don't need PATH binaries
    if (['cd', 'echo', 'true', 'false', 'test', 'export', 'set', 'unset', 'read', 'exit'].includes(cmd)) {
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
 * Recursively find all symbolic links within a directory.
 */
function findSymlinks(dir, { maxDepth = 6, currentDepth = 0, results = [], ignoreDirs = new Set(['.git', 'node_modules', '.supergpt_auxiliary']) } = {}) {
  if (currentDepth > maxDepth || !existsSync(dir)) return results;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) {
        findSymlinks(fullPath, { maxDepth, currentDepth: currentDepth + 1, results, ignoreDirs });
      }
    }
  }
  return results;
}

/**
 * Scan workspace for external symlinks and safely snapshot readable repository targets.
 */
export function scanAndSnapshotExternalSymlinks({
  worktreePath,
  sourceWorkspace = null,
  auxiliaryRoot = null,
} = {}) {
  const symlinks = findSymlinks(worktreePath);
  const snapshots = [];
  const blockers = [];

  const effectiveAuxRoot = auxiliaryRoot || path.join(worktreePath, '.supergpt_auxiliary', 'snapshots');

  for (const symlinkPath of symlinks) {
    let linkTarget;
    try {
      linkTarget = readlinkSync(symlinkPath);
    } catch (err) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: path.relative(worktreePath, symlinkPath),
        detail: `Cannot read symlink '${symlinkPath}': ${err.message}`,
        remediation: 'Verify file permissions on the symlink.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${path.relative(worktreePath, symlinkPath)}`,
      });
      continue;
    }

    const symlinkDir = path.dirname(symlinkPath);
    const resolvedTarget = path.resolve(symlinkDir, linkTarget);

    // If target is inside the worktree, it's local and safe
    if (isSubpath(worktreePath, resolvedTarget)) {
      if (!existsSync(resolvedTarget)) {
        blockers.push({
          type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
          resource: path.relative(worktreePath, symlinkPath),
          detail: `Local symlink '${path.relative(worktreePath, symlinkPath)}' points to non-existent target '${path.relative(worktreePath, resolvedTarget)}'.`,
          remediation: 'Create or repair the symlink target file.',
          fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${path.relative(worktreePath, symlinkPath)}`,
        });
      }
      continue;
    }

    // Target resolves OUTSIDE the isolated worktree
    const relSymlink = path.relative(worktreePath, symlinkPath);

    if (!existsSync(resolvedTarget)) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        detail: `Symlink '${relSymlink}' points outside the worktree to non-existent target '${resolvedTarget}'.`,
        remediation: 'Ensure the external dependency exists and is accessible.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    let st;
    try {
      st = statSync(resolvedTarget);
    } catch (err) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: relSymlink,
        detail: `External symlink target '${resolvedTarget}' is unreadable: ${err.message}`,
        remediation: 'Grant read access to the symlink target.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${relSymlink}`,
      });
      continue;
    }

    // Only regular files are safely snapshotted as read-only task context
    if (!st.isFile()) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        detail: `External symlink target '${resolvedTarget}' is not a regular file and cannot be snapshotted safely.`,
        remediation: 'Use a regular file or link within the worktree.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    // Check if within source workspace / repo root policy
    const isInsideSource = sourceWorkspace ? isSubpath(sourceWorkspace, resolvedTarget) : true;
    if (!isInsideSource) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE,
        resource: relSymlink,
        detail: `External symlink target '${resolvedTarget}' resolves outside allowed repository root '${sourceWorkspace}'.`,
        remediation: 'Relocate external dependency into repository boundary.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE}:${relSymlink}`,
      });
      continue;
    }

    // Create safe read-only snapshot with provenance
    try {
      const content = readFileSync(resolvedTarget);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const snapshotDir = path.join(effectiveAuxRoot, hash.slice(0, 12));
      mkdirSync(snapshotDir, { recursive: true });
      const snapshotFile = path.join(snapshotDir, path.basename(resolvedTarget));
      writeFileSync(snapshotFile, content, { mode: 0o444 });

      snapshots.push({
        original_symlink_path: relSymlink,
        resolved_source_path: resolvedTarget,
        content_hash: hash,
        snapshot_path: path.relative(worktreePath, snapshotFile),
        absolute_snapshot_path: snapshotFile,
        captured_timestamp: new Date().toISOString(),
        bytes: content.length,
        read_only: true,
      });
    } catch (err) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: relSymlink,
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
  env = process.env,
  executableChecker = checkExecutable,
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
    if (!existsSync(fullPath)) {
      blockers.push({
        type: PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE,
        resource: fileRel,
        detail: `Required task input file '${fileRel}' does not exist.`,
        remediation: 'Ensure the file is created or tracked in the repository.',
        fingerprint: `${PREFLIGHT_BLOCKER_TYPES.FILE_UNREADABLE}:${fileRel}`,
      });
    } else {
      try {
        accessSync(fullPath, constants.R_OK);
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
  const symlinkResult = scanAndSnapshotExternalSymlinks({
    worktreePath: cwd,
    sourceWorkspace,
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

  const defaultChoices = blockerCategory === FAILURE_CATEGORIES.IMPLEMENTATION
    ? [
        'Provide design/implementation guidance and resume',
        'Modify task acceptance criteria and resume',
        'Stop workflow',
      ]
    : [
        'Fix the blocker in the environment and resume',
        'Update verification commands or tooling and resume',
        'Stop workflow',
      ];

  return {
    workflowId: workflowId ?? null,
    taskId: resolvedTaskId,
    taskName: resolvedTaskName,
    attempt,
    stage,
    blockerCategory,
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
    recommendedAction: recommendedAction ?? (
      blockerCategory === FAILURE_CATEGORIES.IMPLEMENTATION
        ? 'Review required changes and provide guidance for rework, then resume.'
        : 'Address the environment/capability requirement on the host, then resume.'
    ),
    availableChoices: Array.isArray(availableChoices) && availableChoices.length > 0 ? availableChoices : defaultChoices,
    attemptHistorySummary: Array.isArray(history) ? history : [],
  };
}
