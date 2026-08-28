// agyClient: minimal non-interactive transport to the locally installed
// Antigravity CLI (`agy`, /Users/jack/.local/bin/agy, v1.1.22).
//
// This is a transport smoke-test primitive only. It is deliberately NOT
// wired into automatedLoop, the Supervisor/Reviewer sessions, gates, or the
// Chrome extension. It just proves the repo can shell out to the locally
// authenticated `agy` binary and get a machine-readable Gemini response
// back.
//
// Confirmed against the installed binary (`agy --help`, `agy models`):
//   - executable:        `agy` on PATH -> /Users/jack/.local/bin/agy
//   - non-interactive:   `agy --print=<prompt>` (the prompt MUST be attached
//                        to the flag; a detached `agy --print <prompt>` lets
//                        the very next token be swallowed as the prompt)
//   - machine-readable:  `--output-format json` (also: text, stream-json)
//   - structured output: `--json-schema <string|path>` enforces a schema
//   - model selection:   `--model <id>` e.g. gemini-3.7-flash-low
//   - slash expansion:   `--disable-slash-commands` keeps the prompt literal
//   - errors:            non-zero exit status; ENOENT if the binary is absent
//
// Auth: none is read, exported, or managed here. `agy` uses whatever Google
// account is already authenticated on this machine.
//
// Privacy: prompt text and any reply text are never logged by this module.
// The prompt is passed as a single `--print=<prompt>` argv entry (never a
// shell command string, so no quoting/escaping/injection surface); only
// callers decide what to do with the returned text.

import { spawn as nodeSpawn } from 'node:child_process';
import { extractSafeAgyEnvelopeMetadata } from './agyErrorEnvelope.js';

export const DEFAULT_AGY_MODEL = 'gemini-3.7-flash-low';
export const DEFAULT_AGY_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_000_000;

export class AgyError extends Error {
  constructor(message, { code = 'AGY_ERROR', exitCode = 1 } = {}) {
    super(message);
    this.name = 'AgyError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class AgyExecutableNotFoundError extends AgyError {
  constructor(executable) {
    super(`agy executable not found: ${executable}`, { code: 'AGY_ENOENT', exitCode: 127 });
    this.name = 'AgyExecutableNotFoundError';
  }
}

export class AgyTimeoutError extends AgyError {
  constructor(timeoutMs) {
    super(`agy did not respond within ${timeoutMs}ms`, { code: 'AGY_TIMEOUT', exitCode: 124 });
    this.name = 'AgyTimeoutError';
  }
}

export class AgyExitError extends AgyError {
  constructor(exitCode, stderr, { durationMs, stdout } = {}) {
    super(`agy exited with status ${exitCode}`, { code: 'AGY_NONZERO_EXIT', exitCode: exitCode || 1 });
    this.name = 'AgyExitError';
    // stderr from agy is diagnostic (auth / rate-limit / usage), not prompt
    // content — safe to surface.
    this.stderr = truncate(stderr);
    if (Number.isFinite(durationMs)) this.durationMs = durationMs;
    // agy sometimes prints a structured error envelope to stdout before
    // exiting non-zero. Pull ONLY whitelisted operational metadata out of it
    // (status / error_code / model / token usage …) — never generated text.
    // See src/agy/agyErrorEnvelope.js. Absent/non-JSON stdout -> no envelope.
    const envelope = extractSafeAgyEnvelopeMetadata(typeof stdout === 'string' ? stdout : '');
    if (envelope.jsonObject && Object.keys(envelope.fields).length > 0) {
      this.envelope = envelope.fields;
    }
  }
}

export class AgyOutputError extends AgyError {
  constructor(message) {
    super(message, { code: 'AGY_MALFORMED_OUTPUT', exitCode: 65 });
    this.name = 'AgyOutputError';
  }
}

function truncate(text) {
  if (typeof text !== 'string') return '';
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

// Pull the assistant text out of whatever envelope `agy --output-format
// json` produced. Tolerant of field naming since the exact envelope is
// version-dependent; the deterministic tests pin the shapes we handle.
function extractText(json) {
  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') return null;
  const candidates = [json.result, json.text, json.response, json.message, json.output, json.content];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * Run one non-interactive `agy` prompt and return a normalized result.
 *
 * @param {object} opts
 * @param {string} opts.prompt              prompt text (required, non-empty)
 * @param {string} [opts.model]             model id (see `agy models`)
 * @param {number} [opts.timeoutMs]         hard wall-clock cap
 * @param {string} [opts.executable]        binary name/path (default "agy")
 * @param {string} [opts.jsonSchema]        value for --json-schema
 * @param {string} [opts.cwd]               working dir for the child
 * @param {Function} [opts.spawn]           injectable spawn (for tests)
 * @returns {Promise<{model:string, exitCode:number, text:string|null,
 *                     json:any, stdout:string, durationMs:number}>}
 */
export async function callAgy({
  prompt,
  model = DEFAULT_AGY_MODEL,
  timeoutMs = DEFAULT_AGY_TIMEOUT_MS,
  executable = 'agy',
  jsonSchema,
  cwd,
  spawn = nodeSpawn,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new AgyError('callAgy requires a non-empty prompt string', { code: 'AGY_BAD_INPUT' });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgyError('callAgy requires a positive timeoutMs', { code: 'AGY_BAD_INPUT' });
  }

  // agy v1.1.22: the prompt MUST be attached to the flag as `--print=<prompt>`.
  // With a detached `--print <prompt>` the parser takes the *next token*
  // (e.g. `--output-format`) as the prompt and silently ignores the real one.
  // Attaching it also means every other flag is an ordinary flag that cannot
  // be consumed as the prompt, regardless of ordering.
  const args = [
    `--print=${prompt}`,
    '--output-format', 'json',
    '--disable-slash-commands',
    '--model', model,
  ];
  if (typeof jsonSchema === 'string' && jsonSchema.length > 0) {
    args.push('--json-schema', jsonSchema);
  }

  const startedAt = Date.now();

  const { code, stdout, stderr, timedOut, spawnError } = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => finish({ spawnError: err }));
    child.stdout?.on('data', (chunk) => {
      if (outBytes < MAX_CAPTURE_BYTES) { outChunks.push(chunk); outBytes += chunk.length; }
    });
    child.stderr?.on('data', (chunk) => {
      if (errBytes < MAX_CAPTURE_BYTES) { errChunks.push(chunk); errBytes += chunk.length; }
    });
    child.on('close', (closeCode) => {
      finish({
        code: closeCode,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });

  if (spawnError) {
    if (spawnError && spawnError.code === 'ENOENT') {
      throw new AgyExecutableNotFoundError(executable);
    }
    throw new AgyError(`failed to spawn agy: ${spawnError.message}`, { code: 'AGY_SPAWN_FAILED' });
  }
  if (timedOut) {
    throw new AgyTimeoutError(timeoutMs);
  }
  if (code !== 0) {
    throw new AgyExitError(code, stderr, { durationMs: Date.now() - startedAt, stdout });
  }

  const trimmed = (stdout || '').trim();
  if (trimmed === '') {
    throw new AgyOutputError('agy produced no stdout');
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new AgyOutputError('agy stdout was not valid JSON');
  }

  return {
    model,
    exitCode: code,
    text: extractText(json),
    json,
    stdout: trimmed,
    durationMs: Date.now() - startedAt,
  };
}
