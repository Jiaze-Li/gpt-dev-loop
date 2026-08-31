// Tests for scripts/doctor.js — deterministic prerequisite checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkGit,
  checkNode,
  checkAgy,
  checkClaude,
  checkCodex,
  checkGlobalPolicy,
  runDoctor,
} from '../scripts/doctor.js';
import { installGlobal } from '../bin/install-plugin.js';

const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));

function frontendExec() {
  const mcp = { claude: false, codex: false };
  return (command, args = []) => {
    if (args[0] === '--version') return `${command} test\n`;
    if ((command === 'claude' || command === 'codex') && args[0] === 'mcp') {
      const action = args[1];
      if (action === 'add') { mcp[command] = true; return 'added\n'; }
      if (action === 'remove') { if (!mcp[command]) throw new Error('not configured'); mcp[command] = false; return 'removed\n'; }
      if (action === 'get') { if (!mcp[command]) throw new Error('not configured'); return 'ok\n'; }
    }
    throw new Error(`unexpected: ${command} ${args.join(' ')}`);
  };
}

// Builds an isolated fake home with a full, valid global install.
async function freshGlobalHome(tag) {
  const home = path.join('/tmp', `supergpt-doctor-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(home, '.gemini', 'config');
  await installGlobal({
    configDir,
    homeDir: home,
    policyFile: COMMON,
    mcpBin: '/opt/supergpt/bin/supergpt-mcp.js',
    nodeBin: '/usr/bin/node',
    execFileSync: frontendExec(),
  });
  return { home, configDir, policyOptions: { homeDir: home, configDir, policyFile: COMMON } };
}

const OK_EXEC = () => fakeExec({
  'git --version': 'git version 2.42.0',
  'agy --version': 'agy 1',
  'claude --version': 'claude 1',
  'codex --version': 'codex 1',
});

function fakeExec(map) {
  return (command) => {
    if (Object.prototype.hasOwnProperty.call(map, command)) {
      const value = map[command];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`command not found: ${command}`);
  };
}

test('individual frontend prerequisite checks report versions', () => {
  assert.deepEqual(checkAgy({ execSync: fakeExec({ 'agy --version': 'agy 1\n' }) }), {
    name: 'agy', ok: true, version: 'agy 1',
  });
  assert.deepEqual(checkClaude({ execSync: fakeExec({ 'claude --version': 'claude 1\n' }) }), {
    name: 'claude', ok: true, version: 'claude 1',
  });
  assert.deepEqual(checkCodex({ execSync: fakeExec({ 'codex --version': 'codex 1\n' }) }), {
    name: 'codex', ok: true, version: 'codex 1',
  });
});

test('checkGit and checkNode report local runtime prerequisites', () => {
  assert.deepEqual(checkGit({ execSync: fakeExec({ 'git --version': 'git version 2.42.0\n' }) }), {
    name: 'git', ok: true, version: 'git version 2.42.0',
  });
  assert.equal(checkNode().ok, true);
  assert.equal(checkNode({ env: { npm_config_node_version: 'v20.11.0' } }).version, 'v20.11.0');
});

test('runDoctor requires AGY, Claude, and Codex symmetrically', async () => {
  const { home, policyOptions } = await freshGlobalHome('symmetric');
  try {
    const lines = [];
    const report = runDoctor({
      execSync: fakeExec({
        'git --version': 'git version 2.42.0',
        'agy --version': 'agy 1',
        'claude --version': 'claude 1',
        'codex --version': 'codex 1',
      }),
      log: (line) => lines.push(line),
      env: {},
      policyOptions,
    });
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.results).sort(), ['agy', 'claude', 'codex', 'git', 'global_policy', 'node']);
    assert.ok(lines.includes('doctor: all prerequisites satisfied'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('runDoctor fails when any supported frontend is unavailable', async () => {
  const { home, policyOptions } = await freshGlobalHome('missing-frontend');
  try {
    for (const missing of ['agy', 'claude', 'codex']) {
      const commands = {
        'git --version': 'git version 2.42.0',
        'agy --version': 'agy 1',
        'claude --version': 'claude 1',
        'codex --version': 'codex 1',
      };
      commands[`${missing} --version`] = new Error(`${missing} missing`);
      const report = runDoctor({ execSync: fakeExec(commands), log: () => {}, env: {}, policyOptions });
      assert.equal(report.ok, false);
      assert.equal(report.results[missing].ok, false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkGlobalPolicy passes only for a full COMMON-sourced install', async () => {
  const { home, configDir, policyOptions } = await freshGlobalHome('full');
  try {
    const res = checkGlobalPolicy(policyOptions);
    assert.equal(res.ok, true);
    for (const f of ['claude', 'codex', 'agy']) assert.equal(res.frontends[f].ok, true, f);
    assert.equal(res.agyMcp.ok, true);
    assert.equal(res.agySkill.ok, true);

    // All three auto-loaded targets carry byte-identical COMMON content.
    const common = (await readFile(COMMON, 'utf8')).trim();
    for (const rel of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) {
      const text = await readFile(path.join(home, rel), 'utf8');
      const start = text.indexOf('BEGIN -->') + 'BEGIN -->'.length;
      const end = text.indexOf('<!-- SUPERGPT-GLOBAL-POLICY:END');
      assert.equal(text.slice(start, end).trim(), common, rel);
    }
    assert.ok(existsSync(path.join(configDir, 'mcp_config.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkGlobalPolicy distinguishes missing file, missing block, stale/corrupt content, and AGY MCP loss', async () => {
  const { home, configDir, policyOptions } = await freshGlobalHome('degraded');
  const claudeFile = path.join(home, '.claude', 'CLAUDE.md');
  const codexFile = path.join(home, '.codex', 'AGENTS.md');
  const geminiFile = path.join(home, '.gemini', 'GEMINI.md');
  const common = (await readFile(COMMON, 'utf8')).trim();
  try {
    // Missing file — existence is never assumed to mean installed.
    await rm(claudeFile, { force: true });
    assert.equal(checkGlobalPolicy(policyOptions).frontends.claude.reason, 'missing-file');

    // File present but no managed block.
    await writeFile(claudeFile, '# just user notes\n');
    assert.equal(checkGlobalPolicy(policyOptions).frontends.claude.reason, 'missing-block');

    // Stale / forged content.
    await writeFile(codexFile, '<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->\nnot the policy\n<!-- SUPERGPT-GLOBAL-POLICY:END -->\n');
    assert.equal(checkGlobalPolicy(policyOptions).frontends.codex.reason, 'stale-content');

    // Duplicate / corrupt markers.
    await writeFile(geminiFile, `<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->\n${common}\n<!-- SUPERGPT-GLOBAL-POLICY:END -->\n\n<!-- SUPERGPT-GLOBAL-POLICY:BEGIN -->\n${common}\n<!-- SUPERGPT-GLOBAL-POLICY:END -->\n`);
    assert.equal(checkGlobalPolicy(policyOptions).frontends.agy.reason, 'corrupt-block');

    // AGY MCP registration lost.
    await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    const res = checkGlobalPolicy(policyOptions);
    assert.equal(res.agyMcp.ok, false);
    assert.equal(res.agyMcp.reason, 'not-registered');
    assert.equal(res.ok, false);
    assert.ok(res.issues.length >= 4);

    // doctor surfaces the degraded policy as a non-fatal diagnostic warning:
    // core prerequisites pass, so the overall report still succeeds.
    const lines = [];
    const report = runDoctor({ execSync: OK_EXEC(), log: (l) => lines.push(l), env: {}, policyOptions });
    assert.equal(report.ok, true);
    assert.equal(report.results.global_policy.ok, false);
    assert.ok(lines.some((l) => l.includes('warn  global_policy')));
    assert.ok(!lines.some((l) => l.includes('FAIL  global_policy')));
    assert.ok(lines.includes('doctor: all prerequisites satisfied'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('runDoctor treats a missing global policy as a non-fatal diagnostic', async () => {
  const { home, policyOptions } = await freshGlobalHome('policy-missing');
  try {
    await rm(path.join(home, '.claude', 'CLAUDE.md'), { force: true });
    await rm(path.join(home, '.codex', 'AGENTS.md'), { force: true });
    await rm(path.join(home, '.gemini', 'GEMINI.md'), { force: true });
    const lines = [];
    const report = runDoctor({ execSync: OK_EXEC(), log: (l) => lines.push(l), env: {}, policyOptions });
    assert.equal(report.ok, true);
    assert.equal(report.status, 'pass');
    assert.equal(report.results.global_policy.ok, false);
    assert.ok(lines.some((l) => l.includes('warn  global_policy')));
    assert.ok(lines.includes('doctor: all prerequisites satisfied'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('runDoctor treats a stale global policy as a non-fatal diagnostic', async () => {
  const { home, policyOptions } = await freshGlobalHome('policy-stale');
  try {
    const bumped = path.join(home, 'COMMON-next.md');
    const common = (await readFile(COMMON, 'utf8')).trim();
    await writeFile(bumped, `${common}\n\n## New Rule\nAdded.\n`);
    const lines = [];
    const report = runDoctor({
      execSync: OK_EXEC(),
      log: (l) => lines.push(l),
      env: {},
      policyOptions: { ...policyOptions, policyFile: bumped },
    });
    assert.equal(report.ok, true);
    assert.equal(report.results.global_policy.ok, false);
    assert.ok(lines.some((l) => l.includes('warn  global_policy') && l.includes('stale-content')));
    assert.ok(lines.includes('doctor: all prerequisites satisfied'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('checkGlobalPolicy upgrades: block matching an old COMMON is reported stale', async () => {
  const { home, policyOptions } = await freshGlobalHome('upgrade');
  try {
    const bumped = path.join(home, 'COMMON-next.md');
    const common = (await readFile(COMMON, 'utf8')).trim();
    await writeFile(bumped, `${common}\n\n## New Rule\nAdded.\n`);
    const res = checkGlobalPolicy({ ...policyOptions, policyFile: bumped });
    for (const f of ['claude', 'codex', 'agy']) assert.equal(res.frontends[f].reason, 'stale-content', f);
    assert.equal(res.ok, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('package.json defines the doctor script', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.scripts.doctor, 'node ./scripts/doctor.js');
});
