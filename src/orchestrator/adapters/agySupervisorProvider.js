// AgySupervisorProvider — the MVP Gemini Supervisor, built on the proven
// src/agy/agyClient.js transport.
//
// Drop-in for the `supervisorSession.decide(context)` slot the automated
// loop (src/orchestrator/automatedLoop.js) already calls: given the current
// workflow context it returns exactly one decision object of the same shape
// supervisorProtocol.js's parseSupervisorDecision produces:
//
//   { action: 'NEXT_TASK', task_card }
//   { action: 'CONTINUE_REWORK' }
//   { action: 'WORKFLOW_DONE', summary }
//   { action: 'HUMAN_REQUIRED', reason, question }
//
// ── Token-budget control ────────────────────────────────────────────
//
// The Supervisor prompt is built from a *compact deterministic checkpoint*,
// NOT by echoing full workflow history.  Goals, history entries, and review
// results are mechanically projected down to the minimum fields needed for
// the next decision.
//
// Budget constants:
//   GOAL_CHAR_LIMIT   —  max chars of workflowGoal kept (first N + marker)
//   RATIONALE_LIMIT   —  max chars of reviewer rationale per entry
//   NORMAL_TARGET     —  soft budget; prompt should stay below this
//   HARD_LIMIT        —  absolute max; exceeding → SUPERVISOR_CONTEXT_BUDGET_EXCEEDED
//
// If the fully-assembled prompt exceeds HARD_LIMIT after all compaction, the
// provider throws SUPERVISOR_CONTEXT_BUDGET_EXCEEDED without calling the model.

import { randomUUID } from 'node:crypto';
import { callAgy as defaultCallAgy } from '../../agy/agyClient.js';
import {
  AgyTimeoutError,
  AgyExitError,
  AgyExecutableNotFoundError,
  AgyError,
  AgyConversationResumeError,
} from '../../agy/agyClient.js';
import { AgyStructuredOutputError, parseAgyJsonObject, isNonEmptyString } from '../../agy/agyJson.js';
import { AGY_SUPERVISOR_DEFAULT_MODEL } from '../../agy/agyConfig.js';
import { parseTaskCard, REQUIRED_FIELDS } from '../taskCard.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../errors.js';

const ACTIONS = new Set(['NEXT_TASK', 'CONTINUE_REWORK', 'WORKFLOW_DONE', 'HUMAN_REQUIRED', 'OUT_OF_SCOPE']);
const SCALAR_TASK_FIELDS = ['task_id', 'goal', 'context', 'scope', 'completion_signal'];
const LIST_TASK_FIELDS = ['allowed_files', 'forbidden_files', 'acceptance_criteria', 'verification_commands'];

// ── Budget constants (exported for tests) ───────────────────────────
export const GOAL_CHAR_LIMIT = 2000;
export const RATIONALE_LIMIT = 500;
export const FINDING_LIMIT = 300;
export const NORMAL_TARGET = 15_000;
export const HARD_LIMIT = 25_000;

function invalid(message) {
  return new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, message);
}


// ── Compact projection helpers (deterministic, no model calls) ──────

/**
 * Deterministically truncate the workflowGoal to at most GOAL_CHAR_LIMIT chars.
 * Returns the original text if it's already short enough, otherwise the first
 * N chars plus a stable marker.
 *
 * When truncation occurs and `plannedTasks` is available, a compact task index
 * is appended so the Supervisor never loses task IDs / goals that appear past
 * the truncation boundary.
 */
export function buildCompactGoal(workflowGoal, limit = GOAL_CHAR_LIMIT, plannedTasks = null) {
  if (!isNonEmptyString(workflowGoal)) return '(none provided)';
  if (workflowGoal.length <= limit) return workflowGoal;

  let result = workflowGoal.slice(0, limit)
    + `\n[… truncated from ${workflowGoal.length} to ${limit} chars — full goal in workflow state]`;

  // Append a compact task index so tail-of-plan tasks are never invisible.
  if (Array.isArray(plannedTasks) && plannedTasks.length > 0) {
    const taskIndex = plannedTasks
      .map((t) => {
        const id = t.task_id ?? t.id ?? '?';
        const goal = t.goal ? truncField(t.goal, 120) : '';
        return goal ? `- ${id}: ${goal}` : `- ${id}`;
      })
      .join('\n');
    result += `\n\nPlanned tasks (complete index):\n${taskIndex}`;
  }

  return result;
}

/**
 * Project the history array into compact one-line summaries.
 * Each entry: "taskId: STATUS (N attempts)" — no execution reports, no
 * evidence blobs, no reviewer prose.
 */
export function buildCompactHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return 'none';
  return history
    .map((entry, i) => {
      if (typeof entry === 'string') return `${i + 1}. ${entry}`;
      const id = entry.task_id ?? `task-${i + 1}`;
      const dec = entry.decision ?? 'PASS';
      const att = entry.attempts !== undefined ? ` (${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'})` : '';
      return `${i + 1}. ${id}: ${dec}${att}`;
    })
    .join('\n');
}

/**
 * Truncate a single string field to `limit` chars.
 */
function truncField(value, limit) {
  if (typeof value !== 'string') return value;
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '…';
}

/**
 * Clean and cap rationale text: strip internal Node test runner frames, then
 * truncate to RATIONALE_LIMIT.
 */
function cleanRationale(rationale) {
  if (!rationale || typeof rationale !== 'string') return '';
  const cleaned = rationale
    .split('\n')
    .filter((line) => {
      // Drop internal node test runner frames and async hooks
      if (/^\s*at\s+(?:TestContext|Test\.run|Test\.start|startSubtest|processTicksAndRejections|node:internal|node:async_hooks)/.test(line)) {
        return false;
      }
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncField(cleaned, RATIONALE_LIMIT);
}

/**
 * Project a finding (from structured reviewer output) to a compact one-liner.
 * Keeps: severity, file/path, concise issue text.
 */
function compactFinding(finding) {
  if (typeof finding === 'string') return truncField(finding, FINDING_LIMIT);
  if (finding && typeof finding === 'object') {
    const parts = [];
    if (finding.severity) parts.push(`[${finding.severity}]`);
    if (finding.file || finding.path) parts.push(finding.file || finding.path);
    if (finding.issue || finding.message || finding.description) {
      parts.push(truncField(finding.issue || finding.message || finding.description, FINDING_LIMIT));
    }
    return parts.join(' ') || JSON.stringify(finding).slice(0, FINDING_LIMIT);
  }
  return String(finding).slice(0, FINDING_LIMIT);
}

/**
 * Build a compact review result block that keeps only the fields needed for
 * the Supervisor to decide CONTINUE_REWORK vs HUMAN_REQUIRED.
 *
 * Preserved: decision, task_id, required_changes (compacted), rationale (capped).
 * Dropped: full evidence, execution reports, verbose prose.
 */
export function buildCompactReviewResult(reviewResult) {
  if (!reviewResult) return 'none';
  if (reviewResult.decision === 'PASS') {
    return 'Previous task PASSED. No task currently in rework.';
  }

  const lines = [`decision: ${reviewResult.decision}`];
  lines.push(`task_id: ${reviewResult.task_id ?? 'current'}`);

  // Required changes — keep as compact list
  if (Array.isArray(reviewResult.required_changes)) {
    lines.push('required_changes:');
    for (const c of reviewResult.required_changes) {
      lines.push(`- ${compactFinding(c)}`);
    }
  } else if (reviewResult.required_changes && reviewResult.required_changes !== 'none') {
    lines.push(`required_changes:\n- ${truncField(String(reviewResult.required_changes), FINDING_LIMIT)}`);
  } else {
    lines.push('required_changes: none');
  }

  // Findings — structured severity/file/issue if available
  if (Array.isArray(reviewResult.findings) && reviewResult.findings.length > 0) {
    lines.push('findings:');
    for (const f of reviewResult.findings) {
      lines.push(`- ${compactFinding(f)}`);
    }
  }

  // Rationale — capped
  const capped = cleanRationale(reviewResult.rationale);
  if (capped) lines.push(`rationale: ${capped}`);

  // Source and round — small, useful for debugging
  if (reviewResult.source) lines.push(`source: ${reviewResult.source}`);
  if (reviewResult.round !== undefined) lines.push(`round: ${reviewResult.round}`);

  return lines.join('\n');
}


function renderRepositoryContext(ctx) {
  const c = ctx ?? {};
  return `repository_name: ${c.repository_name ?? 'unknown'}
repository_url: ${c.repository_url ?? 'none'}
branch: ${c.branch ?? 'unknown'}
commit_sha: ${c.commit_sha ?? 'unknown'}`;
}


function renderCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const completed = Array.isArray(checkpoint.completed_tasks) && checkpoint.completed_tasks.length > 0
    ? checkpoint.completed_tasks.map((t) => `${t.task_id} (${t.status})`).join(', ')
    : 'none';
  return `\n# Workflow Checkpoint (Rotated Conversation)
This Supervisor session was rotated for context efficiency. The orchestrator maintains full continuity:
- Overall Goal: ${checkpoint.overall_goal ?? 'in progress'}
- Completed Tasks: ${completed}
- Current Rework Task: ${checkpoint.current_task ? JSON.stringify(checkpoint.current_task) : 'none'}
- Workflow Invariants: verified clean worktree, single task at a time
\n`;
}


// ── Prompt budget enforcement ───────────────────────────────────────

/**
 * If the prompt exceeds the hard limit, deterministically trim the history
 * section first (oldest entries removed), then the goal section.  If still
 * over, return { budgetExceeded: true }.
 */
export function enforcePromptBudget(prompt, limit = HARD_LIMIT) {
  const len = typeof prompt === 'string' ? prompt.length : 0;
  if (len <= limit) {
    return { prompt, budgetExceeded: false, originalLength: len, limit };
  }

  // Hard truncate to limit chars (last resort)
  const truncated = prompt.slice(0, limit);
  const marker = `\n\n[SUPERVISOR_CONTEXT_BUDGET_EXCEEDED — prompt truncated from ${len} to ${limit} chars]`;
  return {
    prompt: truncated + marker,
    budgetExceeded: true,
    originalLength: len,
    limit,
  };
}


// ── Main prompt builder ─────────────────────────────────────────────

export function buildAgySupervisorPrompt(context = {}) {
  const { workflowGoal, repositoryContext, history, latestReviewResult, checkpoint, plannedTasks } = context;
  const reworkInProgress = latestReviewResult && latestReviewResult.decision && latestReviewResult.decision !== 'PASS';

  const shapeBlock = reworkInProgress
    ? `{
  "action": "CONTINUE_REWORK" | "HUMAN_REQUIRED",
  "reason": "<why only a human can decide>",   // REQUIRED iff action == "HUMAN_REQUIRED"
  "question": "<the specific question for the human>"  // REQUIRED iff action == "HUMAN_REQUIRED"
}`
    : `{
  "action": "NEXT_TASK" | "CONTINUE_REWORK" | "WORKFLOW_DONE" | "HUMAN_REQUIRED",
  "task_card": {                       // REQUIRED iff action == "NEXT_TASK", omit otherwise
    "task_id": "<short-unique-id>",
    "repository_context": { "repository_name": "<name>", "repository_url": "<url or 'none'>", "branch": "<branch>", "commit_sha": "<sha or 'unknown'>" },
    "goal": "<1-3 sentences>",
    "context": "<background the executor needs>",
    "scope": "<in scope / out of scope>",
    "allowed_files": ["<path or glob>", "..."],
    "forbidden_files": ["<path or glob>"],          // [] if none
    "acceptance_criteria": ["<checkable condition>", "..."],
    "verification_commands": ["<shell command that exits non-zero on failure>", "..."],
    "completion_signal": "DONE"
  },
  "summary": "<what was accomplished>",  // REQUIRED iff action == "WORKFLOW_DONE"
  "reason": "<why only a human can decide>",   // REQUIRED iff action == "HUMAN_REQUIRED"
  "question": "<the specific question for the human>"  // REQUIRED iff action == "HUMAN_REQUIRED"
}`;

  // ── Compact projections (deterministic, no model calls) ───────────
  const compactGoal = buildCompactGoal(workflowGoal, GOAL_CHAR_LIMIT, plannedTasks);
  const compactHistory = buildCompactHistory(history);
  const compactReview = buildCompactReviewResult(latestReviewResult);

  return `You are the Supervisor in an automated development loop. Decide the single next step.

Reply with ONLY one JSON object, no prose, no code fence. Shape:

${shapeBlock}

Rules:
- One task at a time. Derive each task ONLY from the plan below.
- completion_signal must be exactly "DONE".
- Use CONTINUE_REWORK to re-run the current task after the Reviewer asked for changes; do NOT include rework instructions — the orchestrator rebuilds the rework run from the Reviewer's required_changes. CONTINUE_REWORK carries no task_card.
- Use HUMAN_REQUIRED only for a genuine product/architecture/credentials/irreversible-action decision. A failing test or a REWORK verdict is NOT a reason for HUMAN_REQUIRED.
- ${reworkInProgress
    ? 'A rework is IN PROGRESS on the current task (see "Latest Review Result"): reply with CONTINUE_REWORK or HUMAN_REQUIRED only.'
    : 'No task is mid-rework: reply with NEXT_TASK, WORKFLOW_DONE, or HUMAN_REQUIRED only.'}
- When every task in the plan has a PASS in the history, reply WORKFLOW_DONE.
${renderCheckpoint(checkpoint)}
# Plan (authoritative)
${compactGoal}

# Repository context (copy into task_card.repository_context)
${renderRepositoryContext(repositoryContext)}

# Task history (each entry: task_id, decision, attempts)
${compactHistory}

# Latest Review Result
${compactReview}

Reply with the JSON object now.`;
}

// task_card object -> canonical "## field_name" document for parseTaskCard.
function taskCardObjectToDocument(tc) {
  if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) {
    throw invalid('NEXT_TASK decision is missing a "task_card" object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in tc)) throw invalid(`NEXT_TASK task_card is missing "${field}"`);
  }
  for (const field of SCALAR_TASK_FIELDS) {
    if (!isNonEmptyString(tc[field])) throw invalid(`NEXT_TASK task_card field "${field}" must be a non-empty string`);
  }
  for (const field of LIST_TASK_FIELDS) {
    if (!Array.isArray(tc[field])) throw invalid(`NEXT_TASK task_card field "${field}" must be an array`);
  }

  const rc = tc.repository_context;
  if (rc === null || typeof rc !== 'object' || Array.isArray(rc)) {
    throw invalid('NEXT_TASK task_card.repository_context must be an object');
  }

  const renderList = (items, prefix = '- ') =>
    items.length ? items.map((x) => `${prefix}${x}`).join('\n') : 'none';

  return `## task_id
${tc.task_id}

## repository_context
repository_name: ${rc.repository_name ?? 'unknown'}
repository_url: ${rc.repository_url ?? 'none'}
branch: ${rc.branch ?? 'unknown'}
commit_sha: ${rc.commit_sha ?? 'unknown'}

## goal
${tc.goal}

## context
${tc.context}

## scope
${tc.scope}

## allowed_files
${renderList(tc.allowed_files)}

## forbidden_files
${renderList(tc.forbidden_files)}

## acceptance_criteria
${tc.acceptance_criteria.length ? tc.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n') : 'none'}

## verification_commands
${tc.verification_commands.length ? tc.verification_commands.map((c) => `- \`${c}\``).join('\n') : 'none'}

## completion_signal
${tc.completion_signal}`;
}

export function parseSupervisorJson(obj) {
  const action = obj.action;
  if (!ACTIONS.has(action)) {
    throw invalid(`supervisor JSON "action" must be one of NEXT_TASK, CONTINUE_REWORK, WORKFLOW_DONE, HUMAN_REQUIRED, OUT_OF_SCOPE — got: ${JSON.stringify(action)}`);
  }

  if (action === 'CONTINUE_REWORK') {
    const res = { action };
    if (isNonEmptyString(obj.guidance)) res.guidance = obj.guidance.trim();
    if (isNonEmptyString(obj.repair_guidance)) res.repair_guidance = obj.repair_guidance.trim();
    if (isNonEmptyString(obj.strategy)) res.strategy = obj.strategy.trim();
    if (isNonEmptyString(obj.executor_model)) res.executor_model = obj.executor_model.trim();
    if (isNonEmptyString(obj.model)) res.model = obj.model.trim();
    if (isNonEmptyString(obj.provider)) res.provider = obj.provider.trim();
    return res;
  }

  if (action === 'OUT_OF_SCOPE') {
    return {
      action: 'OUT_OF_SCOPE',
      reason: isNonEmptyString(obj.reason) ? obj.reason.trim() : 'Supervisor judged finding as OUT_OF_SCOPE',
    };
  }
  if (action === 'WORKFLOW_DONE') {
    if (!isNonEmptyString(obj.summary)) throw invalid('WORKFLOW_DONE decision must include a non-empty "summary"');
    return { action, summary: obj.summary.trim() };
  }
  if (action === 'HUMAN_REQUIRED') {
    if (!isNonEmptyString(obj.reason)) throw invalid('HUMAN_REQUIRED decision must include a non-empty "reason"');
    if (!isNonEmptyString(obj.question)) throw invalid('HUMAN_REQUIRED decision must include a non-empty "question"');
    return { action, reason: obj.reason.trim(), question: obj.question.trim() };
  }

  // NEXT_TASK
  let taskCard;
  try {
    taskCard = parseTaskCard(taskCardObjectToDocument(obj.task_card));
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw invalid(`NEXT_TASK task_card is invalid: ${err.message}`);
  }
  return { action, task_card: taskCard };
}


function mapAgyError(err, model) {
  const isTimeout = err instanceof AgyTimeoutError;
  const isAgy =
    isTimeout ||
    err instanceof AgyExecutableNotFoundError ||
    err instanceof AgyExitError ||
    err instanceof AgyError;
  if (!isAgy) return err;

  const code = isTimeout ? ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT : ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE;
  const details = {
    role: 'supervisor',
    model: model ?? null,
    agyErrorName: err.name,
    agyCode: err.code ?? null,
    exitCode: Number.isFinite(err.exitCode) ? err.exitCode : null,
    stderr: typeof err.stderr === 'string' ? err.stderr : null,
    durationMs: Number.isFinite(err.durationMs) ? err.durationMs : null,
    agyEnvelope: err.envelope && typeof err.envelope === 'object' ? err.envelope : null,
    providerFailure: /quota|rate.?limit|usage limit/i.test(err.stderr ?? '') ? 'PROVIDER_QUOTA_EXHAUSTED'
      : /auth|required|login|credential/i.test(err.stderr ?? '') ? 'PROVIDER_AUTH_FAILED'
        : isTimeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
  };
  return new AdapterError(code, err.message, details);
}

export function createAgySupervisorProvider({
  callAgy = defaultCallAgy,
  model = AGY_SUPERVISOR_DEFAULT_MODEL,
  timeoutMs = 180_000,
  jsonSchema,
  signal,
} = {}) {
  return {
    model,
    // conversationId (optional): resume this persistent Supervisor
    // conversation. Forwarded verbatim to callAgy, which fails closed
    // (AgyConversationResumeError) if agy cannot resume exactly it. The
    // returned decision carries `conversationId` — the id agy actually used
    // (newly created on the first call, echoed back on every resume) — so
    // the caller can capture it once and reuse it thereafter.
    async decide(context = {}, { conversationId, effort } = {}) {
      const prompt = buildAgySupervisorPrompt(context);

      // ── Budget enforcement ──────────────────────────────────────────
      const budget = enforcePromptBudget(prompt);
      if (budget.budgetExceeded) {
        throw new AdapterError(
          ADAPTER_ERROR_CODES.SUPERVISOR_CONTEXT_BUDGET_EXCEEDED,
          `Supervisor prompt exceeded hard limit: ${budget.originalLength} chars > ${budget.limit} char budget. ` +
          `Context must be compacted further before calling the model.`,
          {
            role: 'supervisor',
            originalLength: budget.originalLength,
            limit: budget.limit,
          },
        );
      }

      let result;
      try {
        result = await callAgy({ prompt, model, timeoutMs, jsonSchema, conversationId, signal });
      } catch (err) {
        if (err instanceof AgyConversationResumeError) throw err;
        throw mapAgyError(err, model);
      }

      let obj;
      try {
        obj = parseAgyJsonObject(result);
      } catch (err) {
        if (err instanceof AgyStructuredOutputError) throw invalid(err.message);
        throw err;
      }
      const callId = `call-agy-sup-${randomUUID()}`;
      const decision = {
        ...parseSupervisorJson(obj),
        conversationId: result.conversationId ?? null,
      };
      const usageWithCallId = result.usage ? { ...result.usage, callId } : { callId };
      try {
        Object.defineProperties(decision, {
          callId: { value: callId, writable: true, configurable: true, enumerable: false },
          usage: { value: usageWithCallId, writable: true, configurable: true, enumerable: false },
          durationMs: { value: result.durationMs ?? null, writable: true, configurable: true, enumerable: false },
          // agy has no documented effort control; do not send an unsupported flag.
          effortResolved: { value: null, writable: true, configurable: true, enumerable: false },
        });
      } catch {
        /* best effort */
      }
      return decision;
    },
  };
}
