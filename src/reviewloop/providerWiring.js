// Production wiring for the ReviewLoop controller.
//
// Builds the internal Reviewer / Supervisor pool (RoleRouter -> capability ->
// quota -> health -> selected family -> caller crosses ModelSpendAuthority ->
// selected transport) and the PR backend. Nothing here performs a model call
// or a GitHub trigger at construction time.
//
// Active roles are exactly reviewer + supervisor. No Planner, no Executor.
//
// Malformed / unparseable / schema-invalid provider output NEVER becomes an
// empty finding list — it is surfaced as { malformed: true, ... } so the
// normalizer fails it closed (FAILED -> HUMAN_REQUIRED).

import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import { resolveAgyReviewerModel, resolveAgySupervisorModel } from '../agy/agyConfig.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  EffortPolicy,
} from '../orchestrator/roleRouting.js';
import { createGithubReviewBackend } from './githubBackend.js';

export const ACTIVE_ROLE_POOLS = Object.freeze(Object.keys(DEFAULT_ROLE_POLICY));

const SEVERITIES = new Set(['P1', 'P2', 'P3']);

// Strict shape validation of a parsed Reviewer payload. Returns the payload
// unchanged when it is a well-formed findings list, or a malformed marker.
export function validateReviewerPayload(parsed, { raw } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true, reason: 'reviewer output is not a JSON object', raw };
  }
  if (!Array.isArray(parsed.findings)) {
    return { malformed: true, reason: 'reviewer output has no "findings" array', raw };
  }
  for (const f of parsed.findings) {
    if (!f || typeof f !== 'object') {
      return { malformed: true, reason: 'a finding is not an object', raw };
    }
    const sev = String(f.severity ?? '').trim().toUpperCase();
    if (!SEVERITIES.has(sev)) {
      return { malformed: true, reason: `a finding has an invalid severity: ${JSON.stringify(f.severity)}`, raw };
    }
    if (!String(f.title ?? f.message ?? '').trim()) {
      return { malformed: true, reason: 'a finding has no title/message', raw };
    }
  }
  return parsed;
}

export function validateSupervisorPayload(parsed, { raw } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true, reason: 'supervisor output is not a JSON object', raw };
  }
  const rec = String(parsed.recommendation ?? '').trim().toUpperCase();
  if (rec !== 'REWORK' && rec !== 'HUMAN_REQUIRED') {
    return { malformed: true, reason: `supervisor recommendation must be REWORK|HUMAN_REQUIRED, got ${JSON.stringify(parsed.recommendation)}`, raw };
  }
  if (!String(parsed.guidance ?? '').trim()) {
    return { malformed: true, reason: 'supervisor guidance is empty', raw };
  }
  return { guidance: String(parsed.guidance).trim(), recommendation: rec };
}

function parseJsonish(res) {
  if (res && typeof res.json === 'object' && res.json !== null) return { parsed: res.json, raw: res.json };
  const text = String(res?.text ?? res ?? '');
  try {
    return { parsed: JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()), raw: text };
  } catch {
    return { parsed: null, raw: text };
  }
}

// ---- Reviewer / Supervisor pool -----------------------------------------

export function createReviewLoopProviderPool({
  callAgy = defaultCallAgy,
  env = process.env,
  quotaRegistry = new QuotaPoolRegistry({ filePath: null }),
  providerHealth = new ProviderHealthRegistry(),
} = {}) {
  const reviewerModel = resolveAgyReviewerModel(env);
  const supervisorModel = resolveAgySupervisorModel(env);

  // Per-family transport. Only the agy families have a live adapter in this
  // build; codex/claude remain capability-declared protocol targets but have
  // no wired transport, so they are marked unavailable up front and the
  // RoleRouter skips them (rather than pretending a call can be made).
  const modelForFamily = {
    'agy:gemini': supervisorModel,
    'agy:gpt-oss': reviewerModel,
  };
  const transports = {
    'agy:gemini': async (prompt) => callAgy({ prompt, model: supervisorModel }),
    'agy:gpt-oss': async (prompt) => callAgy({ prompt, model: reviewerModel }),
  };
  for (const family of Object.keys(PRODUCTION_ROLE_CAPABILITIES)) {
    if (!transports[family]) providerHealth.record(family, 'UNAVAILABLE', 'no wired transport in this build');
  }

  const router = new RoleRouter({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry,
    providerHealth,
    effortPolicy: new EffortPolicy(),
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: modelForFamily[family] ?? family.split(':')[1] ?? null,
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      capabilities: {
        roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [],
        supportsReasoningEffort: false,
        supportedEfforts: ['medium'],
      },
    }),
  });

  function route(role, signals = {}) {
    const sel = router.route(role, signals);
    if (!sel) return null;
    return {
      role,
      family: sel.requestedFamily,
      provider: sel.provider,
      model: sel.resolvedModel,
      transport: transports[sel.requestedFamily] ?? null,
    };
  }

  function recordFailure(selection, failure) {
    router.recordFailure({ role: selection.role, requestedFamily: selection.family, provider: selection.provider }, failure);
  }

  return { router, route, recordFailure, transports };
}

// ---- convenience Reviewer / Supervisor callables ------------------------
// Used when the controller does not itself drive routing (kept simple for the
// default path and for wiring inspection). The controller's production path
// prefers routeReviewerFn/routeSupervisorFn so it can bind the real selected
// family into the CallIntent and drive bounded failover.

function buildReviewerInvoke() {
  return async ({ objective, diff, changedFiles, gate, transport, model }) => {
    const prompt = [
      'You are an INDEPENDENT code reviewer. Judge ONLY against the original objective.',
      `ORIGINAL OBJECTIVE: ${objective.goal}`,
      objective.constraints?.length ? `CONSTRAINTS:\n- ${objective.constraints.join('\n- ')}` : '',
      `CHANGED FILES: ${(changedFiles ?? []).join(', ') || '(none)'}`,
      `DETERMINISTIC GATE: ${gate?.verdict ?? 'n/a'}`,
      'GIT DIFF (primary evidence):',
      String(diff ?? ''),
      '',
      'Return JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
      'P1/P2 block completion. P3 does not.',
    ].filter(Boolean).join('\n');
    const res = await transport(prompt);
    const { parsed, raw } = parseJsonish(res);
    const value = validateReviewerPayload(parsed, { raw });
    return { value, usage: res?.usage ?? null, model: res?.model ?? model };
  };
}

function buildSupervisorInvoke() {
  return async ({ objective, blockingFindings, transport, model }) => {
    const prompt = [
      'You are a repair STRATEGIST, not an implementer. You cannot edit code or declare PASS.',
      `ORIGINAL OBJECTIVE: ${objective.goal}`,
      `PERSISTENT BLOCKING FINDINGS:\n${JSON.stringify(blockingFindings, null, 2)}`,
      'Give concise repair guidance for the Worker, or recommend HUMAN_REQUIRED.',
      'Return JSON: {"guidance":"","recommendation":"REWORK|HUMAN_REQUIRED"}.',
    ].join('\n');
    const res = await transport(prompt);
    const { parsed, raw } = parseJsonish(res);
    const value = validateSupervisorPayload(parsed, { raw });
    return { value, usage: res?.usage ?? null, model: res?.model ?? model };
  };
}

export function createProductionReviewLoopProviders({ env = process.env, callAgy, github } = {}) {
  const pool = createReviewLoopProviderPool({ callAgy, env });
  const reviewerInvoke = buildReviewerInvoke();
  const supervisorInvoke = buildSupervisorInvoke();

  return {
    env,
    pool,
    routeReviewerFn: (signals) => pool.route('reviewer', signals),
    routeSupervisorFn: (signals) => pool.route('supervisor', signals),
    recordProviderFailure: pool.recordFailure,
    reviewerFn: async (args) => {
      const sel = args.selection ?? pool.route('reviewer');
      if (!sel?.transport) throw Object.assign(new Error('no eligible Reviewer provider'), { code: 'PROVIDER_UNAVAILABLE' });
      return reviewerInvoke({ ...args, transport: sel.transport, model: sel.model });
    },
    supervisorFn: async (args) => {
      const sel = args.selection ?? pool.route('supervisor');
      if (!sel?.transport) throw Object.assign(new Error('no eligible Supervisor provider'), { code: 'PROVIDER_UNAVAILABLE' });
      return supervisorInvoke({ ...args, transport: sel.transport, model: sel.model });
    },
    reviewerInvoke,
    supervisorInvoke,
    prBackend: createGithubReviewBackend({ github, env }),
  };
}
