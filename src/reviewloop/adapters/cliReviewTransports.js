// Production Reviewer / Supervisor transports for the Codex and Claude
// families.
//
// Both are NARROW, stateless, single-turn inference — never a second coding
// Worker:
//   - run from an isolated empty scratch dir (no repo / AGENTS.md / CLAUDE.md /
//     project / session history to preload)
//   - user config, project rules and MCP servers explicitly disabled
//   - read-only / no tool use, no conversation continuation
//   - bounded wall-clock via runBoundedCli (terminates the process group)
//   - output goes through the SAME strict structured normalization as the agy
//     transport (providerWiring parseJsonish + validate*Payload); malformed ->
//     HUMAN_REQUIRED, never CLEAN/PASS
//   - quota / auth / unavailable / protocol / timeout failures throw a
//     CliTransportError whose code is one of the RETRYABLE provider-failure
//     codes the RoleRouter health/quota fallback already handles
//
// No second retry/failover state machine: one physical attempt per call. The
// controller's meteredWithFailover owns bounded failover; every physical
// attempt is still metered through ModelSpendAuthority upstream.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { narrowReviewTransportCwd } from './scratchCwd.js';
import { runBoundedCli, classifyCliFailure, CliTransportError, CLI_FAILURE, probeCli } from './boundedCli.js';

// Zero-token runtime availability probe for the CLI-backed families. Returns
// { 'codex:default': {available, reason, version?}, 'claude:opus': {...} }.
// Never throws. The adapter always exists; this only answers whether the
// runtime is there.
export async function probeReviewTransportRuntime({ spawn } = {}) {
  const [codex, claude] = await Promise.all([
    probeCli('codex', { spawn }),
    probeCli('claude', { spawn }),
  ]);
  return { 'codex:default': codex, 'claude:opus': claude };
}

export const DEFAULT_CLI_TRANSPORT_TIMEOUT_MS = 180_000;

function firstNumber(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return undefined;
}

// ---- Codex --------------------------------------------------------------
//
// `codex exec` narrow-mode flags (confirmed via `codex exec --help`):
//   --ephemeral            no session files persisted
//   --ignore-user-config   do not load $CODEX_HOME/config.toml (instructions)
//   --ignore-rules         do not load user/project execpolicy .rules
//   --skip-git-repo-check  run outside a git repo (scratch cwd)
//   -s read-only           model-generated shell commands cannot write
//   -C <dir>               working root
//   --json                 JSONL event stream (used for token usage)
//   -o <file>              final agent message written here (used for the reply)

export function makeCodexReviewTransport({
  model = null, spawn = nodeSpawn, timeoutMs = DEFAULT_CLI_TRANSPORT_TIMEOUT_MS, env = process.env,
} = {}) {
  return async (prompt) => {
    const cwd = narrowReviewTransportCwd();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-codex-'));
    const outFile = path.join(tmp, 'last-message.txt');
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '-s', 'read-only', '-C', cwd,
      '--color', 'never', '--json', '-o', outFile,
    ];
    if (typeof model === 'string' && model.trim() !== '') args.push('-m', model.trim());
    args.push(String(prompt));

    let res;
    try {
      res = await runBoundedCli({ executable: 'codex', args, cwd, timeoutMs, spawn, env });
    } finally { /* tmp cleaned below */ }

    if (res.timedOut) {
      rmSync(tmp, { recursive: true, force: true });
      throw new CliTransportError(`codex exec exceeded ${timeoutMs}ms`, CLI_FAILURE.TIMEOUT, { stderr: res.stderr });
    }
    if (res.spawnErrorCode || res.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      const code = classifyCliFailure({ code: res.code, stderr: res.stderr, spawnErrorCode: res.spawnErrorCode });
      throw new CliTransportError(`codex exec failed (exit ${res.code ?? res.spawnErrorCode})`, code, { stderr: res.stderr });
    }

    let text = '';
    try { text = readFileSync(outFile, 'utf8'); } catch { text = ''; }
    rmSync(tmp, { recursive: true, force: true });

    // Best-effort token usage from the JSONL event stream. UNKNOWN -> null.
    let usage = null;
    let resolvedModel = model || null;
    for (const line of res.stdout.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const u = ev.usage ?? ev.token_usage ?? ev.total_token_usage ?? ev.msg?.usage ?? ev.info?.total_token_usage;
      if (u && typeof u === 'object') {
        usage = {
          input_tokens: firstNumber(u.input_tokens, u.prompt_tokens, u.input),
          output_tokens: firstNumber(u.output_tokens, u.completion_tokens, u.output),
          cache_read_input_tokens: firstNumber(u.cached_input_tokens, u.cache_read_input_tokens),
        };
      }
      const m = ev.model ?? ev.msg?.model ?? ev.info?.model;
      if (typeof m === 'string' && m) resolvedModel = m;
    }
    if (!text.trim() && !res.stdout.trim()) {
      throw new CliTransportError('codex exec produced no output', CLI_FAILURE.PROTOCOL_ERROR);
    }

    return {
      model: resolvedModel,
      requestedModel: model || null,
      exitCode: 0,
      text: text.trim(),
      json: null,
      usage,
      durationMs: res.durationMs,
      meta: { promptChars: String(prompt ?? '').length },
    };
  };
}

// ---- Claude ------------------------------------------------------------
//
// `claude -p` narrow-mode flags:
//   --output-format json                       machine-readable envelope
//   --strict-mcp-config --mcp-config {}         no MCP servers
//   --disallowedTools <all>                     no tool use
//   --exclude-dynamic-system-prompt-sections    trims the system prompt
//   (run from scratch cwd -> no CLAUDE.md / project context)
// The `claude` shell alias adds --dangerously-skip-permissions; spawning the
// binary directly (argv, not a shell) never sees that alias.

const CLAUDE_DISALLOWED_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'Task', 'TodoWrite', 'Agent',
].join(',');

export function makeClaudeReviewTransport({
  model = null, spawn = nodeSpawn, timeoutMs = DEFAULT_CLI_TRANSPORT_TIMEOUT_MS, env = process.env,
} = {}) {
  return async (prompt) => {
    const cwd = narrowReviewTransportCwd();
    const args = [
      '-p', String(prompt),
      '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{}',
      '--disallowedTools', CLAUDE_DISALLOWED_TOOLS,
      '--exclude-dynamic-system-prompt-sections',
    ];
    if (typeof model === 'string' && model.trim() !== '') args.push('--model', model.trim());

    const res = await runBoundedCli({ executable: 'claude', args, cwd, timeoutMs, spawn, env });

    if (res.timedOut) {
      throw new CliTransportError(`claude -p exceeded ${timeoutMs}ms`, CLI_FAILURE.TIMEOUT, { stderr: res.stderr });
    }
    if (res.spawnErrorCode) {
      const code = classifyCliFailure({ spawnErrorCode: res.spawnErrorCode });
      throw new CliTransportError(`claude -p failed to spawn (${res.spawnErrorCode})`, code, { stderr: res.stderr });
    }

    let envelope = null;
    const trimmed = res.stdout.trim();
    if (trimmed) { try { envelope = JSON.parse(trimmed); } catch { envelope = null; } }

    if (res.code !== 0 || envelope?.is_error === true || String(envelope?.subtype ?? '').startsWith('error')) {
      const stderrLike = res.stderr || (typeof envelope?.result === 'string' ? envelope.result : trimmed);
      const code = classifyCliFailure({ code: res.code, stderr: stderrLike });
      throw new CliTransportError(`claude -p failed (exit ${res.code}${envelope?.subtype ? `, ${envelope.subtype}` : ''})`, code, { stderr: stderrLike });
    }
    if (!envelope) {
      throw new CliTransportError('claude -p output was not valid JSON', CLI_FAILURE.PROTOCOL_ERROR, { stderr: res.stderr });
    }

    const u = envelope.usage ?? null;
    const usage = u && typeof u === 'object' ? {
      input_tokens: firstNumber(u.input_tokens),
      output_tokens: firstNumber(u.output_tokens),
      cache_read_input_tokens: firstNumber(u.cache_read_input_tokens),
      cache_creation_input_tokens: firstNumber(u.cache_creation_input_tokens),
    } : null;

    return {
      model: envelope.model ?? model ?? null,
      requestedModel: model || null,
      exitCode: 0,
      text: typeof envelope.result === 'string' ? envelope.result : '',
      json: envelope,
      usage,
      costUsd: firstNumber(envelope.total_cost_usd, envelope.cost_usd),
      durationMs: res.durationMs,
      meta: { promptChars: String(prompt ?? '').length },
    };
  };
}
