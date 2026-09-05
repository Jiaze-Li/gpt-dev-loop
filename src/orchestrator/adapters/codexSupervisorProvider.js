// Codex Supervisor provider. This is intentionally a decision-only,
// tool-free transport: the deterministic orchestrator owns repository state,
// task execution, gates, and review. Codex receives only the compact semantic
// Supervisor context and returns the existing validated decision protocol.

import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { assembleSupervisorPrompt, parseSupervisorJson } from './agySupervisorProvider.js';
import { AdapterError, ADAPTER_ERROR_CODES, ProviderCancelledError } from '../errors.js';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../processTree.js';

function classify(stderr = '') {
  if (/quota|rate.?limit|usage limit/i.test(stderr)) return 'PROVIDER_QUOTA_EXHAUSTED';
  if (/auth|required|login|credential/i.test(stderr)) return 'PROVIDER_AUTH_FAILED';
  return 'PROVIDER_UNAVAILABLE';
}

async function callCodex({ prompt, model, timeoutMs = 180000, executable = 'codex', spawn = nodeSpawn, effort = null, conversationId = null, signal = null } = {}) {
  if (signal?.aborted) throw new ProviderCancelledError('Codex Supervisor call cancelled before launch', { model: model ?? null });
  // Codex persists a thread locally so BOUNDED_STICKY can use its documented
  // `exec resume <session-id>` transport. CHECKPOINT_FRESH callers simply
  // omit the id and get a new physical thread.
  const args = conversationId ? ['exec', 'resume', conversationId, '--json', '--skip-git-repo-check', '--ignore-user-config'] : ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config'];
  if (model) args.push('--model', model);
  if (['low', 'medium', 'high'].includes(effort)) args.push('--config', `model_reasoning_effort=${effort}`);
  args.push(prompt);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...PROCESS_GROUP_SPAWN_OPTS });
    } catch (error) {
      resolve({ error });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let treeTermination = null;

    const tearDownTree = () => {
      if (!treeTermination) treeTermination = terminateProcessTree(child);
      return treeTermination;
    };

    const finish = async (value, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (awaitTree && treeTermination) await treeTermination.done;
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { tearDownTree(); } catch {}
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      try { tearDownTree(); } catch {}
    };
    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      void finish({ error, aborted, timedOut }, { awaitTree: aborted || timedOut });
    });
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('close', (exitCode) => {
      void finish({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        aborted,
        timedOut,
      }, { awaitTree: aborted || timedOut });
    });
  });
  const durationMs = Date.now() - started;
  if (result.aborted || signal?.aborted) throw new ProviderCancelledError('Codex Supervisor call cancelled', { durationMs, model: model ?? null });
  if (result.timedOut) throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT, 'Codex Supervisor timed out', { providerFailure: 'PROVIDER_TIMEOUT', durationMs, model: model ?? null });
  if (result.error || result.exitCode !== 0) throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE, 'Codex Supervisor transport unavailable', { providerFailure: classify(result.stderr), durationMs, model: model ?? null, exitCode: result.exitCode ?? null });
  let text = null;
  let usage = null;
  let returnedConversationId = null;
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

export function createCodexSupervisorProvider({ call = callCodex, model = null, timeoutMs, executable, spawn, signal = null } = {}) {
  return {
    provider: 'codex', model,
    async decide(context = {}, { effort = null, conversationId = null } = {}) {
      const { prompt } = assembleSupervisorPrompt(context);
      const result = await call({ prompt, model, timeoutMs, executable, spawn, effort, conversationId, signal });
      const callId = `call-codex-sup-${randomUUID()}`;
      const usage = result.usage ? { ...result.usage, callId } : { callId };
      let raw;
      // The provider DID respond (usage known) even when its reply fails
      // decoding/shape validation — attach usage to SUPERVISOR_INVALID_OUTPUT
      // so the reservation settles SETTLED_KNOWN, not UNRESOLVED (see
      // modelSpendReservation.js §6).
      try { raw = JSON.parse(result.text.trim()); } catch {
        throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, 'Codex Supervisor did not return a JSON decision', { providerFailure: 'PROVIDER_PROTOCOL_ERROR', model, usage });
      }
      let parsedDecision;
      try {
        parsedDecision = parseSupervisorJson(raw);
      } catch (err) {
        if (err instanceof AdapterError && !err.details?.usage) err.details = { ...(err.details ?? {}), usage };
        throw err;
      }
      const decision = { ...parsedDecision, conversationId: result.conversationId ?? null };
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
