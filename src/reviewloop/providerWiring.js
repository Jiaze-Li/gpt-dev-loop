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

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
  EffortPolicy,
} from '../orchestrator/roleRouting.js';
import { resolveModelFamily, MODEL_FAMILY_REGISTRY } from '../orchestrator/modelFamilyResolver.js';
import { createGithubReviewBackend } from './githubBackend.js';

export const ACTIVE_ROLE_POOLS = Object.freeze(Object.keys(DEFAULT_ROLE_POLICY));

// The Reviewer / Supervisor are NARROW single-turn inference, not a second
// coding Worker. The agy transport runs from an isolated empty scratch dir so
// there is no repo, no GEMINI.md, no project/agent memory for the CLI to
// preload; slash/skill expansion is disabled and no conversation is resumed.
// This is the lightest mode `agy` offers — any residual transport context tax
// is MEASURED (payloadMeta / contextOverheadTokens in the durable spend
// record), never hidden.
let narrowCwd;
export function narrowReviewTransportCwd() {
  if (narrowCwd) return narrowCwd;
  const dir = path.join(os.tmpdir(), 'reviewloop-review-transport');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort; agy still runs */ }
  narrowCwd = dir;
  return dir;
}

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

// callAgy() resolves to the TRANSPORT envelope:
//   { model, exitCode, text, json, stdout, durationMs, conversationId, usage }
// where `json` is agy's own envelope ({ result, usage, conversation_id, ... })
// and `text` is the MODEL's reply — i.e. the actual
// `{"findings":[...]}` / `{"guidance":"...","recommendation":"..."}` payload,
// possibly fenced. The reviewer/supervisor payload therefore lives in `text`,
// NOT in `json`. Parsing `json` first (the old behaviour) fed the transport
// envelope to validateReviewerPayload, which has no `findings` array, so every
// real production Reviewer call failed closed.
function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function looksLikePayload(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    && (Array.isArray(obj.findings) || 'recommendation' in obj || 'guidance' in obj);
}

// A model reply is often prose wrapped around the JSON, e.g.
//   "I reviewed the diff. ```json\n{...}\n``` Let me know."
// Pull the JSON out of it: first a ```json fenced block, then the first
// balanced {...} substring that parses AND looks like a reviewer/supervisor
// payload. Deterministic; never executes anything.
function extractEmbeddedJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const p = JSON.parse(fenced[1].trim());
      if (p && typeof p === 'object') return p;
    } catch { /* keep looking */ }
  }
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const p = JSON.parse(s.slice(i, j + 1));
            if (looksLikePayload(p)) return p;
          } catch { /* not this one */ }
          break;
        }
      }
    }
  }
  return null;
}

function parseJsonish(res) {
  if (typeof res === 'string') {
    try { return { parsed: JSON.parse(stripFence(res)), raw: res }; } catch { /* embedded */ }
    const embedded = extractEmbeddedJson(res);
    return { parsed: embedded, raw: res };
  }
  // 1. The model's own reply text — the normal channel.
  const replyText = typeof res?.text === 'string' ? res.text : null;
  if (replyText && stripFence(replyText)) {
    try {
      return { parsed: JSON.parse(stripFence(replyText)), raw: replyText };
    } catch { /* fall through */ }
    const embedded = extractEmbeddedJson(replyText);
    if (embedded) return { parsed: embedded, raw: replyText };
  }
  // 2. `agy --json-schema` can make the ENVELOPE itself the schema'd object.
  //    Only accept res.json when it already looks like a reviewer/supervisor
  //    payload — never the bare transport envelope.
  if (looksLikePayload(res?.json)) {
    return { parsed: res.json, raw: res.json };
  }
  // 3. A nested envelope field sometimes carries the JSON as a string.
  for (const cand of [res?.json?.result, res?.json?.output, res?.json?.content]) {
    if (typeof cand === 'string' && stripFence(cand)) {
      try { return { parsed: JSON.parse(stripFence(cand)), raw: cand }; } catch { /* keep trying */ }
      const embedded = extractEmbeddedJson(cand);
      if (embedded) return { parsed: embedded, raw: cand };
    }
  }
  return { parsed: null, raw: replyText ?? (res?.json ? JSON.stringify(res.json) : '') };
}

// ---- Reviewer / Supervisor pool -----------------------------------------

export function createReviewLoopProviderPool({
  callAgy = defaultCallAgy,
  env = process.env,
  quotaRegistry = new QuotaPoolRegistry({ filePath: null }),
  providerHealth = new ProviderHealthRegistry(),
  // `agy models` catalog (ids array / raw stdout) for runtime model-family
  // resolution. null -> the provider-default path (transport omits --model).
  // Deterministic tests leave it null; production wiring probes it once.
  agyCatalog = null,
} = {}) {
  // Resolve every registered family to a concrete model (or null = provider
  // default) at construction. Stable family identity in, concrete version out —
  // a catalog bump changes `resolvedModel` here without any policy edit.
  const resolution = {};
  for (const family of Object.keys(MODEL_FAMILY_REGISTRY)) {
    resolution[family] = resolveModelFamily(family, { env, agyCatalog });
  }
  const modelForFamily = Object.fromEntries(
    Object.entries(resolution).map(([f, r]) => [f, r.resolvedModel]),
  );

  // Per-family transport. Only the agy families have a wired transport in this
  // stage; codex/claude remain capability-declared protocol targets with no
  // transport, so they are marked unavailable up front and the RoleRouter
  // skips them (rather than pretending a call can be made).
  const narrow = (family) => async (prompt) => {
    const res = await callAgy({
      prompt,
      model: modelForFamily[family] ?? null,
      cwd: narrowReviewTransportCwd(),
      disableSlashCommands: true,
    });
    return { ...res, meta: { promptChars: String(prompt ?? '').length } };
  };
  const transports = {
    'agy:gemini': narrow('agy:gemini'),
    'agy:gpt-oss': narrow('agy:gpt-oss'),
  };
  for (const family of Object.keys(PRODUCTION_ROLE_CAPABILITIES)) {
    if (!transports[family]) providerHealth.record(family, 'UNAVAILABLE', 'no wired transport in this build');
  }

  const router = new RoleRouter({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry,
    providerHealth,
    effortPolicy: new EffortPolicy(),
    resolveFamily: (family) => {
      const r = resolution[family] ?? resolveModelFamily(family, { env, agyCatalog });
      return {
        requestedFamily: family,
        resolvedModel: r.resolvedModel,
        resolvedFrom: r.resolvedFrom,
        provider: r.provider ?? (family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0]),
        capabilities: {
          roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [],
          supportsReasoningEffort: false,
          supportedEfforts: ['medium'],
        },
      };
    },
  });

  function route(role, signals = {}) {
    const sel = router.route(role, signals);
    if (!sel) return null;
    return {
      role,
      family: sel.requestedFamily,
      provider: sel.provider,
      model: sel.resolvedModel,
      resolvedFrom: resolution[sel.requestedFamily]?.resolvedFrom ?? null,
      transport: transports[sel.requestedFamily] ?? null,
    };
  }

  function recordFailure(selection, failure) {
    router.recordFailure({ role: selection.role, requestedFamily: selection.family, provider: selection.provider }, failure);
  }

  return { router, route, recordFailure, transports, resolution };
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
    return {
      value,
      usage: res?.usage ?? null,
      model: res?.model ?? model,
      meta: {
        promptChars: prompt.length,
        diffChars: String(diff ?? '').length,
        reviewPayloadChars: prompt.length,
        ...(res?.meta ?? {}),
      },
    };
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
    return {
      value,
      usage: res?.usage ?? null,
      model: res?.model ?? model,
      meta: {
        promptChars: prompt.length,
        diffChars: 0,
        reviewPayloadChars: prompt.length,
        ...(res?.meta ?? {}),
      },
    };
  };
}

export function createProductionReviewLoopProviders({
  env = process.env, callAgy, github, agyCatalog = null,
} = {}) {
  // `agyCatalog` (ids array / raw `agy models` stdout) drives runtime
  // model-family resolution. It is supplied by the MCP entrypoint, which
  // probes it once; left null here so nothing is spawned in tests and the
  // resolution falls back to the provider-default path.
  const pool = createReviewLoopProviderPool({ callAgy, env, agyCatalog });
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
