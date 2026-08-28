#!/usr/bin/env node
// doctor — verify the prerequisites the dev loop needs are installed and
// runnable: git, node, agy, claude, supergpt environment, and permissions (PART 19).
//
//   node scripts/doctor.js
//   supergpt doctor
//
// Zero-model-token deterministic health check.

import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync, accessSync, constants } from 'node:fs';
import os from 'node:os';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../src/agy/agyConfig.js';
import { checkGlobalStatus } from '../bin/install-plugin.js';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { defaultOrganicReworkRecorder } from '../src/orchestrator/organicReworkRecorder.js';

// Run `<command>` and return its trimmed stdout, or throw. Kept tiny so the
// individual checks stay declarative.
function probe(execSync, command) {
  return String(execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

export function checkGit({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'git', ok: true, version: probe(exec, 'git --version') };
  } catch (err) {
    return { name: 'git', ok: false, error: err.message };
  }
}

// node is the runtime already executing this file, so the authoritative
// answer is process.version — no child process needed.
export function checkNode({ env } = {}) {
  const version = (env && env.npm_config_node_version) || process.version;
  return { name: 'node', ok: Boolean(version), version };
}

export function checkAgy({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'agy', ok: true, version: probe(exec, 'agy --version') };
  } catch (err) {
    return { name: 'agy', ok: false, error: err.message };
  }
}

export function checkClaude({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'claude', ok: true, version: probe(exec, 'claude --version') };
  } catch (err) {
    return { name: 'claude', ok: false, error: err.message };
  }
}

export function checkCodex({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'codex', ok: true, version: probe(exec, 'codex --version') }; }
  catch (err) { return { name: 'codex', ok: false, error: err.message }; }
}

export function checkRuntimeDir({ root = SUPERGPT_WORKTREE_ROOT } = {}) {
  try {
    if (existsSync(root)) {
      accessSync(root, constants.R_OK | constants.W_OK);
    }
    return { name: 'runtime_dir', ok: true, path: root };
  } catch (err) {
    return { name: 'runtime_dir', ok: false, error: err.message, path: root };
  }
}

export function checkModels({ env = process.env } = {}) {
  try {
    const supervisor = resolveAgySupervisorModel(env);
    const reviewer = resolveAgyReviewerModel(env);
    return {
      name: 'models',
      ok: true,
      supervisor,
      reviewer,
      executor: 'claude-sonnet-5 (default) / opus (escalation)',
    };
  } catch (err) {
    return { name: 'models', ok: false, error: err.message };
  }
}

// Run every check and fold the results into a single report.
export function runDoctor({ execSync, log, env } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const results = [
    checkGit({ execSync: exec }),
    checkNode({ env: environment }),
    checkAgy({ execSync: exec }),
    checkClaude({ execSync: exec }),
  ];

  const ok = results.every((r) => r.ok);

  for (const r of results) {
    if (r.ok) {
      write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}`);
    } else {
      write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
    }
  }
  const codex = checkCodex({ execSync: exec });
  write(codex.ok ? `  info  codex (${codex.version})` : `  info  codex unavailable: ${codex.error || 'not found'}`);

  // Supplementary diagnostic info
  const runtimeCheck = checkRuntimeDir();
  if (runtimeCheck.ok) {
    write(`  info  runtime dir: ${runtimeCheck.path}`);
  }

  const modelCheck = checkModels({ env: environment });
  if (modelCheck.ok) {
    write(`  info  models: supervisor=${modelCheck.supervisor}, reviewer=${modelCheck.reviewer}, executor=${modelCheck.executor}`);
  }
  const quota = new QuotaPoolRegistry();
  write('  info  role pools: ' + Object.entries(DEFAULT_ROLE_POLICY).map(([role, candidates]) => `${role}=${candidates.map((c) => c.family).join('>')}`).join(' | '));
  write('  info  role capabilities: ' + Object.entries(PRODUCTION_ROLE_CAPABILITIES).map(([family, roles]) => `${family}=${roles.join(',')}`).join(' | '));
  for (const pool of quota.summary()) {
    write(`  info  quota ${pool.poolId}: ${pool.status}${pool.resetAt ? ` · reset ${pool.resetAt}` : ''}`);
  }
  const rework = defaultOrganicReworkRecorder.getVerificationStatus();
  // An in-progress sequence is evidence capture, not a live verification.
  // Keep the user-facing readiness statement binary and truthful.
  const liveStatus = rework.status === 'LIVE VERIFIED' ? 'LIVE VERIFIED' : 'NOT YET OBSERVED';
  const capture = rework.status === 'OBSERVED IN PROGRESS' ? ' (capture in progress)' : '';
  write(`  info  organic Reviewer REWORK: ${liveStatus}${capture} · future evidence capture enabled`);

  write(ok ? 'doctor: all prerequisites satisfied' : 'doctor: missing prerequisites');

  return {
    ok,
    status: ok ? 'pass' : 'fail',
    results: Object.fromEntries(results.map((r) => [r.name, r])),
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const report = runDoctor();
  process.exit(report.ok ? 0 : 1);
}
