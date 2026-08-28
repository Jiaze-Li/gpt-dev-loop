// AgyReviewerProvider — the MVP Gemini Reviewer, built on src/agy/agyClient.js.
//
// Drop-in for the Reviewer slot the automated loop calls as
// reviewerSession.review(taskId, taskCard, executionReport, evidence). Returns
// a Review Result of the same shape gptReviewerAdapter.js's parseReviewResult
// produces:
//
//   { task_id, repository_context, decision, findings, required_changes, rationale }
//
//   decision       — exactly one of PASS | REWORK | HUMAN_REQUIRED
//   required_changes — array of actionable strings on REWORK (non-empty,
//                      enforced); the string 'none' on PASS/HUMAN_REQUIRED.
//                      Fed straight into the existing fresh-Claude rework
//                      path via automatedLoop's persistence.writeState().
//
// MVP is STATELESS: one fresh `agy` invocation per review() call (rework
// rounds included). The prompt carries the complete current Task Card, the
// attempt number, the Execution Report, and the deterministic gate
// results + Evidence — everything needed to judge intent-alignment without a
// persistent conversation.
//
// Structured output only (JSON object, fail-closed parse). Reuses
// gptReviewerAdapter.js's renderTaskCard / renderExecutionReport /
// renderEvidence so the Reviewer sees the exact same rendered inputs the
// Chrome Reviewer does — no second rendering path.

import { callAgy as defaultCallAgy } from '../../agy/agyClient.js';
import {
  AgyTimeoutError,
  AgyExitError,
  AgyExecutableNotFoundError,
  AgyError,
} from '../../agy/agyClient.js';
import { AgyStructuredOutputError, parseAgyJsonObject, isNonEmptyString } from '../../agy/agyJson.js';
import { AGY_REVIEWER_DEFAULT_MODEL } from '../../agy/agyConfig.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../errors.js';
import { renderReviewInputs } from './gptReviewerAdapter.js';

const DECISIONS = new Set(['PASS', 'REWORK', 'HUMAN_REQUIRED']);

function invalid(message) {
  return new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT, message);
}

export function buildAgyReviewPrompt(taskCard, executionReport, evidence, { attempt } = {}) {
  return `You are the Reviewer in an automated development loop. Judge whether the Execution Report satisfies the Task Card's acceptance_criteria, using the evidence. Judge intent-alignment — do not merely restate the gate pass/fail shown in the evidence.

This is attempt ${attempt ?? 'unknown'} for this task.

Reply with ONLY one JSON object, no prose, no code fence. Shape:

{
  "decision": "PASS" | "REWORK" | "HUMAN_REQUIRED",
  "findings": ["<specific observation tied to a file/criterion/behavior>", "..."],
  "required_changes": ["<specific actionable change>", "..."],   // MUST be non-empty when decision == "REWORK"; use [] for PASS
  "rationale": "<why this decision, tied to acceptance_criteria>"
}

Use HUMAN_REQUIRED only for a genuine ambiguity a human must resolve, not for a fixable defect (that is REWORK).

${renderReviewInputs(taskCard, executionReport, evidence)}

Reply with the JSON object now.`;
}

export function parseReviewJson(taskId, obj, repositoryContext) {
  const decision = obj.decision;
  if (!DECISIONS.has(decision)) {
    throw invalid(`reviewer JSON "decision" must be one of PASS, REWORK, HUMAN_REQUIRED — got: ${JSON.stringify(decision)}`);
  }

  const findings = Array.isArray(obj.findings) ? obj.findings.map(String) : [];
  const rawChanges = Array.isArray(obj.required_changes) ? obj.required_changes.map(String).filter((s) => s.trim() !== '') : [];

  if (decision === 'REWORK' && rawChanges.length === 0) {
    throw invalid('reviewer REWORK decision must include a non-empty "required_changes" array');
  }
  if (!isNonEmptyString(obj.rationale)) {
    throw invalid('reviewer JSON must include a non-empty "rationale"');
  }

  return {
    task_id: taskId,
    repository_context: repositoryContext ?? null,
    decision,
    findings,
    required_changes: rawChanges.length ? rawChanges : 'none',
    rationale: obj.rationale.trim(),
  };
}

// Compact, safe one-liner of agy stderr for the AdapterError message.
// stderr from agy is operational diagnostics (auth / quota / rate-limit /
// usage), never prompt or reply content — see AgyExitError. Full text is
// kept in err.details.stderr; here we only inline a bounded summary.
function summarizeStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.trim() === '') return '';
  const oneLine = stderr.trim().replace(/\s*\n\s*/g, ' | ');
  return oneLine.length > 500 ? `${oneLine.slice(0, 500)}…` : oneLine;
}

// Preserves the high-level REVIEWER_* code AND the safe underlying agy
// diagnostics (exit code, stderr, duration, model) — both inlined into the
// message and structured on err.details for operator logging.
function mapAgyError(err, model) {
  const isTimeout = err instanceof AgyTimeoutError;
  const isAgy =
    isTimeout ||
    err instanceof AgyExecutableNotFoundError ||
    err instanceof AgyExitError ||
    err instanceof AgyError;
  if (!isAgy) return err;

  const code = isTimeout ? ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT : ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE;
  const details = {
    role: 'reviewer',
    model: model ?? null,
    agyErrorName: err.name,
    agyCode: err.code ?? null,
    exitCode: Number.isFinite(err.exitCode) ? err.exitCode : null,
    stderr: typeof err.stderr === 'string' ? err.stderr : null,
    durationMs: Number.isFinite(err.durationMs) ? err.durationMs : null,
    // Safe operational metadata from a non-zero `agy` exit envelope (never
    // generated text) — see src/agy/agyErrorEnvelope.js / AgyExitError.
    agyEnvelope: err.envelope && typeof err.envelope === 'object' ? err.envelope : null,
  };
  const stderrSummary = summarizeStderr(err.stderr);
  const message = stderrSummary ? `${err.message} — agy stderr: ${stderrSummary}` : err.message;
  return new AdapterError(code, message, details);
}

export function createAgyReviewerProvider({
  callAgy = defaultCallAgy,
  model = AGY_REVIEWER_DEFAULT_MODEL,
  timeoutMs = 180_000,
  jsonSchema,
} = {}) {
  return {
    model,
    async review(taskCard, executionReport, evidence, { attempt } = {}) {
      const prompt = buildAgyReviewPrompt(taskCard, executionReport, evidence, { attempt });

      let result;
      try {
        result = await callAgy({ prompt, model, timeoutMs, jsonSchema });
      } catch (err) {
        throw mapAgyError(err, model);
      }

      let obj;
      try {
        obj = parseAgyJsonObject(result);
      } catch (err) {
        if (err instanceof AgyStructuredOutputError) throw invalid(err.message);
        throw err;
      }
      return parseReviewJson(taskCard.task_id, obj, taskCard.repository_context ?? null);
    },
  };
}
