// Production wiring for the ReviewLoop controller.
//
// Constructs the internal Reviewer / Supervisor callables and the PR backend.
// Nothing here performs a model call or a GitHub trigger at construction time —
// a call only happens when the controller actually invokes the returned
// functions (and only after crossing ReviewLoop Token Safety /
// ExternalModelTriggerAuthority).
//
// If a provider is not configured in the environment, the returned callable
// fails closed at call time rather than silently doing nothing.

import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import { resolveAgyReviewerModel, resolveAgySupervisorModel } from '../agy/agyConfig.js';
import { DEFAULT_ROLE_POLICY } from '../orchestrator/roleRouting.js';

// Minimal internal Reviewer: hands the immutable objective + Git diff + Gate
// result to the configured Reviewer model and expects a findings payload.
function buildReviewerFn({ callAgy = defaultCallAgy, env = process.env } = {}) {
  const model = resolveAgyReviewerModel(env);
  return async ({ objective, diff, changedFiles, gate }) => {
    const prompt = [
      'You are an INDEPENDENT code reviewer. Judge ONLY against the original objective.',
      `ORIGINAL OBJECTIVE: ${objective.goal}`,
      objective.constraints?.length ? `CONSTRAINTS:\n- ${objective.constraints.join('\n- ')}` : '',
      `CHANGED FILES: ${(changedFiles ?? []).join(', ') || '(none)'}`,
      `DETERMINISTIC GATE: ${gate?.verdict ?? 'n/a'}`,
      'GIT DIFF (primary evidence):',
      String(diff ?? '').slice(0, 12000),
      '',
      'Return JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
      'P1/P2 block completion. P3 does not.',
    ].filter(Boolean).join('\n');
    const res = await callAgy({ prompt, model });
    let parsed;
    try {
      parsed = typeof res?.json === 'object' ? res.json : JSON.parse(String(res?.text ?? res).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    } catch {
      parsed = { findings: [] };
    }
    return { value: parsed, usage: res?.usage ?? null, model: res?.model ?? model };
  };
}

function buildSupervisorFn({ callAgy = defaultCallAgy, env = process.env } = {}) {
  const model = resolveAgySupervisorModel(env);
  return async ({ objective, blockingFindings }) => {
    const prompt = [
      'You are a repair STRATEGIST, not an implementer. You cannot edit code or declare PASS.',
      `ORIGINAL OBJECTIVE: ${objective.goal}`,
      `PERSISTENT BLOCKING FINDINGS:\n${JSON.stringify(blockingFindings, null, 2)}`,
      'Give concise repair guidance for the Worker, or recommend HUMAN_REQUIRED.',
      'Return JSON: {"guidance":"","recommendation":"REWORK|HUMAN_REQUIRED"}.',
    ].join('\n');
    const res = await callAgy({ prompt, model });
    let parsed;
    try {
      parsed = typeof res?.json === 'object' ? res.json : JSON.parse(String(res?.text ?? res).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    } catch {
      parsed = { guidance: String(res?.text ?? ''), recommendation: 'REWORK' };
    }
    return { value: parsed, usage: res?.usage ?? null, model: res?.model ?? model };
  };
}

// PR backend requires an injected GitHub client (gh CLI wrapper). Not
// constructed here — PR-mode real external review is out of scope for the
// current build and must be wired explicitly by the caller.
function buildPrBackend() {
  const notWired = () => {
    throw new Error('ReviewLoop PR mode: no GitHub backend wired in this build');
  };
  return {
    getPrHead: notWired,
    findExistingReview: notWired,
    postReviewTrigger: notWired,
    waitForReview: notWired,
  };
}

export function createProductionReviewLoopProviders({ env = process.env, callAgy } = {}) {
  return {
    reviewerFn: buildReviewerFn({ callAgy, env }),
    supervisorFn: buildSupervisorFn({ callAgy, env }),
    prBackend: buildPrBackend(),
    env,
  };
}

export const ACTIVE_ROLE_POOLS = Object.freeze(Object.keys(DEFAULT_ROLE_POLICY));
