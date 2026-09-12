// Effective-loading verification for ReviewLoop's isolated `reviewloop-minimal`
// AGY agent.
//
// Why this exists: agy 1.1.27 does NOT discover a workspace-local custom agent
// from `<cwd>/.agents/agents/<name>/agent.md`. When `--agent reviewloop-minimal`
// cannot be resolved, agy SILENTLY falls back to its ambient default agent
// (full built-in toolset + inherited skills / rules / plugins / MCP) and logs
//   session.go:81  Agent "reviewloop-minimal" not found, falling back to default
//   conversation_manager.go  Starting new conversation (agent=false)
// The provisioned file existing on disk is therefore NOT proof the review call
// ran isolated. This module turns "the file exists" into "agy actually loaded
// our agent for this call".
//
// Two layers, both zero real model calls:
//   1. detectAgyCustomAgentSupport() — a startup capability probe. It runs a
//      stream-json turn with an immediately-closed stdin (agy emits the `init`
//      event and exits without a single model turn), pointed at an isolated
//      gemini dir via the `--gemini_dir` flag, and inspects the agy log for the
//      activation marker. supported -> the AGY families may be wired;
//      unsupported -> the caller MUST mark them UNAVAILABLE (fail closed).
//   2. verifyEffectiveAgyAgent() — a per-call check of the agy `--log-file`
//      captured alongside a real transport invocation. Not verified -> the
//      transport raises and the default-agent reply is never used.
//
// The `--gemini_dir` flag is NOT in `agy --help` for 1.1.27. It is used ONLY
// behind detectAgyCustomAgentSupport(): if a future/other agy build rejects it
// ("flags provided but not defined", exit 2) the probe returns
// { supported: false } and the AGY families fail closed — never a hard-coded
// assumption that the capability is present.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBoundedCli } from './boundedCli.js';
import { provisionMinimalAgyAgent, MINIMAL_AGY_AGENT_NAME } from './minimalAgyAgent.js';

// agy prints this once the custom agent is resolved and activated for the
// conversation. Its absence (or the explicit `agent=false`) means the ambient
// default agent is in effect.
const AGENT_ACTIVATED_RE = /Starting new conversation \(agent=true\)/;
const AGENT_NOT_ACTIVATED_RE = /Starting new conversation \(agent=false\)/;

function agentNotFoundRe(agentName) {
  const escaped = String(agentName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Agent "${escaped}" not found, falling back`);
}

/**
 * Decide, from captured agy log text, whether a specific custom agent was the
 * effective agent for the run.
 *
 * @param {object} opts
 * @param {string} opts.logText     contents of the agy `--log-file`
 * @param {string} opts.agentName   the requested `--agent` value
 * @returns {{ verified: boolean, reason: string }}
 */
export function verifyEffectiveAgyAgent({ logText, agentName = MINIMAL_AGY_AGENT_NAME } = {}) {
  const text = typeof logText === 'string' ? logText : '';
  if (text.trim() === '') {
    return { verified: false, reason: 'no agy log was captured for this call' };
  }
  if (agentNotFoundRe(agentName).test(text)) {
    return { verified: false, reason: `agy could not resolve --agent ${agentName} and fell back to the default agent` };
  }
  if (AGENT_NOT_ACTIVATED_RE.test(text)) {
    return { verified: false, reason: 'agy started the conversation with no custom agent (agent=false)' };
  }
  if (!AGENT_ACTIVATED_RE.test(text)) {
    return { verified: false, reason: 'agy log did not confirm custom-agent activation (agent=true)' };
  }
  return { verified: true, reason: 'agy activated the custom agent (agent=true)' };
}

export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 25_000;

/**
 * Startup capability probe. Provisions the real minimal agent into `geminiDir`,
 * then runs a zero-model-turn agy session there and checks the log.
 *
 * @param {object} opts
 * @param {string} opts.geminiDir            isolated gemini dir (required)
 * @param {string} [opts.agentName]          agent name to probe
 * @param {string} [opts.executable]         agy binary (default "agy")
 * @param {Function} [opts.spawn]            injectable spawn
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.provision]        injectable provisioner
 * @returns {Promise<{ supported: boolean, reason: string, evidence?: object }>}
 *   Never throws.
 */
export async function detectAgyCustomAgentSupport({
  geminiDir,
  agentName = MINIMAL_AGY_AGENT_NAME,
  executable = 'agy',
  spawn,
  timeoutMs = DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
  provision = provisionMinimalAgyAgent,
} = {}) {
  if (typeof geminiDir !== 'string' || geminiDir.trim() === '') {
    return { supported: false, reason: 'detectAgyCustomAgentSupport requires a geminiDir' };
  }

  try {
    provision({ geminiDir });
  } catch (err) {
    return { supported: false, reason: `could not provision the probe agent: ${err?.message ?? err}` };
  }

  const probeWorkspace = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-agy-cap-ws-'));
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-agy-cap-log-'));
  const logFile = path.join(logDir, 'agy.log');

  try {
    const res = await runBoundedCli({
      executable,
      args: [
        `--gemini_dir=${geminiDir}`,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--agent', agentName,
        '--disable-slash-commands',
        '--log-file', logFile,
      ],
      cwd: probeWorkspace,
      timeoutMs,
      spawn,
      // stdin is left closed (no `input`): agy reads zero NDJSON messages, runs
      // zero model turns, emits the `init` event and exits.
    });

    if (res.spawnErrorCode === 'ENOENT') {
      return { supported: false, reason: 'agy binary not found' };
    }
    if (res.timedOut) {
      return { supported: false, reason: `capability probe timed out after ${timeoutMs}ms` };
    }
    if (/flags provided but not defined|flag provided but not defined/i.test(res.stderr || '')) {
      return { supported: false, reason: 'this agy build does not accept --gemini_dir' };
    }
    if (res.spawnErrorCode) {
      return { supported: false, reason: `capability probe failed to spawn: ${res.spawnErrorCode}` };
    }

    let logText = '';
    try { logText = readFileSync(logFile, 'utf8'); } catch { logText = ''; }

    const verdict = verifyEffectiveAgyAgent({ logText, agentName });
    return {
      supported: verdict.verified,
      reason: verdict.verified
        ? 'agy loads the isolated reviewloop-minimal agent from the redirected gemini dir'
        : `agy did not load the isolated agent: ${verdict.reason}`,
      evidence: { exitCode: res.code ?? null, durationMs: res.durationMs },
    };
  } catch (err) {
    return { supported: false, reason: `capability probe error: ${err?.message ?? err}` };
  } finally {
    for (const d of [probeWorkspace, logDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
