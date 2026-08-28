// Provider Overhead Probe — explicitly requested live diagnostic only.
//
// It uses one fixed harmless prompt per available transport and reports only
// provider-native usage metadata plus wall-clock latency. It never estimates
// token counts, changes production baselines, or runs from normal tests.

import { spawn as nodeSpawn } from 'node:child_process';
import { callAgy, DEFAULT_AGY_TIMEOUT_MS } from '../agy/agyClient.js';
import { resolveAgySupervisorModel } from '../agy/agyConfig.js';

export const PROVIDER_OVERHEAD_PROMPT = 'Reply with exactly: OK';

function nativeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const numberOrNull = (value) => Number.isFinite(value) ? value : null;
  return {
    inputTokens: numberOrNull(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    outputTokens: numberOrNull(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    cacheReadTokens: numberOrNull(usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens),
  };
}

function unavailable(name, reason, details = {}) {
  return { name, status: 'UNAVAILABLE', reason, ...details };
}

function failed(name, error) {
  return {
    name,
    status: 'FAILED',
    errorCode: error?.code ?? 'PROVIDER_ERROR',
    reason: error?.message ?? String(error),
  };
}

async function runAgyVariant({ name, model, disableSlashCommands, agent, callAgyFn, timeoutMs }) {
  try {
    const result = await callAgyFn({
      prompt: PROVIDER_OVERHEAD_PROMPT,
      model,
      disableSlashCommands,
      agent,
      timeoutMs,
    });
    return {
      name,
      status: result.usage ? 'MEASURED' : 'USAGE_UNAVAILABLE',
      provider: 'agy',
      model: result.model ?? model,
      agent: agent ?? null,
      slashCommandsDisabled: Boolean(disableSlashCommands),
      latencyMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
      usage: nativeUsage(result.usage),
      usageSource: result.usage ? 'agy.native_json' : null,
    };
  } catch (error) {
    return failed(name, error);
  }
}

function commandResult({ executable, args, timeoutMs, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, durationMs: Date.now() - startedAt });
      return;
    }
    const stdout = [];
    const stderr = [];
    let done = false;
    const finish = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...data, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({ timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ error }));
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (exitCode) => finish({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

export async function runCodexOverheadProbe({
  executable = 'codex',
  model = null,
  timeoutMs = DEFAULT_AGY_TIMEOUT_MS,
  ignoreUserConfig = true,
  name = ignoreUserConfig ? 'codex_minimal' : 'codex_current_transport',
  spawn = nodeSpawn,
} = {}) {
  // --ignore-user-config is intentional: Supervisor decisions do not need
  // repository tools, skills, or configured MCP servers. Auth remains usable.
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral'];
  if (ignoreUserConfig) args.push('--ignore-user-config');
  if (model) args.push('--model', model);
  args.push(PROVIDER_OVERHEAD_PROMPT);
  const result = await commandResult({ executable, args, timeoutMs, spawn });
  if (result.error) return failed(name, result.error);
  if (result.timedOut) return unavailable(name, 'timeout', { latencyMs: result.durationMs });
  if (result.exitCode !== 0) return unavailable(name, 'nonzero_exit', { latencyMs: result.durationMs });

  let usage = null;
  for (const line of String(result.stdout || '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') usage = event.usage;
    } catch { /* non-JSON diagnostics are not a result */ }
  }
  return {
    name,
    status: usage ? 'MEASURED' : 'USAGE_UNAVAILABLE',
    provider: 'codex',
    model: model ?? null,
    configIsolation: ignoreUserConfig ? 'ignore-user-config' : 'inherited-user-config',
    latencyMs: result.durationMs,
    usage: nativeUsage(usage),
    usageSource: usage ? 'codex.turn.completed.usage' : null,
  };
}

/**
 * Explicitly run the fixed-prompt live overhead probe. This function is never
 * called by normal workflows, ordinary tests, doctor, status, or benchmark.
 */
export async function runProviderOverheadProbe({
  env = process.env,
  callAgyFn = callAgy,
  runCodexFn = runCodexOverheadProbe,
  timeoutMs = DEFAULT_AGY_TIMEOUT_MS,
} = {}) {
  const model = resolveAgySupervisorModel(env);
  const agent = typeof env.SUPERGPT_AGY_SUPERVISOR_AGENT === 'string' && env.SUPERGPT_AGY_SUPERVISOR_AGENT.trim()
    ? env.SUPERGPT_AGY_SUPERVISOR_AGENT.trim()
    : null;
  const variants = [
    await runAgyVariant({
      name: 'agy_current_supervisor', model, disableSlashCommands: true, callAgyFn, timeoutMs,
    }),
    await runAgyVariant({
      name: 'agy_slash_skill_disabled', model, disableSlashCommands: true, callAgyFn, timeoutMs,
    }),
    agent
      ? await runAgyVariant({
          name: 'agy_dedicated_minimal_agent', model, disableSlashCommands: true, agent, callAgyFn, timeoutMs,
        })
      : unavailable('agy_dedicated_minimal_agent', 'No dedicated agent configured; set SUPERGPT_AGY_SUPERVISOR_AGENT to a known agy agent name.'),
    await runCodexFn({
      model: env.SUPERGPT_CODEX_SUPERVISOR_MODEL || null,
      timeoutMs,
      ignoreUserConfig: false,
      name: 'codex_current_transport',
    }),
    await runCodexFn({
      model: env.SUPERGPT_CODEX_SUPERVISOR_MODEL || null,
      timeoutMs,
      ignoreUserConfig: true,
      name: 'codex_minimal',
    }),
  ];
  return {
    schema: 'supergpt.provider-overhead/v1',
    prompt: PROVIDER_OVERHEAD_PROMPT,
    measuredAt: new Date().toISOString(),
    variants,
    notes: [
      'All token fields are provider-native metadata; null means unavailable, never estimated.',
      'This probe is opt-in and does not update production token baselines.',
      'The current agy transport already disables slash/skill expansion; the paired agy variants document that invariant.',
    ],
  };
}
