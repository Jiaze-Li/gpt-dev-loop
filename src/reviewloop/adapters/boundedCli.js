// Bounded, non-interactive CLI runner shared by the Codex and Claude Reviewer /
// Supervisor transports.
//
//   - single spawn, argv only (never a shell string -> no injection surface)
//   - hard wall-clock timeout that terminates the whole process group
//   - stdout/stderr captured with a byte cap
//   - NO stdin unless explicitly provided
//
// It does not know about review payloads or provider semantics — the transport
// wrappers own prompt construction, output normalization and failure
// classification. This is deliberately NOT a second retry/failover state
// machine: one attempt, one result or one classified error.

import { spawn as nodeSpawn } from 'node:child_process';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../../orchestrator/processTree.js';

const MAX_CAPTURE_BYTES = 2_000_000;

export const CLI_FAILURE = Object.freeze({
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  QUOTA_EXHAUSTED: 'PROVIDER_QUOTA_EXHAUSTED',
  PROTOCOL_ERROR: 'PROVIDER_PROTOCOL_ERROR',
  TIMEOUT: 'PROVIDER_TIMEOUT',
});

export class CliTransportError extends Error {
  constructor(message, code, { stderr } = {}) {
    super(message);
    this.name = 'CliTransportError';
    this.code = code;
    this.providerFailure = code;
    if (stderr) this.stderr = String(stderr).slice(0, 4000);
  }
}

// Map an exit code + stderr to one of the RETRYABLE provider-failure codes the
// RoleRouter health/quota fallback already understands. Ordering matters:
// auth/quota/rate-limit before the generic protocol-error bucket.
export function classifyCliFailure({ code, stderr = '', spawnErrorCode } = {}) {
  if (spawnErrorCode === 'ENOENT') return CLI_FAILURE.UNAVAILABLE;
  const s = String(stderr).toLowerCase();
  if (/\b(401|403)\b|unauthorized|not logged in|not authenticated|no api key|invalid api key|authentication/.test(s)) {
    return CLI_FAILURE.AUTH_FAILED;
  }
  if (/insufficient[_ ]?quota|over quota|quota exceeded|billing|payment required|402\b/.test(s)) {
    return CLI_FAILURE.QUOTA_EXHAUSTED;
  }
  if (/\b429\b|rate[ _-]?limit|too many requests|overloaded|capacity/.test(s)) {
    return CLI_FAILURE.RATE_LIMITED;
  }
  return CLI_FAILURE.PROTOCOL_ERROR;
}

/**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string,
 *                     timedOut:boolean, spawnErrorCode:string|null, durationMs:number}>}
 */
export async function runBoundedCli({
  executable, args = [], cwd, timeoutMs = 120_000, input = null, env, spawn = nodeSpawn, signal,
}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: env ?? process.env,
        stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...PROCESS_GROUP_SPAWN_OPTS,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnErrorCode: err?.code ?? 'SPAWN_FAILED', durationMs: Date.now() - startedAt });
      return;
    }

    const out = [];
    const errb = [];
    let outN = 0;
    let errN = 0;
    let settled = false;
    let timedOut = false;
    let tree = null;

    const done = async (result, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (awaitTree && tree) { try { await tree.done; } catch { /* ignore */ } }
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    const kill = () => { if (!tree) tree = terminateProcessTree(child); return tree; };
    const onAbort = () => { try { kill(); } catch { /* ignore */ } void done({ code: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8'), timedOut: false, spawnErrorCode: 'ABORTED' }, { awaitTree: true }); };

    const timer = setTimeout(() => {
      timedOut = true;
      try { kill(); } catch { /* ignore */ }
      void done({ code: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8'), timedOut: true, spawnErrorCode: null }, { awaitTree: true });
    }, timeoutMs);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (err) => {
      void done({ code: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8'), timedOut, spawnErrorCode: err?.code ?? 'SPAWN_FAILED' }, { awaitTree: timedOut });
    });
    child.stdout?.on('data', (c) => { if (outN < MAX_CAPTURE_BYTES) { out.push(c); outN += c.length; } });
    child.stderr?.on('data', (c) => { if (errN < MAX_CAPTURE_BYTES) { errb.push(c); errN += c.length; } });
    child.on('close', (code) => {
      void done({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8'), timedOut, spawnErrorCode: null }, { awaitTree: timedOut });
    });

    if (input != null && child.stdin) {
      child.stdin.end(String(input));
    }
  });
}

// Best-effort, zero-token runtime availability probe: does the CLI exist and
// respond to `--version`? Distinguishes "adapter present, runtime unavailable"
// from "no adapter". Never throws.
export async function probeCli(executable, { spawn = nodeSpawn, timeoutMs = 5_000 } = {}) {
  const r = await runBoundedCli({ executable, args: ['--version'], timeoutMs, spawn });
  if (r.spawnErrorCode === 'ENOENT') return { available: false, reason: 'CLI not installed' };
  if (r.spawnErrorCode) return { available: false, reason: `probe failed: ${r.spawnErrorCode}` };
  if (r.timedOut) return { available: false, reason: 'probe timed out' };
  if (r.code !== 0) return { available: false, reason: `probe exited ${r.code}` };
  return { available: true, reason: 'ok', version: r.stdout.trim().split('\n')[0] };
}
