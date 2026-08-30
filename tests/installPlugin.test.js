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
} from '../bin/install-plugin.js';

const MANAGED_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';
const MANAGED_END = '<!-- SUPERGPT-GLOBAL-POLICY:END -->';
const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));

function occurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

function makeFrontendExec({ missing = [] } = {}) {
  const calls = [];
  const mcp = { claude: false, codex: false };
  const execFileSync = (command, args = []) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') {
      if (missing.includes(command)) throw new Error(`${command}: command not found`);
      return `${command} test-version\n`;
    }
    if ((command === 'claude' || command === 'codex') && args[0] === 'mcp') {
      const action = args[1];
      if (action === 'add') {
        mcp[command] = true;
        return 'added\n';
      }
      if (action === 'remove') {
        if (!mcp[command]) throw new Error('not configured');
        mcp[command] = false;
        return 'removed\n';
      }
      if (action === 'get') {
        if (!mcp[command]) throw new Error('not configured');
        return 'supergpt configured\n';
      }
    }
    throw new Error(`unexpected command: ${[command, ...args].join(' ')}`);
  };
  return { execFileSync, calls, mcp };
}

function callExists(calls, expected) {
  return calls.some((call) => JSON.stringify(call) === JSON.stringify(expected));
}

function managedContent(text) {
  const start = text.indexOf(MANAGED_BEGIN) + MANAGED_BEGIN.length;
  const end = text.indexOf(MANAGED_END);
  return text.slice(start, end).trim();
}

test('installGlobal gives AGY, Claude, and Codex one shared policy and one MCP server', async () => {
  const tmp = path.join('/tmp', `supergpt-unified-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const fake = makeFrontendExec();
  try {
    const result = await installGlobal({
      configDir,
      homeDir: tmp,
      policyFile: COMMON,
      mcpBin: '/opt/supergpt/bin/supergpt-mcp.js',
      nodeBin: '/usr/bin/node',
      execFileSync: fake.execFileSync,
    });

    assert.equal(result.success, true);
    assert.equal(fake.mcp.claude, true);
    assert.equal(fake.mcp.codex, true);
    assert.ok(callExists(fake.calls, [
      'claude', 'mcp', 'add', 'supergpt', '--scope', 'user', '--', '/usr/bin/node', '/opt/supergpt/bin/supergpt-mcp.js',
    ]));
    assert.ok(callExists(fake.calls, [
      'codex', 'mcp', 'add', 'supergpt', '--', '/usr/bin/node', '/opt/supergpt/bin/supergpt-mcp.js',
    ]));

    const agyConfig = JSON.parse(await readFile(result.mcpConfigFile, 'utf8'));
    assert.deepEqual(agyConfig.mcpServers.supergpt, {
      command: '/usr/bin/node',
      args: ['/opt/supergpt/bin/supergpt-mcp.js'],
    });

    const common = (await readFile(COMMON, 'utf8')).trim();
    const agyPolicy = await readFile(result.agyPolicyFile, 'utf8');
    const claudePolicy = await readFile(result.claudePolicyFile, 'utf8');
    const codexPolicy = await readFile(result.codexPolicyFile, 'utf8');
    assert.match(agyPolicy, /# SuperGPT Front-Agent Contract/);
    assert.ok(agyPolicy.endsWith(`${common}\n`));
    assert.equal(managedContent(claudePolicy), common);
    assert.equal(managedContent(codexPolicy), common);

    const status = await checkGlobalStatus({ configDir, homeDir: tmp, execFileSync: fake.execFileSync });
    for (const frontend of [status.agy, status.claude, status.codex]) {
      assert.equal(frontend.available, true);
      assert.equal(frontend.mcpInstalled, true);
      assert.equal(frontend.policyInstalled, true);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('installer is idempotent and preserves unrelated Claude/Codex instructions and AGY MCP entries', async () => {
  const tmp = path.join('/tmp', `supergpt-preserve-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  const codexFile = path.join(tmp, '.codex', 'AGENTS.md');
  const fake = makeFrontendExec();
  await mkdir(configDir, { recursive: true });
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await mkdir(path.dirname(codexFile), { recursive: true });
  await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify({
    unrelated: { keep: true },
    mcpServers: { other: { command: 'other', args: ['x'] } },
  }, null, 2));
  await writeFile(claudeFile, '# My Claude preferences\nKeep this line.\n');
  await writeFile(codexFile, '# My Codex preferences\nKeep this too.\n');

  try {
    const opts = {
      configDir,
      homeDir: tmp,
      policyFile: COMMON,
      mcpBin: '/bin/supergpt-mcp',
      nodeBin: '/bin/node',
      execFileSync: fake.execFileSync,
    };
    await installGlobal(opts);
    await installGlobal(opts);

    const config = JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'));
    assert.deepEqual(config.unrelated, { keep: true });
    assert.deepEqual(config.mcpServers.other, { command: 'other', args: ['x'] });

    const claude = await readFile(claudeFile, 'utf8');
    const codex = await readFile(codexFile, 'utf8');
    assert.match(claude, /Keep this line/);
    assert.match(codex, /Keep this too/);
    assert.equal(occurrences(claude, MANAGED_BEGIN), 1);
    assert.equal(occurrences(codex, MANAGED_BEGIN), 1);

    const removed = await uninstallGlobal({ configDir, homeDir: tmp, execFileSync: fake.execFileSync });
    assert.equal(removed.removedAgyMcp, true);
    assert.equal(removed.removedClaudeMcp, true);
    assert.equal(removed.removedCodexMcp, true);
    assert.equal(removed.removedAgyPolicy, true);
    assert.equal(removed.removedClaudePolicy, true);
    assert.equal(removed.removedCodexPolicy, true);

    const afterConfig = JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'));
    assert.deepEqual(afterConfig.mcpServers.other, { command: 'other', args: ['x'] });
    assert.match(await readFile(claudeFile, 'utf8'), /Keep this line/);
    assert.doesNotMatch(await readFile(claudeFile, 'utf8'), /SUPERGPT-GLOBAL-POLICY/);
    assert.match(await readFile(codexFile, 'utf8'), /Keep this too/);
    assert.doesNotMatch(await readFile(codexFile, 'utf8'), /SUPERGPT-GLOBAL-POLICY/);
    assert.equal(existsSync(path.join(configDir, 'skills', 'supergpt')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('installer fails before writes or MCP registration when AGY config is malformed', async () => {
  const tmp = path.join('/tmp', `supergpt-malformed-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const fake = makeFrontendExec();
  await mkdir(configDir, { recursive: true });
  const configFile = path.join(configDir, 'mcp_config.json');
  const malformed = '{ definitely malformed';
  await writeFile(configFile, malformed);

  try {
    await assert.rejects(
      () => installGlobal({ configDir, homeDir: tmp, policyFile: COMMON, execFileSync: fake.execFileSync }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(configFile, 'utf8'), malformed);
    assert.equal(fake.calls.some((c) => c.includes('add')), false);
    assert.equal(existsSync(path.join(tmp, '.claude', 'CLAUDE.md')), false);
    assert.equal(existsSync(path.join(tmp, '.codex', 'AGENTS.md')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('installer requires all three frontends before changing configuration', async () => {
  const tmp = path.join('/tmp', `supergpt-missing-client-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const fake = makeFrontendExec({ missing: ['codex'] });
  try {
    await assert.rejects(
      () => installGlobal({ configDir, homeDir: tmp, policyFile: COMMON, execFileSync: fake.execFileSync }),
      /codex --version failed/,
    );
    assert.equal(fake.calls.some((c) => c.includes('add')), false);
    assert.equal(existsSync(path.join(configDir, 'mcp_config.json')), false);
    assert.equal(existsSync(path.join(tmp, '.claude', 'CLAUDE.md')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
