// Supervisor structured decision protocol (Issue #2, step 3; revised to a
// section-based format).
//
// Turns the Supervisor's reply from free text into exactly one of four
// machine-parseable decisions an orchestrator can branch on without any
// prose-sniffing:
//
//   NEXT_TASK       — here is the next Task Card to run
//   CONTINUE_REWORK — re-run the CURRENT task card again; the orchestrator
//                     must build the rework prompt itself from the existing
//                     Task Card + the Reviewer's own required_changes +
//                     current repo state. The Supervisor does not (and here
//                     cannot) supply free-text rework instructions of its
//                     own — see parseSupervisorDecision's CONTINUE_REWORK
//                     branch.
//   WORKFLOW_DONE   — the workflow's goal has been met; stop.
//   HUMAN_REQUIRED  — a real product/architecture/credentials/irreversible-
//                     action decision is needed from a human; stop and ask.
//
// This module only builds the prompt and parses the reply. It does not call
// ChatGPT, does not touch SupervisorSession, does not touch Claude/Reviewer,
// and does not implement any loop.
//
// Wire format (deliberately NOT JSON — every other document in this system
// is a Markdown document split on "## field_name" headings: Task Cards
// (taskCard.js), Execution Reports (claudeExecutorAdapter.js), Review
// Results (gptReviewerAdapter.js). This protocol matches that convention
// instead of being the one JSON-shaped exception):
//
//   <ACTION KEYWORD, alone on the first line>
//
//   <body — shape depends on the action, see below>
//
// - NEXT_TASK's body is a complete Task Card, in the EXACT format
//   TASK_PROTOCOL.md §3 defines and taskCard.js's parseTaskCard already
//   parses — reused here verbatim (see parseNextTask below), not
//   reimplemented. There is only ever one Task Card parser in this
//   codebase.
// - CONTINUE_REWORK has no body at all — anything after the action line is
//   rejected, exactly as an extra JSON field used to be rejected. The
//   Supervisor does not get to smuggle rework instructions in here; see the
//   module doc above.
// - WORKFLOW_DONE's body is one "## summary" section.
// - HUMAN_REQUIRED's body is a "## reason" section followed by a
//   "## question" section.
//
// No malformed-output repair is attempted anywhere in this file: a reply
// that doesn't match its action's exact shape throws
// AdapterError(SUPERVISOR_INVALID_OUTPUT) with the raw reply for
// diagnosis, the same as an invalid Task Card/Execution Report/Review
// Result does elsewhere in this codebase. Guessing at what a malformed
// reply "probably meant" is exactly the failure mode this format (and this
// module) exists to avoid.

import { parseTaskCard } from './taskCard.js';
import { AdapterError, ADAPTER_ERROR_CODES } from './errors.js';

export const SUPERVISOR_ACTIONS = Object.freeze({
  NEXT_TASK: 'NEXT_TASK',
  CONTINUE_REWORK: 'CONTINUE_REWORK',
  WORKFLOW_DONE: 'WORKFLOW_DONE',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

const KNOWN_ACTIONS = new Set(Object.values(SUPERVISOR_ACTIONS));

function invalid(message) {
  return new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, message);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function renderRepositoryContext(ctx) {
  if (!ctx) return 'unknown';
  return `repository_name: ${ctx.repository_name ?? 'unknown'}
repository_url: ${ctx.repository_url ?? 'none'}
branch: ${ctx.branch ?? 'unknown'}
commit_sha: ${ctx.commit_sha ?? 'unknown'}`;
}

function renderHistory(history) {
  if (!history || history.length === 0) return 'none';
  return history.map((entry, i) => `${i + 1}. ${JSON.stringify(entry)}`).join('\n');
}

function renderLatestReviewResult(latestReviewResult) {
  if (!latestReviewResult) return 'none';
  return JSON.stringify(latestReviewResult, null, 2);
}

// Builds the Supervisor's prompt for one decision point. `context` carries
// whatever the orchestrator currently knows; none of it is sent anywhere —
// this is pure string assembly.
//
//   context.workflowGoal      — string, the workflow's overall goal
//   context.repositoryContext — { repository_name, repository_url, branch, commit_sha }
//   context.history           — array of plain past-task summary objects (optional)
//   context.latestReviewResult— the most recent Review Result object, or null/omitted
export function buildSupervisorPrompt(context = {}) {
  const { workflowGoal, repositoryContext, history, latestReviewResult } = context;

  return `You are the Supervisor in an automated dev loop. Decide what happens next and reply with a plain-text document in EXACTLY this shape — nothing before it, nothing after it, no markdown code fence around it:

Line 1: ONLY one of these four words, alone on the line: NEXT_TASK, CONTINUE_REWORK, WORKFLOW_DONE, or HUMAN_REQUIRED.
Then a blank line, then a body whose shape depends on that word:

1. Start the next task — body is a complete Task Card, in EXACTLY this template (same convention as every other document in this system: one "## field_name" heading per field, in this order, content filled in for real, never a placeholder):

NEXT_TASK

## task_id
<short unique id>

## repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <sha>

## goal
<1-3 sentences>

## context
<background>

## scope
<in scope / out of scope>

## allowed_files
- <path or glob>

## forbidden_files
- <path or glob, or "none">

## acceptance_criteria
- <checkable condition>

## verification_commands
- \`<command>\`

## completion_signal
DONE | BLOCKED | HUMAN_REQUIRED

2. Re-run the current task after rework, unchanged — body is empty. Reply with ONLY the word on its own, nothing else:

CONTINUE_REWORK

Do not include your own rework instructions here — the orchestrator will build the rework run from the existing Task Card and the Reviewer's own required_changes; anything else you put after this line is invalid.

3. The workflow's goal has been met:

WORKFLOW_DONE

## summary
<what was accomplished>

4. A human decision is required:

HUMAN_REQUIRED

## reason
<why only a human can decide this>

## question
<the specific question for the human>

Use HUMAN_REQUIRED ONLY for something only a human can actually decide: a genuine ambiguity in the product spec/requirements, an architecture decision with no clearly-correct answer, a login/credentials/CAPTCHA block, or confirming an irreversible action. A failing test, a code bug, or the Reviewer returning REWORK are NOT reasons to use this action — those are CONTINUE_REWORK.

# Workflow goal
${workflowGoal ?? 'unknown'}

# Repository context
${renderRepositoryContext(repositoryContext)}

# Task history
${renderHistory(history)}

# Latest Review Result
${renderLatestReviewResult(latestReviewResult)}

Reply with the document now, starting with the action word on line 1. No text before or after it.`;
}

// Splits `text` into { firstLine, body }: firstLine is the trimmed first
// line, body is everything after it (from the first newline onward),
// trimmed. A reply with no newline at all has an empty body.
function splitFirstLine(text) {
  const trimmed = text.trim();
  const newlineIndex = trimmed.indexOf('\n');
  if (newlineIndex === -1) return { firstLine: trimmed, body: '' };
  return { firstLine: trimmed.slice(0, newlineIndex).trim(), body: trimmed.slice(newlineIndex + 1).trim() };
}

// Same "## field_name" splitter taskCard.js/claudeExecutorAdapter.js/
// gptReviewerAdapter.js each already use for their own reply formats —
// kept as a small local copy (not imported) because WORKFLOW_DONE's/
// HUMAN_REQUIRED's own one-or-two-field bodies are a different, much
// smaller shape than any of those documents; NEXT_TASK's body, which IS
// exactly a Task Card, uses taskCard.js's real parser instead of this.
function parseSections(text) {
  const headingRe = /^##\s+(\w+)\s*$/gm;
  const matches = [...text.matchAll(headingRe)];
  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[name] = text.slice(start, end).trim();
  }
  return sections;
}

function parseNextTask(body) {
  if (!isNonEmptyString(body)) {
    throw invalid('NEXT_TASK output has no Task Card body');
  }
  let taskCard;
  try {
    taskCard = parseTaskCard(body);
  } catch (err) {
    throw invalid(`NEXT_TASK task_card is invalid: ${err.message}`);
  }
  return { action: SUPERVISOR_ACTIONS.NEXT_TASK, task_card: taskCard };
}

function parseContinueRework(body) {
  if (isNonEmptyString(body)) {
    throw invalid(
      `CONTINUE_REWORK output must have no body — found: ${body.slice(0, 200)}. CONTINUE_REWORK never carries free-text rework instructions.`
    );
  }
  return { action: SUPERVISOR_ACTIONS.CONTINUE_REWORK };
}

function parseWorkflowDone(body) {
  const sections = parseSections(body);
  if (!isNonEmptyString(sections.summary)) {
    throw invalid('WORKFLOW_DONE output must have a non-empty "## summary" section');
  }
  return { action: SUPERVISOR_ACTIONS.WORKFLOW_DONE, summary: sections.summary };
}

function parseHumanRequired(body) {
  const sections = parseSections(body);
  if (!isNonEmptyString(sections.reason)) {
    throw invalid('HUMAN_REQUIRED output must have a non-empty "## reason" section');
  }
  if (!isNonEmptyString(sections.question)) {
    throw invalid('HUMAN_REQUIRED output must have a non-empty "## question" section');
  }
  return { action: SUPERVISOR_ACTIONS.HUMAN_REQUIRED, reason: sections.reason, question: sections.question };
}

// Parses and validates the Supervisor's reply into exactly one decision
// object of the shape { action, ... }. Throws AdapterError(SUPERVISOR_
// INVALID_OUTPUT) — never returns a partially-valid decision, and never
// attempts to repair a malformed reply — on:
//   - an empty reply, or a first line that isn't exactly one of the four
//     known action words
//   - NEXT_TASK with a missing/invalid Task Card body
//   - CONTINUE_REWORK carrying any body at all
//   - WORKFLOW_DONE with a missing/empty "## summary" section
//   - HUMAN_REQUIRED with a missing/empty "## reason" or "## question" section
export function parseSupervisorDecision(text) {
  if (!isNonEmptyString(text)) {
    throw invalid('supervisor output is empty');
  }

  const { firstLine, body } = splitFirstLine(text);
  if (!KNOWN_ACTIONS.has(firstLine)) {
    throw invalid(
      `supervisor output's first line must be exactly one of NEXT_TASK, CONTINUE_REWORK, WORKFLOW_DONE, HUMAN_REQUIRED — got: "${firstLine}". Raw reply (first 1000 chars): ${text.slice(0, 1000)}`
    );
  }

  switch (firstLine) {
    case SUPERVISOR_ACTIONS.NEXT_TASK:
      return parseNextTask(body);
    case SUPERVISOR_ACTIONS.CONTINUE_REWORK:
      return parseContinueRework(body);
    case SUPERVISOR_ACTIONS.WORKFLOW_DONE:
      return parseWorkflowDone(body);
    case SUPERVISOR_ACTIONS.HUMAN_REQUIRED:
      return parseHumanRequired(body);
    default:
      // Unreachable: KNOWN_ACTIONS.has already guarded this above.
      throw invalid(`supervisor output has an unknown action: "${firstLine}"`);
  }
}
