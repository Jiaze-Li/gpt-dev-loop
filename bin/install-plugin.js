#!/usr/bin/env node
// SuperGPT global installer.
//
// One install gives every repository the same SuperGPT front-agent policy:
//   - AGY/Gemini: global MCP registration + generated SuperGPT skill
//   - Claude Code: managed block in ~/.claude/CLAUDE.md
//   - Codex: managed block in ~/.codex/AGENTS.md
//
// COMMON.md is the single source of truth for cross-agent delegation policy.
// Agent-specific policy fragments only describe how that frontend reaches
// SuperGPT. Managed blocks preserve unrelated user instructions on reinstall
// and uninstall.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_BIN = path.join(REPO_ROOT, 'bin', 'supergpt-mcp.js');
const SOURCE_SKILL = path.join(REPO_ROOT, '.agents', 'skills', 'supergpt', 'SKILL.md');
const POLICY_DIR = path.join(REPO_ROOT, 'agent-policy');

const MANAGED_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const MANAGED_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';

export function resolveGlobalConfigDir(env = process.env) {
  if (env.ANTIGRAVITY_CONFIG_DIR) return env.ANTIGRAVITY_CONFIG_DIR;
  if (env.GEMINI_CONFIG_DIR) return env.GEMINI_CONFIG_DIR;
  return path.join(os.homedir(), '.gemini', 'config');
}

function renderFragment(text, { supergptCli }) {
  return String(text).replaceAll('{{SUPERGPT_CLI}}', supergptCli);
}

function managedBlock(content) {
  return `${MANAGED_BEGIN}\n${String(content).trim()}\n${MANAGED_END}`;
}

export function stripManagedPolicy(text = '') {
  const raw = String(text);
  const begin = raw.indexOf(MANAGED_BEGIN);
  const end = raw.indexOf(MANAGED_END);
  if (begin === -1 && end === -1) return raw;
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('Refusing to modify malformed SuperGPT managed policy block');
  }
  if (raw.indexOf(MANAGED_BEGIN, begin + MANAGED_BEGIN.length) !== -1) {
    throw new Error('Refusing to modify duplicate SuperGPT managed policy blocks');
  }
  const before = raw.slice(0, begin).trimEnd();
  const after = raw.slice(end + MANAGED_END.length).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
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

async function loadPolicySet({ policyDir, supergptCli }) {
  const [common, claude, codex, agy] = await Promise.all([
    readFile(path.join(policyDir, 'COMMON.md'), 'utf8'),
    readFile(path.join(policyDir, 'CLAUDE.md'), 'utf8'),
    readFile(path.join(policyDir, 'CODEX.md'), 'utf8'),
    readFile(path.join(policyDir, 'AGY.md'), 'utf8'),
  ]);
  return {
    common: common.trim(),
    claude: renderFragment(claude, { supergptCli }).trim(),
    codex: renderFragment(codex, { supergptCli }).trim(),
    agy: renderFragment(agy, { supergptCli }).trim(),
  };
}

export async function installGlobal({
  configDir = resolveGlobalConfigDir(),
  homeDir = os.homedir(),
  repoRoot = REPO_ROOT,
  mcpBin = MCP_BIN,
  sourceSkill = SOURCE_SKILL,
  policyDir = POLICY_DIR,
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetDir = path.join(configDir, 'skills', 'supergpt');
  const skillTargetFile = path.join(skillTargetDir, 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');
  const supergptCli = path.join(repoRoot, 'bin', 'supergpt.js');

  await mkdir(configDir, { recursive: true });
  await mkdir(skillTargetDir, { recursive: true });

  // Fail closed before writing any policy if the existing AGY MCP config is invalid.
  let config = { mcpServers: {} };
  if (existsSync(mcpConfigFile)) {
    try {
      const raw = await readFile(mcpConfigFile, 'utf8');
      config = JSON.parse(raw);
      if (!config || typeof config !== 'object') throw new Error('config must be a JSON object');
    } catch (err) {
      throw new Error(`Refusing to overwrite existing invalid MCP config ${mcpConfigFile}: ${err.message}`);
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {};

  const policy = await loadPolicySet({ policyDir, supergptCli });

  // AGY/Gemini-compatible global MCP registration.
  config.mcpServers.supergpt = {
    command: process.execPath || 'node',
    args: [mcpBin],
  };
  await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // Keep the existing AGY skill contract and append the shared policy generated
  // from the same source used by Claude and Codex. Frontmatter stays first.
  const baseSkill = existsSync(sourceSkill) ? (await readFile(sourceSkill, 'utf8')).trimEnd() : '';
  const generatedSkill = [
    baseSkill,
    '## Shared front-agent delegation policy',
    policy.common,
    policy.agy,
  ].filter(Boolean).join('\n\n');
  await writeFile(skillTargetFile, `${generatedSkill}\n`, 'utf8');

  // Claude and Codex load user-level instruction files in every repository.
  // Only our marked block is owned; unrelated user content is preserved.
  await upsertManagedPolicy(claudePolicyFile, `${policy.common}\n\n${policy.claude}`);
  await upsertManagedPolicy(codexPolicyFile, `${policy.common}\n\n${policy.codex}`);

  return {
    success: true,
    mcpConfigFile,
    skillTargetFile,
    claudePolicyFile,
    codexPolicyFile,
    mcpBin,
    supergptCli,
  };
}

export async function uninstallGlobal({
  configDir = resolveGlobalConfigDir(),
  homeDir = os.homedir(),
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetDir = path.join(configDir, 'skills', 'supergpt');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');

  let removedFromMcp = false;
  if (existsSync(mcpConfigFile)) {
    try {
      const raw = await readFile(mcpConfigFile, 'utf8');
      const config = JSON.parse(raw);
      if (config?.mcpServers?.supergpt) {
        delete config.mcpServers.supergpt;
        await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        removedFromMcp = true;
      }
    } catch {
      /* preserve historical uninstall behavior for malformed unrelated config */
    }
  }

  let removedSkill = false;
  if (existsSync(skillTargetDir)) {
    await rm(skillTargetDir, { recursive: true, force: true });
    removedSkill = true;
  }

  const removedClaudePolicy = await removeManagedPolicy(claudePolicyFile);
  const removedCodexPolicy = await removeManagedPolicy(codexPolicyFile);

  return {
    success: true,
    removedFromMcp,
    removedSkill,
    removedClaudePolicy,
    removedCodexPolicy,
  };
}

export async function checkGlobalStatus({
  configDir = resolveGlobalConfigDir(),
  homeDir = os.homedir(),
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetFile = path.join(configDir, 'skills', 'supergpt', 'SKILL.md');
  const claudePolicyFile = path.join(homeDir, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(homeDir, '.codex', 'AGENTS.md');

  let mcpInstalled = false;
  let configuredBin = null;
  if (existsSync(mcpConfigFile)) {
    try {
      const raw = await readFile(mcpConfigFile, 'utf8');
      const config = JSON.parse(raw);
      if (config?.mcpServers?.supergpt) {
        mcpInstalled = true;
        configuredBin = config.mcpServers.supergpt.args?.[0] ?? null;
      }
    } catch {
      /* ignore */
    }
  }

  const hasManagedPolicy = async (filePath) => {
    if (!existsSync(filePath)) return false;
    try {
      const text = await readFile(filePath, 'utf8');
      return text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
    } catch {
      return false;
    }
  };

  return {
    configDir,
    mcpConfigFile,
    mcpInstalled,
    configuredBin,
    skillInstalled: existsSync(skillTargetFile),
    skillTargetFile,
    claudePolicyInstalled: await hasManagedPolicy(claudePolicyFile),
    claudePolicyFile,
    codexPolicyInstalled: await hasManagedPolicy(codexPolicyFile),
    codexPolicyFile,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const status = await checkGlobalStatus();
    console.log('SuperGPT Global Installation Status:');
    console.log(`  AGY MCP:        ${status.mcpInstalled ? `Installed (${status.configuredBin})` : 'Not installed'}`);
    console.log(`  AGY Skill:      ${status.skillInstalled ? `Installed (${status.skillTargetFile})` : 'Not installed'}`);
    console.log(`  Claude Policy:  ${status.claudePolicyInstalled ? `Installed (${status.claudePolicyFile})` : 'Not installed'}`);
    console.log(`  Codex Policy:   ${status.codexPolicyInstalled ? `Installed (${status.codexPolicyFile})` : 'Not installed'}`);
    return;
  }

  if (args.includes('--uninstall')) {
    const result = await uninstallGlobal();
    console.log('SuperGPT global integration removed.');
    console.log(`  AGY MCP entry removed: ${result.removedFromMcp}`);
    console.log(`  AGY skill removed:     ${result.removedSkill}`);
    console.log(`  Claude policy removed: ${result.removedClaudePolicy}`);
    console.log(`  Codex policy removed:  ${result.removedCodexPolicy}`);
    return;
  }

  const result = await installGlobal();
  console.log('SuperGPT installed globally successfully!');
  console.log(`  AGY MCP:        ${result.mcpConfigFile} -> ${result.mcpBin}`);
  console.log(`  AGY Skill:      ${result.skillTargetFile}`);
  console.log(`  Claude Policy:  ${result.claudePolicyFile}`);
  console.log(`  Codex Policy:   ${result.codexPolicyFile}`);
  console.log('\nClaude, Codex, and AGY now receive the same global SuperGPT delegation policy in every repository.');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('SuperGPT installation failed:', err.message);
    process.exitCode = 1;
  });
}
