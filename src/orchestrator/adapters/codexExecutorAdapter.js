// Codex CLI Executor Adapter
// Executes tasks in workspace-write mode inside the isolated task worktree.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AdapterError, ADAPTER_ERROR_CODES, ProviderCancelledError } from '../errors.js';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../processTree.js';
import { buildPrompt, parseExecutionReport } from './claudeExecutorAdapter.js';

function runProcess({ command, args, cwd, env, prompt, timeoutMs, spawn, onActivity, onProcessStarted, onProcessExited, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...PROCESS_GROUP_SPAWN_OPTS });
    } catch (err) {
      onProcessExited?.({ spawnError: err.message, timeoutDurationMs: timeoutMs });
      reject(new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE, `could not start "${command}": ${err.message}`));
      return;
    }

    if (typeof onProcessStarted === 'function' && child.pid) {
      try { onProcessStarted(child.pid); } catch {}
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let treeTermination = null;

    // Start teardown at most once. A direct-child close is not sufficient:
    // descendants may remain alive in the owned process group.
    const tearDownTree = () => {
      if (!treeTermination) treeTermination = terminateProcessTree(child);
      return treeTermination;
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
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = async (fn, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (awaitTree && treeTermination) await treeTermination.done;
      fn();
    };

    child.on('error', (err) => {
      void finish(
        () => {
          onProcessExited?.({ pid: child.pid ?? null, spawnError: err.message, timeoutDurationMs: timeoutMs });
          reject(new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE, `could not run "${command}": ${err.message}`));
        },
        { awaitTree: aborted || timedOut }
      );
    });

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      if (typeof onActivity === 'function') {
        try { onActivity({ stream: 'stdout', chunk }); } catch {}
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (typeof onActivity === 'function') {
        try { onActivity({ stream: 'stderr', chunk }); } catch {}
      }
    });

    child.on('close', (code, closeSignal) => {
      void finish(
        () => {
          onProcessExited?.({
            pid: child.pid ?? null,
            exitCode: code,
            signal: closeSignal ?? null,
            timeoutInitiator: timedOut ? 'internal' : null,
            timeoutDurationMs: timedOut ? timeoutMs : null,
            stdoutTail: Buffer.concat(stdoutChunks).toString('utf8'),
            stderrTail: Buffer.concat(stderrChunks).toString('utf8'),
          });
          if (timedOut) {
            reject(new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, `executor "${command}" did not respond within ${timeoutMs}ms`));
            return;
          }
          if (aborted) {
            reject(new ProviderCancelledError(`executor "${command}" terminated by cancellation`));
            return;
          }
          resolve({
            code,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          });
        },
        { awaitTree: aborted || timedOut }
      );
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export function createCodexExecutorAdapter({
  command = 'codex',
  model = null,
  cwd = process.cwd(),
  env = process.env,
  // `codex exec` exposes no supported per-command / per-tool timeout knob we
  // can rely on, so CLI invocation is left unchanged: a hung tool call is
  // bounded only by this whole-process timeoutMs, which surfaces as
  // EXECUTOR_TIMEOUT and drives provider candidate failover without spending
  // an implementation retry.
  timeoutMs = 10 * 60 * 1000,
  spawn = nodeSpawn,
  onActivity,
  onProcessStarted,
  onProcessExited,
} = {}) {
  const args = [
    'exec',
    '--json',
    '--sandbox', 'workspace-write',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    ...(model ? ['--model', model] : []),
  ];

  return {
    model,
    async execute(taskCard, { signal } = {}) {
      const prompt = buildPrompt(taskCard);
      const result = await runProcess({
        command,
        args,
        cwd,
        env,
        prompt,
        timeoutMs,
        spawn,
        onActivity,
        onProcessStarted,
        onProcessExited,
        signal,
      });

      if (result.code !== 0) {
        let providerFailure = 'PROVIDER_UNAVAILABLE';
        const combined = `${result.stderr} ${result.stdout}`;
        if (/quota|rate.?limit|usage limit/i.test(combined)) providerFailure = 'PROVIDER_QUOTA_EXHAUSTED';
        else if (/auth|required|login|credential/i.test(combined)) providerFailure = 'PROVIDER_AUTH_FAILED';
        throw new AdapterError(
          ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE,
          `executor "${command}" exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
          { providerFailure, exitCode: result.code, stderr: result.stderr }
        );
      }

      let reportText = '';
      let usage = null;
      for (const line of result.stdout.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            reportText = event.item.text;
          }
          if (event.type === 'turn.completed' && event.usage) {
            usage = {
              input_tokens: event.usage.input_tokens ?? 0,
              output_tokens: event.usage.output_tokens ?? 0,
              cache_read_tokens: event.usage.cached_input_tokens ?? 0,
              cache_creation_tokens: 0,
              total_tokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
            };
          }
        } catch {}
      }

      if (!reportText) {
        reportText = result.stdout;
      }

      const report = parseExecutionReport(taskCard.task_id, reportText);
      const callId = `call-codex-exe-${randomUUID()}`;
      Object.defineProperties(report, {
        callId: { value: callId, writable: true, configurable: true, enumerable: false },
      });
      if (usage) {
        usage.callId = callId;
        report.usage = usage;
      }
      if (model) report.model = model;
      return report;
    },
  };
}

function runGit(args, { cwd, spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

async function currentRepositoryState({ cwd, spawn }) {
  const [commit, status] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], { cwd, spawn }),
    runGit(['status', '--short'], { cwd, spawn }),
  ]);
  return `commit: ${commit || 'unknown'}\nchanges:\n${status || '(clean)'}`;
}

function buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState }) {
  return {
    ...taskCard,
    context: `${taskCard.context}

## Rework — Codex session #${sessionNumber}
This is a new Codex session. The previous session's conversation is not
available to you — treat this as a fresh start informed only by what
follows.

### Review / gate feedback from the previous attempt
${feedback}

### Current repository state
${repositoryState}`,
  };
}

export function createCodexSessionManager({
  workflowId,
  taskId,
  persistence,
  createExecutor = createCodexExecutorAdapter,
  cwd = process.cwd(),
  spawn = nodeSpawn,
  env = process.env,
  model = null,
  onRoutingDecision,
  onProcessStarted,
  onProcessExited,
} = {}) {
  let sessionCount = 0;

  return {
    async execute(taskCard, { signal } = {}) {
      if (signal?.aborted) throw new ProviderCancelledError('executor cancelled');
      sessionCount += 1;
      const sessionNumber = sessionCount;

      let feedback = 'none recorded';
      let taskCardForSession = taskCard;
      if (sessionNumber > 1) {
        const state = await persistence?.readState?.(workflowId, taskId);
        feedback = state?.last_error ?? 'none recorded';
        const repositoryState = await currentRepositoryState({ cwd, spawn });
        taskCardForSession = buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState });
      }

      const routing = {
        model: model || 'codex:default',
        escalated: false,
        escalationReason: null,
      };

      if (typeof onRoutingDecision === 'function') {
        try {
          onRoutingDecision({
            workflowId,
            taskId,
            sessionNumber,
            ...routing,
          });
        } catch {}
      }

      if (persistence && typeof persistence.writeState === 'function') {
        try {
          await persistence.writeState({
            workflow_id: workflowId,
            task_id: taskId,
            executor_model: routing.model,
            model_escalated: routing.escalated,
            escalation_reason: routing.escalationReason,
          });
        } catch {}
      }

      const processContext = { role: 'executor', taskId, attempt: sessionNumber, provider: 'codex', requestedFamily: 'codex:default', resolvedModel: routing.model };
      const executor = createExecutor({
        cwd,
        model,
        env,
        spawn,
        onProcessStarted: (pid) => onProcessStarted?.({ ...processContext, pid }),
        onProcessExited: (details) => onProcessExited?.({ ...processContext, ...details }),
      });
      const report = await executor.execute(taskCardForSession, { signal });
      if (signal?.aborted) throw new ProviderCancelledError('executor cancelled');

      try {
        Object.defineProperties(report, {
          model: { value: report.model || routing.model, writable: true, configurable: true, enumerable: false },
          modelEscalated: { value: false, writable: true, configurable: true, enumerable: false },
          escalationReason: { value: null, writable: true, configurable: true, enumerable: false },
        });
      } catch {}

      return report;
    },
  };
}
