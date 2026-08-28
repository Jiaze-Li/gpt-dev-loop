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
    supervisor: { conversation_id: null },
    reviewer: { conversations: {} },
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
      const convs = persisted.reviewer && persisted.reviewer.conversations;
      if (convs && typeof convs === 'object') {
        for (const [taskId, id] of Object.entries(convs)) {
          if (typeof id === 'string' && id !== '') state.reviewer.conversations[taskId] = id;
        }
      }
    }
  }

  async function persist() {
    if (!enabled) return;
    await persistence.writeWorkflowState(workflowId, {
      workflow_id: workflowId,
      supervisor: { conversation_id: state.supervisor.conversation_id },
      reviewer: { conversations: { ...state.reviewer.conversations } },
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
    // Test/diagnostic view of the in-memory map (no I/O).
    snapshot() {
      return {
        workflow_id: state.workflow_id,
        supervisor: { conversation_id: state.supervisor.conversation_id },
        reviewer: { conversations: { ...state.reviewer.conversations } },
      };
    },
  };
}

export function createAgySupervisorSession(provider, { store } = {}) {
  let conversationId = null;
  let resolved = false;
  return {
    async create() {
      return {}; // no tab
    },
    async decide(context) {
      if (!resolved) {
        resolved = true;
        if (store) conversationId = await store.getSupervisorConversationId();
      }
      // Fail closed: once we own a conversation id, a decide() that cannot
      // resume exactly it throws (AgyConversationResumeError) rather than
      // silently starting a detached second Supervisor conversation.
      const { conversationId: returned, ...decision } = await provider.decide(context, {
        conversationId: conversationId ?? undefined,
      });
      if (typeof returned === 'string' && returned !== '' && returned !== conversationId) {
        conversationId = returned;
        if (store) await store.setSupervisorConversationId(returned);
      }
      return decision;
    },
    async close() {},
    // Test/diagnostic only.
    get conversationId() {
      return conversationId;
    },
  };
}

export function createAgyReviewerSessionFactory(provider, { store } = {}) {
  return function createAgyReviewerSession() {
    // One session object per task (automatedLoop contract). The loop calls
    // review() once per attempt for that task; a `reuseAttempt` call is a
    // rate-limit retry of the same attempt (never happens on the agy path,
    // whose errors are not rate limits) and must not advance the counter.
    //
    // The first review() for this task captures the agy conversation id;
    // every REWORK round of the SAME task resumes it. A different task gets
    // a brand-new session object -> conversationId starts null -> fresh
    // conversation.
    let attempt = 0;
    let conversationId = null;
    let resolvedForTask = null;
    let boundTaskId = null;
    return {
      async create(taskId) {
        boundTaskId = taskId ?? null;
        return {}; // no tab
      },
      async review(taskId, taskCard, executionReport, evidence, opts = {}) {
        if (!opts.reuseAttempt) attempt += 1;
        const effectiveTaskId = taskId ?? boundTaskId ?? taskCard?.task_id ?? null;
        if (conversationId === null && resolvedForTask !== effectiveTaskId) {
          resolvedForTask = effectiveTaskId;
          if (store && effectiveTaskId !== null) {
            conversationId = await store.getReviewerConversationId(effectiveTaskId);
          }
        }
        const { conversationId: returned, ...result } = await provider.review(
          taskCard,
          executionReport,
          evidence,
          { attempt, conversationId: conversationId ?? undefined },
        );
        if (typeof returned === 'string' && returned !== '' && returned !== conversationId) {
          conversationId = returned;
          if (store && effectiveTaskId !== null) {
            await store.setReviewerConversationId(effectiveTaskId, returned);
          }
        }
        return result;
      },
      async close() {},
      // Test/diagnostic only.
      get conversationId() {
        return conversationId;
      },
    };
  };
}
