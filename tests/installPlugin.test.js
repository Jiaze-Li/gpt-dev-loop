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

test('installGlobal manages a GEMINI.md block from COMMON alongside Claude, Codex, and the AGY skill', async () => {
  const tmp = path.join('/tmp', `supergpt-gemini-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const geminiFile = path.join(tmp, '.gemini', 'GEMINI.md');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  const codexFile = path.join(tmp, '.codex', 'AGENTS.md');
  const userGemini = '# My Gemini notes\nTop matter.\n\n## Footer\nBottom matter.';
  const fake = makeFrontendExec();
  await mkdir(path.dirname(geminiFile), { recursive: true });
  await writeFile(geminiFile, `${userGemini}\n`);

  const opts = {
    configDir,
    homeDir: tmp,
    policyFile: COMMON,
    mcpBin: '/opt/supergpt/bin/supergpt-mcp.js',
    nodeBin: '/usr/bin/node',
    execFileSync: fake.execFileSync,
  };
  const statusOpts = { configDir, homeDir: tmp, policyFile: COMMON, execFileSync: fake.execFileSync };
  const common = (await readFile(COMMON, 'utf8')).trim();

  try {
    const result = await installGlobal(opts);
    assert.equal(result.geminiPolicyFile, geminiFile);

    let gemini = await readFile(geminiFile, 'utf8');
    const claude = await readFile(claudeFile, 'utf8');
    const codex = await readFile(codexFile, 'utf8');
    // Every auto-loaded target carries the exact same COMMON-sourced content.
    assert.equal(managedContent(gemini), common);
    assert.equal(managedContent(gemini), managedContent(claude));
    assert.equal(managedContent(gemini), managedContent(codex));
    // Bytes outside the managed block survive verbatim.
    assert.ok(gemini.includes(userGemini));
    assert.equal(occurrences(gemini, MANAGED_BEGIN), 1);

    // Repeat install is idempotent.
    await installGlobal(opts);
    gemini = await readFile(geminiFile, 'utf8');
    assert.equal(occurrences(gemini, MANAGED_BEGIN), 1);
    assert.ok(gemini.includes(userGemini));

    const status = await checkGlobalStatus(statusOpts);
    assert.equal(status.agy.policyInstalled, true);
    assert.equal(status.agy.policyFile, geminiFile);
    assert.equal(status.agy.skillInstalled, true);
    assert.equal(status.agy.mcpInstalled, true);
    assert.equal(status.claude.policyInstalled, true);
    assert.equal(status.codex.policyInstalled, true);

    // COMMON upgrade replaces the block in place and makes the old content stale.
    const bumped = path.join(tmp, 'COMMON-v2.md');
    await writeFile(bumped, `${common}\n\n## Added Section\nNew rule.\n`);
    await installGlobal({ ...opts, policyFile: bumped });
    gemini = await readFile(geminiFile, 'utf8');
    assert.match(managedContent(gemini), /Added Section/);
    assert.equal(occurrences(gemini, MANAGED_BEGIN), 1);
    assert.ok(gemini.includes(userGemini));

    const stale = await checkGlobalStatus(statusOpts);
    assert.equal(stale.agy.policyInstalled, false);
    assert.equal(stale.agy.policyReason, 'stale-content');
    assert.equal(stale.claude.policyInstalled, false);
    assert.equal(stale.codex.policyInstalled, false);

    // Uninstall drops only the managed block and the AGY MCP entry / skill.
    const removed = await uninstallGlobal({ configDir, homeDir: tmp, execFileSync: fake.execFileSync });
    assert.equal(removed.removedGeminiPolicy, true);
    const finalGemini = await readFile(geminiFile, 'utf8');
    assert.doesNotMatch(finalGemini, /SUPERGPT-GLOBAL-POLICY/);
    assert.ok(finalGemini.includes(userGemini));
    assert.equal(existsSync(path.join(configDir, 'skills', 'supergpt')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('status rejects a GEMINI.md target that only exists or carries a broken/forged block', async () => {
  const tmp = path.join('/tmp', `supergpt-gemini-bad-${Date.now()}`);
  const configDir = path.join(tmp, '.gemini', 'config');
  const geminiFile = path.join(tmp, '.gemini', 'GEMINI.md');
  const fake = makeFrontendExec();
  await mkdir(path.dirname(geminiFile), { recursive: true });
  const common = (await readFile(COMMON, 'utf8')).trim();
  const statusOpts = { configDir, homeDir: tmp, policyFile: COMMON, execFileSync: fake.execFileSync };

  try {
    await writeFile(geminiFile, '');
    assert.equal((await checkGlobalStatus(statusOpts)).agy.policyReason, 'missing-block');

    await writeFile(geminiFile, `${MANAGED_BEGIN}\nnot the real policy\n${MANAGED_END}\n`);
    assert.equal((await checkGlobalStatus(statusOpts)).agy.policyReason, 'stale-content');

    await writeFile(geminiFile, `${MANAGED_BEGIN}\n${common}\n${MANAGED_END}\n\n${MANAGED_BEGIN}\n${common}\n${MANAGED_END}\n`);
    assert.equal((await checkGlobalStatus(statusOpts)).agy.policyReason, 'corrupt-block');

    await writeFile(geminiFile, `dangling tail\n${MANAGED_END}\n`);
    assert.equal((await checkGlobalStatus(statusOpts)).agy.policyReason, 'corrupt-block');

    const s = await checkGlobalStatus(statusOpts);
    assert.equal(s.agy.policyInstalled, false);
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
