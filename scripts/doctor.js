#!/usr/bin/env node
// doctor — deterministic, zero-model prerequisite + repo-invariant check for
// the local ReviewLoop runtime.
//
// Mandatory core prerequisites: Node, Git, the ReviewLoop runtime dir, and
// COMMON/source consistency (a repo invariant). The global install state is a
// diagnostic warning only — a stale or absent global install never fails
// doctor, and doctor never mutates the real environment or makes a model call.

import path from 'node:path';
import os from 'node:os';
import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { extractManagedPolicy, resolveGlobalConfigDir, hasLegacyManagedPolicy } from '../bin/install-plugin.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';

const DEFAULT_POLICY_FILE = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));
const MCP_NAME = 'reviewloop';
const ACTIVE_ROLES = ['supervisor', 'reviewer'];

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
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return { name: 'node', ok: Number.isFinite(major) && major >= 20, version };
}

export function checkRuntimeDir({ root = REVIEWLOOP_RUNTIME_ROOT } = {}) {
  try {
    if (existsSync(root)) accessSync(root, constants.R_OK | constants.W_OK);
    return { name: 'runtime_dir', ok: true, path: root };
  } catch (err) {
    return { name: 'runtime_dir', ok: false, error: err.message, path: root };
  }
}

// Repo invariant (NOT an install state): the active architecture must present
// exactly the reviewer + supervisor roles, no planner, no executor, and the
// COMMON contract must be the ReviewLoop Worker Contract v1.
export function checkRepoInvariants({ policyFile = DEFAULT_POLICY_FILE } = {}) {
  const issues = [];
  const roles = Object.keys(DEFAULT_ROLE_POLICY).sort();
  if (JSON.stringify(roles) !== JSON.stringify([...ACTIVE_ROLES].sort())) {
    issues.push(`DEFAULT_ROLE_POLICY roles are [${roles}] — expected exactly [reviewer, supervisor]`);
  }
  for (const forbidden of ['planner', 'executor']) {
    if (forbidden in DEFAULT_ROLE_POLICY) issues.push(`active "${forbidden}" role must not exist`);
    for (const caps of Object.values(PRODUCTION_ROLE_CAPABILITIES)) {
      if (caps.includes(forbidden)) issues.push(`PRODUCTION_ROLE_CAPABILITIES still declares "${forbidden}"`);
    }
  }
  let common;
  try {
    common = readFileSync(policyFile, 'utf8');
  } catch (err) {
    return { name: 'repo_invariants', ok: false, issues: [`unreadable COMMON policy: ${err.message}`] };
  }
  if (!/ReviewLoop Worker Contract/.test(common)) issues.push('COMMON is not the ReviewLoop Worker Contract');
  const version = common.match(/Contract version:\s*(\d+)/i);
  if (!version || Number(version[1]) < 1) issues.push('COMMON has no valid "Contract version:" >= 1');
  if (/Front[- ]Agent|supergpt_route|Fast Path|Full Path|\bPlanner\b|\bExecutor\b/.test(common)) {
    issues.push('COMMON still references retired SuperGPT concepts (Front Agent / route / Fast/Full / Planner / Executor)');
  }
  const bytes = Buffer.byteLength(common, 'utf8');
  if (bytes > 2560) issues.push(`COMMON is ${bytes} bytes — exceeds the 2.5KB Worker-context target`);
  return { name: 'repo_invariants', ok: issues.length === 0, issues, commonBytes: bytes };
}

// Diagnostic only. Distinguishes "repo invariant PASS" from "external global
// install stale/absent" — the latter is a warning, resolved by running the
// installer, never by mutating the environment here.
export function checkGlobalPolicy({
  homeDir = os.homedir(), configDir, env = process.env, policyFile = DEFAULT_POLICY_FILE,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(env, homeDir);
  const targets = {
    claude: path.join(homeDir, '.claude', 'CLAUDE.md'),
    codex: path.join(homeDir, '.codex', 'AGENTS.md'),
    agy: path.join(homeDir, '.gemini', 'GEMINI.md'),
  };
  let expected;
  try { expected = readFileSync(policyFile, 'utf8').trim(); }
  catch (err) { return { name: 'global_policy', ok: false, error: `unreadable COMMON policy: ${err.message}` }; }

  const frontends = {};
  const issues = [];
  for (const [frontend, filePath] of Object.entries(targets)) {
    if (!existsSync(filePath)) { frontends[frontend] = { ok: true, reason: 'not-configured' }; continue; }
    let text;
    try { text = readFileSync(filePath, 'utf8'); } catch { frontends[frontend] = { ok: false, reason: 'unreadable' }; issues.push(`${frontend} rules unreadable`); continue; }
    let content;
    try { content = extractManagedPolicy(text); } catch (err) { frontends[frontend] = { ok: false, reason: 'corrupt-block' }; issues.push(`${frontend} managed block corrupt: ${err.message}`); continue; }
    if (hasLegacyManagedPolicy(text)) issues.push(`${frontend} still carries the legacy SuperGPT managed block — run the installer to migrate`);
    if (content === null) { frontends[frontend] = { ok: false, reason: 'missing-block' }; issues.push(`${frontend} ReviewLoop policy not installed`); }
    else if (content !== expected) { frontends[frontend] = { ok: false, reason: 'stale-content' }; issues.push(`${frontend} ReviewLoop policy stale`); }
    else frontends[frontend] = { ok: true, reason: 'ok' };
  }

  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  let agyMcp = { ok: true, reason: 'not-configured' };
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigFile, 'utf8'));
      if (config?.mcpServers?.[MCP_NAME]) agyMcp = { ok: true, reason: 'ok' };
      else { agyMcp = { ok: false, reason: 'not-registered' }; issues.push('reviewloop MCP not registered for AGY'); }
      if (config?.mcpServers?.supergpt) issues.push('legacy `supergpt` MCP still registered for AGY');
    } catch (err) { agyMcp = { ok: false, reason: 'invalid-config' }; issues.push(`AGY MCP config invalid: ${err.message}`); }
  }

  return { name: 'global_policy', ok: issues.length === 0, frontends, agyMcp, issues };
}

export function checkReviewerSupervisorPools() {
  const eligible = { reviewer: [], supervisor: [] };
  for (const role of ACTIVE_ROLES) {
    for (const cand of DEFAULT_ROLE_POLICY[role] ?? []) {
      if ((PRODUCTION_ROLE_CAPABILITIES[cand.family] ?? []).includes(role)) eligible[role].push(cand.family);
    }
  }
  const issues = [];
  if (eligible.reviewer.length === 0) issues.push('no internal Reviewer candidate available');
  if (eligible.supervisor.length === 0) issues.push('no internal Supervisor candidate available');
  return { name: 'model_pools', ok: issues.length === 0, eligible, issues };
}

// Per-family Reviewer/Supervisor transport status. Distinguishes:
//   - adapter implemented + runtime available  (wired, selectable, callable)
//   - adapter implemented + runtime unavailable (CLI missing / not authed)
//   - no adapter
// plus the default model-resolution mode and whether a concrete version is
// pinned by default (must be "no"). Zero model calls; the CLI probes are just
// `--version` like the gh probe above.
export function checkReviewTransportRuntime({ execSync, env } = {}) {
  const exec = execSync || nodeExecSync;
  const probeVersion = (bin) => {
    try { probe(exec, `${bin} --version`); return { available: true, reason: 'ok' }; }
    catch (err) {
      const enoent = /ENOENT|not found/i.test(err.message);
      return { available: false, reason: enoent ? 'CLI not installed' : 'probe failed' };
    }
  };
  const transportRuntime = {
    'codex:default': probeVersion('codex'),
    'claude:opus': probeVersion('claude'),
  };
  let runtimeStatus = {};
  try {
    runtimeStatus = createReviewLoopProviderPool({ env: env || process.env, transportRuntime }).runtimeStatus;
  } catch (err) {
    return { name: 'review_transports', ok: true, error: err.message, families: {} };
  }
  return { name: 'review_transports', ok: true, families: runtimeStatus };
}

export function checkGithubCapability({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    probe(exec, 'gh --version');
    let auth = false;
    try { probe(exec, 'gh auth status'); auth = true; } catch { auth = false; }
    return { name: 'github', ok: true, gh: true, authenticated: auth };
  } catch {
    return { name: 'github', ok: true, gh: false, authenticated: false };
  }
}

export function runDoctor({ execSync, log, env } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const core = [
    checkNode({ env: environment }),
    checkGit({ execSync: exec }),
    checkRuntimeDir(),
    checkRepoInvariants(),
  ];
  const ok = core.every((r) => r.ok);

  for (const r of core) {
    if (r.name === 'repo_invariants') {
      if (r.ok) write(`  ok    repo_invariants (reviewer+supervisor only, no planner/executor, COMMON ${r.commonBytes}B)`);
      else for (const i of r.issues) write(`  FAIL  repo_invariants: ${i}`);
      continue;
    }
    if (r.ok) write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}${r.path ? ` (${r.path})` : ''}`);
    else write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
  }

  const pools = checkReviewerSupervisorPools();
  write(`  ${pools.ok ? 'ok  ' : 'warn'}  model_pools: reviewer=[${pools.eligible.reviewer.join(',') || 'none'}] supervisor=[${pools.eligible.supervisor.join(',') || 'none'}]`);
  for (const i of pools.issues) write(`  warn  model_pools: ${i}`);
  write('  info  Worker = external / current coding agent (not selected, spawned, or budgeted by ReviewLoop)');

  const transports = checkReviewTransportRuntime({ execSync: exec, env: environment });
  for (const [family, s] of Object.entries(transports.families)) {
    const rt = s.runtimeAvailable ? 'runtime available' : `runtime UNAVAILABLE (${s.reason})`;
    write(`  info  transport ${family}: adapter=${s.adapterImplemented ? 'yes' : 'NO'}, ${rt}, model=${s.defaultModelResolution ?? 'n/a'}, versionPinnedByDefault=${s.concreteVersionPinnedByDefault ? 'YES' : 'no'}`);
  }

  const gh = checkGithubCapability({ execSync: exec });
  write(`  info  github: gh ${gh.gh ? 'present' : 'absent'}${gh.gh ? `, ${gh.authenticated ? 'authenticated' : 'not authenticated'}` : ''} (PR-mode diagnostic; no real trigger)`);

  const policy = checkGlobalPolicy({ env: environment });
  if (policy.ok) write('  ok    global_policy (ReviewLoop managed blocks + MCP match COMMON)');
  else if (policy.error) write(`  warn  global_policy: ${policy.error} (diagnostic only)`);
  else {
    for (const i of policy.issues) write(`  warn  global_policy: ${i}`);
    write('  info  global_policy issues are non-fatal — run `npm run install-global` to configure or refresh');
  }

  const quota = new QuotaPoolRegistry();
  for (const pool of quota.summary()) write(`  info  quota ${pool.poolId}: ${pool.status}`);

  write(ok ? 'doctor: all core prerequisites satisfied' : 'doctor: missing core prerequisites');
  return {
    ok,
    status: ok ? 'pass' : 'fail',
    results: Object.fromEntries([...core, pools, transports, policy, gh].map((r) => [r.name, r])),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const report = runDoctor();
  process.exit(report.ok ? 0 : 1);
}
