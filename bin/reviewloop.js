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
import os from 'node:os';
import { existsSync } from 'node:fs';
import { runDoctor } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';
import { REVIEWLOOP_RUNTIME_ROOT } from '../src/reviewloop/runtimeDir.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import {
  resolveRepositoryIdentity,
  readPrLatch,
  grantPrLatchApproval,
  describePrLatch,
  PR_LATCH_STATE_KEY,
} from '../src/reviewloop/prLatch.js';

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

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else { flags[key] = true; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function scanPrLatches() {
  const root = REVIEWLOOP_RUNTIME_ROOT;
  if (!existsSync(root)) return [];
  const dirs = await readdir(root).catch(() => []);
  const out = [];
  for (const d of dirs) {
    if (!d.startsWith('pr-latch-')) continue;
    const f = path.join(root, d, 'workflow.json');
    if (!existsSync(f)) continue;
    try {
      const state = JSON.parse(await readFile(f, 'utf8'));
      const latch = state?.[PR_LATCH_STATE_KEY];
      if (latch) out.push(latch);
    } catch { /* skip */ }
  }
  return out;
}

async function prLatchCommand(rest) {
  const [sub, ...subRest] = rest;
  const { flags, positional } = parseFlags(subRest);

  if (!sub || sub === 'status') {
    if (positional.length === 0 && !flags.repo && !flags.pr) {
      const all = await scanPrLatches();
      if (!all.length) { console.log('No PR HUMAN_REQUIRED latches.'); return 0; }
      for (const latch of all) {
        console.log(`  PR #${latch.prNumber}  (${latch.repositoryIdentity})`);
        console.log(`    ${describePrLatch(latch)}`);
      }
      return 0;
    }
    const prNumber = Number(flags.pr ?? positional[0]);
    if (!Number.isInteger(prNumber)) { console.error('pr-latch status <prNumber>'); return 1; }
    const repositoryIdentity = flags.repo
      ? String(flags.repo)
      : await resolveRepositoryIdentity({ cwd: process.cwd() });
    const latch = await readPrLatch(new Persistence(REVIEWLOOP_RUNTIME_ROOT), { repositoryIdentity, prNumber });
    if (!latch) {
      console.log(`No latch for PR #${prNumber} (${repositoryIdentity}).`);
      return 0;
    }
    console.log(`PR #${prNumber}  (${repositoryIdentity})`);
    console.log(`  ${describePrLatch(latch)}`);
    console.log(`  reason: ${latch.reason}`);
    return 0;
  }

  if (sub === 'approve') {
    const prNumber = Number(flags.pr ?? positional[0]);
    if (!Number.isInteger(prNumber)) { console.error('usage: reviewloop pr-latch approve <prNumber> [--repo <identity>] [--note <text>]'); return 1; }
    const repositoryIdentity = flags.repo
      ? String(flags.repo)
      : await resolveRepositoryIdentity({ cwd: process.cwd() });
    const approvedBy = String(flags.by ?? os.userInfo().username ?? process.env.USER ?? 'unknown');
    const note = typeof flags.note === 'string' ? flags.note : null;
    const res = await grantPrLatchApproval(new Persistence(REVIEWLOOP_RUNTIME_ROOT), {
      repositoryIdentity, prNumber, approvedBy, note,
    });
    if (!res.ok) {
      console.error(`Cannot approve: ${res.reason}`);
      return 1;
    }
    console.log(`Approved one fresh ReviewLoop budget for PR #${prNumber} (${repositoryIdentity}).`);
    console.log(`  approvalId: ${res.approvalId}`);
    console.log(`  approvedBy: ${approvedBy}`);
    console.log('  The next reviewloop_begin for this PR will consume it. If that loop also exhausts its rounds, the PR re-latches.');
    return 0;
  }

  console.error('usage: reviewloop pr-latch <status|approve>');
  return 1;
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
    case 'pr-latch': {
      const code = await prLatchCommand(rest);
      process.exit(code ?? 0);
      break;
    }
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
      console.log('usage: reviewloop <doctor|status|install|uninstall|pr-latch>');
      console.log('       reviewloop pr-latch status [<prNumber> [--repo <identity>]]');
      console.log('       reviewloop pr-latch approve <prNumber> [--repo <identity>] [--note <text>]');
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
