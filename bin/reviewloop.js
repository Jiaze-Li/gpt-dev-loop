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
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { Persistence } from '../src/orchestrator/persistence.js';
import {
  resolveRepositoryIdentity,
  readPrLatch,
  attachSignedApproval,
  signApproval,
  trustedApproverKeys,
  approverKeyId,
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

  if (sub === 'keygen') {
    const out = typeof flags.out === 'string' ? flags.out : path.join(REVIEWLOOP_RUNTIME_ROOT, 'approver.key');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    writeFileSync(out, privPem, { mode: 0o600 });
    try { chmodSync(out, 0o600); } catch { /* best effort */ }
    console.log('Generated an Ed25519 ReviewLoop approver keypair.');
    console.log(`  private key: ${out}   (mode 0600)`);
    console.log(`  key id:      ${approverKeyId(spkiB64)}`);
    console.log('');
    console.log('  IMPORTANT: move the private key somewhere the coding agent cannot read');
    console.log('  (a password manager, another machine, a hardware token wrapper). If it');
    console.log('  stays on this box in the agent\'s reach, the latch is not enforceable.');
    console.log('');
    console.log('  Add the PUBLIC key to the ReviewLoop MCP server config env so consume-time');
    console.log('  verification trusts it (this is NOT a file the agent can rewrite):');
    console.log('');
    console.log(`    REVIEWLOOP_APPROVER_PUBKEYS=${spkiB64}`);
    return 0;
  }

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
    const trustedKeys = trustedApproverKeys(process.env);
    const latch = await readPrLatch(new Persistence(REVIEWLOOP_RUNTIME_ROOT), { repositoryIdentity, prNumber });
    if (!latch) {
      console.log(`No latch for PR #${prNumber} (${repositoryIdentity}).`);
      return 0;
    }
    console.log(`PR #${prNumber}  (${repositoryIdentity})`);
    console.log(`  ${describePrLatch(latch, { trustedKeys, repositoryIdentity, prNumber })}`);
    console.log(`  reason: ${latch.reason}`);
    console.log(`  trusted approver keys configured (this shell): ${trustedKeys.size}`);
    return 0;
  }

  if (sub === 'approve') {
    const prNumber = Number(flags.pr ?? positional[0]);
    if (!Number.isInteger(prNumber)) { console.error('usage: reviewloop pr-latch approve <prNumber> --key <private-key.pem> [--repo <identity>] [--note <text>]'); return 1; }
    const keyPath = typeof flags.key === 'string' ? flags.key : null;
    if (!keyPath) {
      console.error('reviewloop pr-latch approve requires --key <private-key.pem>. A signed approval is the only');
      console.error('thing the coding agent cannot forge. Run `reviewloop pr-latch keygen` first if you have no key.');
      return 1;
    }
    let privPem;
    try { privPem = readFileSync(keyPath, 'utf8'); }
    catch (err) { console.error(`cannot read approver key ${keyPath}: ${err?.message ?? err}`); return 1; }

    const repositoryIdentity = flags.repo
      ? String(flags.repo)
      : await resolveRepositoryIdentity({ cwd: process.cwd() });
    const approvedBy = String(flags.by ?? os.userInfo().username ?? process.env.USER ?? 'unknown');
    const note = typeof flags.note === 'string' ? flags.note : null;
    const persistence = new Persistence(REVIEWLOOP_RUNTIME_ROOT);

    const latch = await readPrLatch(persistence, { repositoryIdentity, prNumber });
    if (!latch) { console.error(`No latch for PR #${prNumber} (${repositoryIdentity}).`); return 1; }

    let grant;
    try {
      grant = signApproval(privPem, {
        repositoryIdentity, prNumber,
        exhaustedLoopId: latch.exhaustedLoopId,
        exhaustedHead: latch.exhaustedHead,
        latchCount: latch.latchCount,
      });
    } catch (err) { console.error(`could not sign approval: ${err?.message ?? err}`); return 1; }

    // attachSignedApproval verifies the signature + latch binding before it
    // stores anything. We check against the key we just signed with (derived
    // from the private key). The AUTHORITATIVE trust decision is the MCP
    // server's, at consume time, against ITS REVIEWLOOP_APPROVER_PUBKEYS.
    const selfTrust = trustedApproverKeys({ REVIEWLOOP_APPROVER_PUBKEYS: grant.publicKeySpkiB64 });
    const res = await attachSignedApproval(persistence, {
      repositoryIdentity, prNumber, approval: grant, approvedBy, note, trustedKeys: selfTrust,
    });
    if (!res.ok) { console.error(`Cannot approve: ${res.reason}`); return 1; }

    const shellTrusted = trustedApproverKeys(process.env);
    console.log(`Signed one fresh ReviewLoop budget approval for PR #${prNumber} (${repositoryIdentity}).`);
    console.log(`  approvalId:    ${res.approvalId}`);
    console.log(`  approverKeyId: ${grant.approverKeyId}`);
    console.log(`  approvedBy:    ${approvedBy}`);
    if (shellTrusted.size === 0) {
      console.log('  NOTE: REVIEWLOOP_APPROVER_PUBKEYS is unset here. This approval is only enforceable if the');
      console.log('  running ReviewLoop MCP server was launched with this key id in REVIEWLOOP_APPROVER_PUBKEYS.');
    } else if (!shellTrusted.has(grant.approverKeyId)) {
      console.log(`  WARNING: key ${grant.approverKeyId} is not in this shell's REVIEWLOOP_APPROVER_PUBKEYS — the MCP server may not trust it.`);
    }
    console.log('  The next reviewloop_begin for this PR consumes it if the MCP server trusts this key.');
    console.log('  If that loop also exhausts its rounds, the PR re-latches and needs a new signed approval.');
    return 0;
  }

  console.error('usage: reviewloop pr-latch <status|approve|keygen>');
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
      console.log('       reviewloop pr-latch keygen [--out <path>]');
      console.log('       reviewloop pr-latch status [<prNumber> [--repo <identity>]]');
      console.log('       reviewloop pr-latch approve <prNumber> --key <private-key.pem> [--repo <identity>] [--note <text>]');
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
