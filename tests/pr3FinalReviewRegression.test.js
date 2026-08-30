import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';
import { WorkflowLifecycleManager, isSuperGptOwnedWorktree } from '../src/orchestrator/workflowLifecycle.js';
import { installGlobal } from '../bin/install-plugin.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commonPolicy = path.join(repoRoot, 'agent-policy', 'COMMON.md');

test('P1 final review: CLI wait without --status does not accept RUNNING and returns only after terminal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supergpt-cli-wait-final-'));
  const root = path.join(home, '.supergpt', 'worktrees');
  const workflowId = 'wf-cli-wait-final';
  await mkdir(root, { recursive: true });
  const manager = new WorkflowStateManager({ workflowId, root });
  manager.startStage('INIT');

  try {
    const bin = path.join(repoRoot, 'bin', 'supergpt.js');
    const env = { ...process.env, HOME: home };
    const running = spawnSync(process.execPath, [bin, 'wait', workflowId, '--timeout=120', '--output-format=json'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(running.status, 0, 'default wait must not return success for RUNNING');

    manager.transitionTerminal('DONE', { summary: 'done' });
    const done = spawnSync(process.execPath, [bin, 'wait', workflowId, '--timeout=1000', '--output-format=json'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).workflowStatus, 'DONE');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('P2 final review: lifecycle accepts the exact worktree produced for any validated hand-authored workflow ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supergpt-custom-id-final-'));
  const workflowId = 'my-workflow_123';
  const worktreePath = path.join(root, `repo-${workflowId}`);
  await mkdir(worktreePath, { recursive: true });
  try {
    assert.equal(isSuperGptOwnedWorktree(worktreePath, root, workflowId), true);
    assert.equal(isSuperGptOwnedWorktree(path.join(root, 'repo-other-id'), root, workflowId), false);
    const manager = new WorkflowLifecycleManager({ workflowId, root });
    assert.doesNotThrow(() => manager.trackWorktree(worktreePath));
    assert.equal(manager.resources.worktrees[0].path, worktreePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P2 final review: failed global update restores every prior frontend config/policy byte-for-byte', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supergpt-install-rollback-final-'));
  const configDir = path.join(home, '.gemini', 'config');
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const agyPolicyFile = path.join(configDir, 'skills', 'supergpt', 'SKILL.md');
  const claudePolicyFile = path.join(home, '.claude', 'CLAUDE.md');
  const codexPolicyFile = path.join(home, '.codex', 'AGENTS.md');
  const claudeMcpConfigFile = path.join(home, '.claude.json');
  const codexMcpConfigFile = path.join(home, '.codex', 'config.toml');

  const old = {
    agyConfig: `${JSON.stringify({ mcpServers: { supergpt: { command: '/old/node', args: ['/old/mcp'] }, other: { command: 'keep' } } }, null, 2)}\n`,
    agyPolicy: 'old agy policy\n',
    claudePolicy: '# old Claude policy\n',
    claudeMcp: '{"mcpServers":{"supergpt":{"command":"/old/claude"}}}\n',
    codexMcp: '[mcp_servers.supergpt]\ncommand = "/old/codex"\n',
  };

  await mkdir(path.dirname(agyPolicyFile), { recursive: true });
  await mkdir(path.dirname(claudePolicyFile), { recursive: true });
  await mkdir(path.dirname(codexMcpConfigFile), { recursive: true });
  await writeFile(mcpConfigFile, old.agyConfig);
  await writeFile(agyPolicyFile, old.agyPolicy);
  await writeFile(claudePolicyFile, old.claudePolicy);
  await writeFile(claudeMcpConfigFile, old.claudeMcp);
  await writeFile(codexMcpConfigFile, old.codexMcp);

  const execFileSync = (command, args = []) => {
    if (args[0] === '--version') return `${command} test-version\n`;
    if ((command === 'claude' || command === 'codex') && args[0] === 'mcp') {
      const action = args[1];
      const configFile = command === 'claude' ? claudeMcpConfigFile : codexMcpConfigFile;
      if (action === 'remove') {
        writeFileSync(configFile, `${command}-removed\n`);
        return 'removed\n';
      }
      if (action === 'add') {
        writeFileSync(configFile, `${command}-new\n`);
        if (command === 'codex') {
          // Make the final policy target unreadable as a file only after the
          // installer has snapshotted the prior frontend state.
          mkdirSync(codexPolicyFile, { recursive: true });
        }
        return 'added\n';
      }
      if (action === 'get') return 'configured\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await assert.rejects(() => installGlobal({
      configDir,
      homeDir: home,
      policyFile: commonPolicy,
      mcpBin: '/new/supergpt-mcp.js',
      nodeBin: '/new/node',
      execFileSync,
    }));

    assert.equal(await readFile(mcpConfigFile, 'utf8'), old.agyConfig);
    assert.equal(await readFile(agyPolicyFile, 'utf8'), old.agyPolicy);
    assert.equal(await readFile(claudePolicyFile, 'utf8'), old.claudePolicy);
    assert.equal(await readFile(claudeMcpConfigFile, 'utf8'), old.claudeMcp);
    assert.equal(await readFile(codexMcpConfigFile, 'utf8'), old.codexMcp);
    assert.equal(existsSync(codexPolicyFile), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
