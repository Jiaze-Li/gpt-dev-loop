#!/usr/bin/env node
// ReviewLoop human CLI.
//
//   reviewloop doctor       zero-token prerequisite + repo-invariant check
//   reviewloop status       list local ReviewLoop sessions and their state
//   reviewloop install      install/refresh the global ReviewLoop policy + MCP
//   reviewloop uninstall    remove the global ReviewLoop integration
//
// The agent-facing surface is the MCP server (reviewloop_begin /
// reviewloop_review) — not this CLI.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runDoctor } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';

async function listSessions() {
  const root = REVIEWLOOP_RUNTIME_ROOT;
  if (!existsSync(root)) {
    console.log('No ReviewLoop sessions found.');
    return;
  }
  const dirs = await readdir(root).catch(() => []);
  let found = 0;
  for (const d of dirs) {
    const stateFile = path.join(root, d, 'workflow.json');
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      const loop = state.reviewLoop;
      if (!loop) continue;
      found += 1;
      console.log(`  ${loop.loopId}  ${loop.state}  round=${loop.round ?? 0}  reviewer=${loop.reviewerCalls ?? 0} supervisor=${loop.supervisorCalls ?? 0}`);
    } catch { /* skip */ }
  }
  if (!found) console.log('No ReviewLoop sessions found.');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'doctor': {
      const report = runDoctor();
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case 'status':
      await listSessions();
      break;
    case 'install': {
      const res = await installGlobal();
      console.log('ReviewLoop installed globally.');
      console.log(`  MCP server: ${res.mcpBin}`);
      break;
    }
    case 'uninstall':
      await uninstallGlobal();
      console.log('ReviewLoop global integration removed.');
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log('usage: reviewloop <doctor|status|install|uninstall>');
      break;
    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
