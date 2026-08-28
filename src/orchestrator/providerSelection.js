// Explicit Supervisor / Reviewer provider selection for the MVP agy
// workflow entry point (scripts/run-agy-workflow.js).
//
//   SUPERVISOR_PROVIDER=agy   REVIEWER_PROVIDER=agy
//
// Only the all-agy combination is wired here. The existing Chrome/web
// Supervisor + Reviewer path is untouched and still reachable through
// scripts/test-automated-loop-live.js — it is simply never selected from
// this entry point, satisfying "existing providers remain available but
// must not be used when agy is selected" and "no Chrome tab when both
// providers are agy" (nullWindowSession opens nothing).

import { createAgySupervisorProvider } from './adapters/agySupervisorProvider.js';
import { createCodexSupervisorProvider, callCodex } from './adapters/codexSupervisorProvider.js';
import { createClaudeSupervisorProvider, callClaude } from './adapters/claudeSupervisorProvider.js';
import { createClaudeReviewerProvider } from './adapters/claudeReviewerProvider.js';
import { createCodexReviewerProvider } from './adapters/codexReviewerProvider.js';
import { createCodexSessionManager } from './adapters/codexExecutorAdapter.js';
import { randomUUID } from 'node:crypto';
import { createFailoverSupervisorSession } from './supervisorFailover.js';
import { createProductionRoleRuntime } from './productionRoleRuntime.js';
import { PRODUCTION_ROLE_CAPABILITIES } from './roleRouting.js';
import { createClaudeSessionManager } from './adapters/claudeSessionManager.js';
import { createAgyReviewerProvider } from './adapters/agyReviewerProvider.js';
import {
  createAgySupervisorSession,
  createAgyReviewerSessionFactory,
  createAgyProviderSessionStore,
  nullWindowSession,
} from './agyProviderSessions.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../agy/agyConfig.js';
import { supervisorSessionStrategy } from './supervisorCostPolicy.js';

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Planner calls bypass the state-machine roles, so account for the physical
// invocation at this adapter boundary.  The call id is created exactly once
// here and is never derived from mutable provider output.
function recordPlannerUsage({ result, selection, model, usageTracker, provider }) {
  if (!usageTracker) return;
  const callId = `call-${provider}-plan-${randomUUID()}`;
  usageTracker.record({
    role: 'planner',
    callId,
    model: result?.model ?? model ?? null,
    requestedFamily: selection?.requestedFamily ?? null,
    resolvedModel: selection?.resolvedModel ?? result?.model ?? model ?? null,
    usage: result?.usage ?? null,
    durationMs: result?.durationMs ?? null,
    providerMetadata: {
      provider: selection?.provider ?? provider,
      conversationId: result?.conversationId ?? null,
      exitCode: result?.exitCode ?? null,
    },
  });
}

// Returns { supervisorModel, reviewerModel, supervisorSession,
// createReviewerSession, windowSession } ready to hand to
// runAutomatedWorkflow. The Supervisor and Reviewer each get ONLY their own
// resolved model — the Claude executor is never handed either. Throws (fail
// closed) if either provider env var is not exactly "agy".
export function selectProviders({
  env = process.env,
  callAgy,
  timeoutMs,
  jsonSchema,
  persistence,
  workflowId,
  usageTracker,
  codexCall,
  claudeCall,
  onProviderEvent,
  router,
  rolePolicy,
  quotaRegistry,
  providerHealth,
  onEvent,
} = {}) {
  // One shared persistent-conversation store for this workflow: the
  // Supervisor session and every per-task Reviewer session created below
  // read/write the same map, persisted to workflow state when a
  // `persistence` + `workflowId` pair is supplied.
  const sessionStore = createAgyProviderSessionStore({ persistence, workflowId });
  const codexModel = env.SUPERGPT_CODEX_MODEL?.trim() || env.SUPERGPT_CODEX_SUPERVISOR_MODEL?.trim() || null;
  const geminiModel = resolveAgySupervisorModel(env);
  const gptOssModel = resolveAgyReviewerModel(env);
  const sessions = new Map();
  const reviewerSessions = new Map();
  const getSupervisor = (family) => {
    if (!sessions.has(family)) {
      let provider;
      if (family === 'codex:default') {
        provider = createCodexSupervisorProvider({ call: codexCall, model: codexModel, timeoutMs });
      } else if (family === 'claude:opus') {
        provider = createClaudeSupervisorProvider({ call: claudeCall, model: 'opus', timeoutMs });
      } else {
        provider = createAgySupervisorProvider({ callAgy, model: family === 'agy:gpt-oss' ? gptOssModel : geminiModel, timeoutMs, jsonSchema });
      }
      sessions.set(family, createAgySupervisorSession(provider, {
        store: sessionStore, usageTracker, onEvent, requestedFamily: family,
        resolvedModel: family === 'codex:default' ? codexModel : family === 'claude:opus' ? 'opus' : family === 'agy:gpt-oss' ? gptOssModel : geminiModel,
        strategy: supervisorSessionStrategy(family),
      }));
    }
    return sessions.get(family);
  };
  const runtime = createProductionRoleRuntime({
    router, rolePolicy, quotaRegistry, providerHealth, onEvent,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family === 'codex:default' ? codexModel : family === 'agy:gpt-oss' ? gptOssModel : family === 'agy:gemini' ? geminiModel : family.split(':')[1],
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      // Adapter declaration, never inferred from a locally installed CLI.
      // Unsupported policy candidates are skipped by RoleRouter locally.
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [], supportsReasoningEffort: family === 'codex:default', supportedEfforts: ['low', 'medium', 'high'] },
    }),
    adapters: {
      planner: {
        'codex:default': ({ resolve }, selection) => resolve(async (opts) => {
          const result = await (codexCall ?? callCodex)({ prompt: opts.prompt, model: codexModel, timeoutMs });
          recordPlannerUsage({ result, selection, model: codexModel, usageTracker, provider: 'codex' });
          const trimmed = (result.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          return { text: trimmed, json: JSON.parse(trimmed), usage: result.usage, durationMs: result.durationMs };
        }),
        'agy:gemini': ({ resolve }, selection) => resolve(async (opts) => {
          const result = await callAgy({ ...opts, model: geminiModel });
          recordPlannerUsage({ result, selection, model: geminiModel, usageTracker, provider: 'agy' });
          return result;
        }),
        'claude:opus': ({ resolve }, selection) => resolve(async (opts) => {
          const result = await (claudeCall ?? callClaude)({ prompt: opts.prompt, model: 'opus', timeoutMs });
          recordPlannerUsage({ result, selection, model: 'opus', usageTracker, provider: 'claude' });
          const trimmed = (result.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          return { text: trimmed, json: JSON.parse(trimmed), usage: result.usage, durationMs: result.durationMs };
        }),
        'agy:gpt-oss': ({ resolve }, selection) => resolve(async (opts) => {
          const result = await callAgy({ ...opts, model: gptOssModel });
          recordPlannerUsage({ result, selection, model: gptOssModel, usageTracker, provider: 'agy' });
          return result;
        }),
      },
      supervisor: {
        'agy:gemini': (context, selection) => getSupervisor('agy:gemini').decide(context, { effort: selection.effort }),
        'codex:default': (context, selection) => getSupervisor('codex:default').decide(context, { effort: selection.effort }),
        'claude:opus': (context, selection) => getSupervisor('claude:opus').decide(context, { effort: selection.effort }),
        'agy:gpt-oss': (context, selection) => getSupervisor('agy:gpt-oss').decide(context, { effort: selection.effort }),
      },
      reviewer: {
        'agy:gpt-oss': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:agy:gpt-oss`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createAgyReviewerProvider({ callAgy, model: gptOssModel, timeoutMs, jsonSchema }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'codex:default': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:codex:default`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createCodexReviewerProvider({ call: codexCall, model: codexModel, timeoutMs }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'agy:gemini': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:agy:gemini`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createAgyReviewerProvider({ callAgy, model: geminiModel, timeoutMs, jsonSchema }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'claude:opus': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:claude:opus`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createClaudeReviewerProvider({ call: claudeCall, model: 'opus', timeoutMs }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
      },
      executor: {
        'claude:sonnet': async ({ taskId, taskCard, ...args }) => createClaudeSessionManager({ ...args, taskId, env: { ...env, FORCE_CLAUDE_MODEL: 'sonnet' } }).execute(taskCard),
        'codex:default': async ({ taskId, taskCard, ...args }) => createCodexSessionManager({ ...args, taskId, model: codexModel, env }).execute(taskCard),
        'claude:opus': async ({ taskId, taskCard, ...args }) => createClaudeSessionManager({ ...args, taskId, env: { ...env, FORCE_CLAUDE_MODEL: 'opus' } }).execute(taskCard),
      },
    },
  });
  const supervisorSession = {
    create: async () => ({}), close: async () => {},
    decide: async (context) => (await runtime.invoke('supervisor', context, { signals: context?.signals, operationId: workflowId })).value,
  };
  const createReviewerSession = () => ({
    create: async () => ({}), close: async () => {},
    review: async (taskId, taskCard, executionReport, evidence, opts = {}) => (await runtime.invoke('reviewer', { taskId, taskCard, executionReport, evidence, opts }, { signals: { reworkCycles: Math.max(0, (opts.attempt ?? 1) - 1) }, operationId: `${workflowId}:${taskId}` })).value,
  });

  return {
    // Presentation compatibility only; it does not select the provider.
    supervisorModel: normalize(env.SUPERVISOR_PROVIDER) === 'codex' ? codexModel : geminiModel,
    reviewerModel: gptOssModel,
    supervisorSession,
    createReviewerSession,
    windowSession: nullWindowSession,
    sessionStore,
    runtime,
    createExecutorSessionManager: ({ taskId, persistence, cwd, onRoutingDecision, onProcessStarted, onProcessExited }) => ({
      async execute(taskCard) {
        const result = await runtime.invoke('executor', { taskId, workflowId, persistence, cwd, onRoutingDecision, onProcessStarted, onProcessExited, taskCard }, { signals: { reasoningFailures: 0 }, operationId: `${workflowId}:${taskId}` });
        return result.value;
      },
    }),
  };
}
