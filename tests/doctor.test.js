// Tests for scripts/doctor.js — the prerequisite checker for the dev loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  checkGit,
  checkNode,
  checkAgy,
  checkClaude,
  runDoctor,
} from '../scripts/doctor.js';

// An execSync stub that returns canned stdout per command, or throws when a
// command is registered as failing.
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

test('checkGit reports ok with trimmed version on success', () => {
  const execSync = fakeExec({ 'git --version': '  git version 2.42.0\n' });
  const result = checkGit({ execSync });
  assert.deepEqual(result, { name: 'git', ok: true, version: 'git version 2.42.0' });
});

test('checkGit reports failure when git is missing', () => {
  const execSync = fakeExec({ 'git --version': new Error('spawn git ENOENT') });
  const result = checkGit({ execSync });
  assert.equal(result.name, 'git');
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test('checkNode reports ok using process.version by default', () => {
  const result = checkNode();
  assert.equal(result.name, 'node');
  assert.equal(result.ok, true);
  assert.equal(result.version, process.version);
});

test('checkNode honours npm_config_node_version override', () => {
  const result = checkNode({ env: { npm_config_node_version: 'v20.11.0' } });
  assert.equal(result.ok, true);
  assert.equal(result.version, 'v20.11.0');
});

test('checkAgy reports ok with version on success', () => {
  const execSync = fakeExec({ 'agy --version': 'agy 0.9.1\n' });
  const result = checkAgy({ execSync });
  assert.deepEqual(result, { name: 'agy', ok: true, version: 'agy 0.9.1' });
});

test('checkAgy reports failure when agy is missing', () => {
  const execSync = fakeExec({ 'agy --version': new Error('not found: agy') });
  const result = checkAgy({ execSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /agy/);
});

test('checkClaude reports ok with version on success', () => {
  const execSync = fakeExec({ 'claude --version': '1.2.3 (Claude Code)\n' });
  const result = checkClaude({ execSync });
  assert.deepEqual(result, {
    name: 'claude',
    ok: true,
    version: '1.2.3 (Claude Code)',
  });
});

test('checkClaude reports failure when claude is missing', () => {
  const execSync = fakeExec({ 'claude --version': new Error('command not found') });
  const result = checkClaude({ execSync });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('runDoctor aggregates a passing report when all prerequisites are present', () => {
  const lines = [];
  const execSync = fakeExec({
    'git --version': 'git version 2.42.0',
    'agy --version': 'agy 0.9.1',
    'claude --version': '1.2.3',
  });
  const report = runDoctor({ execSync, log: (l) => lines.push(l), env: {} });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'pass');
  assert.deepEqual(Object.keys(report.results).sort(), ['agy', 'claude', 'git', 'node', 'repo_mcp_config']);
  assert.equal(report.results.git.ok, true);
  assert.ok(lines.includes('doctor: all prerequisites satisfied'));
});

test('runDoctor aggregates a failing report when prerequisites are missing', () => {
  const lines = [];
  const execSync = fakeExec({
    'git --version': 'git version 2.42.0',
    'agy --version': new Error('spawn agy ENOENT'),
    'claude --version': new Error('spawn claude ENOENT'),
  });
  const report = runDoctor({ execSync, log: (l) => lines.push(l), env: {} });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'fail');
  assert.equal(report.results.git.ok, true);
  assert.equal(report.results.node.ok, true);
  assert.equal(report.results.agy.ok, false);
  assert.equal(report.results.claude.ok, false);
  assert.ok(lines.includes('doctor: missing prerequisites'));
  assert.ok(lines.some((l) => /FAIL\s+agy/.test(l)));
});

test('runDoctor reports fail when every external prerequisite is absent', () => {
  const execSync = fakeExec({
    'git --version': new Error('ENOENT'),
    'agy --version': new Error('ENOENT'),
    'claude --version': new Error('ENOENT'),
  });
  const report = runDoctor({ execSync, log: () => {}, env: {} });
  assert.equal(report.ok, false);
  // node is still satisfied since it is the running runtime.
  assert.equal(report.results.node.ok, true);
  assert.equal(report.results.git.ok, false);
});

test('package.json defines the doctor script', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.scripts.doctor, 'node ./scripts/doctor.js');
});
