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

export function createAgySupervisorSession(provider) {
  return {
    async create() {
      return {}; // no tab / no conversation
    },
    decide(context) {
      return provider.decide(context);
    },
    async close() {},
  };
}

export function createAgyReviewerSessionFactory(provider) {
  return function createAgyReviewerSession() {
    // One session object per task (automatedLoop contract). The loop calls
    // review() once per attempt for that task; a `reuseAttempt` call is a
    // rate-limit retry of the same attempt (never happens on the agy path,
    // whose errors are not rate limits) and must not advance the counter.
    let attempt = 0;
    return {
      async create() {
        return {}; // no tab / no conversation
      },
      review(taskId, taskCard, executionReport, evidence, opts = {}) {
        if (!opts.reuseAttempt) attempt += 1;
        return provider.review(taskCard, executionReport, evidence, { attempt });
      },
      async close() {},
    };
  };
}
