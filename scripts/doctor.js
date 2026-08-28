#!/usr/bin/env node
// doctor — verify the prerequisites the dev loop needs are installed and
// runnable: git, node, agy, and claude.
//
//   node scripts/doctor.js
//
// Exits 0 when every prerequisite is satisfied, non-zero otherwise.
//
// Every check is a small pure function that takes its dependencies by
// argument so it can be exercised in isolation. runDoctor() wires them
// together and accepts { execSync, log, env } for the same reason.

import { execSync as nodeExecSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Run `<command>` and return its trimmed stdout, or throw. Kept tiny so the
// individual checks stay declarative.
function probe(execSync, command) {
  return String(execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

export function checkGit({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'git', ok: true, version: probe(exec, 'git --version') };
  } catch (err) {
    return { name: 'git', ok: false, error: err.message };
  }
}

// node is the runtime already executing this file, so the authoritative
// answer is process.version — no child process needed.
export function checkNode({ env } = {}) {
  const version = (env && env.npm_config_node_version) || process.version;
  return { name: 'node', ok: Boolean(version), version };
}

export function checkAgy({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'agy', ok: true, version: probe(exec, 'agy --version') };
  } catch (err) {
    return { name: 'agy', ok: false, error: err.message };
  }
}

export function checkClaude({ execSync } = {}) {
  const exec = execSync || nodeExecSync;
  try {
    return { name: 'claude', ok: true, version: probe(exec, 'claude --version') };
  } catch (err) {
    return { name: 'claude', ok: false, error: err.message };
  }
}

// Run every check and fold the results into a single report.
export function runDoctor({ execSync, log, env } = {}) {
  const exec = execSync || nodeExecSync;
  const write = log || console.log;
  const environment = env || process.env;

  const results = [
    checkGit({ execSync: exec }),
    checkNode({ env: environment }),
    checkAgy({ execSync: exec }),
    checkClaude({ execSync: exec }),
  ];

  const ok = results.every((r) => r.ok);

  for (const r of results) {
    if (r.ok) {
      write(`  ok    ${r.name}${r.version ? ` (${r.version})` : ''}`);
    } else {
      write(`  FAIL  ${r.name}: ${r.error || 'not found'}`);
    }
  }
  write(ok ? 'doctor: all prerequisites satisfied' : 'doctor: missing prerequisites');

  return {
    ok,
    status: ok ? 'pass' : 'fail',
    results: Object.fromEntries(results.map((r) => [r.name, r])),
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const report = runDoctor();
  process.exit(report.ok ? 0 : 1);
}
