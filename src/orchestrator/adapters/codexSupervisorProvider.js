// Codex Supervisor provider. This is intentionally a decision-only,
// tool-free transport: the deterministic orchestrator owns repository state,
// task execution, gates, and review. Codex receives only the compact semantic
// Supervisor context and returns the existing validated decision protocol.

import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { buildAgySupervisorPrompt, parseSupervisorJson } from './agySupervisorProvider.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../errors.js';

function classify(stderr = '') {
  if (/quota|rate.?limit|usage limit/i.test(stderr)) return 'PROVIDER_QUOTA_EXHAUSTED';
  if (/auth|required|login|credential/i.test(stderr)) return 'PROVIDER_AUTH_FAILED';
  return 'PROVIDER_UNAVAILABLE';
}

async function callCodex({ prompt, model, timeoutMs = 180000, executable = 'codex', spawn = nodeSpawn, effort = null, conversationId = null } = {}) {
  // Codex persists a thread locally so BOUNDED_STICKY can use its documented
  // `exec resume <session-id>` transport.  CHECKPOINT_FRESH callers simply
  // omit the id and get a new physical thread.
  const args = conversationId ? ['exec', 'resume', conversationId, '--json', '--skip-git-repo-check', '--ignore-user-config'] : ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config'];
  if (model) args.push('--model', model);
  if (['low', 'medium', 'high'].includes(effort)) args.push('--config', `model_reasoning_effort=${effort}`);
  args.push(prompt);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { resolve({ error }); return; }
    const out = []; const err = []; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ timedOut: true }); }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ error }));
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('close', (exitCode) => finish({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
  const durationMs = Date.now() - started;
  if (result.timedOut) throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT, 'Codex Supervisor timed out', { providerFailure: 'PROVIDER_TIMEOUT', durationMs, model: model ?? null });
  if (result.error || result.exitCode !== 0) throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE, 'Codex Supervisor transport unavailable', { providerFailure: classify(result.stderr), durationMs, model: model ?? null, exitCode: result.exitCode ?? null });
  let text = null; let usage = null; let returnedConversationId = null;
  for (const line of result.stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
      if (event.type === 'turn.completed' && event.usage) usage = event.usage;
      if (event.type === 'thread.started') returnedConversationId = event.thread_id ?? event.thread?.id ?? null;
    } catch { /* only JSONL events are accepted */ }
  }
  if (!text) throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, 'Codex Supervisor returned no agent message', { providerFailure: 'PROVIDER_PROTOCOL_ERROR', durationMs, model: model ?? null });
  return { text, usage, durationMs, conversationId: returnedConversationId ?? conversationId ?? null };
}

export function createCodexSupervisorProvider({ call = callCodex, model = null, timeoutMs, executable, spawn } = {}) {
  return {
    provider: 'codex', model,
    async decide(context = {}, { effort = null, conversationId = null } = {}) {
      const result = await call({ prompt: buildAgySupervisorPrompt(context), model, timeoutMs, executable, spawn, effort, conversationId });
      let raw;
      try { raw = JSON.parse(result.text.trim()); } catch {
        throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, 'Codex Supervisor did not return a JSON decision', { providerFailure: 'PROVIDER_PROTOCOL_ERROR', model });
      }
      const callId = `call-codex-sup-${randomUUID()}`;
      const decision = { ...parseSupervisorJson(raw), conversationId: result.conversationId ?? null };
      const usage = result.usage ? { ...result.usage, callId } : { callId };
      Object.defineProperties(decision, {
        callId: { value: callId, enumerable: false },
        usage: { value: usage, enumerable: false },
        durationMs: { value: result.durationMs, enumerable: false },
        effortResolved: { value: result.effortResolved ?? effort, enumerable: false },
      });
      return decision;
    },
  };
}

export { callCodex };
