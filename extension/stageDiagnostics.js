// Pure, chrome-API-free stage-tracking store backing background.js's
// timeout diagnostics. Tracks the last known extension-side stage for each
// in-flight supervisorAsk request, keyed by requestId, so a diagnostic
// lookup made AFTER the original request has been cancelled/timed out can
// still report where it got stuck — see the 2026-08-27 live finding where a
// Reviewer supervisorAsk timed out after a fully healthy preflight, and the
// best-effort failure snapshot taken afterward found nothing because
// automatedLoop's cleanup had already torn down the tab/window by then.
//
// Records contain ONLY requestId/tabId/stage/timestamp — never prompt/reply/
// page content, matching every other diagnostic in this codebase
// (reviewerPreflight, the stage-only `onStage` logging already used
// throughout domActions.js/content.js/background.js).
//
// Only requests explicitly started via init() are ever tracked — update()
// on an unknown requestId is a silent no-op. That is what scopes this store
// to exactly the requests a caller cares about (background.js only init()s
// supervisorAsk requests) without needing an allowlist of action names here.
//
// TTL is a SLIDING window: every init()/update() call rearms it, so an
// actively-progressing request's record survives indefinitely, while one
// that stalls (or finishes and is never looked up) is forgotten `ttlMs`
// after its last update — bounding memory without depending on the original
// request's own promise, WebSocket connection, or tab still being alive
// (the diagnostic lookup must not depend on any of those, per this task's
// requirement 4).
export function createStageStore({
  ttlMs = 5 * 60 * 1000,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (token) => clearTimeout(token),
} = {}) {
  const records = new Map();

  function armTtl(requestId) {
    const record = records.get(requestId);
    if (!record) return;
    if (record.timer !== null) cancel(record.timer);
    record.timer = schedule(() => records.delete(requestId), ttlMs);
  }

  return {
    // Starts tracking a new request. A second init() for the same
    // requestId simply resets it — callers are expected to init() at most
    // once per requestId (background.js does, at the top of
    // handleSupervisorAsk).
    init(requestId, tabId, stage) {
      records.set(requestId, { requestId, tabId, stage, timestamp: now(), timer: null });
      armTtl(requestId);
    },

    // No-op if `requestId` was never init()'d — this is what keeps this
    // store scoped to only the requests a caller opted into tracking.
    update(requestId, stage) {
      const record = records.get(requestId);
      if (!record) return;
      record.stage = stage;
      record.timestamp = now();
      armTtl(requestId);
    },

    // Returns { requestId, tabId, stage, timestamp }, or null if unknown/
    // expired. Never exposes the internal timer handle.
    get(requestId) {
      const record = records.get(requestId);
      if (!record) return null;
      return { requestId: record.requestId, tabId: record.tabId, stage: record.stage, timestamp: record.timestamp };
    },

    size() {
      return records.size;
    },
  };
}
