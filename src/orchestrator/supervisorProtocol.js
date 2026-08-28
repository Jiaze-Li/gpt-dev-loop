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
// Wire format — render-stable plaintext, NOT Markdown headings. The
// Supervisor's reply is not read as raw text: it is read from ChatGPT's
// rendered assistant DOM node (extension/domActions.js's `.markdown`
// innerText). ChatGPT renders a literal "## field_name" line as an actual
// <h2> DOM element, and that element's innerText is just "field_name" — the
// "##" characters never reach this parser. Every OTHER document in this
// system (Task Cards via taskCard.js, Execution Reports via
// claudeExecutorAdapter.js, Review Results via gptReviewerAdapter.js) is
// exchanged as a file or as Claude/Reviewer plain-text output, never
// through ChatGPT's rendered Markdown DOM, so "##" headings survive there.
// Only the Supervisor's replies cross that specific rendering boundary, so
// only this protocol uses a delimiter Markdown does not treat specially:
// "@@ field_name", which ChatGPT renders as a literal, unmodified text
// line.
//
//   <ACTION KEYWORD, alone on the first line>
//
//   <body — shape depends on the action, see below>
//
// - NEXT_TASK's body is a complete Task Card, using "@@ field_name"
//   section markers (instead of "## field_name") for exactly the fields
//   TASK_PROTOCOL.md §3 defines. Before validation, the "@@ field_name"
//   markers are mechanically rewritten to "## field_name" and handed to
//   taskCard.js's existing parseTaskCard — reused verbatim, not
//   reimplemented. There is only ever one Task Card schema/validator in
//   this codebase; this module only translates the wire delimiter.
// - CONTINUE_REWORK has no body at all — anything after the action line is
//   rejected, exactly as an extra JSON field used to be rejected. The
//   Supervisor does not get to smuggle rework instructions in here; see the
//   module doc above.
// - WORKFLOW_DONE's body is one "@@ summary" section.
// - HUMAN_REQUIRED's body is a "@@ reason" section followed by a
//   "@@ question" section.
//
// No malformed-output repair is attempted anywhere in this file: a reply
// that doesn't match its action's exact shape throws
// AdapterError(SUPERVISOR_INVALID_OUTPUT) with the raw reply for
// diagnosis, the same as an invalid Task Card/Execution Report/Review
// Result does elsewhere in this codebase. Guessing at what a malformed
// reply "probably meant" is exactly the failure mode this format (and this
// module) exists to avoid — including a reply that still uses "##"
// Markdown headings instead of "@@" markers, which fails loudly rather
// than being reinterpreted.

import { parseTaskCard, REQUIRED_FIELDS } from './taskCard.js';
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

  return `You are the Supervisor in an automated dev loop. Decide what happens next and reply with a plain-text document in EXACTLY this shape — nothing before it, nothing after it, no markdown code fence around it, and no Markdown formatting anywhere in the document (no "#" headings, no "**bold**", no bullet-list syntax beyond the literal "- " prefix shown below). Your reply is read back from the rendered page, not as raw text, so any characters Markdown would transform (like "#" headings) will NOT survive — use ONLY the literal "@@ field_name" markers shown below to separate fields.

Line 1: ONLY one of these four words, alone on the line: NEXT_TASK, CONTINUE_REWORK, WORKFLOW_DONE, or HUMAN_REQUIRED.
Then a blank line, then a body whose shape depends on that word:

1. Start the next task — body is a complete Task Card, in EXACTLY this template (one "@@ field_name" marker per field, in this order, content filled in for real, never a placeholder — do NOT write "## field_name", write "@@ field_name" exactly as shown):

NEXT_TASK

@@ task_id
<short unique id>

@@ repository_context
repository_name: <name>
repository_url: <url, or "none">
branch: <branch>
commit_sha: <sha>

@@ goal
<1-3 sentences>

@@ context
<background>

@@ scope
<in scope / out of scope>

@@ allowed_files
- <path or glob>

@@ forbidden_files
- <path or glob, or "none">

@@ acceptance_criteria
- <checkable condition>

@@ verification_commands
- \`<command>\`

@@ completion_signal
DONE

For a normal executable NEXT_TASK, completion_signal must be exactly the
single word DONE — never write the literal string
"DONE | BLOCKED | HUMAN_REQUIRED" here. BLOCKED and HUMAN_REQUIRED remain
possible runtime outcomes the Executor can report back in its Execution
Report; they are not values you plan into the Task Card's completion_signal.

2. Re-run the current task after rework, unchanged — body is empty. Reply with ONLY the word on its own, nothing else:

CONTINUE_REWORK

Do not include your own rework instructions here — the orchestrator will build the rework run from the existing Task Card and the Reviewer's own required_changes; anything else you put after this line is invalid.

3. The workflow's goal has been met:

WORKFLOW_DONE

@@ summary
<what was accomplished>

4. A human decision is required:

HUMAN_REQUIRED

@@ reason
<why only a human can decide this>

@@ question
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

// Render-stable section splitter: splits on "@@ field_name" markers, the
// literal delimiter this protocol uses instead of "## field_name" Markdown
// headings (see the module doc above for why). Kept as a small local copy
// (not imported) because WORKFLOW_DONE's/HUMAN_REQUIRED's own
// one-or-two-field bodies are a different, much smaller shape than a Task
// Card; NEXT_TASK's body is translated to "## field_name" form and handed
// to taskCard.js's real parser instead of this (see parseNextTask below).
function parseSections(text) {
  const headingRe = /^@@\s+(\w+)\s*$/gm;
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

// Structural-only diagnostics for a raw Supervisor reply — used when a
// NEXT_TASK reply fails to parse, so a live run can show the exact wire
// shape GPT actually returned WITHOUT ever logging what any field
// contained. Every value below is a marker NAME, a count, or a length —
// never a section's body text, never the workflow goal/repository
// URL/task content that's baked into the prompt or the reply, so this is
// safe to put in a thrown error message or a console log line.
function extractMarkerNames(text) {
  const headingRe = /^@@\s+(\w+)\s*$/gm;
  return [...text.matchAll(headingRe)].map((match) => match[1]);
}

function findDuplicateMarkerNames(markerNames) {
  const seen = new Set();
  const duplicates = new Set();
  for (const name of markerNames) {
    if (seen.has(name)) duplicates.add(name);
    else seen.add(name);
  }
  return [...duplicates];
}

// Returns { action, markers, duplicates, missing, length } describing the
// shape of `text` (a raw Supervisor reply, or a NEXT_TASK body — either
// works since this only looks at the first line and "@@ field_name"
// marker names). `missing` is only meaningful for a NEXT_TASK reply: the
// subset of taskCard.js's REQUIRED_FIELDS not found among the observed
// markers; it's empty for every other action.
export function describeSupervisorReplyStructure(text) {
  const safeText = typeof text === 'string' ? text : '';
  const { firstLine } = splitFirstLine(safeText);
  const markerNames = extractMarkerNames(safeText);
  const missing =
    firstLine === SUPERVISOR_ACTIONS.NEXT_TASK
      ? REQUIRED_FIELDS.filter((field) => !markerNames.includes(field))
      : [];
  return {
    action: isNonEmptyString(firstLine) ? firstLine : '(empty)',
    markers: markerNames,
    duplicates: findDuplicateMarkerNames(markerNames),
    missing,
    length: safeText.length,
  };
}

// Renders describeSupervisorReplyStructure's result as the fixed-shape,
// field-content-free log/error line documented in the diagnostics work
// item — safe to print to stdout/stderr or embed in a thrown error's
// message even for a reply carrying sensitive prompt/task data.
export function formatSupervisorReplyDiagnostic(text) {
  const d = describeSupervisorReplyStructure(text);
  return `gpt-loop: supervisor response structure:
action=${d.action}
markers=[${d.markers.join(',')}]
missing=[${d.missing.join(',')}]
duplicates=[${d.duplicates.join(',')}]
length=${d.length}`;
}

// Mechanically rewrites this protocol's "@@ field_name" wire markers to
// the "## field_name" Markdown headings taskCard.js's parseTaskCard
// expects. This is a pure delimiter translation, not a second Task Card
// model: the resulting text is fed straight into the existing parser, so
// all of its field/schema validation still applies unchanged. A body that
// uses Markdown "##" headings instead of "@@" markers is left untouched
// here and falls through to parseTaskCard's own "no ## field_name
// headings" failure — no repair, no guessing.
function toTaskCardHeadings(body) {
  return body.replace(/^@@\s+(\w+)\s*$/gm, '## $1');
}

// On any NEXT_TASK parse failure, logs the structural (field-content-free)
// diagnostic and folds it into the thrown error's message so a live run
// shows the exact wire shape GPT returned without ever printing what a
// field contained — see describeSupervisorReplyStructure's doc comment.
function invalidNextTask(body, message) {
  const diagnostic = formatSupervisorReplyDiagnostic(`${SUPERVISOR_ACTIONS.NEXT_TASK}\n${body}`);
  console.error(diagnostic);
  return invalid(`${message}\n${diagnostic}`);
}

function parseNextTask(body) {
  if (!isNonEmptyString(body)) {
    throw invalidNextTask(body, 'NEXT_TASK output has no Task Card body');
  }
  if (!/^@@\s+\w+\s*$/m.test(body)) {
    throw invalidNextTask(
      body,
      'NEXT_TASK task_card is invalid: no "@@ field_name" markers found. The Supervisor must use "@@ field_name" section markers, not "## field_name" Markdown headings — Markdown headings do not survive ChatGPT rendering and are rejected, never guessed at.'
    );
  }
  let taskCard;
  try {
    taskCard = parseTaskCard(toTaskCardHeadings(body));
  } catch (err) {
    throw invalidNextTask(body, `NEXT_TASK task_card is invalid: ${err.message}`);
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
    throw invalid('WORKFLOW_DONE output must have a non-empty "@@ summary" section');
  }
  return { action: SUPERVISOR_ACTIONS.WORKFLOW_DONE, summary: sections.summary };
}

function parseHumanRequired(body) {
  const sections = parseSections(body);
  if (!isNonEmptyString(sections.reason)) {
    throw invalid('HUMAN_REQUIRED output must have a non-empty "@@ reason" section');
  }
  if (!isNonEmptyString(sections.question)) {
    throw invalid('HUMAN_REQUIRED output must have a non-empty "@@ question" section');
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
//   - WORKFLOW_DONE with a missing/empty "@@ summary" section
//   - HUMAN_REQUIRED with a missing/empty "@@ reason" or "@@ question" section
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
