import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  installGlobal,
  uninstallGlobal,
  checkGlobalStatus,
} from '../bin/install-plugin.js';

const MANAGED_BEGIN = '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->';

function occurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

test('installGlobal: registers AGY MCP/skill and installs one shared policy for Claude and Codex', async () => {
  const tmpConfig = path.join('/tmp', `supergpt-inst-test-${Date.now()}`);
  const tmpSkill = path.join(tmpConfig, 'source-skill.md');
  await mkdir(tmpConfig, { recursive: true });
  await writeFile(tmpSkill, '# SuperGPT Skill Content');

  try {
    const res = await installGlobal({
      configDir: tmpConfig,
      homeDir: tmpConfig,
      mcpBin: '/usr/local/bin/supergpt-mcp',
      sourceSkill: tmpSkill,
    });

    assert.equal(res.success, true);

    const mcpRaw = await readFile(res.mcpConfigFile, 'utf8');
    const mcpConfig = JSON.parse(mcpRaw);
    assert.ok(mcpConfig.mcpServers.supergpt);
    assert.deepEqual(mcpConfig.mcpServers.supergpt.args, ['/usr/local/bin/supergpt-mcp']);

    assert.equal(existsSync(res.skillTargetFile), true);
    const installedSkill = await readFile(res.skillTargetFile, 'utf8');
    assert.match(installedSkill, /Shared front-agent delegation policy/);
    assert.match(installedSkill, /When uncertain, prefer SuperGPT/);

    const claude = await readFile(res.claudePolicyFile, 'utf8');
    const codex = await readFile(res.codexPolicyFile, 'utf8');
    for (const policy of [claude, codex]) {
      assert.match(policy, /When uncertain, prefer SuperGPT/);
      assert.equal(occurrences(policy, MANAGED_BEGIN), 1);
    }
    assert.match(claude, /Claude-specific integration/);
    assert.match(codex, /Codex-specific integration/);

    const status = await checkGlobalStatus({ configDir: tmpConfig, homeDir: tmpConfig });
    assert.equal(status.mcpInstalled, true);
    assert.equal(status.skillInstalled, true);
    assert.equal(status.claudePolicyInstalled, true);
    assert.equal(status.codexPolicyInstalled, true);
    assert.equal(status.configuredBin, '/usr/local/bin/supergpt-mcp');

    const uninst = await uninstallGlobal({ configDir: tmpConfig, homeDir: tmpConfig });
    assert.equal(uninst.success, true);
    assert.equal(uninst.removedFromMcp, true);
    assert.equal(uninst.removedSkill, true);
    assert.equal(uninst.removedClaudePolicy, true);
    assert.equal(uninst.removedCodexPolicy, true);

    const postStatus = await checkGlobalStatus({ configDir: tmpConfig, homeDir: tmpConfig });
    assert.equal(postStatus.mcpInstalled, false);
    assert.equal(postStatus.skillInstalled, false);
    assert.equal(postStatus.claudePolicyInstalled, false);
    assert.equal(postStatus.codexPolicyInstalled, false);
  } finally {
    await rm(tmpConfig, { recursive: true, force: true });
  }
});

test('installer preserves unrelated agent instructions, is idempotent, and fails closed on malformed AGY JSON', async () => {
  const tmp = path.join('/tmp', `supergpt-preserve-${Date.now()}`);
  const skill = path.join(tmp, 'skill.md');
  const claudeFile = path.join(tmp, '.claude', 'CLAUDE.md');
  const codexFile = path.join(tmp, '.codex', 'AGENTS.md');
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await mkdir(path.dirname(codexFile), { recursive: true });
  await writeFile(skill, '# skill');
  await writeFile(claudeFile, '# My Claude preferences\nKeep this line.\n');
  await writeFile(codexFile, '# My Codex preferences\nKeep this too.\n');
  const config = path.join(tmp, 'mcp_config.json');

  try {
    await writeFile(config, JSON.stringify({ arbitrary: { keep: true }, mcpServers: { other: { command: 'other', args: ['x'] } } }, null, 2));
    await installGlobal({ configDir: tmp, homeDir: tmp, mcpBin: '/bin/supergpt', sourceSkill: skill });
    await installGlobal({ configDir: tmp, homeDir: tmp, mcpBin: '/bin/supergpt', sourceSkill: skill });

    const parsed = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(parsed.arbitrary, { keep: true });
    assert.deepEqual(parsed.mcpServers.other, { command: 'other', args: ['x'] });

    const claudeInstalled = await readFile(claudeFile, 'utf8');
    const codexInstalled = await readFile(codexFile, 'utf8');
    assert.match(claudeInstalled, /Keep this line/);
    assert.match(codexInstalled, /Keep this too/);
    assert.equal(occurrences(claudeInstalled, MANAGED_BEGIN), 1);
    assert.equal(occurrences(codexInstalled, MANAGED_BEGIN), 1);

    await uninstallGlobal({ configDir: tmp, homeDir: tmp });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).mcpServers.other, { command: 'other', args: ['x'] });
    assert.match(await readFile(claudeFile, 'utf8'), /Keep this line/);
    assert.doesNotMatch(await readFile(claudeFile, 'utf8'), /SUPERGPT-GLOBAL-POLICY/);
    assert.match(await readFile(codexFile, 'utf8'), /Keep this too/);
    assert.doesNotMatch(await readFile(codexFile, 'utf8'), /SUPERGPT-GLOBAL-POLICY/);

    const malformed = '{ definitely malformed';
    await writeFile(config, malformed);
    await assert.rejects(
      () => installGlobal({ configDir: tmp, homeDir: tmp, mcpBin: '/bin/supergpt', sourceSkill: skill }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(config, 'utf8'), malformed);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('installer copies the current non-blocking SuperGPT skill globally and appends shared routing policy', async () => {
  const tmp = path.join('/tmp', `supergpt-current-skill-${Date.now()}`);
  try {
    const result = await installGlobal({ configDir: tmp, homeDir: tmp, mcpBin: '/bin/supergpt-mcp' });
    const installed = await readFile(result.skillTargetFile, 'utf8');
    assert.match(installed, /supergpt_start\(\{ goal, cwd \}\)/);
    assert.match(installed, /status: "RUNNING", workflowId/);
    assert.match(installed, /supergpt_run/);
    assert.match(installed, /blocking convenience API/i);
    assert.match(installed, /When uncertain, prefer SuperGPT/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
