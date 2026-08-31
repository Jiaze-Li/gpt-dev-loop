#!/usr/bin/env node
// SuperGPT global frontend installer.
//
// Product contract: Claude, Codex, and AGY are identical front-agent launchers.
// All three receive the same agent-policy/COMMON.md and the same `supergpt` MCP
// server. Client-specific differences are limited to the mechanics required to
// write each client's global configuration.

import path from 'node:path';
import os from 'node:os';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_BIN = path.join(REPO_ROOT, 'bin', 'supergpt-mcp.js');
const POLICY_FILE = path.join(REPO_ROOT, 'agent-policy', 'COMMON.md');

const MCP_NAME = 'supergpt';
const MANAGED_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const MANAGED_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';

export function resolveGlobalConfigDir(env = process.env, homeDir = os.homedir()) {
  if (env.ANTIGRAVITY_CONFIG_DIR) return env.ANTIGRAVITY_CONFIG_DIR;
  if (env.GEMINI_CONFIG_DIR) return env.GEMINI_CONFIG_DIR;
  return path.join(homeDir, '.gemini', 'config');
}

function managedBlock(content) {
  return `${MANAGED_BEGIN}\n${String(content).trim()}\n${MANAGED_END}`;
}

function locateManagedPolicy(text) {
  const raw = String(text);
  const begin = raw.indexOf(MANAGED_BEGIN);
  const end = raw.indexOf(MANAGED_END);
  if (begin === -1 && end === -1) return null;
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('Refusing to modify malformed SuperGPT managed policy block');
  }
  if (raw.indexOf(MANAGED_BEGIN, begin + MANAGED_BEGIN.length) !== -1) {
    throw new Error('Refusing to modify duplicate SuperGPT managed policy blocks');
  }
  return { raw, begin, end: end + MANAGED_END.length };
}

export function stripManagedPolicy(text = '') {
  const located = locateManagedPolicy(text);
  if (!located) return String(text);
  const { raw, begin, end } = located;
  const before = raw.slice(0, begin).trimEnd();
  const after = raw.slice(end).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

// Returns the normalized content of the sole managed block, or null when the
// file carries no block. Throws on malformed or duplicate markers so callers
// can treat a corrupt file as "not correctly installed".
export function extractManagedPolicy(text = '') {
  const located = locateManagedPolicy(text);
  if (!located) return null;
  const { raw, begin, end } = located;
  return raw.slice(begin + MANAGED_BEGIN.length, end - MANAGED_END.length).trim();
}

async function upsertManagedPolicy(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? await readFile(filePath, 'utf8') : '';
  const unmanaged = stripManagedPolicy(existing).trimEnd();
  const next = `${unmanaged ? `${unmanaged}\n\n` : ''}${managedBlock(content)}\n`;
  await writeFile(filePath, next, 'utf8');
}

async function removeManagedPolicy(filePath) {
  if (!existsSync(filePath)) return false;
  const existing = await readFile(filePath, 'utf8');
  if (!existing.includes(MANAGED_BEGIN) && !existing.includes(MANAGED_END)) return false;
  const unmanaged = stripManagedPolicy(existing);
  await writeFile(filePath, unmanaged ? `${unmanaged.trimEnd()}\n` : '', 'utf8');
  return true;
}

function runCli(execFileSync, command, args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) ?? '').trim();
  } catch (err) {
    if (allowFailure) return null;
    const detail = err?.stderr ? String(err.stderr).trim() : err?.message;
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function assertFrontendCli(execFileSync, command) {
  const version = runCli(execFileSync, command, ['--version']);
  if (!version) throw new Error(`${command} --version returned no output`);
  return version;
}

function registerClaudeMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true });
  runCli(execFileSync, 'claude', ['mcp', 'add', MCP_NAME, '--scope', 'user', '--', nodeBin, mcpBin]);
}

function registerCodexMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true });
  runCli(execFileSync, 'codex', ['mcp', 'add', MCP_NAME, '--', nodeBin, mcpBin]);
}

function removeClaudeMcp(execFileSync) {
  return runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true }) !== null;
}

function removeCodexMcp(execFileSync) {
  return runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true }) !== null;
}

function hasClaudeMcp(execFileSync) {
  return runCli(execFileSync, 'claude', ['mcp', 'get', MCP_NAME], { allowFailure: true }) !== null;
}

function hasCodexMcp(execFileSync) {
  return runCli(execFileSync, 'codex', ['mcp', 'get', MCP_NAME], { allowFailure: true }) !== null;
}

function renderAgySkill(commonPolicy) {
  return `---\nname: supergpt\ndescription: Shared SuperGPT frontend launcher contract.\n---\n\n${String(commonPolicy).trim()}\n`;
}

async function snapshotFileState(filePath) {
  try {
    return { existed: true, content: await readFile(filePath) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { existed: false, content: null };
    throw err;
  }
}

async function restoreFileState(filePath, snapshot) {
  // Remove any partial replacement first, including an unexpected directory
  // or symlink at a path that used to be absent or a regular file.
  await rm(filePath, { recursive: true, force: true });
  if (!snapshot?.existed) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, snapshot.content);
}

async function restoreFileStates(snapshots) {
  const errors = [];
  for (const [filePath, snapshot] of snapshots) {
    try {
      await restoreFileState(filePath, snapshot);
    } catch (err) {
      errors.push(`${filePath}: ${err?.message || err}`);
    }
  }
  return errors;
}

async function readAgyConfig(mcpConfigFile) {
  let config = { mcpServers: {} };
  if (existsSync(mcpConfigFile)) {
    try {
      const raw = await readFile(mcpConfigFile, 'utf8');
      config = JSON.parse(raw);
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('config must be a JSON object');
      }
    } catch (err) {
      throw new Error(`Refusing to overwrite existing invalid MCP config ${mcpConfigFile}: ${err.message}`);
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }
  return config;
}

export async function installGlobal({
  configDir,
  homeDir = os.homedir(),
  mcpBin = MCP_BIN,
  policyFile = POLICY_FILE,
  nodeBin = process.execPath || 'node',
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillTargetDir = path.join(agyConfigDir, 'skills', MCP_NAME);
  const agyPolicyFile = path.join(agySkillTargetDir, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  // Preflight everything before changing any frontend configuration.
  const [commonPolicy, agyConfig] = await Promise.all([
    readFile(policyFile, 'utf8'),
    readAgyConfig(mcpConfigFile),
  ]);
  const versions = {
    agy: assertFrontendCli(execFileSync, 'agy'),
    claude: assertFrontendCli(execFileSync, 'claude'),
    codex: assertFrontendCli(execFileSync, 'codex'),
  };

  const claudeMcpConfigFile = path.join(homeDir, '.claude.json');
  const codexMcpConfigFile = path.join(homeDir, '.codex', 'config.toml');
  const transactionalPaths = [
    mcpConfigFile,
    agyPolicyFile,
    claudePolicyFile,
    codexPolicyFile,
    geminiPolicyFile,
    claudeMcpConfigFile,
    codexMcpConfigFile,
  ];
  const snapshots = new Map();
  for (const filePath of transactionalPaths) {
    snapshots.set(filePath, await snapshotFileState(filePath));
  }

  // Validate existing managed policy blocks before the first MCP registration
  // mutates frontend state.
  for (const policyPath of [claudePolicyFile, codexPolicyFile, geminiPolicyFile]) {
    const snapshot = snapshots.get(policyPath);
    if (snapshot?.existed) stripManagedPolicy(snapshot.content.toString('utf8'));
  }

  try {
    registerClaudeMcp(execFileSync, nodeBin, mcpBin);
    registerCodexMcp(execFileSync, nodeBin, mcpBin);

    await mkdir(agyConfigDir, { recursive: true });
    await mkdir(agySkillTargetDir, { recursive: true });

    agyConfig.mcpServers[MCP_NAME] = { command: nodeBin, args: [mcpBin] };
    await writeFile(mcpConfigFile, `${JSON.stringify(agyConfig, null, 2)}\n`, 'utf8');
    await writeFile(agyPolicyFile, renderAgySkill(commonPolicy), 'utf8');

    await upsertManagedPolicy(claudePolicyFile, commonPolicy);
    await upsertManagedPolicy(codexPolicyFile, commonPolicy);
    await upsertManagedPolicy(geminiPolicyFile, commonPolicy);
  } catch (err) {
    // Registration helpers remove/replace existing entries. Remove any partial
    // new entry, then restore exact pre-install bytes for every frontend file.
    removeCodexMcp(execFileSync);
    removeClaudeMcp(execFileSync);
    const rollbackErrors = await restoreFileStates(snapshots);
    if (rollbackErrors.length > 0) {
      err.rollbackErrors = rollbackErrors;
      err.message = `${err.message} (rollback incomplete: ${rollbackErrors.join('; ')})`;
    }
    throw err;
  }

  return {
    success: true,
    versions,
    mcpBin,
    mcpConfigFile,
    agyPolicyFile,
    claudePolicyFile,
    codexPolicyFile,
    geminiPolicyFile,
  };
}

export async function uninstallGlobal({
  configDir,
  homeDir = os.homedir(),
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillTargetDir = path.join(agyConfigDir, 'skills', MCP_NAME);
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  let removedAgyMcp = false;
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      if (config?.mcpServers?.[MCP_NAME]) {
        delete config.mcpServers[MCP_NAME];
        await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        removedAgyMcp = true;
      }
    } catch {
      // Do not rewrite unrelated malformed user configuration during uninstall.
    }
  }

  const removedAgyPolicy = existsSync(agySkillTargetDir);
  if (removedAgyPolicy) await rm(agySkillTargetDir, { recursive: true, force: true });

  const removedClaudeMcp = removeClaudeMcp(execFileSync);
  const removedCodexMcp = removeCodexMcp(execFileSync);
  const removedClaudePolicy = await removeManagedPolicy(claudePolicyFile);
  const removedCodexPolicy = await removeManagedPolicy(codexPolicyFile);
  const removedGeminiPolicy = await removeManagedPolicy(geminiPolicyFile);

  return {
    success: true,
    removedAgyMcp,
    removedClaudeMcp,
    removedCodexMcp,
    removedAgyPolicy,
    removedClaudePolicy,
    removedCodexPolicy,
    removedGeminiPolicy,
  };
}

export async function checkGlobalStatus({
  configDir,
  homeDir = os.homedir(),
  policyFile = POLICY_FILE,
  execFileSync = nodeExecFileSync,
} = {}) {
  const agyConfigDir = configDir ?? resolveGlobalConfigDir(process.env, homeDir);
  const mcpConfigFile = path.join(agyConfigDir, 'mcp_config.json');
  const agySkillFile = path.join(agyConfigDir, 'skills', MCP_NAME, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  const expectedPolicy = (await readFile(policyFile, 'utf8')).trim();

  let agyMcpInstalled = false;
  let configuredBin = null;
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      const entry = config?.mcpServers?.[MCP_NAME];
      if (entry) {
        agyMcpInstalled = true;
        configuredBin = entry.args?.[0] ?? null;
      }
    } catch {
      // Status reports false instead of mutating invalid configuration.
    }
  }

  // A managed policy target counts as installed only when the file carries
  // exactly one well-formed SuperGPT block whose normalized content matches the
  // current COMMON policy. Missing files, missing/duplicate/corrupt markers, and
  // stale content all report false.
  const managedPolicyState = async (filePath) => {
    if (!existsSync(filePath)) return { policyInstalled: false, reason: 'missing-file' };
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return { policyInstalled: false, reason: 'unreadable' };
    }
    let content;
    try {
      content = extractManagedPolicy(text);
    } catch (err) {
      return { policyInstalled: false, reason: 'corrupt-block', detail: err.message };
    }
    if (content === null) return { policyInstalled: false, reason: 'missing-block' };
    if (content !== expectedPolicy) return { policyInstalled: false, reason: 'stale-content' };
    return { policyInstalled: true, reason: 'ok' };
  };

  const frontendAvailable = (command) => runCli(execFileSync, command, ['--version'], { allowFailure: true }) !== null;

  const [claudePolicy, codexPolicy, geminiPolicy] = await Promise.all([
    managedPolicyState(claudePolicyFile),
    managedPolicyState(codexPolicyFile),
    managedPolicyState(geminiPolicyFile),
  ]);

  return {
    mcpConfigFile,
    configuredBin,
    agy: {
      available: frontendAvailable('agy'),
      mcpInstalled: agyMcpInstalled,
      policyInstalled: geminiPolicy.policyInstalled,
      policyReason: geminiPolicy.reason,
      policyDetail: geminiPolicy.detail,
      policyFile: geminiPolicyFile,
      skillInstalled: existsSync(agySkillFile),
      skillFile: agySkillFile,
    },
    claude: {
      available: frontendAvailable('claude'),
      mcpInstalled: hasClaudeMcp(execFileSync),
      policyInstalled: claudePolicy.policyInstalled,
      policyReason: claudePolicy.reason,
      policyDetail: claudePolicy.detail,
      policyFile: claudePolicyFile,
    },
    codex: {
      available: frontendAvailable('codex'),
      mcpInstalled: hasCodexMcp(execFileSync),
      policyInstalled: codexPolicy.policyInstalled,
      policyReason: codexPolicy.reason,
      policyDetail: codexPolicy.detail,
      policyFile: codexPolicyFile,
    },
  };
}

function installedText(frontend) {
  if (frontend.available && frontend.mcpInstalled && frontend.policyInstalled) return 'Installed';
  const notes = [];
  if (!frontend.available) notes.push('frontend unavailable');
  if (!frontend.mcpInstalled) notes.push('MCP not registered');
  if (!frontend.policyInstalled) notes.push(`policy ${frontend.policyReason || 'not installed'}`);
  return `Incomplete (${notes.join(', ')})`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const status = await checkGlobalStatus();
    console.log('SuperGPT Global Frontend Status:');
    console.log(`  AGY:     ${installedText(status.agy)}${status.agy.skillInstalled ? '' : ' [skill missing]'}`);
    console.log(`  Claude:  ${installedText(status.claude)}`);
    console.log(`  Codex:   ${installedText(status.codex)}`);
    return;
  }

  if (args.includes('--uninstall')) {
    await uninstallGlobal();
    console.log('SuperGPT global frontend integration removed.');
    return;
  }

  const result = await installGlobal();
  console.log('SuperGPT installed globally for AGY, Claude, and Codex.');
  console.log(`  MCP server: ${result.mcpBin}`);
  console.log('  Policy:     agent-policy/COMMON.md (single source of truth)');
  console.log(`  Claude:     ${result.claudePolicyFile} (managed block)`);
  console.log(`  Codex:      ${result.codexPolicyFile} (managed block)`);
  console.log(`  AGY:        ${result.geminiPolicyFile} (managed block) + ${result.agyPolicyFile} (skill)`);
  console.log('Restart/open a new frontend session so each client reloads its global MCP and policy.');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('SuperGPT installation failed:', err.message);
    process.exitCode = 1;
  });
}
