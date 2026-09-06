#!/usr/bin/env node
// ReviewLoop global installer.
//
// Installs the ReviewLoop Worker Contract (agent-policy/COMMON.md) and the
// shared `reviewloop` MCP server into whichever supported coding agents are
// present (Claude, Codex, Gemini/AGY). Missing agents are skipped, not fatal.
//
// It ALSO transactionally migrates an older SuperGPT install found on the
// machine:
//   - removes the `supergpt` MCP registration it owns (claude / codex / agy)
//   - removes the `<!-- SUPERGPT-GLOBAL-POLICY -->` managed block
//   - removes the old AGY `supergpt` skill
// Unrelated user content outside the managed block is preserved byte-for-byte.
// Every touched file is snapshotted first; any failure rolls all of them back.

import path from 'node:path';
import os from 'node:os';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_BIN = path.join(REPO_ROOT, 'bin', 'reviewloop-mcp.js');
const POLICY_FILE = path.join(REPO_ROOT, 'agent-policy', 'COMMON.md');

const MCP_NAME = 'reviewloop';
const LEGACY_MCP_NAME = 'supergpt';
const MANAGED_BEGIN = '<!-- REVIEWLOOP-GLOBAL-POLICY:BEGIN -->';
const MANAGED_END = '<!-- REVIEWLOOP-GLOBAL-POLICY:END -->';
const LEGACY_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const LEGACY_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';

export function resolveGlobalConfigDir(env = process.env, homeDir = os.homedir()) {
  if (env.ANTIGRAVITY_CONFIG_DIR) return env.ANTIGRAVITY_CONFIG_DIR;
  if (env.GEMINI_CONFIG_DIR) return env.GEMINI_CONFIG_DIR;
  return path.join(homeDir, '.gemini', 'config');
}

function managedBlock(content) {
  return `${MANAGED_BEGIN}\n${String(content).trim()}\n${MANAGED_END}`;
}

function locate(text, begin, end, label) {
  const raw = String(text);
  const b = raw.indexOf(begin);
  const e = raw.indexOf(end);
  if (b === -1 && e === -1) return null;
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`Refusing to modify malformed ${label} managed policy block`);
  }
  if (raw.indexOf(begin, b + begin.length) !== -1) {
    throw new Error(`Refusing to modify duplicate ${label} managed policy blocks`);
  }
  return { raw, begin: b, end: e + end.length };
}

function stripOne(text, begin, end, label) {
  const located = locate(text, begin, end, label);
  if (!located) return String(text);
  const { raw, begin: b, end: e } = located;
  const before = raw.slice(0, b).trimEnd();
  const after = raw.slice(e).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

// Removes BOTH the current ReviewLoop block and any legacy SuperGPT block.
export function stripManagedPolicy(text = '') {
  return stripOne(stripOne(text, LEGACY_BEGIN, LEGACY_END, 'SuperGPT'), MANAGED_BEGIN, MANAGED_END, 'ReviewLoop');
}

export function extractManagedPolicy(text = '') {
  const located = locate(text, MANAGED_BEGIN, MANAGED_END, 'ReviewLoop');
  if (!located) return null;
  const { raw, begin, end } = located;
  return raw.slice(begin + MANAGED_BEGIN.length, end - MANAGED_END.length).trim();
}

export function hasLegacyManagedPolicy(text = '') {
  return String(text).includes(LEGACY_BEGIN);
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
  if (!existing.includes(MANAGED_BEGIN) && !existing.includes(LEGACY_BEGIN)) return false;
  const unmanaged = stripManagedPolicy(existing);
  await writeFile(filePath, unmanaged ? `${unmanaged.trimEnd()}\n` : '', 'utf8');
  return true;
}

function runCli(execFileSync, command, args, { allowFailure = false } = {}) {
  try {
    return String(execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '').trim();
  } catch (err) {
    if (allowFailure) return null;
    const detail = err?.stderr ? String(err.stderr).trim() : err?.message;
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function frontendAvailable(execFileSync, command) {
  return runCli(execFileSync, command, ['--version'], { allowFailure: true }) !== null;
}

function registerClaudeMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'claude', ['mcp', 'remove', LEGACY_MCP_NAME, '--scope', 'user'], { allowFailure: true });
  runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true });
  runCli(execFileSync, 'claude', ['mcp', 'add', MCP_NAME, '--scope', 'user', '--', nodeBin, mcpBin]);
}

function registerCodexMcp(execFileSync, nodeBin, mcpBin) {
  runCli(execFileSync, 'codex', ['mcp', 'remove', LEGACY_MCP_NAME], { allowFailure: true });
  runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true });
  runCli(execFileSync, 'codex', ['mcp', 'add', MCP_NAME, '--', nodeBin, mcpBin]);
}

function removeClaudeMcp(execFileSync) {
  runCli(execFileSync, 'claude', ['mcp', 'remove', LEGACY_MCP_NAME, '--scope', 'user'], { allowFailure: true });
  return runCli(execFileSync, 'claude', ['mcp', 'remove', MCP_NAME, '--scope', 'user'], { allowFailure: true }) !== null;
}

function removeCodexMcp(execFileSync) {
  runCli(execFileSync, 'codex', ['mcp', 'remove', LEGACY_MCP_NAME], { allowFailure: true });
  return runCli(execFileSync, 'codex', ['mcp', 'remove', MCP_NAME], { allowFailure: true }) !== null;
}

function hasClaudeMcp(execFileSync) {
  return runCli(execFileSync, 'claude', ['mcp', 'get', MCP_NAME], { allowFailure: true }) !== null;
}

function hasCodexMcp(execFileSync) {
  return runCli(execFileSync, 'codex', ['mcp', 'get', MCP_NAME], { allowFailure: true }) !== null;
}

function renderAgySkill(commonPolicy) {
  return `---\nname: reviewloop\ndescription: Shared ReviewLoop Worker contract.\n---\n\n${String(commonPolicy).trim()}\n`;
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
  await rm(filePath, { recursive: true, force: true });
  if (!snapshot?.existed) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, snapshot.content);
}

async function restoreFileStates(snapshots) {
  const errors = [];
  for (const [filePath, snapshot] of snapshots) {
    try {
      // eslint-disable-next-line no-await-in-loop
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
      config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a JSON object');
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
  const legacyAgySkillDir = path.join(agyConfigDir, 'skills', LEGACY_MCP_NAME);
  const agyPolicyFile = path.join(agySkillTargetDir, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const geminiPolicyFile = path.join(homeDir, '.gemini', 'GEMINI.md');

  const commonPolicy = await readFile(policyFile, 'utf8');
  const agyConfig = await readAgyConfig(mcpConfigFile);

  const present = {
    claude: frontendAvailable(execFileSync, 'claude'),
    codex: frontendAvailable(execFileSync, 'codex'),
    agy: frontendAvailable(execFileSync, 'agy'),
  };
  if (!present.claude && !present.codex && !present.agy) {
    throw new Error('No supported coding agent (claude / codex / agy) found on this machine');
  }

  const transactionalPaths = [
    mcpConfigFile, agyPolicyFile,
    claudePolicyFile, codexPolicyFile, geminiPolicyFile,
    path.join(homeDir, '.claude.json'), path.join(homeDir, '.codex', 'config.toml'),
  ];
  const snapshots = new Map();
  for (const filePath of transactionalPaths) {
    // eslint-disable-next-line no-await-in-loop
    snapshots.set(filePath, await snapshotFileState(filePath));
  }

  for (const policyPath of [claudePolicyFile, codexPolicyFile, geminiPolicyFile]) {
    const snap = snapshots.get(policyPath);
    if (snap?.existed) stripManagedPolicy(snap.content.toString('utf8'));
  }

  const migrated = { legacyBlocks: [], legacyMcp: [], legacySkill: false };

  try {
    if (present.claude) registerClaudeMcp(execFileSync, nodeBin, mcpBin);
    if (present.codex) registerCodexMcp(execFileSync, nodeBin, mcpBin);

    if (existsSync(mcpConfigFile) && agyConfig.mcpServers[LEGACY_MCP_NAME]) {
      migrated.legacyMcp.push('agy');
    }
    delete agyConfig.mcpServers[LEGACY_MCP_NAME];

    if (present.agy || existsSync(mcpConfigFile)) {
      await mkdir(agyConfigDir, { recursive: true });
      await mkdir(agySkillTargetDir, { recursive: true });
      agyConfig.mcpServers[MCP_NAME] = { command: nodeBin, args: [mcpBin] };
      await writeFile(mcpConfigFile, `${JSON.stringify(agyConfig, null, 2)}\n`, 'utf8');
      await writeFile(agyPolicyFile, renderAgySkill(commonPolicy), 'utf8');
      if (existsSync(legacyAgySkillDir)) {
        await rm(legacyAgySkillDir, { recursive: true, force: true });
        migrated.legacySkill = true;
      }
    }

    for (const [frontend, policyPath] of [
      ['claude', claudePolicyFile], ['codex', codexPolicyFile], ['agy', geminiPolicyFile],
    ]) {
      const snap = snapshots.get(policyPath);
      const legacy = snap?.existed && hasLegacyManagedPolicy(snap.content.toString('utf8'));
      if (legacy) migrated.legacyBlocks.push(frontend);
      if (present[frontend] || legacy) {
        // eslint-disable-next-line no-await-in-loop
        await upsertManagedPolicy(policyPath, commonPolicy);
      }
    }
  } catch (err) {
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
    present,
    migrated,
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
      let changed = false;
      for (const name of [MCP_NAME, LEGACY_MCP_NAME]) {
        if (config?.mcpServers?.[name]) { delete config.mcpServers[name]; changed = true; }
      }
      if (changed) {
        await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        removedAgyMcp = true;
      }
    } catch { /* never rewrite unrelated malformed user config */ }
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
  let legacyAgyMcp = false;
  if (existsSync(mcpConfigFile)) {
    try {
      const config = JSON.parse(await readFile(mcpConfigFile, 'utf8'));
      agyMcpInstalled = Boolean(config?.mcpServers?.[MCP_NAME]);
      legacyAgyMcp = Boolean(config?.mcpServers?.[LEGACY_MCP_NAME]);
    } catch { /* report false */ }
  }

  const managedPolicyState = async (filePath) => {
    if (!existsSync(filePath)) return { policyInstalled: false, reason: 'missing-file', legacy: false };
    let text;
    try { text = await readFile(filePath, 'utf8'); } catch { return { policyInstalled: false, reason: 'unreadable', legacy: false }; }
    const legacy = hasLegacyManagedPolicy(text);
    let content;
    try { content = extractManagedPolicy(text); } catch (err) { return { policyInstalled: false, reason: 'corrupt-block', detail: err.message, legacy }; }
    if (content === null) return { policyInstalled: false, reason: 'missing-block', legacy };
    if (content !== expectedPolicy) return { policyInstalled: false, reason: 'stale-content', legacy };
    return { policyInstalled: true, reason: 'ok', legacy };
  };

  const avail = (command) => runCli(execFileSync, command, ['--version'], { allowFailure: true }) !== null;
  const [claudePolicy, codexPolicy, geminiPolicy] = await Promise.all([
    managedPolicyState(claudePolicyFile),
    managedPolicyState(codexPolicyFile),
    managedPolicyState(geminiPolicyFile),
  ]);

  return {
    mcpConfigFile,
    legacyAgyMcp,
    agy: {
      available: avail('agy'),
      mcpInstalled: agyMcpInstalled,
      policyInstalled: geminiPolicy.policyInstalled,
      policyReason: geminiPolicy.reason,
      legacyPolicy: geminiPolicy.legacy,
      policyFile: geminiPolicyFile,
      skillInstalled: existsSync(agySkillFile),
      skillFile: agySkillFile,
    },
    claude: {
      available: avail('claude'),
      mcpInstalled: hasClaudeMcp(execFileSync),
      policyInstalled: claudePolicy.policyInstalled,
      policyReason: claudePolicy.reason,
      legacyPolicy: claudePolicy.legacy,
      policyFile: claudePolicyFile,
    },
    codex: {
      available: avail('codex'),
      mcpInstalled: hasCodexMcp(execFileSync),
      policyInstalled: codexPolicy.policyInstalled,
      policyReason: codexPolicy.reason,
      legacyPolicy: codexPolicy.legacy,
      policyFile: codexPolicyFile,
    },
  };
}

function installedText(frontend) {
  if (!frontend.available) return 'Skipped (agent not installed)';
  if (frontend.mcpInstalled && frontend.policyInstalled) return 'Installed';
  const notes = [];
  if (!frontend.mcpInstalled) notes.push('MCP not registered');
  if (!frontend.policyInstalled) notes.push(`policy ${frontend.policyReason || 'not installed'}`);
  return `Incomplete (${notes.join(', ')})`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const status = await checkGlobalStatus();
    console.log('ReviewLoop global status:');
    console.log(`  AGY:     ${installedText(status.agy)}`);
    console.log(`  Claude:  ${installedText(status.claude)}`);
    console.log(`  Codex:   ${installedText(status.codex)}`);
    if (status.legacyAgyMcp) console.log('  note: legacy `supergpt` MCP registration still present — run install to migrate');
    return;
  }
  if (args.includes('--uninstall')) {
    await uninstallGlobal();
    console.log('ReviewLoop global integration removed.');
    return;
  }
  const result = await installGlobal();
  const targets = Object.entries(result.present).filter(([, v]) => v).map(([k]) => k);
  console.log(`ReviewLoop installed globally for: ${targets.join(', ') || '(none available)'}`);
  console.log(`  MCP server: ${result.mcpBin}`);
  console.log('  Policy:     agent-policy/COMMON.md (single source of truth)');
  if (result.migrated.legacyBlocks.length || result.migrated.legacyMcp.length || result.migrated.legacySkill) {
    console.log(`  Migrated legacy SuperGPT: blocks=[${result.migrated.legacyBlocks}] mcp=[${result.migrated.legacyMcp}] skill=${result.migrated.legacySkill}`);
  }
  console.log('Restart/open a new agent session so each client reloads its MCP and policy.');
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('ReviewLoop installation failed:', err.message);
    process.exitCode = 1;
  });
}
