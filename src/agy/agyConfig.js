// Per-role agy model resolution for the MVP Supervisor + Reviewer path.
//
// The automated workflow runs each role on its own Antigravity model:
//   - Supervisor default: Gemini 3.7 Flash (High)  -> gemini-3.7-flash-high
//   - Reviewer   default: GPT-OSS 120B (Medium)    -> gpt-oss-120b-medium
// Both IDs are the exact machine-usable IDs reported by `agy models` on the
// locally installed CLI (v1.1.22). Reasoning effort is encoded in the ID
// suffix (…-high / …-medium), so no separate --effort flag is needed.
//
// Resolution precedence (fail soft to the role default, never throw):
//   Supervisor: AGY_SUPERVISOR_MODEL -> AGY_MODEL -> gemini-3.7-flash-high
//   Reviewer:   AGY_REVIEWER_MODEL   -> AGY_MODEL -> gpt-oss-120b-medium
//
// AGY_MODEL is kept only as a backward-compatible shared fallback for both
// roles; the per-role vars override it independently.
//
// This is intentionally separate from src/agy/agyClient.js's
// DEFAULT_AGY_MODEL (a conservative default for ad-hoc callers of the raw
// transport) — the workflow wants role-specific models by default.

export const AGY_SUPERVISOR_DEFAULT_MODEL = 'gemini-3.7-flash-high';
export const AGY_REVIEWER_DEFAULT_MODEL = 'gpt-oss-120b-medium';

// Back-compat alias: the previous shared default was the Supervisor model.
export const AGY_WORKFLOW_DEFAULT_MODEL = AGY_SUPERVISOR_DEFAULT_MODEL;

function envValue(env, key) {
  const v = env ? env[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// Human-readable label for the compact orchestrator status stream, e.g.
// "gemini-3.7-flash-high" -> "Gemini 3.7 Flash High".
export function agyModelLabel(model) {
  if (typeof model !== 'string' || model.trim() === '') return '(unknown model)';
  return model
    .split('-')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

// Shared fallback only. Prefer the per-role resolvers below.
export function resolveAgyModel(env = process.env) {
  return envValue(env, 'AGY_MODEL') ?? AGY_SUPERVISOR_DEFAULT_MODEL;
}

export function resolveAgySupervisorModel(env = process.env) {
  return (
    envValue(env, 'AGY_SUPERVISOR_MODEL') ??
    envValue(env, 'AGY_MODEL') ??
    AGY_SUPERVISOR_DEFAULT_MODEL
  );
}

export function resolveAgyReviewerModel(env = process.env) {
  return (
    envValue(env, 'AGY_REVIEWER_MODEL') ??
    envValue(env, 'AGY_MODEL') ??
    AGY_REVIEWER_DEFAULT_MODEL
  );
}
