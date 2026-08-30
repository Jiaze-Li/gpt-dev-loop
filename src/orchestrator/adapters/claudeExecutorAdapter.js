// Claude Code CLI Executor Adapter — docs/workflow/ADAPTER_INTERFACE.md §1:
// execute(task_card) -> execution_report (shaped per EXECUTION_REPORT.md §2).
//
// Wraps the local `claude` CLI as one concrete implementation of the
// Executor Adapter. The core Workflow Manager (workflowManager.js) never
// imports this file — per ADAPTER_INTERFACE.md §4 the core only knows the
// `execute(task_card) -> execution_report` signature; wiring a real
// executor in is the caller's job.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AdapterError, ADAPTER_ERROR_CODES, ProviderCancelledError } from '../errors.js';
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from '../processTree.js';

const REPORT_FIELDS = [
  'task_id',
  'repository_context',
  'status',
  'changed_files',
  'tests_run',
  'test_results',
  'issues',
  'next_recommendation',
];
const STATUSES = new Set(['DONE', 'BLOCKED', 'HUMAN_REQUIRED']);

function renderList(items) {
  return items && items.length ? items.map((item) => `- ${item}`).join('\n') : 'none';
}

// TASK_PROTOCOL.md/EXECUTION_REPORT.md/REVIEW_RESULT.md §2 repository_context:
// repository_name/repository_url/branch/commit_sha, one "key: value" per line.
function renderRepositoryContext(repositoryContext) {
  const ctx = repositoryContext ?? {};
  return `repository_name: ${ctx.repository_name}
repository_url: ${ctx.repository_url ?? 'none'}
branch: ${ctx.branch}
commit_sha: ${ctx.commit_sha}`;
}

function parseRepositoryContext(raw) {
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(repository_name|repository_url|branch|commit_sha):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim();
  }
  return {
    repository_name: fields.repository_name ?? null,
    repository_url: fields.repository_url && fields.repository_url !== 'none' ? fields.repository_url : null,
    branch: fields.branch ?? null,
    commit_sha: fields.commit_sha ?? null,
  };
}

// TASK_PROTOCOL.md §3 template, filled from the in-memory task_card object.
export function renderTaskCard(taskCard) {
  const rework = taskCard.rework_feedback;
  const reworkFeedback = rework
    ? `\n\n## rework_feedback\nThis is a rework attempt. Correct these Reviewer-identified issues; do not preserve an intentional first-attempt defect.\n\nfindings:\n${renderList(rework.findings)}\n\nrequired_changes:\n${renderList(rework.required_changes)}\n\nrationale:\n${rework.rationale ?? 'none'}`
    : '';
  return `## task_id
${taskCard.task_id}

## repository_context
${renderRepositoryContext(taskCard.repository_context)}

## goal
${taskCard.goal}

## context
${taskCard.context}

## scope
${taskCard.scope}

## allowed_files
${renderList(taskCard.allowed_files)}

## forbidden_files
${renderList(taskCard.forbidden_files)}

## acceptance_criteria
${renderList(taskCard.acceptance_criteria)}

## verification_commands
${renderList((taskCard.verification_commands ?? []).map((command) => `\`${command}\``))}

## completion_signal
${taskCard.completion_signal}${reworkFeedback}`;
}

// Instructs the CLI to act as Executor and reply with nothing but an
// EXECUTION_REPORT.md §3-shaped document, so parseExecutionReport can
// recover it deterministically.
export function buildPrompt(taskCard) {
  return `You are the Executor in an automated dev loop. Act on the Task Card below exactly as scoped — respect allowed_files/forbidden_files and acceptance_criteria — then run the listed verification_commands yourself.

Reply with ONLY an Execution Report: one Markdown document, one "## field_name" heading per field, in exactly this order: task_id, repository_context, status, changed_files, tests_run, test_results, issues, next_recommendation. repository_context.commit_sha must be the commit you actually left the repo at, which is not necessarily the Task Card's commit_sha. No text before or after it.

# Task Card

${renderTaskCard(taskCard)}

# Execution Report template

## task_id
${taskCard.task_id}

## repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <the commit you actually left the repo at>

## status
DONE | BLOCKED | HUMAN_REQUIRED

## changed_files
- <path>

## tests_run
- \`<command>\`

## test_results
- \`<command>\`: pass/fail — <output>

## issues
- <deviation, assumption, or follow-up; or "none">

## next_recommendation
<proceed / re-plan / what would unblock>`;
}

function parseList(raw) {
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

// Splits the executor's reply on "## field_name" headings (TASK_PROTOCOL.md
// §1 convention) and validates it against EXECUTION_REPORT.md §2.
export function parseExecutionReport(taskId, text) {
  const headingRe = /^##\s+(\w+)\s*$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length === 0) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT,
      'executor output contained no Execution Report headings'
    );
  }

  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[name] = text.slice(start, end).trim();
  }

  for (const field of REPORT_FIELDS) {
    if (!(field in sections)) {
      throw new AdapterError(
        ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT,
        `executor output is missing the "${field}" section`
      );
    }
  }

  if (!STATUSES.has(sections.status)) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT,
      `executor output has an invalid status: "${sections.status}"`
    );
  }

  if (sections.task_id !== taskId) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT,
      `executor Execution Report task_id "${sections.task_id}" does not match Task Card task_id "${taskId}"`
    );
  }

  return {
    task_id: sections.task_id,
    repository_context: parseRepositoryContext(sections.repository_context),
    status: sections.status,
    changed_files: parseList(sections.changed_files),
    tests_run: parseList(sections.tests_run),
    test_results: parseList(sections.test_results),
    issues: sections.issues,
    next_recommendation: sections.next_recommendation,
  };
}

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
      try {
        onProcessStarted(child.pid);
      } catch {
        /* ignore hook errors */
      }
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let treeTermination = null;

    // Start teardown at most once. The returned promise remains authoritative
    // even if the direct CLI exits first: descendants in its process group can
    // still be alive and mutating the worktree.
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
        try {
          onActivity({ stream: 'stdout', chunk });
        } catch {
          /* ignore hook errors */
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (typeof onActivity === 'function') {
        try {
          onActivity({ stream: 'stderr', chunk });
        } catch {
          /* ignore hook errors */
        }
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
            reject(
              new AdapterError(ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT, `executor "${command}" did not respond within ${timeoutMs}ms`)
            );
            return;
          }
          if (aborted) {
            // A cancellation is not a provider failure — surface it as one so
            // it triggers ZERO failover / retry (see errors.js isCancellation).
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

export function createClaudeExecutorAdapter({
  command = 'claude',
  // Runs non-interactively with no TTY to approve prompts, so file edits
  // must be pre-authorized or every task reports BLOCKED before it can
  // touch allowed_files. acceptEdits still leaves Bash and other
  // permission classes gated normally — only file edits are auto-accepted.
  args,
  model = 'sonnet',
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 10 * 60 * 1000,
  spawn = nodeSpawn,
  onActivity,
  onProcessStarted,
  onProcessExited,
} = {}) {
  const resolvedArgs = args ?? [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
    ...(model ? ['--model', model] : []),
  ];

  return {
    model,
    async execute(taskCard, { signal } = {}) {
      const prompt = buildPrompt(taskCard);
      const result = await runProcess({
        command,
        args: resolvedArgs,
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
        throw new AdapterError(
          ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE,
          `executor "${command}" exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`
        );
      }

      let reportText = result.stdout;
      let usage = null;
      let costUsd = null;
      let modelUsed = model;

      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.result === 'string') {
            reportText = parsed.result;
          }
          if (parsed.usage && typeof parsed.usage === 'object') {
            usage = {
              input_tokens: parsed.usage.input_tokens ?? 0,
              output_tokens: parsed.usage.output_tokens ?? 0,
              cache_read_tokens: parsed.usage.cache_read_input_tokens ?? 0,
              cache_creation_tokens: parsed.usage.cache_creation_input_tokens ?? 0,
              total_tokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
            };
          }
          if (Number.isFinite(parsed.total_cost_usd)) {
            costUsd = parsed.total_cost_usd;
          }
          if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
            const keys = Object.keys(parsed.modelUsage);
            if (keys.length > 0) modelUsed = keys[0];
          }
        }
      } catch {
        /* plain text fallback */
      }

      const report = parseExecutionReport(taskCard.task_id, reportText);
      const callId = `call-claude-exe-${randomUUID()}`;
      try {
        Object.defineProperty(report, 'callId', {
          value: callId,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch {
        report.callId = callId;
      }
      if (usage) {
        try {
          Object.defineProperty(usage, 'callId', {
            value: callId,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {
          usage.callId = callId;
        }
        report.usage = usage;
      }
      if (costUsd !== null) report.costUsd = costUsd;
      if (usage || costUsd !== null) report.model = modelUsed;
      return report;
    },
  };
}
