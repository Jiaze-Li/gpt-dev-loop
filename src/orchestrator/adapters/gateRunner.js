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
//
// Cancellation: a verification command can be arbitrarily long-running or
// hung. `run()` takes an AbortSignal and OWNS every shell process it spawns.
// Teardown uses the same process-group primitive as Executor adapters and does
// not complete merely because the shell leader exits: all descendants must be
// gone before cancellation is acknowledged.

import { spawn as nodeSpawn } from 'node:child_process';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../processTree.js';

export class GateCancelledError extends Error {
  constructor(message = 'gate verification cancelled') {
    super(message);
    this.name = 'GateCancelledError';
    this.code = 'GATE_CANCELLED';
  }
}

function runShellCommand(command, { cwd, env, spawn, signal, killGraceMs = 2000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GateCancelledError());
      return;
    }

    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...PROCESS_GROUP_SPAWN_OPTS,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let treeTermination = null;
    let onAbort = null;

    const tearDownTree = () => {
      if (!treeTermination) {
        treeTermination = terminateProcessTree(child, { graceMs: killGraceMs });
      }
      return treeTermination;
    };

    const cleanup = () => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const finish = async (fn, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (awaitTree && treeTermination) await treeTermination.done;
      fn();
    };

    onAbort = () => {
      if (settled) return;
      try { tearDownTree(); } catch {}
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      void finish(() => reject(err), { awaitTree: Boolean(signal?.aborted) });
    });
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('close', (code, closeSignal) => {
      void finish(
        () => {
          if (signal?.aborted) {
            reject(new GateCancelledError(`gate command terminated by cancellation (${closeSignal || code})`));
            return;
          }
          resolve({
            code,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          });
        },
        { awaitTree: Boolean(signal?.aborted) }
      );
    });
  });
}

export function createGateRunner({
  gitEvidenceCollector,
  cwd = process.cwd(),
  env = process.env,
  spawn = nodeSpawn,
  baseline = null,
  signal = null,
} = {}) {
  return {
    async run(verificationCommands, { signal: runSignal = signal } = {}) {
      const commands = verificationCommands ?? [];
      const results = [];
      for (const command of commands) {
        if (runSignal?.aborted) throw new GateCancelledError();
        const { code, stdout, stderr } = await runShellCommand(command, { cwd, env, spawn, signal: runSignal });
        const pass = code === 0;
        const raw = (stdout + stderr).trim() || (pass ? 'ok' : `exit code ${code}`);
        const output = raw.length > 4000
          ? `${raw.slice(0, 2000)}\n...[truncated ${raw.length - 4000} chars]...\n${raw.slice(-2000)}`
          : raw;
        results.push({ command, pass, output });
      }

      if (runSignal?.aborted) throw new GateCancelledError();
      const testResults = { pass: results.every((result) => result.pass), results };
      return gitEvidenceCollector.collect_evidence({ cwd, testResults, baseline });
    },
  };
}
