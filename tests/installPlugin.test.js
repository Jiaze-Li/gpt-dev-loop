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

test('installGlobal: registers MCP server and copies skill cleanly', async () => {
  const tmpConfig = path.join('/tmp', `supergpt-inst-test-${Date.now()}`);
  const tmpSkill = path.join(tmpConfig, 'source-skill.md');
  await mkdir(tmpConfig, { recursive: true });
  await writeFile(tmpSkill, '# SuperGPT Skill Content');

  try {
    const res = await installGlobal({
      configDir: tmpConfig,
      mcpBin: '/usr/local/bin/supergpt-mcp',
      sourceSkill: tmpSkill,
    });

    assert.equal(res.success, true);

    // Verify mcp_config.json
    const mcpRaw = await readFile(res.mcpConfigFile, 'utf8');
    const mcpConfig = JSON.parse(mcpRaw);
    assert.ok(mcpConfig.mcpServers.supergpt);
    assert.deepEqual(mcpConfig.mcpServers.supergpt.args, ['/usr/local/bin/supergpt-mcp']);

    // Verify skill file
    const skillExists = existsSync(res.skillTargetFile);
    assert.equal(skillExists, true);

    // Check status
    const status = await checkGlobalStatus({ configDir: tmpConfig });
    assert.equal(status.mcpInstalled, true);
    assert.equal(status.skillInstalled, true);
    assert.equal(status.configuredBin, '/usr/local/bin/supergpt-mcp');

    // Uninstall
    const uninst = await uninstallGlobal({ configDir: tmpConfig });
    assert.equal(uninst.success, true);
    assert.equal(uninst.removedFromMcp, true);
    assert.equal(uninst.removedSkill, true);

    const postStatus = await checkGlobalStatus({ configDir: tmpConfig });
    assert.equal(postStatus.mcpInstalled, false);
    assert.equal(postStatus.skillInstalled, false);
  } finally {
    await rm(tmpConfig, { recursive: true, force: true });
  }
});

test('installer preserves unrelated configuration and fails closed on malformed JSON', async () => {
  const tmp = path.join('/tmp', `supergpt-preserve-${Date.now()}`);
  const skill = path.join(tmp, 'skill.md');
  await mkdir(tmp, { recursive: true }); await writeFile(skill, '# skill');
  const config = path.join(tmp, 'mcp_config.json');
  try {
    await writeFile(config, JSON.stringify({ arbitrary: { keep: true }, mcpServers: { other: { command: 'other', args: ['x'] } } }, null, 2));
    await installGlobal({ configDir: tmp, mcpBin: '/bin/supergpt', sourceSkill: skill });
    const parsed = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(parsed.arbitrary, { keep: true });
    assert.deepEqual(parsed.mcpServers.other, { command: 'other', args: ['x'] });
    await uninstallGlobal({ configDir: tmp });
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).mcpServers.other, { command: 'other', args: ['x'] });
    const malformed = '{ definitely malformed'; await writeFile(config, malformed);
    await assert.rejects(() => installGlobal({ configDir: tmp, mcpBin: '/bin/supergpt', sourceSkill: skill }), /Refusing to overwrite/);
    assert.equal(await readFile(config, 'utf8'), malformed);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
