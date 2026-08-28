// Authoritative SuperGPT Runtime Identity.
//
// Pin runtime identity at workflow creation to detect orchestrator / runtime
// generation mismatches without mutating existing workflows or fabricating compatibility.

import { execSync as nodeExecSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_WORKFLOW_SCHEMA_VERSION = '1';

/**
 * Resolves the full git SHA of the SuperGPT source checkout.
 * Resolves against the SuperGPT package/source root, NOT the invocation repo.
 * If unavailable, returns null (explicit unversioned state).
 */
export function getSuperGptSourceRevision({
  execSync = nodeExecSync,
  supergptSourceRoot = null,
} = {}) {
  const root = supergptSourceRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    const rev = execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (rev && typeof rev === 'string' && rev.trim().length > 0) {
      return rev.trim();
    }
  } catch {
    /* not a git checkout or git unavailable */
  }
  return null;
}

/**
 * Resolves the SuperGPT package version from package.json.
 */
export function getSuperGptVersion({ supergptSourceRoot = null } = {}) {
  const root = supergptSourceRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {}
  }
  return '1.0.0';
}

/**
 * Capture current installed/running runtime identity.
 */
export function getCurrentRuntimeIdentity({
  execSync = nodeExecSync,
  supergptSourceRoot = null,
} = {}) {
  return {
    supergptVersion: getSuperGptVersion({ supergptSourceRoot }),
    orchestratorRevision: getSuperGptSourceRevision({ execSync, supergptSourceRoot }),
    workflowSchemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
  };
}

/**
 * Deterministic comparison between workflow creation identity and current runtime identity.
 * Consumes ZERO model tokens.
 *
 * @param {object|null} workflowIdentity - Identity persisted at workflow creation
 * @param {object|null} currentIdentity - Current runtime identity (defaults to getCurrentRuntimeIdentity())
 * @returns {object} { workflow, current, stale, reason, warning, staleRuntime, workflowRevision, currentRevision }
 */
export function compareRuntimeIdentity(workflowIdentity, currentIdentity = null) {
  const current = currentIdentity || getCurrentRuntimeIdentity();

  // Normalize legacy or missing identity
  if (!workflowIdentity || typeof workflowIdentity !== 'object') {
    const legacyWorkflow = {
      supergptVersion: 'UNKNOWN_LEGACY',
      orchestratorRevision: 'UNKNOWN_LEGACY',
      workflowSchemaVersion: 'UNKNOWN_LEGACY',
    };
    return {
      workflow: legacyWorkflow,
      current,
      stale: true,
      staleRuntime: true,
      reason: 'UNKNOWN_LEGACY',
      workflowRevision: 'UNKNOWN_LEGACY',
      currentRevision: current.orchestratorRevision ?? null,
      warning: '⚠ Workflow started with an unversioned legacy runtime (no runtime identity recorded).',
    };
  }

  const normalizedWf = {
    supergptVersion: workflowIdentity.supergptVersion ?? workflowIdentity.supergpt_version ?? null,
    orchestratorRevision: workflowIdentity.orchestratorRevision ?? workflowIdentity.orchestrator_revision ?? null,
    workflowSchemaVersion: workflowIdentity.workflowSchemaVersion ?? workflowIdentity.workflow_schema_version ?? null,
  };

  if (!normalizedWf.orchestratorRevision && !normalizedWf.supergptVersion && !normalizedWf.workflowSchemaVersion) {
    return {
      workflow: normalizedWf,
      current,
      stale: true,
      staleRuntime: true,
      reason: 'UNKNOWN_LEGACY',
      workflowRevision: null,
      currentRevision: current.orchestratorRevision ?? null,
      warning: '⚠ Workflow started with an unversioned legacy runtime (no runtime identity recorded).',
    };
  }

  // Check revision mismatch
  const currentRev = current.orchestratorRevision;
  const wfRev = normalizedWf.orchestratorRevision;

  if (wfRev && currentRev && wfRev !== currentRev) {
    const shortWf = wfRev.slice(0, 7);
    const shortCur = currentRev.slice(0, 7);
    return {
      workflow: normalizedWf,
      current,
      stale: true,
      staleRuntime: true,
      reason: 'ORCHESTRATOR_REVISION_CHANGED',
      workflowRevision: wfRev,
      currentRevision: currentRev,
      warning: `⚠ Workflow started with older SuperGPT runtime\nWorkflow: ${shortWf}...\nCurrent:  ${shortCur}...`,
    };
  }

  // Check version mismatch if revisions are unavailable or matching
  const currentVer = current.supergptVersion;
  const wfVer = normalizedWf.supergptVersion;
  if (wfVer && currentVer && wfVer !== currentVer) {
    return {
      workflow: normalizedWf,
      current,
      stale: true,
      staleRuntime: true,
      reason: 'SUPERGPT_VERSION_CHANGED',
      workflowRevision: wfRev ?? null,
      currentRevision: currentRev ?? null,
      warning: `⚠ Workflow started with SuperGPT version ${wfVer}, current runtime is ${currentVer}.`,
    };
  }

  // Check schema version mismatch
  const currentSchema = current.workflowSchemaVersion;
  const wfSchema = normalizedWf.workflowSchemaVersion;
  if (wfSchema && currentSchema && wfSchema !== currentSchema) {
    return {
      workflow: normalizedWf,
      current,
      stale: true,
      staleRuntime: true,
      reason: 'SCHEMA_VERSION_CHANGED',
      workflowRevision: wfRev ?? null,
      currentRevision: currentRev ?? null,
      warning: `⚠ Workflow schema version (${wfSchema}) differs from current runtime (${currentSchema}).`,
    };
  }

  return {
    workflow: normalizedWf,
    current,
    stale: false,
    staleRuntime: false,
    reason: null,
    workflowRevision: wfRev ?? null,
    currentRevision: currentRev ?? null,
    warning: null,
  };
}
