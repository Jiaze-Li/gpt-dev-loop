// ReviewLoop deterministic Gate.
//
//   Gate model tokens = 0
//
// The Gate is independent verification evidence. It does NOT tell the Worker
// which commands the Worker may run — the Worker uses its host's normal
// permissions. The Gate only runs a small, trusted, deterministic command set
// and reports PASS / FAIL with a fingerprint.
//
// Verification discovery priority (§9):
//   1. explicit trusted/user configuration (objective.verificationCommands)
//   2. ReviewLoop repo config (.reviewloop.json "verify")
//   3. deterministic manifest discovery (package.json "test" script)
//   4. minimal mechanical checks (git diff --check)

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { collectFailureIdentities } from '../orchestrator/gateFailureIdentity.js';
import { diffBaselineFailures, BASELINE_DIFF_VERDICTS } from '../orchestrator/baselineDiffGate.js';

export const GATE_VERDICTS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN' });

export function discoverVerificationCommands({ cwd, configured = null } = {}) {
  if (Array.isArray(configured) && configured.length) {
    return { source: 'configured', commands: configured.map(String) };
  }
  const repoConfig = path.join(cwd, '.reviewloop.json');
  if (existsSync(repoConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(repoConfig, 'utf8'));
      const verify = parsed?.verify ?? parsed?.verification_commands;
      if (Array.isArray(verify) && verify.length) {
        return { source: 'repo-config', commands: verify.map(String) };
      }
    } catch {
      /* fall through to manifest discovery */
    }
  }
  const pkgPath = path.join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg?.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
        return { source: 'package.json', commands: ['npm test'] };
      }
    } catch {
      /* fall through */
    }
  }
  // Minimal mechanical check — never invents a dangerous command.
  return { source: 'mechanical', commands: ['git diff --check'] };
}

function runCommand(command, cwd, spawn) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ command, exitCode: 127, stdout: '', stderr: String(e?.message ?? e) }));
    child.on('close', (code) => resolve({
      command,
      exitCode: code ?? 0,
      stdout: Buffer.concat(out).toString('utf8').slice(0, 200_000),
      stderr: Buffer.concat(err).toString('utf8').slice(0, 200_000),
    }));
  });
}

// Run the discovered commands. `runner` is injectable for deterministic tests.
export async function runGate({
  cwd,
  commands,
  spawn = nodeSpawn,
  runner = null,
  baselineGateEvidence = null,
} = {}) {
  const exec = runner
    ? (cmd) => runner(cmd, cwd)
    : (cmd) => runCommand(cmd, cwd, spawn);

  const results = [];
  for (const command of commands) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await exec(command));
  }
  const rawPass = results.every((r) => (r.exitCode ?? 0) === 0);
  const evidence = { results, pass: rawPass };
  const failureIdentities = collectFailureIdentities(evidence);
  const fingerprint = failureIdentities.length
    ? failureIdentities.slice().sort().join('|')
    : `pass:${commands.join(',')}`;

  let verdict = rawPass ? GATE_VERDICTS.PASS : GATE_VERDICTS.FAIL;
  let baselineDiff = null;
  if (!rawPass && baselineGateEvidence) {
    baselineDiff = diffBaselineFailures(baselineGateEvidence, evidence);
    // Only newly-introduced failures are a real regression; pre-existing repo
    // red tests degrade FAIL to WARN (V2 baseline-diff gate lesson).
    if (baselineDiff.verdict === BASELINE_DIFF_VERDICTS.NO_NEW_FAILURES) {
      verdict = GATE_VERDICTS.WARN;
    }
  }

  return {
    verdict,
    pass: verdict === GATE_VERDICTS.PASS,
    fingerprint,
    failureIdentities,
    results: results.map((r) => ({
      command: r.command,
      exitCode: r.exitCode,
      // keep tails only — full output persists locally, not echoed to Worker
      stdoutTail: String(r.stdout ?? '').slice(-2000),
      stderrTail: String(r.stderr ?? '').slice(-2000),
    })),
    baselineDiff,
    commandSource: null,
  };
}
