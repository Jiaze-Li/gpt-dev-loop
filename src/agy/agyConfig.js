// Per-role agy model resolution for the Supervisor + Reviewer path.
//
// ReviewLoop configuration binds each role to an ordered pool of stable model
// FAMILIES, never a concrete released version (see
// src/orchestrator/modelFamilyResolver.js + roleRouting.js DEFAULT_ROLE_POLICY).
// The AGY families in those pools are agy:opus, agy:gemini-reviewer,
// agy:gemini-supervisor, agy:sonnet and agy:gpt-oss; the helpers below resolve
// the two Gemini role heads (Reviewer Gemini head = agy:gemini-reviewer / -low,
// Supervisor head = agy:gemini-supervisor / -medium) and the AGY Claude Opus
// Reviewer primary (agy:opus) for the telemetry/label layers.
//
// Concrete model resolution order (never throws):
//   1. explicit env override — pins a concrete id (tests / benchmark / repro):
//        Supervisor: REVIEWLOOP_GEMINI_SUPERVISOR_MODEL -> AGY_GEMINI_SUPERVISOR_MODEL -> AGY_MODEL
//        Reviewer:   REVIEWLOOP_GEMINI_REVIEWER_MODEL   -> AGY_GEMINI_REVIEWER_MODEL   -> AGY_MODEL
//   2. runtime catalog (`agy models`) — newest entry for the family
//   3. provider default — null; the transport omits --model and the CLI picks
//      its own current default. The concrete model is recovered from the reply
//      envelope and persisted by the telemetry layer.
//
// There is deliberately NO hard-coded concrete default version here anymore.

import { resolveModelFamily } from '../orchestrator/modelFamilyResolver.js';

// Human-readable label for the compact orchestrator status stream, e.g.
// "gemini-3.8-flash-high" -> "Gemini 3.8 Flash High".
export function agyModelLabel(model) {
  if (typeof model !== 'string' || model.trim() === '') return '(unknown model)';
  return model
    .split('-')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

// Shared fallback only: an explicit AGY_MODEL, else null (provider default).
export function resolveAgyModel(env = process.env) {
  const v = env?.AGY_MODEL;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// Concrete Supervisor model id, or null for "let the provider choose".
// `agyCatalog` (ids array / raw `agy models` stdout) enables runtime catalog
// resolution; omit it in deterministic tests.
export function resolveAgySupervisorModel(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:gemini-supervisor', { env, agyCatalog }).resolvedModel;
}

export function resolveAgyReviewerModel(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:gemini-reviewer', { env, agyCatalog }).resolvedModel;
}

// Full resolution record (provider, resolvedFrom, pinnedByEnv, ...) for the
// telemetry / wiring layers.
export function resolveAgySupervisorFamily(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:gemini-supervisor', { env, agyCatalog });
}

export function resolveAgyReviewerFamily(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:gemini-reviewer', { env, agyCatalog });
}

// AGY-hosted Claude Opus (Reviewer primary / first choice). Concrete id resolves from the live
// `agy models` catalog (`catalogPrefix: 'claude-opus-'`) at pool construction —
// never a long-term concrete version pin. null -> provider default.
export function resolveAgyOpusModel(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:opus', { env, agyCatalog }).resolvedModel;
}

export function resolveAgyOpusFamily(env = process.env, { agyCatalog = null } = {}) {
  return resolveModelFamily('agy:opus', { env, agyCatalog });
}
