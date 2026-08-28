// Adapts the stateless agy Gemini providers to the session-shaped slots
// src/orchestrator/automatedLoop.js already expects, so the automated loop's
// state machine runs UNCHANGED against the agy path:
//
//   supervisorSession       { create(), decide(context), close() }
//   createReviewerSession() -> { create(taskId), review(taskId, taskCard,
//                                executionReport, evidence, opts), close() }
//   windowSession            { create(), activateTab(), close(), closeTab() }
//
// No Chrome tab, window, or conversation is created anywhere here — create()/
// close() are no-ops and nullWindowSession hands back inert placeholders. The
// loop's tab-activation invariant checks still pass (active:true,
// windowFocused:false) without any real window existing.

// A window session that opens nothing. initialTabId is null so the loop
// skips its placeholder-tab cleanup entirely; listTabs is intentionally
// absent so the loop skips its window-tab diagnostics too.
import { TokenAwareSessionPolicy, createSupervisorCheckpoint } from './tokenAwareSessionPolicy.js';
import { SUPERVISOR_SESSION_STRATEGIES, supervisorDecisionEffort, serializedSize } from './supervisorCostPolicy.js';
export const nullWindowSession = Object.freeze({
  async create() {
    return { windowId: null, initialTabId: null };
  },
  async activateTab(tabId) {
    return { tabId: tabId ?? null, active: true, windowId: null, windowFocused: false };
  },
  async close() {},
  async closeTab() {},
});

// Persistent role-conversation ownership for one whole workflow, shared by
// the Supervisor session and every per-task Reviewer session created from
// the same selectProviders() call:
//
//   supervisor.conversation_id       — the single agy conversation the
//                                      Supervisor created on its first
//                                      decide() and resumes on every later
//                                      one.
//   reviewer.conversations[taskId]   — one agy conversation per task,
//                                      reused across that task's REWORK
//                                      rounds; a different task gets a
//                                      different (fresh) conversation.
//
// When a `persistence` object and a `workflowId` are supplied the whole map
// is loaded once (on the first access, so a resumed run continues the same
// conversations) and written back via persistence.writeWorkflowState every
// time an id is captured. With neither, the store is a pure in-memory
// coordinator — conversation reuse within the process still works, it just
// is not persisted.
export function createAgyProviderSessionStore({ persistence, workflowId } = {}) {
  const enabled =
    persistence &&
    typeof persistence.writeWorkflowState === 'function' &&
    typeof persistence.readWorkflowState === 'function' &&
    typeof workflowId === 'string' &&
    workflowId !== '';

  const state = {
    workflow_id: workflowId ?? null,
    supervisor: { conversation_id: null, rotations: [] },
    reviewer: { conversations: {}, rotations: {} },
  };
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!enabled) return;
    const persisted = await persistence.readWorkflowState(workflowId);
    if (persisted && typeof persisted === 'object') {
      const sup = persisted.supervisor && persisted.supervisor.conversation_id;
      if (typeof sup === 'string' && sup !== '') state.supervisor.conversation_id = sup;
      if (Array.isArray(persisted.supervisor?.rotations)) {
        state.supervisor.rotations = [...persisted.supervisor.rotations];
      }
      const convs = persisted.reviewer && persisted.reviewer.conversations;
      if (convs && typeof convs === 'object') {
        for (const [taskId, id] of Object.entries(convs)) {
          if (typeof id === 'string' && id !== '') state.reviewer.conversations[taskId] = id;
        }
      }
      if (persisted.reviewer?.rotations && typeof persisted.reviewer.rotations === 'object') {
        state.reviewer.rotations = { ...persisted.reviewer.rotations };
      }
    }
  }

  async function persist() {
    if (!enabled) return;
    await persistence.writeWorkflowState(workflowId, {
      workflow_id: workflowId,
      supervisor: {
        conversation_id: state.supervisor.conversation_id,
        rotations: state.supervisor.rotations,
      },
      reviewer: {
        conversations: { ...state.reviewer.conversations },
        rotations: { ...state.reviewer.rotations },
      },
    });
  }

  return {
    async getSupervisorConversationId() {
      await load();
      return state.supervisor.conversation_id;
    },
    async setSupervisorConversationId(id) {
      await load();
      if (state.supervisor.conversation_id === id) return;
      state.supervisor.conversation_id = id;
      await persist();
    },
    async getReviewerConversationId(taskId) {
      await load();
      return state.reviewer.conversations[taskId] ?? null;
    },
    async setReviewerConversationId(taskId, id) {
      await load();
      if (state.reviewer.conversations[taskId] === id) return;
      state.reviewer.conversations[taskId] = id;
      await persist();
    },
    async recordSupervisorRotation({ from, to, reason, rotatedAt = new Date().toISOString() }) {
      await load();
      state.supervisor.rotations.push({ from, to, reason, rotatedAt });
      await persist();
    },
    async recordReviewerRotation(taskId, { from, to, reason, rotatedAt = new Date().toISOString() }) {
      await load();
      if (!state.reviewer.rotations[taskId]) state.reviewer.rotations[taskId] = [];
      state.reviewer.rotations[taskId].push({ from, to, reason, rotatedAt });
      await persist();
    },
    async getSupervisorRotations() {
      await load();
      return [...state.supervisor.rotations];
    },
    async getReviewerRotations(taskId) {
      await load();
      return [...(state.reviewer.rotations[taskId] ?? [])];
    },
    // Test/diagnostic view of the in-memory map (no I/O).
    snapshot() {
      return {
        workflow_id: state.workflow_id,
        supervisor: {
          conversation_id: state.supervisor.conversation_id,
          rotations: [...state.supervisor.rotations],
        },
        reviewer: {
          conversations: { ...state.reviewer.conversations },
          rotations: { ...state.reviewer.rotations },
        },
      };
    },
  };
}

export function createAgySupervisorSession(provider, {
  store,
  requestedFamily = 'agy:gemini',
  resolvedModel = null,
  strategy = SUPERVISOR_SESSION_STRATEGIES.BOUNDED_STICKY,
  maxTurns = 6,
  tokenPressureThreshold = 30000,
  usageTracker,
  sessionPolicy = new TokenAwareSessionPolicy({ maxPhysicalCalls: maxTurns }),
  onEvent,
} = {}) {
  let conversationId = null;
  let resolved = false;
  let turnsInConversation = 0;
  let lastInputTokens = 0;
  let sessionTelemetry = sessionPolicy.initial();
  let semanticFailures = 0;

  return {
    async create() {
      return {}; // no tab
    },
    async decide(context, { effort: routedEffort = null } = {}) {
      if (!resolved) {
        resolved = true;
        if (store) conversationId = await store.getSupervisorConversationId();
      }

      // Check context pressure: rotate if turns or tokens exceed threshold, or if explicitly requested
      const policyReason = sessionPolicy.rotationReason(sessionTelemetry, {
        contextUtilization: context?.contextUtilization,
        providerCompaction: context?.providerCompaction,
        protocolInstability: context?.protocolInstability,
      });
      const checkpointFresh = strategy === SUPERVISOR_SESSION_STRATEGIES.CHECKPOINT_FRESH;
      const shouldRotate = !checkpointFresh && conversationId !== null && (Boolean(policyReason) || lastInputTokens >= tokenPressureThreshold || context?.forceRotation === true);

      let effectiveContext = context;
      let previousConversationId = null;

      if (checkpointFresh) {
        previousConversationId = conversationId;
        conversationId = null;
        effectiveContext = { ...context, checkpoint: createSupervisorCheckpoint(context), isFreshCheckpoint: true };
        sessionTelemetry = sessionPolicy.rotate(sessionTelemetry);
      } else if (shouldRotate) {
        previousConversationId = conversationId;
        conversationId = null;
        turnsInConversation = 0;
        effectiveContext = {
          ...context,
          checkpoint: createSupervisorCheckpoint(context),
          isRotatedConversation: true,
        };
      }

      // Fail closed: once we own a conversation id, a decide() that cannot
      // resume exactly it throws (AgyConversationResumeError) rather than
      // silently starting a detached second Supervisor conversation.
      // Route-level effort is a provider default. The actual decision point is
      // classified from authoritative semantic context here.
      const requestedEffort = supervisorDecisionEffort(context, { priorSemanticFailures: semanticFailures });
      let decision;
      try {
        decision = await provider.decide(effectiveContext, { conversationId: conversationId ?? undefined, effort: requestedEffort });
        semanticFailures = 0;
      } catch (error) {
        const failure = error?.details?.providerFailure ?? error?.providerFailure;
        if (!['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT'].includes(failure)) semanticFailures += 1;
        throw error;
      }
      const returned = decision.conversationId;

      if (!checkpointFresh && typeof returned === 'string' && returned !== '') {
        if (returned !== conversationId) {
          conversationId = returned;
          if (store) await store.setSupervisorConversationId(returned);
          if (previousConversationId && store?.recordSupervisorRotation) {
            const reason = policyReason ?? (lastInputTokens >= tokenPressureThreshold ? 'token_pressure' : 'context_pressure');
            await store.recordSupervisorRotation({
              from: previousConversationId,
              to: returned,
              reason,
              rotatedAt: new Date().toISOString(),
            });
            onEvent?.({ type: 'ROLE_SESSION_ROTATED', role: 'supervisor', reason, generation: sessionTelemetry.generation + 1 });
            sessionTelemetry = sessionPolicy.rotate(sessionTelemetry);
          }
        }
      }

      const previousCallInput = lastInputTokens || null;
      turnsInConversation += 1;
      if (decision.usage) {
        lastInputTokens = decision.usage.input_tokens ?? 0;
      }
      sessionTelemetry = sessionPolicy.observe(sessionTelemetry, {
        inputTokens: decision.usage?.input_tokens,
        cacheReadTokens: decision.usage?.cached_input_tokens ?? decision.usage?.cache_read_input_tokens,
        latencyMs: decision.durationMs,
      });

      if (usageTracker?.record) usageTracker.record({
        role: 'supervisor', callId: decision.callId ?? decision.usage?.callId ?? null, model: resolvedModel ?? provider.model ?? null,
        requestedFamily, resolvedModel: resolvedModel ?? provider.model ?? null, usage: decision.usage, durationMs: decision.durationMs,
        providerMetadata: { sessionStrategy: strategy, sessionGeneration: sessionTelemetry.generation, fresh: checkpointFresh || previousConversationId !== null,
          reused: !checkpointFresh && previousConversationId === null && conversationId !== null, previousCallInput,
          rotationReason: checkpointFresh ? 'checkpoint_fresh' : policyReason, effortRequested: requestedEffort, effortResolved: decision.effortResolved ?? null,
          serializedSemanticPromptSize: serializedSize(context), checkpointSize: serializedSize(effectiveContext.checkpoint),
          thinkingTokens: decision.usage?.thinking_tokens ?? decision.usage?.reasoning_tokens ?? null },
      });

      return decision;
    },
    async close() {},
    // Test/diagnostic only.
    get conversationId() {
      return conversationId;
    },
    get turnsInConversation() {
      return turnsInConversation;
    },
    get strategy() { return strategy; },
    get sessionGeneration() { return sessionTelemetry.generation; },
  };
}

export function createAgyReviewerSessionFactory(provider, {
  store,
  maxReworkTurns = 3,
  tokenPressureThreshold = 40000,
  usageTracker,
} = {}) {
  return function createAgyReviewerSession() {
    let attempt = 0;
    // Reviewer continuity is structured, task-scoped state.  Replaying an
    // opaque provider transcript caused prior evidence to be mistaken for
    // current-attempt evidence after REWORK.
    let boundTaskId = null;
    let reworkTurns = 0;
    let lastInputTokens = 0;
    let lastRequiredChanges = [];

    return {
      async create(taskId) {
        boundTaskId = taskId ?? null;
        return {}; // no tab
      },
      async review(taskId, taskCard, executionReport, evidence, opts = {}) {
        if (!opts.reuseAttempt) attempt += 1;
        const effectiveTaskId = taskId ?? boundTaskId ?? taskCard?.task_id ?? null;
        const checkpoint = attempt > 1 ? {
          task_id: effectiveTaskId,
          prior_required_changes: lastRequiredChanges,
          prior_status: 'addressed_or_reassess_from_current_evidence',
        } : null;

        const result = await provider.review(
          taskCard,
          executionReport,
          evidence,
          { attempt, checkpoint },
        );
        const returned = result.conversationId;

        // Deliberately do not retain/resume provider conversation ids here.
        // `returned` is useful telemetry only; current evidence is always
        // supplied in a fresh, bounded call.
        void returned;

        if (attempt > 1) reworkTurns += 1;
        if (Array.isArray(result.required_changes)) {
          lastRequiredChanges = result.required_changes;
        }

        if (result.usage) {
          lastInputTokens = result.usage.input_tokens ?? 0;
        }

        return result;
      },
      async close() {},
      // Test/diagnostic only.
      get conversationId() { return null; },
      get reworkTurns() {
        return reworkTurns;
      },
    };
  };
}
