import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  installGlobal,
  uninstallGlobal,
  checkGlobalStatus,
  extractManagedPolicy,
  hasLegacyManagedPolicy,
} from '../bin/install-plugin.js';

const BEGIN = '<!-- REVIEWLOOP-GLOBAL-POLICY:BEGIN -->';
const LEGACY_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const LEGACY_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';
const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));

function occurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

function makeFrontendExec({ missing = [] } = {}) {
  const calls = [];
  const mcp = { claude: {}, codex: {} };
  const execFileSync = (command, args = []) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') {
      if (missing.includes(command)) throw new Error(`${command}: command not found`);
      return `${command} test-version\n`;
    }
    if ((command === 'claude' || command === 'codex') && args[0] === 'mcp') {
      const [, action, name] = args;
      if (action === 'add') { mcp[command][name] = true; return 'added\n'; }
      if (action === 'remove') { if (!mcp[command][name]) throw new Error('not configured'); delete mcp[command][name]; return 'removed\n'; }
      if (action === 'get') { if (!mcp[command][name]) throw new Error('not configured'); return `${name} configured\n`; }
    }
    throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
  };
  return { execFileSync, calls, mcp };
}

const opts = (tmp, fake, extra = {}) => ({
  configDir: path.join(tmp, '.gemini', 'config'),
  homeDir: tmp,
  policyFile: COMMON,
  mcpBin: '/opt/reviewloop/bin/reviewloop-mcp.js',
  nodeBin: '/usr/bin/node',
  execFileSync: fake.execFileSync,
  ...extra,
});

test('installs the reviewloop MCP + managed policy for every present agent', async () => {
  const tmp = path.join('/tmp', `rl-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fake = makeFrontendExec();
  try {
    const result = await installGlobal(opts(tmp, fake));
    assert.equal(result.success, true);
    assert.ok(fake.mcp.claude.reviewloop && fake.mcp.codex.reviewloop);

    const agyConfig = JSON.parse(await readFile(result.mcpConfigFile, 'utf8'));
    assert.deepEqual(agyConfig.mcpServers.reviewloop, { command: '/usr/bin/node', args: ['/opt/reviewloop/bin/reviewloop-mcp.js'] });
    assert.equal(agyConfig.mcpServers.supergpt, undefined);

    const common = (await readFile(COMMON, 'utf8')).trim();
    assert.equal(extractManagedPolicy(await readFile(result.claudePolicyFile, 'utf8')), common);
    assert.equal(extractManagedPolicy(await readFile(result.codexPolicyFile, 'utf8')), common);
    assert.equal(extractManagedPolicy(await readFile(result.geminiPolicyFile, 'utf8')), common);
    assert.match(await readFile(result.agyPolicyFile, 'utf8'), /name: reviewloop/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a machine with only one agent installs without failing', async () => {
  const tmp = path.join('/tmp', `rl-partial-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fake = makeFrontendExec({ missing: ['codex', 'agy'] });
  try {
    const result = await installGlobal(opts(tmp, fake));
    assert.equal(result.success, true);
    assert.equal(result.present.claude, true);
    assert.equal(result.present.codex, false);
    assert.ok(fake.mcp.claude.reviewloop);
    assert.equal(existsSync(result.claudePolicyFile), true);
    // codex file is never created when codex is absent
    assert.equal(existsSync(result.codexPolicyFile), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('fails only when NO supported agent is present', async () => {
  const tmp = path.join('/tmp', `rl-none-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fake = makeFrontendExec({ missing: ['claude', 'codex', 'agy'] });
  try {
    await assert.rejects(() => installGlobal(opts(tmp, fake)), /No supported coding agent/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('transactionally migrates a legacy SuperGPT install', async () => {
  const tmp = path.join('/tmp', `rl-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  const geminiFile = path.join(tmp, '.gemini', 'GEMINI.md');
  const fake = makeFrontendExec();
  // pre-seed a legacy install
  fake.mcp.claude.supergpt = true;
  fake.mcp.codex.supergpt = true;
  await mkdir(configDir, { recursive: true });
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await mkdir(path.join(configDir, 'skills', 'supergpt'), { recursive: true });
  await writeFile(path.join(configDir, 'skills', 'supergpt', 'SKILL.md'), 'old skill\n');
  await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: { supergpt: { command: 'node', args: ['old'] }, other: { command: 'x', args: [] } },
  }, null, 2));
  await writeFile(claudeFile, `# my notes\nkeep me\n\n${LEGACY_BEGIN}\nold supergpt policy\n${LEGACY_END}\n`);
  await writeFile(geminiFile, `${LEGACY_BEGIN}\nold\n${LEGACY_END}\n`);

  try {
    const result = await installGlobal(opts(tmp, fake));
    assert.ok(result.migrated.legacyMcp.includes('agy'));
    assert.ok(result.migrated.legacyBlocks.includes('claude'));
    assert.equal(result.migrated.legacySkill, true);

    const config = JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'));
    assert.equal(config.mcpServers.supergpt, undefined);
    assert.ok(config.mcpServers.reviewloop);
    assert.deepEqual(config.mcpServers.other, { command: 'x', args: [] });

    const claude = await readFile(claudeFile, 'utf8');
    assert.match(claude, /keep me/);
    assert.equal(hasLegacyManagedPolicy(claude), false);
    assert.equal(occurrences(claude, BEGIN), 1);
    assert.equal(existsSync(path.join(configDir, 'skills', 'supergpt')), false);
    assert.equal(existsSync(path.join(configDir, 'skills', 'reviewloop', 'SKILL.md')), true);

    const status = await checkGlobalStatus({ configDir, homeDir: tmp, policyFile: COMMON, execFileSync: fake.execFileSync });
    assert.equal(status.legacyAgyMcp, false);
    assert.equal(status.claude.policyInstalled, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rolls back every touched file when a mid-install step throws', async () => {
  const tmp = path.join('/tmp', `rl-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await writeFile(claudeFile, '# original claude\n');
  const fake = makeFrontendExec();
  // make the codex MCP registration throw AFTER claude succeeded
  const orig = fake.execFileSync;
  const execFileSync = (cmd, args = []) => {
    if (cmd === 'codex' && args[1] === 'add') throw new Error('boom');
    return orig(cmd, args);
  };
  try {
    await assert.rejects(() => installGlobal(opts(tmp, fake, { execFileSync })), /boom/);
    assert.equal(await readFile(claudeFile, 'utf8'), '# original claude\n');
    assert.equal(existsSync(path.join(configDir, 'mcp_config.json')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('idempotent + uninstall preserves unrelated content', async () => {
  const tmp = path.join('/tmp', `rl-idem-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  await mkdir(configDir, { recursive: true });
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await writeFile(claudeFile, '# keep\n');
  await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2));
  const fake = makeFrontendExec();
  try {
    await installGlobal(opts(tmp, fake));
    await installGlobal(opts(tmp, fake));
    assert.equal(occurrences(await readFile(claudeFile, 'utf8'), BEGIN), 1);

    const removed = await uninstallGlobal({ configDir, homeDir: tmp, execFileSync: fake.execFileSync });
    assert.equal(removed.removedAgyMcp, true);
    assert.equal(removed.removedClaudePolicy, true);
    const config = JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'));
    assert.deepEqual(config.mcpServers.other, { command: 'x', args: [] });
    assert.match(await readFile(claudeFile, 'utf8'), /keep/);
    assert.doesNotMatch(await readFile(claudeFile, 'utf8'), /REVIEWLOOP-GLOBAL-POLICY/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
