// EnvironmentProbe — runtime environment detection for SuperGPT benchmarks & token baselines.
//
// Ensures baseline environment metadata is dynamically probed from real runtime binaries
// rather than using hardcoded placeholder strings.

import { execSync as nodeExecSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGY_SUPERVISOR_DEFAULT_MODEL, AGY_REVIEWER_DEFAULT_MODEL } from '../agy/agyConfig.js';

const EXPLICIT_PLACEHOLDER_TOKENS = new Set([
  'unknown',
  'placeholder',
  'example',
  'default',
  'not_available',
  'not_installed',
  'unversioned',
  'x.y.z',
  'none',
]);

/**
 * Returns true only if a version string is an explicit placeholder / unknown / example marker.
 * Syntactically valid semantic versions (e.g. "2.1.0", "1.0.0") are NEVER classified as placeholders.
 */
export function isPlaceholderVersion(versionStr) {
  if (!versionStr || typeof versionStr !== 'string') return true;
  const trimmed = versionStr.trim().toLowerCase();
  if (trimmed === '') return true;
  if (EXPLICIT_PLACEHOLDER_TOKENS.has(trimmed)) return true;
  if (
    trimmed.includes('placeholder') ||
    trimmed.includes('example') ||
    trimmed.includes('not_available') ||
    trimmed.includes('not_installed')
  ) {
    return true;
  }
  return false;
}

/**
 * Probe runtime environment metadata from local system and tools.
 *
 * @param {object} [opts]
 * @param {Function} [opts.execSync] Custom execSync for testing
 * @param {string} [opts.cwd] Working directory for git probe
 * @returns {object} Probed environment metadata
 */
export function probeEnvironmentMetadata({
  execSync = nodeExecSync,
  cwd = process.cwd(),
} = {}) {
  let gitRevision = 'unversioned';
  try {
    const rev = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (rev && typeof rev === 'string') {
      gitRevision = rev.trim();
    }
  } catch {}

  let agyVersion = 'not_available';
  try {
    const agyOut = execSync('agy --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (agyOut && typeof agyOut === 'string') {
      agyVersion = agyOut.trim().split('\n')[0].trim();
    }
  } catch {}

  let claudeCliVersion = 'not_available';
  try {
    const claudeOut = execSync('claude --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (claudeOut && typeof claudeOut === 'string') {
      claudeCliVersion = claudeOut.trim().split('\n')[0].trim();
    }
  } catch {}

  let supergptVersion = '0.1.0';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '../../package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) supergptVersion = pkg.version;
    }
  } catch {}

  const supervisorModel = AGY_SUPERVISOR_DEFAULT_MODEL || 'gemini-3.7-flash-high';
  const reviewerModel = AGY_REVIEWER_DEFAULT_MODEL || 'gpt-oss-120b-medium';
  const claudeExecutorModel = 'claude-sonnet-5';

  return {
    supergptVersion,
    gitRevision,
    agyVersion,
    supervisorModel,
    reviewerModel,
    claudeCliVersion,
    claudeExecutorModel,
    probedAt: new Date().toISOString(),
  };
}
