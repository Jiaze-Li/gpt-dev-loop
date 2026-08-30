// Tests for scripts/doctor.js — deterministic prerequisite checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  checkGit,
  checkNode,
  checkAgy,
  checkClaude,
  checkCodex,
  runDoctor,
} from '../scripts/doctor.js';

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

test('runDoctor requires AGY, Claude, and Codex symmetrically', () => {
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
  });
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report.results).sort(), ['agy', 'claude', 'codex', 'git', 'node']);
  assert.ok(lines.includes('doctor: all prerequisites satisfied'));
});

test('runDoctor fails when any supported frontend is unavailable', () => {
  for (const missing of ['agy', 'claude', 'codex']) {
    const commands = {
      'git --version': 'git version 2.42.0',
      'agy --version': 'agy 1',
      'claude --version': 'claude 1',
      'codex --version': 'codex 1',
    };
    commands[`${missing} --version`] = new Error(`${missing} missing`);
    const report = runDoctor({ execSync: fakeExec(commands), log: () => {}, env: {} });
    assert.equal(report.ok, false);
    assert.equal(report.results[missing].ok, false);
  }
});

test('package.json defines the doctor script', () => {
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.scripts.doctor, 'node ./scripts/doctor.js');
});
