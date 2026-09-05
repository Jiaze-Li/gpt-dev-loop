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
import { ModelSpendAuthority } from './modelSpendAuthority.js';
import { ReservationLedger, ReservationStore } from './modelSpendReservation.js';
import { NewInformationLedger, InformationStore } from './newInformation.js';
import { createExecutorBudgetPolicy } from './executorBudgetPolicy.js';
import {
  resolveWorkflowCostCeilingUsd,
  resolveWorkflowUsageVolumeCeiling,
  resolveTaskExecutorUsageVolumeCeiling,
  resolveExecutorPhysicalCallCeiling,
} from './workflowCostGuard.js';
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
import { decideDeterministically, validPlannedTasks } from './deterministicSupervisorPolicy.js';

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

function clonePlannedTasks(tasks) {
  return tasks.map((task) => ({
    ...task,
    allowed_files: [...task.allowed_files],
    verification_commands: [...task.verification_commands],
    ...(Array.isArray(task.acceptance_criteria) ? { acceptance_criteria: [...task.acceptance_criteria] } : {}),
    ...(Array.isArray(task.forbidden_files) ? { forbidden_files: [...task.forbidden_files] } : {}),
  }));
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
  signal,
  // Optional: forwarded onto the ModelSpendAuthority's ReservationLedger so
  // an UNRESOLVED reservation's BLOCKING safety event reaches the workflow's
  // user-visible terminal result (workflowState.js#recordSafetyEvent).
  recordSafetyEvent,
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

  // Planner is already required to return the complete ordered task list.
  // Keep that structured result in Core so obvious Supervisor transitions can
  // be decided locally. A legacy hand-written plan has no task array and
  // therefore cleanly falls back to the model Supervisor.
  let plannedTasks = null;
  let planSummary = null;
  const supervisorReworkMemory = new Map();
  const capturePlannerResolution = (resolved) => {
    if (validPlannedTasks(resolved?.tasks)) {
      plannedTasks = clonePlannedTasks(resolved.tasks);
      planSummary = typeof resolved?.summary === 'string' ? resolved.summary : null;
    } else {
      plannedTasks = null;
      planSummary = null;
    }
    return resolved;
  };
  // `resolve` decides internally whether the real transport (`call`) is
  // actually invoked — the documented "Planner happy path is zero-token"
  // contract (a deterministic/local resolution, e.g. an already-complete
  // plan) never calls it at all. That is the one case Token Safety's own
  // rule already carves out (see modelSpendAuthority.js's
  // extractSettlementUsage doc): usage is mechanically, provably zero only
  // when the call type cannot have billed anything — never estimated, never
  // assumed from a bare successful return. Tracking whether `call` was
  // physically invoked lets this attach that mechanical zero rather than
  // leaving a genuinely zero-spend local resolution UNRESOLVED and blocking
  // the workflow. Any resolution that DID reach the transport is untouched:
  // its own usage (or lack of it) stands, subject to the general rule.
  const resolveAndCapture = async (resolve, call) => {
    let transportInvoked = false;
    const trackedCall = async (...args) => { transportInvoked = true; return call(...args); };
    const resolved = await resolve(trackedCall);
    if (!transportInvoked && resolved && typeof resolved === 'object' && resolved.usage == null) {
      resolved.usage = { input_tokens: 0, output_tokens: 0 };
    }
    return capturePlannerResolution(resolved);
  };

  const getSupervisor = (family) => {
    if (!sessions.has(family)) {
      let provider;
      if (family === 'codex:default') {
        provider = createCodexSupervisorProvider({ call: codexCall, model: codexModel, timeoutMs, signal });
      } else if (family === 'claude:opus') {
        provider = createClaudeSupervisorProvider({ call: claudeCall, model: 'opus', timeoutMs, signal });
      } else {
        provider = createAgySupervisorProvider({ callAgy, model: family === 'agy:gpt-oss' ? gptOssModel : geminiModel, timeoutMs, jsonSchema, signal });
      }
      sessions.set(family, createAgySupervisorSession(provider, {
        store: sessionStore, usageTracker, onEvent, requestedFamily: family,
        resolvedModel: family === 'codex:default' ? codexModel : family === 'claude:opus' ? 'opus' : family === 'agy:gpt-oss' ? gptOssModel : geminiModel,
        strategy: supervisorSessionStrategy(family),
      }));
    }
    return sessions.get(family);
  };
  // Re-checked fresh at EVERY physical dispatch attempt (ModelSpendAuthority
  // .authorize() runs once per physical attempt, including a future
  // re-enabled failover's 2nd/3rd candidate inside one invoke()) — reuses
  // the same env-resolved ceilings and the same usageTracker as the
  // pre-invoke() checks in automatedLoop.js / supergpt.js, so it agrees with
  // them in the common single-attempt case and only ever adds a stop that
  // those pre-checks could not see (a second physical attempt after the
  // first one's usage was recorded).
  const executorBudgetPolicy = createExecutorBudgetPolicy({
    usageTracker,
    workflowCostCeilingUsd: resolveWorkflowCostCeilingUsd(env),
    workflowUsageVolumeCeiling: resolveWorkflowUsageVolumeCeiling(env),
    taskExecutorUsageVolumeCeiling: resolveTaskExecutorUsageVolumeCeiling(env),
    executorPhysicalCallCeiling: resolveExecutorPhysicalCallCeiling(env),
  });
  // Persistent Model Spend Reservation: reuses the SAME workflow-scoped
  // persistence as every other durable orchestrator state (persistence.js /
  // workflow.json), so a reservation survives the identical restart/resume
  // path as the rest of the workflow. Without a `persistence` instance (rare
  // — some tests construct the runtime directly), the ledger stays
  // in-memory-only for the process lifetime.
  const reservationLedger = new ReservationLedger({
    store: persistence ? new ReservationStore(persistence) : null,
    onEvent,
    recordSafetyEvent,
  });
  // § Global New Information Policy / Wiring Card 3 — ONE shared durable
  // ledger, backed by the SAME workflow-scoped persistence as the
  // ReservationLedger above, wired onto the ONE production ModelSpendAuthority
  // every role (Planner, Supervisor, Executor, Reviewer, PR-closeout repair)
  // shares. Enforcement in ModelSpendAuthority.authorize() is gated
  // per-CallIntent on whether the caller explicitly supplied `evidenceIds`
  // (see modelSpendAuthority.js's detailed comment at that check) — as of
  // Wiring Card 3, EVERY production internal physical model call site
  // supplies it: Full Path Planner (supergpt.js), Fast Path + Full Path first
  // Executor and Executor rework (automatedLoop.js / this file's
  // createExecutorSessionManager().execute()), Executor Reviewer rework and
  // ordinary Reviewer calls (createReviewerSession().review() below),
  // Supervisor escalation (supervisorSession.decide() below), and the
  // PR-closeout repair Executor (supergpt.js's runRepairTask). Production
  // construction of ModelSpendAuthority is therefore never "optional" about
  // the information ledger in practice — only low-level unit tests that
  // construct their own Authority directly (never through this factory) may
  // omit one. Without a `persistence` instance the ledger stays in-memory
  // only for the process lifetime, exactly like ReservationLedger above.
  const informationLedger = new NewInformationLedger({
    store: persistence ? new InformationStore(persistence) : null,
  });
  const spendAuthority = new ModelSpendAuthority({
    policy: executorBudgetPolicy, onEvent, reservationLedger, recordSafetyEvent, informationLedger,
  });
  const runtime = createProductionRoleRuntime({
    router, rolePolicy, quotaRegistry, providerHealth, onEvent, signal, spendAuthority,
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
        'codex:default': ({ resolve }, selection) => resolveAndCapture(resolve, async (opts) => {
          const result = await (codexCall ?? callCodex)({ prompt: opts.prompt, model: codexModel, timeoutMs, signal });
          recordPlannerUsage({ result, selection, model: codexModel, usageTracker, provider: 'codex' });
          const trimmed = (result.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          return { text: trimmed, json: JSON.parse(trimmed), usage: result.usage, durationMs: result.durationMs };
        }),
        'agy:gemini': ({ resolve }, selection) => resolveAndCapture(resolve, async (opts) => {
          const result = await callAgy({ ...opts, model: geminiModel, signal });
          recordPlannerUsage({ result, selection, model: geminiModel, usageTracker, provider: 'agy' });
          return result;
        }),
        'claude:opus': ({ resolve }, selection) => resolveAndCapture(resolve, async (opts) => {
          const result = await (claudeCall ?? callClaude)({ prompt: opts.prompt, model: 'opus', timeoutMs, signal });
          recordPlannerUsage({ result, selection, model: 'opus', usageTracker, provider: 'claude' });
          const trimmed = (result.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          return { text: trimmed, json: JSON.parse(trimmed), usage: result.usage, durationMs: result.durationMs };
        }),
        'agy:gpt-oss': ({ resolve }, selection) => resolveAndCapture(resolve, async (opts) => {
          const result = await callAgy({ ...opts, model: gptOssModel, signal });
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
          const key = `${taskId}:agy:gpt-oss`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createAgyReviewerProvider({ callAgy, model: gptOssModel, timeoutMs, jsonSchema, signal }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'codex:default': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:codex:default`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createCodexReviewerProvider({ call: codexCall, model: codexModel, timeoutMs, signal }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'agy:gemini': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:agy:gemini`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createAgyReviewerProvider({ callAgy, model: geminiModel, timeoutMs, jsonSchema, signal }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
        'claude:opus': async ({ taskId, taskCard, executionReport, evidence, opts }) => {
          const key = `${taskId}:claude:opus`; if (!reviewerSessions.has(key)) reviewerSessions.set(key, createAgyReviewerSessionFactory(createClaudeReviewerProvider({ call: claudeCall, model: 'opus', timeoutMs, signal }), { store: sessionStore, usageTracker })());
          return reviewerSessions.get(key).review(taskId, taskCard, executionReport, evidence, opts);
        },
      },
      executor: {
        'claude:sonnet': async ({ taskId, taskCard, ...args }) => createClaudeSessionManager({ ...args, taskId, env: { ...env, FORCE_CLAUDE_MODEL: 'sonnet' } }).execute(taskCard, { signal }),
        'codex:default': async ({ taskId, taskCard, ...args }) => createCodexSessionManager({ ...args, taskId, model: codexModel, env }).execute(taskCard, { signal }),
        'claude:opus': async ({ taskId, taskCard, ...args }) => createClaudeSessionManager({ ...args, taskId, env: { ...env, FORCE_CLAUDE_MODEL: 'opus' } }).execute(taskCard, { signal }),
      },
    },
  });
  const supervisorSession = {
    create: async () => ({}), close: async () => {},
    decide: async (context) => {
      const local = decideDeterministically({
        context,
        plannedTasks,
        planSummary,
        reworkMemory: supervisorReworkMemory,
      });
      if (local.handled) {
        onEvent?.({
          type: 'SUPERVISOR_DECISION_DETERMINISTIC',
          workflowId,
          action: local.decision.action,
          reason: local.reason,
        });
        return local.decision;
      }
      onEvent?.({ type: 'SUPERVISOR_ESCALATED', workflowId, reason: local.reason });
      // `evidenceIds` (§ Global New Information Policy / Wiring Card 3) is
      // OPTIONAL and forwarded verbatim into the CallIntent exactly like the
      // Reviewer's own `opts.evidenceIds` above — see
      // productionRoleRuntime.invoke()'s doc. automatedLoop.js registers the
      // deterministic escalation evidence (Gate fingerprint / review findings
      // / task card) BEFORE calling decide() and supplies it as
      // `context.evidenceIds`; any other caller/test that predates this
      // feature omits it and is completely unaffected.
      return (await runtime.invoke('supervisor', context, { signals: context?.signals, operationId: workflowId, workflowId, evidenceIds: context?.evidenceIds })).value;
    },
  };
  const createReviewerSession = () => ({
    create: async () => ({}), close: async () => {},
    // `evidenceIds` (§ Global New Information Policy / Wiring Card 2) is
    // OPTIONAL and forwarded verbatim into the CallIntent exactly like the
    // Executor's own `evidenceIds` option above — see
    // productionRoleRuntime.invoke()'s doc. automatedLoop.js's
    // runReviewStep() supplies the CHANGED_TASK_DIFF evidence for every
    // Reviewer call; any other caller/test that predates this feature omits
    // `opts.evidenceIds` and is completely unaffected.
    review: async (taskId, taskCard, executionReport, evidence, opts = {}) => (await runtime.invoke('reviewer', { taskId, taskCard, executionReport, evidence, opts }, { signals: { reworkCycles: Math.max(0, (opts.attempt ?? 1) - 1) }, operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds: opts.evidenceIds })).value,
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
    // § Global New Information Policy / Wiring Card 2 — exposed so the two
    // migrated call sites (supergpt.js's Planner invocation and Fast Path
    // task-card registration) can register evidence against the SAME ledger
    // instance `spendAuthority` actually enforces against. Never used to
    // bypass anything: registering evidence here still requires
    // ModelSpendAuthority.authorize() to find it eligible/unconsumed before
    // any permit is minted.
    informationLedger,
    createExecutorSessionManager: ({ taskId, persistence, cwd, onRoutingDecision, onProcessStarted, onProcessExited }) => ({
      // `evidenceIds` (§ Global New Information Policy / Wiring Card 2) is
      // OPTIONAL and forwarded verbatim into the CallIntent exactly like
      // productionRoleRuntime.invoke()'s own `evidenceIds` option. Only the
      // Fast Path first Executor call site (automatedLoop.js) ever supplies
      // it; every other Executor call (Full Path, rework, escalation, resume
      // rework) omits it and is completely unaffected — see
      // modelSpendAuthority.js's evidence-aware gating.
      async execute(taskCard, { signal: executionSignal, evidenceIds } = {}) {
        if (executionSignal?.aborted) throw new Error('executor cancelled');
        const result = await runtime.invoke('executor', { taskId, workflowId, persistence, cwd, onRoutingDecision, onProcessStarted, onProcessExited, taskCard }, { signals: { reasoningFailures: 0 }, operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds });
        if (executionSignal?.aborted) throw new Error('executor cancelled');
        return result.value;
      },
    }),
  };
}
