#!/usr/bin/env node
// doctor — deterministic prerequisite check for the local SuperGPT runtime.
// Frontends are symmetric launchers, so AGY, Claude, and Codex are all
// required local prerequisites for the supported global installation.

import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { existsSync, accessSync, constants } from 'node:fs';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../src/agy/agyConfig.js';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { defaultOrganicReworkRecorder } from '../src/orchestrator/organicReworkRecorder.js';

function probe(execSync, command) {
  return String(execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

export function checkGit({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'git', ok: true, version: probe(exec, 'git --version') }; }
  catch (err) { return { name: 'git', ok: false, error: err.message }; }
}

export function checkNode({ env } = {}) {
  const version = (env && env.npm_config_node_version) || process.version;
  return { name: 'node', ok: Boolean(version), version };
}

export function checkAgy({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'agy', ok: true, version: probe(exec, 'agy --version') }; }
  catch (err) { return { name: 'agy', ok: false, error: err.message }; }
}

export function checkClaude({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'claude', ok: true, version: probe(exec, 'claude --version') }; }
  catch (err) { return { name: 'claude', ok: false, error: err.message }; }
}

export function checkCodex({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try { return { name: 'codex', ok: true, version: probe(exec, 'codex --version') }; }
  catch (err) { return { name: 'codex', ok: false, error: err.message }; }
}

export function checkRuntimeDir({ root = SUPERGPT_WORKTREE_ROOT } = {}) {
  try {
    if (existsSync(root)) accessSync(root, constants.R_OK | constants.W_OK);
    return { name: 'runtime_dir', ok: true, path: root };
  } catch (err) {
    return { name: 'runtime_dir', ok: false, error: err.message, path: root };
  }
}

export function checkModels({ env = process.env } = {}) {
  try {
    return {
      name: 'models',
      ok: true,
      supervisor: resolveAgySupervisorModel(env),
      reviewer: resolveAgyReviewerModel(env),
      executor: 'claude-sonnet-5 (default) / opus (escalation)',
    };
  } catch (err) {
    return { name: 'models', ok: false, error: err.message };
  }
}

export function runDoctor({ execSync, log, env } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const results = [
    checkGit({ execSync: exec }),
    checkNode({ env: environment }),
    checkAgy({ execSync: exec }),
    checkClaude({ execSync: exec }),
    checkCodex({ execSync: exec }),
  ];
  const ok = results.every((r) => r.ok);

  for (const r of results) {
    if (r.ok) write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}`);
    else write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
  }

  const runtimeCheck = checkRuntimeDir();
  if (runtimeCheck.ok) write(`  info  runtime dir: ${runtimeCheck.path}`);

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

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = runDoctor();
  process.exit(report.ok ? 0 : 1);
}
