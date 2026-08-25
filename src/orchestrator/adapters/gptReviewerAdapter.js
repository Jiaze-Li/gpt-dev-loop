// GPT Reviewer Adapter — docs/workflow/ADAPTER_INTERFACE.md §2:
// review(task_card, execution_report, evidence) -> review_result
// (shaped per REVIEW_RESULT.md §2).
//
// Wraps the existing ChatGPT Web Bridge (`askGpt`, src/bridge/chatgptWeb.js
// — the same function src/mcp/server.js's `ask_gpt` tool calls) as one
// concrete implementation of the Reviewer Adapter. The core Workflow
// Manager never imports this file — per ADAPTER_INTERFACE.md §4 the core
// only knows the `review(task_card, execution_report, evidence) ->
// review_result` signature; wiring a real reviewer in is the caller's job.
// Does not modify the browser bridge or the MCP transport.

import { askGpt } from '../../bridge/chatgptWeb.js';
import { TransportError, ResponseTimeoutError, RequestTimeoutError } from '../../bridge/errors.js';
import { loadConfig, workflowProfileDir } from '../../config.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../errors.js';

const RESULT_FIELDS = ['task_id', 'repository_context', 'decision', 'findings', 'required_changes', 'rationale'];
const DECISIONS = new Set(['PASS', 'REWORK', 'HUMAN_REQUIRED']);

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
function renderTaskCard(taskCard) {
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
${taskCard.completion_signal}`;
}

// EXECUTION_REPORT.md §3 template, filled from the in-memory execution_report.
function renderExecutionReport(executionReport) {
  const issues = Array.isArray(executionReport.issues) ? renderList(executionReport.issues) : executionReport.issues ?? 'none';
  return `## task_id
${executionReport.task_id}

## repository_context
${renderRepositoryContext(executionReport.repository_context)}

## status
${executionReport.status}

## changed_files
${renderList(executionReport.changed_files)}

## tests_run
${renderList(executionReport.tests_run)}

## test_results
${renderList(executionReport.test_results)}

## issues
${issues}

## next_recommendation
${executionReport.next_recommendation}`;
}

// ARCHITECTURE.md §5 / STATE_MACHINE.md §1 REVIEWING: Git diff/base-head
// coordinates plus gate results. `evidence` is whatever the Gate Runner
// adapter produced (STATE_MACHINE.md §1 VERIFYING's test_results), plus
// git diff/base-head coordinates when the caller supplies them — this
// renders whichever fields are present rather than assuming one fixed
// evidence shape.
function renderEvidence(evidence) {
  const sections = [];

  if (evidence?.status) {
    // Phase 6.3.1: an empty diff is a valid evidence state, not an error —
    // the Git Evidence Collector only reports CHANGED/NO_CHANGES as fact;
    // whether NO_CHANGES is acceptable for this task is the reviewer's call
    // against the Task Card's acceptance_criteria, not the collector's.
    sections.push(`### diff status\n${evidence.status}`);
  }
  if (evidence?.base || evidence?.head) {
    sections.push(`### base/head\nbase: ${evidence.base ?? 'none'}\nhead: ${evidence.head ?? 'none'}`);
  }
  if (evidence?.diff !== undefined) {
    sections.push(`### git diff\n\`\`\`diff\n${evidence.diff || '(no changes)'}\n\`\`\``);
  }

  const results = evidence?.results ?? [];
  const resultLines = results.length
    ? results.map((result) => `- \`${result.command}\`: ${result.pass ? 'pass' : 'fail'} — ${result.output ?? ''}`).join('\n')
    : 'none';
  sections.push(`### gate results\noverall pass: ${evidence?.pass ?? 'unknown'}\n${resultLines}`);

  return sections.join('\n\n');
}

// Instructs GPT to act as Reviewer and reply with nothing but a
// REVIEW_RESULT.md §3-shaped document, so parseReviewResult can recover it
// deterministically.
// Repository Context header (Phase 6.3.1): a plain-language block up front
// so GPT can state which repository/branch/commit it is reviewing without
// having to dig for it inside the Task Card body. The Task Card is still
// the authoritative source (TASK_PROTOCOL.md §2's repository_context is
// "which repository this Task Card belongs to"); the Execution Report's
// repository_context is used as a fallback only if the Task Card omitted
// one.
function renderRepositoryHeader(taskCard, executionReport) {
  const ctx = taskCard.repository_context ?? executionReport.repository_context ?? {};
  return `Repository:
${ctx.repository_name ?? 'unknown'}

GitHub:
${ctx.repository_url ?? 'none'}

Branch:
${ctx.branch ?? 'unknown'}

Commit:
${ctx.commit_sha ?? 'unknown'}`;
}

function buildPrompt(taskCard, executionReport, evidence) {
  return `You are the Reviewer in an automated dev loop. Judge whether the Execution Report below satisfies the Task Card's acceptance_criteria, using the evidence provided. Per REVIEW_POLICY.md, judge intent-alignment — do not merely restate the gate pass/fail already shown in the evidence. If the evidence's diff status is NO_CHANGES, decide for yourself whether that's acceptable for this task's acceptance_criteria — the evidence only reports the fact, not the verdict.

${renderRepositoryHeader(taskCard, executionReport)}

Reply with ONLY a Review Result: one Markdown document, one "## field_name" heading per field, in exactly this order: task_id, repository_context, decision, findings, required_changes, rationale. repository_context here is the commit this review was actually performed against. No text before or after it.

# Task Card (TASK_PROTOCOL.md)

${renderTaskCard(taskCard)}

# Execution Report (EXECUTION_REPORT.md)

${renderExecutionReport(executionReport)}

# Evidence

${renderEvidence(evidence)}

# Review Result template

## task_id
${taskCard.task_id}

## repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <the commit this review was performed against>

## decision
PASS | REWORK | HUMAN_REQUIRED

## findings
- <specific observation, tied to a file/criterion/behavior>

## required_changes
- <specific, actionable change; or "none" if PASS>

## rationale
<why this decision, tied to acceptance_criteria>`;
}

function parseList(raw) {
  if (raw.trim().toLowerCase() === 'none') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

// Splits GPT's reply on "## field_name" headings (TASK_PROTOCOL.md §1
// convention) and validates it against REVIEW_RESULT.md §2.
function parseReviewResult(taskId, text) {
  const headingRe = /^##\s+(\w+)\s*$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length === 0) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
      'reviewer output contained no Review Result headings'
    );
  }

  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[name] = text.slice(start, end).trim();
  }

  for (const field of RESULT_FIELDS) {
    if (!(field in sections)) {
      throw new AdapterError(
        ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
        `reviewer output is missing the "${field}" section`
      );
    }
  }

  if (!DECISIONS.has(sections.decision)) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
      `reviewer output has an invalid decision: "${sections.decision}"`
    );
  }

  if (sections.task_id !== taskId) {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
      `reviewer Review Result task_id "${sections.task_id}" does not match Task Card task_id "${taskId}"`
    );
  }

  const requiredChanges = parseList(sections.required_changes);

  return {
    task_id: sections.task_id,
    repository_context: parseRepositoryContext(sections.repository_context),
    decision: sections.decision,
    findings: parseList(sections.findings),
    required_changes: requiredChanges.length ? requiredChanges : 'none',
    rationale: sections.rationale,
  };
}

// workflowId (ORCHESTRATOR_DESIGN.md/PERSISTENCE.md's workflow_id), when
// given, scopes this adapter's Chrome profile to
// workflows/<workflow_id>/chrome-profile instead of the shared default
// profile dir — see workflowProfileDir in config.js. Without it, the
// adapter falls back to the shared profile dir from `config`, unchanged
// from before this scoping existed.
export function createGptReviewerAdapter({ askGptFn = askGpt, config = loadConfig(), workflowId } = {}) {
  const effectiveConfig = workflowId
    ? { ...config, profileDir: workflowProfileDir(workflowId, config.profileDir) }
    : config;

  return {
    async review(taskCard, executionReport, evidence) {
      const prompt = buildPrompt(taskCard, executionReport, evidence);

      let reply;
      try {
        reply = await askGptFn(prompt, effectiveConfig);
      } catch (err) {
        if (err instanceof ResponseTimeoutError || err instanceof RequestTimeoutError) {
          throw new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT, err.message);
        }
        if (err instanceof TransportError) {
          throw new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE, err.message);
        }
        throw new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE, err.message);
      }

      return parseReviewResult(taskCard.task_id, reply);
    },
  };
}
