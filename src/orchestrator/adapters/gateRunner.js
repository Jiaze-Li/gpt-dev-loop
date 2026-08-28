// Gate Runner Adapter — docs/workflow/ADAPTER_INTERFACE.md §3:
// run(verification_commands) -> evidence (pass/fail per command plus raw
// output, per STATE_MACHINE.md §1 VERIFYING).
//
// Runs each verification command through a shell, then hands the resulting
// pass/fail summary to the Git Evidence Collector
// (src/adapters/gate/git-evidence/index.js) as `testResults`, so the single
// `evidence` object the Workflow Manager threads from VERIFYING into
// REVIEWING already carries both the gate outcome and the git diff/
// repository context the Reviewer Adapter's renderEvidence reads. The core
// Workflow Manager never imports this file — per ADAPTER_INTERFACE.md §4 it
// only knows the `run(verification_commands) -> evidence` signature; wiring
// a real gate runner in is the caller's job.

import { spawn as nodeSpawn } from 'node:child_process';

function runShellCommand(command, { cwd, env, spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];

    child.on('error', (err) => reject(err));
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

export function createGateRunner({ gitEvidenceCollector, cwd = process.cwd(), env = process.env, spawn = nodeSpawn, baseline = null } = {}) {
  return {
    async run(verificationCommands) {
      const commands = verificationCommands ?? [];
      const results = [];
      for (const command of commands) {
        const { code, stdout, stderr } = await runShellCommand(command, { cwd, env, spawn });
        const pass = code === 0;
        const raw = (stdout + stderr).trim() || (pass ? 'ok' : `exit code ${code}`);
        const output = raw.length > 4000
          ? `${raw.slice(0, 2000)}\n...[truncated ${raw.length - 4000} chars]...\n${raw.slice(-2000)}`
          : raw;
        results.push({ command, pass, output });
      }

      const testResults = { pass: results.every((result) => result.pass), results };
      return gitEvidenceCollector.collect_evidence({ cwd, testResults, baseline });
    },
  };
}
