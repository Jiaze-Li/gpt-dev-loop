#!/usr/bin/env node
// SuperGPT Global Plugin / MCP Installer.
//
// Installs SuperGPT as a global tool and skill for Antigravity (and compatible front agents)
// so that any Git workspace / branch / linked worktree can invoke SuperGPT without:
//   - copying Skill files into each repo
//   - manually configuring worktree paths
//   - manually starting background daemons
//   - running manual CLI commands
//
// Targets:
//   1. MCP Server in ~/.gemini/config/mcp_config.json
//   2. Skill file in ~/.gemini/config/skills/supergpt/SKILL.md
//
// Usage:
//   node bin/install-plugin.js             # Install globally
//   node bin/install-plugin.js --status    # Check current install status
//   node bin/install-plugin.js --uninstall # Cleanly remove global registration

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_BIN = path.join(REPO_ROOT, 'bin', 'supergpt-mcp.js');
const SOURCE_SKILL = path.join(REPO_ROOT, '.agents', 'skills', 'supergpt', 'SKILL.md');

export function resolveGlobalConfigDir(env = process.env) {
  if (env.ANTIGRAVITY_CONFIG_DIR) return env.ANTIGRAVITY_CONFIG_DIR;
  if (env.GEMINI_CONFIG_DIR) return env.GEMINI_CONFIG_DIR;
  return path.join(os.homedir(), '.gemini', 'config');
}

export async function installGlobal({
  configDir = resolveGlobalConfigDir(),
  repoRoot = REPO_ROOT,
  mcpBin = MCP_BIN,
  sourceSkill = SOURCE_SKILL,
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetDir = path.join(configDir, 'skills', 'supergpt');
  const skillTargetFile = path.join(skillTargetDir, 'SKILL.md');

  // 1. Ensure config directories exist
  await mkdir(configDir, { recursive: true });
  await mkdir(skillTargetDir, { recursive: true });

  // 2. Read or initialize mcp_config.json
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

  // 3. Register supergpt MCP server
  config.mcpServers.supergpt = {
    command: process.execPath || 'node',
    args: [mcpBin],
  };
  await writeFile(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // 4. Install SuperGPT skill
  if (existsSync(sourceSkill)) {
    await copyFile(sourceSkill, skillTargetFile);
  }

  return {
    success: true,
    mcpConfigFile,
    skillTargetFile,
    mcpBin,
  };
}

export async function uninstallGlobal({
  configDir = resolveGlobalConfigDir(),
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetDir = path.join(configDir, 'skills', 'supergpt');

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
      /* ignore */
    }
  }

  let removedSkill = false;
  if (existsSync(skillTargetDir)) {
    await rm(skillTargetDir, { recursive: true, force: true });
    removedSkill = true;
  }

  return {
    success: true,
    removedFromMcp,
    removedSkill,
  };
}

export async function checkGlobalStatus({
  configDir = resolveGlobalConfigDir(),
} = {}) {
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const skillTargetFile = path.join(configDir, 'skills', 'supergpt', 'SKILL.md');

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

  const skillInstalled = existsSync(skillTargetFile);

  return {
    configDir,
    mcpConfigFile,
    mcpInstalled,
    configuredBin,
    skillInstalled,
    skillTargetFile,
  };
}

// CLI runner
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const status = await checkGlobalStatus();
    console.log('SuperGPT Global Installation Status:');
    console.log(`  Config Dir:      ${status.configDir}`);
    console.log(`  MCP Server:      ${status.mcpInstalled ? `Installed (${status.configuredBin})` : 'Not installed'}`);
    console.log(`  Skill (Global):  ${status.skillInstalled ? `Installed (${status.skillTargetFile})` : 'Not installed'}`);
    return;
  }

  if (args.includes('--uninstall')) {
    const result = await uninstallGlobal();
    console.log('SuperGPT uninstalled globally.');
    console.log(`  MCP entry removed:  ${result.removedFromMcp}`);
    console.log(`  Skill dir removed:  ${result.removedSkill}`);
    return;
  }

  const result = await installGlobal();
  console.log('SuperGPT installed globally successfully!');
  console.log(`  MCP Server:  ${result.mcpConfigFile} -> ${result.mcpBin}`);
  console.log(`  Skill File:  ${result.skillTargetFile}`);
  console.log('\nYou can now use SuperGPT from any repository or workspace.');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('SuperGPT installation failed:', err.message);
    process.exitCode = 1;
  });
}
