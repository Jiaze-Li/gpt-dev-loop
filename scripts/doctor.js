#!/usr/bin/env node
// doctor — deterministic prerequisite check for the local SuperGPT runtime.
// Frontends are symmetric launchers, so AGY, Claude, and Codex are all
// required local prerequisites for the supported global installation.

import path from 'node:path';
import os from 'node:os';
import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { extractManagedPolicy, resolveGlobalConfigDir } from '../bin/install-plugin.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../src/agy/agyConfig.js';
import { DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry } from '../src/orchestrator/roleRouting.js';
import { defaultOrganicReworkRecorder } from '../src/orchestrator/organicReworkRecorder.js';

const DEFAULT_POLICY_FILE = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));
const MCP_NAME = 'supergpt';

// Deterministic check that the three auto-loaded frontend rule targets (Claude
// CLAUDE.md, Codex AGENTS.md, AGY GEMINI.md) each carry exactly one well-formed
// SuperGPT managed block whose normalized content matches the current COMMON
// policy, and that the AGY MCP registration and on-demand skill are still in
// place. File existence alone is never treated as installed.
export function checkGlobalPolicy({
  homeDir = os.homedir(),
  configDir,
  env = process.env,
  policyFile = DEFAULT_POLICY_FILE,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(env, homeDir);
  const targets = {
    claude: path.join(homeDir, '.claude', 'CLAUDE.md'),
    codex: path.join(homeDir, '.codex', 'AGENTS.md'),
    agy: path.join(homeDir, '.gemini', 'GEMINI.md'),
  };
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const skillFile = path.join(agyConfigDir, 'skills', MCP_NAME, 'SKILL.md');

  let expected;
  try {
    expected = readFileSync(policyFile, 'utf8').trim();
  } catch (err) {
    return { name: 'global_policy', ok: false, error: `unreadable COMMON policy: ${err.message}` };
  }

  const frontends = {};
  const issues = [];
  for (const [frontend, filePath] of Object.entries(targets)) {
    let state;
    if (!existsSync(filePath)) {
      state = { ok: false, reason: 'missing-file' };
    } else {
      let text;
      try {
        text = readFileSync(filePath, 'utf8');
      } catch {
        text = null;
      }
      if (text === null) {
        state = { ok: false, reason: 'unreadable' };
      } else {
        let content;
        try {
          content = extractManagedPolicy(text);
        } catch (err) {
          content = undefined;
          state = { ok: false, reason: 'corrupt-block', detail: err.message };
        }
        if (content === null) state = { ok: false, reason: 'missing-block' };
        else if (content === undefined) { /* corrupt-block already set */ }
        else if (content !== expected) state = { ok: false, reason: 'stale-content' };
        else state = { ok: true, reason: 'ok' };
      }
    }
    frontends[frontend] = { ...state, file: filePath };
    if (!state.ok) issues.push(`${frontend} policy ${state.reason}${state.detail ? ` (${state.detail})` : ''} at ${filePath}`);
  }

  let agyMcp = { ok: false, reason: 'missing-file', file: mcpConfigFile };
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigFile, 'utf8'));
      agyMcp = config?.mcpServers?.[MCP_NAME]
        ? { ok: true, reason: 'ok', file: mcpConfigFile }
        : { ok: false, reason: 'not-registered', file: mcpConfigFile };
    } catch (err) {
      agyMcp = { ok: false, reason: 'invalid-config', detail: err.message, file: mcpConfigFile };
    }
  }
  if (!agyMcp.ok) issues.push(`AGY MCP ${agyMcp.reason}${agyMcp.detail ? ` (${agyMcp.detail})` : ''} at ${mcpConfigFile}`);

  const agySkill = { ok: existsSync(skillFile), file: skillFile };
  if (!agySkill.ok) issues.push(`AGY skill missing at ${skillFile}`);

  const ok = Object.values(frontends).every((f) => f.ok) && agyMcp.ok && agySkill.ok;
  return { name: 'global_policy', ok, frontends, agyMcp, agySkill, issues };
}

// Zero-model-token mechanical check that the unified Front-Agent local-wait
// contract is in effect and the retired auto-watch contract is gone. Verifies:
//   - COMMON declares a contract version >= 2,
//   - COMMON routes autonomous launches through `supergpt_start_and_wait`,
//   - COMMON no longer instructs an automatic `supergpt_watch` attach/loop,
//   - the MCP server actually registers `supergpt_start_and_wait`.
// COMMON is byte-identical across Claude / Codex / AGY (enforced by
// checkGlobalPolicy), so a single source check covers all three frontends.
export function checkFrontAgentContract({
  policyFile = DEFAULT_POLICY_FILE,
  serverFile = fileURLToPath(new URL('../src/mcp/supergptMcpServer.js', import.meta.url)),
} = {}) {
  const issues = [];
  let contractVersion = null;
  let common;
  try {
    common = readFileSync(policyFile, 'utf8');
  } catch (err) {
    return { name: 'front_agent_contract', ok: false, contractVersion: null, issues: [`unreadable COMMON policy: ${err.message}`] };
  }

  const versionMatch = common.match(/Contract version:\s*(\d+)/i);
  if (!versionMatch) {
    issues.push('COMMON policy has no "Contract version:" declaration');
  } else {
    contractVersion = Number(versionMatch[1]);
    if (contractVersion < 2) issues.push(`COMMON contract version ${contractVersion} predates the unified local-wait entrypoint (need >= 2)`);
  }

  if (!/supergpt_start_and_wait/.test(common)) {
    issues.push('COMMON policy does not route autonomous launches through supergpt_start_and_wait');
  }
  if (/Attach\s+`?supergpt_watch/i.test(common)) {
    issues.push('COMMON policy still instructs an automatic supergpt_watch attach (retired auto-watch contract)');
  }
  if (!/do not (?:use|loop)[\s\S]{0,120}supergpt_watch/i.test(common) && !/must not loop on watch/i.test(common)) {
    issues.push('COMMON policy does not explicitly forbid an automatic watch/wait polling loop');
  }

  let serverSource = null;
  try {
    serverSource = readFileSync(serverFile, 'utf8');
  } catch (err) {
    issues.push(`unreadable MCP server source: ${err.message}`);
  }
  if (serverSource !== null && !/registerTool\(\s*['"]supergpt_start_and_wait['"]/.test(serverSource)) {
    issues.push('MCP server does not register the supergpt_start_and_wait tool');
  }

  return { name: 'front_agent_contract', ok: issues.length === 0, contractVersion, issues };
}

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

export function runDoctor({ execSync, log, env, policyOptions } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const policy = checkGlobalPolicy({ env: environment, ...(policyOptions || {}) });
  const contract = checkFrontAgentContract(policyOptions?.contractOptions || {});
  // Core local runtime prerequisites. global_policy is reported as diagnostic
  // info/warning only — a missing or stale global install never fails runDoctor.
  // front_agent_contract IS fatal: it is a repo invariant, not an install state,
  // and its whole purpose is to fail loudly if the retired auto-watch contract
  // creeps back in.
  const coreResults = [
    checkGit({ execSync: exec }),
    checkNode({ env: environment }),
    checkAgy({ execSync: exec }),
    checkClaude({ execSync: exec }),
    checkCodex({ execSync: exec }),
    contract,
  ];
  const results = [...coreResults, policy];
  const ok = coreResults.every((r) => r.ok);

  for (const r of coreResults) {
    if (r.name === 'front_agent_contract') {
      if (r.ok) write(`  ok    front_agent_contract (v${r.contractVersion}, unified supergpt_start_and_wait, no auto-watch loop)`);
      else for (const issue of r.issues) write(`  FAIL  front_agent_contract: ${issue}`);
      continue;
    }
    if (r.ok) write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}`);
    else write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
  }

  if (policy.ok) {
    write('  ok    global_policy (Claude, Codex, AGY managed blocks match COMMON; AGY MCP + skill present)');
  } else if (policy.error) {
    write(`  warn  global_policy: ${policy.error} (diagnostic only — run install to configure global rules)`);
  } else {
    for (const issue of policy.issues) write(`  warn  global_policy: ${issue}`);
    write('  info  global_policy issues are non-fatal — run the plugin installer to configure or refresh global rules');
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
