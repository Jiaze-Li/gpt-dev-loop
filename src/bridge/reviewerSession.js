// ReviewerSession: one persistent ChatGPT conversation held open across
// every REWORK round of a single task, addressed by an explicit Chrome
// tabId — never "whichever ChatGPT tab is active". Issue #2's task-scoped
// Reviewer lifecycle primitive.
//
// Why this exists (live E2E finding, 2026-08-26): the previous Reviewer
// transport (chatgptExtension.js's askGptWithIdentity + deleteConversation)
// creates a brand-new conversation for every single review call. That is
// fine for one-shot reviews, but a task that goes through several REWORK
// rounds was creating/deleting a fresh ChatGPT conversation per round —
// high-frequency conversation create/delete turned out to trip ChatGPT's
// own conversation-level rate limiting. The fix is not "retry harder"; it's
// "don't recreate the conversation" — one Reviewer conversation per task,
// reused across every review() call for that task, exactly mirroring how
// SupervisorSession already holds one conversation open across an entire
// workflow.
//
// Deliberately built by composing the same supervisorCreate/supervisorAsk/
// supervisorClose wire actions supervisorSession.js already uses (see
// extensionServer.js/extensionProtocol.js) rather than adding new
// "reviewer*" actions to the wire protocol or new DOM automation to
// background.js/content.js/domActions.js. "Create a tab and hold it open
// across many addressed asks, closing it only on request" is exactly what
// those three actions already do; nothing about that behavior is
// Supervisor-specific. Wire-level errors (SUPERVISOR_TAB_LOST /
// SUPERVISOR_IDENTITY_MISMATCH) are remapped below to this file's own
// Reviewer* error classes so callers never see a "Supervisor" error name
// out of a ReviewerSession.
//
// Prompt content is the other reuse point: buildReviewPrompt/
// parseReviewResult (exported from gptReviewerAdapter.js) are the exact
// same Task Card/Execution Report/Evidence rendering and Review Result
// parsing used by the one-shot Reviewer Adapter — no new prompt-building or
// reply-parsing logic was written. The only thing added here is a framing
// header (buildSessionFramingHeader below) instructing GPT that, because
// this is a multi-turn conversation, only the current turn's Task
// Card/Execution Report/Evidence are current fact — see that function's
// doc comment for the exact failure mode it prevents.

import { randomUUID } from 'node:crypto';
import { getExtensionServer } from './extensionServer.js';
import { withTimeout } from './chromeRuntime.js';
import { mapProtocolError } from './chatgptExtension.js';
import {
  TransportError,
  ChromeUnavailableError,
  SupervisorTabLostError,
  SupervisorIdentityMismatchError,
  SupervisorAttachMismatchError,
  ReviewerTaskMismatchError,
  ReviewerTabLostError,
  ReviewerIdentityMismatchError,
  ReviewerAttachMismatchError,
  ReviewerPreflightError,
} from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';
import { buildReviewPrompt, parseReviewResult } from '../orchestrator/adapters/gptReviewerAdapter.js';

// Stage-only diagnostics (requestId/tabId/taskId, never prompt/reply/Task
// Card/Evidence content) for the "reviewer review request entered" ->
// "reviewer output parsing completed" span — added 2026-08-27 after live
// evidence showed the full automated loop stalling with a bare
// ResponseTimeoutError and no visibility into which side of the Node/
// extension boundary the stall was on. Mirrors extensionServer.js's own
// `log()` helper (console.error, "gpt-loop: " prefix).
function log(message) {
  console.error(`gpt-loop: ${message}`);
}

const NOT_CREATED_MESSAGE = 'ReviewerSession.create(taskId) has not been called (or did not succeed) — there is no tab to address.';
const ALREADY_CREATED_MESSAGE =
  'ReviewerSession.create(taskId) was already called for this session. Call close() before creating a new one.';

function taskMismatchMessage(boundTaskId, calledTaskId) {
  return `This ReviewerSession is bound to task "${boundTaskId}" (from create()); it cannot be reused for task "${calledTaskId}". Create a new ReviewerSession per task.`;
}

// Every review() call resends the FULL current Task Card/Execution
// Report/Evidence (buildReviewPrompt below, unchanged from the one-shot
// adapter) — never a diff or "here's what changed since last time". This
// header is what makes that safe to send into a conversation that already
// has earlier rounds in it: without it, GPT tends to (a) treat its own
// prior REWORK verdict as still-pending ground truth even once this round's
// evidence shows the fix landed, or (b) award PASS because a previously
// requested change was *asked for* in an earlier turn, without checking
// this turn's evidence actually shows it done. Both are exactly the
// false-PASS/stuck-REWORK failure modes a task-scoped session must not
// introduce.
function buildSessionFramingHeader(attempt) {
  return `This is review attempt #${attempt} for this task, inside a single ongoing Reviewer conversation. Earlier messages in this conversation are REAL — you actually said them — but they are history, not current fact:

- Judge this attempt using ONLY the Task Card, Execution Report, and Evidence given below in THIS message.
- Any verdict or findings from an earlier attempt in this conversation are context for how the task evolved, not evidence about the current state of the repository.
- Do not assume a change you previously requested has been made just because you asked for it before — only the Evidence below tells you what is actually true now.
- A PASS decision must be justified entirely by this message's Evidence. If this message's Evidence does not show a previously required change actually landed, do not award PASS.`;
}

function buildSessionPrompt(attempt, taskCard, executionReport, evidence) {
  return `${buildSessionFramingHeader(attempt)}\n\n${buildReviewPrompt(taskCard, executionReport, evidence)}`;
}

async function runSupervisorCreate(server, config, requestId, active, windowId) {
  try {
    return await server.supervisorCreate({
      requestId,
      chatgptUrl: config.chatgptUrl,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
      active,
      windowId,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorAttach(server, config, requestId, conversationId) {
  try {
    return await server.supervisorAttach(conversationId, {
      requestId,
      chatgptUrl: config.chatgptUrl,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorAsk(server, config, requestId, tabId, prompt, expectedConversationId) {
  try {
    return await server.supervisorAsk(prompt, {
      requestId,
      tabId,
      expectedConversationId,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

async function runSupervisorClose(server, config, requestId, tabId) {
  try {
    return await server.supervisorClose({
      requestId,
      tabId,
      responseTimeoutMs: config.responseTimeoutMs,
      connectTimeoutMs: config.extensionConnectTimeoutMs,
    });
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure: ${err.message}`);
  }
}

// Wire-level Supervisor* errors mean the same thing for a Reviewer tab —
// remapped so a ReviewerSession caller only ever sees Reviewer* names.
function remapSupervisorError(err) {
  if (err instanceof SupervisorTabLostError) return new ReviewerTabLostError(err.message);
  if (err instanceof SupervisorIdentityMismatchError) return new ReviewerIdentityMismatchError(err.message);
  if (err instanceof SupervisorAttachMismatchError) return new ReviewerAttachMismatchError(err.message);
  return err;
}

// --- Zero-GPT-request preflight / failure snapshot ------------------------
//
// Live evidence (2026-08-27): the automated loop occasionally hits a blank
// second Reviewer tab, and reproducing it live risks tripping ChatGPT's own
// "too many requests" limiting. Rather than keep reproducing it, the next
// naturally-occurring failure should be fully diagnosable from one run: a
// lightweight LOCAL read of the tab's own state (chrome tab metadata +
// content-script reachability + composer readiness), taken immediately
// before every review() send and again on any review() failure/timeout.
// Never sends anything to ChatGPT and never reloads/retries/creates a tab —
// see reviewerPreflight() in extensionServer.js/extensionProtocol.js and
// domActions.js's snapshotReviewerPreflight for the rest of this path.

// Bounded well under the real review request's own responseTimeoutMs —
// this is a single local DOM read, not a "wait for GPT to reply" call, so
// it must never itself eat into (or approach) the 130s-class budget a real
// review send gets.
const REVIEWER_PREFLIGHT_TIMEOUT_MS = 8000;

async function runReviewerPreflight(server, config, requestId, tabId) {
  try {
    return await withTimeout(
      server.reviewerPreflight({
        requestId,
        tabId,
        responseTimeoutMs: REVIEWER_PREFLIGHT_TIMEOUT_MS,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      }),
      REVIEWER_PREFLIGHT_TIMEOUT_MS + 5000,
      `Reviewer preflight did not complete within ${REVIEWER_PREFLIGHT_TIMEOUT_MS + 5000}ms.`,
      () => server.cancel(requestId)
    );
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure during reviewer preflight: ${err.message}`);
  }
}

// url is reduced to a coarse state, never logged in full — a full URL can
// carry a real conversation id, and this log line must stay safe to paste
// anywhere without leaking anything about the conversation's content.
function classifyUrlState(url) {
  if (!url) return 'unknown';
  try {
    return new URL(url).hostname.endsWith('chatgpt.com') ? 'chatgpt' : 'other';
  } catch {
    return 'unknown';
  }
}

function classifyComposerState(preflight) {
  if (!preflight.contentScriptReachable) return 'unknown';
  if (preflight.composerExists === false) return 'missing';
  if (preflight.composerConnected === false) return 'disconnected';
  if (preflight.composerInteractive === false) return 'not-interactive';
  if (preflight.composerInteractive === true) return 'ready';
  return 'unknown';
}

// Renders exactly the identifiers/state described in the task's log
// example — tabId/urlState/tabStatus/active/discarded/contentScript/
// pageReady/composer — and nothing else. No prompt/reply/page text ever
// passes through here since `preflight` itself never carries any.
function formatPreflightSummary(preflight) {
  return (
    `tabId=${preflight.tabId} urlState=${classifyUrlState(preflight.url)} tabStatus=${preflight.tabStatus} ` +
    `active=${preflight.active} discarded=${preflight.discarded} ` +
    `contentScript=${preflight.contentScriptReachable ? 'reachable' : 'unreachable'} ` +
    `pageReady=${preflight.pageReady} composer=${classifyComposerState(preflight)}`
  );
}

// Runs the preflight and, if it proves the tab unusable, throws immediately
// — before the real review prompt is ever sent, and without waiting out the
// full response timeout. Never reloads/retries/creates another tab; a
// failure here is always terminal for this review() call.
async function runPreflightGate(server, config, requestId, tabId, taskId) {
  const { preflight } = await runReviewerPreflight(server, config, requestId, tabId);
  log(`[${requestId}] reviewer preflight: ${formatPreflightSummary(preflight)}`);

  if (!preflight.tabExists) {
    throw new ReviewerTabLostError(
      `Reviewer tab ${tabId} no longer exists (task "${taskId}") — preflight found it gone before sending the review.`
    );
  }
  if (!preflight.contentScriptReachable) {
    throw new ReviewerPreflightError(
      `Reviewer tab ${tabId}'s content script did not respond to the preflight probe (task "${taskId}").`,
      'CONTENT_SCRIPT_UNREACHABLE'
    );
  }
  if (!preflight.pageReady) {
    throw new ReviewerPreflightError(
      `Reviewer tab ${tabId}'s ChatGPT page is not ready (composer=${classifyComposerState(preflight)}, task "${taskId}").`,
      'CHATGPT_PAGE_NOT_READY'
    );
  }
  return preflight;
}

// Bounded well under the real review request's own responseTimeoutMs, same
// reasoning as REVIEWER_PREFLIGHT_TIMEOUT_MS above — this is a single local
// read of background.js's in-memory stage store, not a "wait for GPT"
// call.
const DIAGNOSTIC_STAGE_TIMEOUT_MS = 5000;

// Looks up the last known extension-side stage for `originalRequestId` — a
// PREVIOUSLY issued requestId whose own request has typically already timed
// out or been cancelled (see extensionServer.js's diagnosticStage()) —
// using a brand-new requestId of its own. This is what lets
// captureFailureSnapshot below still learn where a timed-out supervisorAsk
// got stuck even after automatedLoop's own cleanup has since closed the
// tab/window (see stageDiagnostics.js's header comment for the live finding
// this fixes).
async function runDiagnosticStage(server, config, requestId, originalRequestId) {
  try {
    return await withTimeout(
      server.diagnosticStage({
        requestId,
        originalRequestId,
        responseTimeoutMs: DIAGNOSTIC_STAGE_TIMEOUT_MS,
        connectTimeoutMs: config.extensionConnectTimeoutMs,
      }),
      DIAGNOSTIC_STAGE_TIMEOUT_MS + 5000,
      `Reviewer diagnostic stage lookup did not complete within ${DIAGNOSTIC_STAGE_TIMEOUT_MS + 5000}ms.`,
      () => server.cancel(requestId)
    );
  } catch (err) {
    if (err instanceof ExtensionProtocolError) throw mapProtocolError(err);
    if (err instanceof TransportError) throw err;
    throw new ChromeUnavailableError(`Unexpected extension transport failure during reviewer diagnostic stage lookup: ${err.message}`);
  }
}

// Best-effort final diagnostic snapshot taken on ANY review() failure or
// timeout (including a bare ResponseTimeoutError where the original
// supervisorAsk request never returned at all) — complements, never
// replaces, the existing stage-only diagnostics logged around the send
// itself. A failure while capturing THIS snapshot must never mask or
// replace the original error, so it is swallowed and logged separately.
//
// `originalRequestId` (the requestId the timed-out/failed supervisorAsk
// itself used, if known) is looked up FIRST and logged in the exact format
// this task's timeout-diagnostics requirement specifies, before falling
// back to the existing preflight-based snapshot below it.
async function captureFailureSnapshot(server, config, tabId, taskId, stage, originalRequestId) {
  const requestId = randomUUID();
  if (originalRequestId) {
    try {
      const { stageRecord } = await runDiagnosticStage(server, config, randomUUID(), originalRequestId);
      if (stageRecord) {
        const stageAgeMs = Date.now() - stageRecord.timestamp;
        log(
          `reviewer failure snapshot: originalRequestId=${originalRequestId} tabId=${stageRecord.tabId} ` +
            `lastExtensionStage=${stageRecord.stage} stageAgeMs=${stageAgeMs}`
        );
      } else {
        log(`reviewer failure snapshot: originalRequestId=${originalRequestId} lastExtensionStage=unavailable (no stage record found)`);
      }
    } catch (err) {
      log(`reviewer failure snapshot: originalRequestId=${originalRequestId} stage lookup failed (${err.message})`);
    }
  }
  try {
    const { preflight } = await runReviewerPreflight(server, config, requestId, tabId);
    log(`[${requestId}] reviewer failure snapshot taskId=${taskId} stage=${stage} ${formatPreflightSummary(preflight)}`);
  } catch (err) {
    log(`[${requestId}] reviewer failure snapshot taskId=${taskId} stage=${stage} tabId=${tabId}: preflight unavailable (${err.message})`);
  }
}

export class ReviewerSession {
  constructor(config) {
    this.config = config;
    this._taskId = null;
    this._tabId = null;
    this._conversationId = null;
    this._attempt = 0;
  }

  // { taskId, tabId, conversationId } — conversationId is null until the
  // first review() has actually landed a reply (same reasoning as
  // SupervisorSession.getIdentity()).
  getIdentity() {
    return { taskId: this._taskId, tabId: this._tabId, conversationId: this._conversationId };
  }

  // Opens exactly one fresh ChatGPT tab for this task and leaves it open.
  // Does not send any prompt and does not (cannot yet) capture a
  // conversation id — mirrors SupervisorSession.create() exactly, plus
  // binding this session to `taskId` for its whole lifetime (see
  // ReviewerTaskMismatchError above).
  // `active` is an optional diagnostic override (undefined by default, so
  // background.js's own default of active: false governs) — added only for
  // scripts/test-tab-activation-readiness-live.js's A/B comparison of
  // background- vs foreground-created Reviewer tabs. `windowId` is likewise
  // an optional diagnostic override — added only for
  // scripts/test-background-automation-window-live.js, which creates the
  // Reviewer tab inside a dedicated, deliberately unfocused window.
  async create(taskId, { active, windowId } = {}) {
    if (!taskId) throw new Error('ReviewerSession.create(taskId) requires a non-empty taskId.');
    if (this._taskId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorCreate(server, this.config, requestId, active, windowId),
      this.config.requestTimeoutMs,
      `Reviewer create request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._taskId = taskId;
    this._tabId = result.tabId;
    return this.getIdentity();
  }

  // Re-attaches this session to an EXISTING Reviewer conversation by its
  // exact ChatGPT conversationId — never creates a new conversation — and
  // binds this session to `taskId` for its whole lifetime exactly as
  // create(taskId) does. Mirrors SupervisorSession.attach(): opens a fresh
  // worker tab navigated directly to /c/<conversationId>, and only resolves
  // once the extension has verified (real DOM/URL evidence, never a guess)
  // that the tab actually ended up showing that exact conversation. Any
  // divergence rejects with ReviewerAttachMismatchError and leaves this
  // session exactly as if attach() had never been called — it never
  // silently falls back to creating a fresh conversation. Once attach()
  // succeeds, review(taskId, ...) works exactly as it does after
  // create(taskId), including refusing a different taskId
  // (ReviewerTaskMismatchError).
  async attach(taskId, conversationId) {
    if (!taskId) throw new Error('ReviewerSession.attach(taskId, conversationId) requires a non-empty taskId.');
    if (!conversationId) throw new Error('ReviewerSession.attach(taskId, conversationId) requires a non-empty conversationId.');
    if (this._taskId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    let result;
    try {
      result = await withTimeout(
        runSupervisorAttach(server, this.config, requestId, conversationId),
        this.config.requestTimeoutMs,
        `Reviewer attach request did not complete within ${this.config.requestTimeoutMs}ms.`,
        () => server.cancel(requestId)
      );
    } catch (err) {
      throw remapSupervisorError(err);
    }
    this._taskId = taskId;
    this._tabId = result.tabId;
    this._conversationId = result.conversationId;
    return this.getIdentity();
  }

  // Sends the FULL current Task Card/Execution Report/Evidence into the
  // SAME tab/conversation create() (or the previous review()) established,
  // and returns the parsed Review Result. `taskId` must match the one this
  // session was create()'d for (ReviewerTaskMismatchError otherwise, before
  // any extension call is made — a mismatch never reaches the network).
  //
  // Always addresses this._tabId explicitly. On every review() after the
  // first, the already-known conversation id is sent along as
  // `expectedConversationId`; the extension refuses
  // (ReviewerIdentityMismatchError) rather than silently continuing if the
  // tab's actual conversation no longer matches.
  //
  // `reuseAttempt` (default false): when true, this call does NOT advance
  // the internal review-attempt counter and rebuilds the exact same
  // framing/prompt as the immediately-preceding review() call. It exists
  // for one caller only — the automated loop's bounded rate-limit recovery
  // (automatedLoop.js) — which must be able to re-issue the SAME review
  // (same attempt number, same Task Card/Execution Report/Evidence) after a
  // ChatGPT throttle without it counting as a new review attempt.
  async review(taskId, taskCard, executionReport, evidence, { reuseAttempt = false } = {}) {
    if (this._tabId === null) throw new Error(NOT_CREATED_MESSAGE);
    if (taskId !== this._taskId) throw new ReviewerTaskMismatchError(taskMismatchMessage(this._taskId, taskId));

    if (!reuseAttempt || this._attempt === 0) this._attempt += 1;
    const prompt = buildSessionPrompt(this._attempt, taskCard, executionReport, evidence);

    const requestId = randomUUID();
    log(
      `[${requestId}] reviewer review request entered taskId=${taskId} tabId=${this._tabId} attempt=${this._attempt}` +
        (reuseAttempt ? ' (reused attempt — rate-limit retry)' : '')
    );
    const server = getExtensionServer(this.config);

    await runPreflightGate(server, this.config, randomUUID(), this._tabId, taskId);

    let result;
    try {
      result = await withTimeout(
        runSupervisorAsk(server, this.config, requestId, this._tabId, prompt, this._conversationId),
        this.config.requestTimeoutMs,
        `Reviewer review request did not complete within ${this.config.requestTimeoutMs}ms.`,
        () => server.cancel(requestId)
      );
    } catch (err) {
      log(`[${requestId}] reviewer review request failed taskId=${taskId} tabId=${this._tabId}: ${err.message}`);
      await captureFailureSnapshot(server, this.config, this._tabId, taskId, 'review.supervisorAsk', requestId);
      throw remapSupervisorError(err);
    }
    this._conversationId = result.conversationId;
    log(`[${requestId}] reviewer output parsing started taskId=${taskId}`);
    const parsed = parseReviewResult(taskCard.task_id, result.text);
    log(`[${requestId}] reviewer output parsing completed taskId=${taskId}`);
    return parsed;
  }

  // Closes just this session's own Reviewer worker tab (a plain
  // chrome.tabs.remove) — never the ChatGPT in-page delete flow, and never
  // touches the Supervisor tab or any other ChatGPT tab. Conversation
  // deletion is out of scope for this step (see this file's header
  // comment); the conversation is deliberately left in the account. A
  // no-op if create() was never called.
  async close() {
    if (this._tabId === null) return;
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const tabId = this._tabId;
    this._taskId = null;
    this._tabId = null;
    this._conversationId = null;
    this._attempt = 0;
    try {
      await withTimeout(
        runSupervisorClose(server, this.config, requestId, tabId),
        this.config.requestTimeoutMs,
        `Reviewer close request did not complete within ${this.config.requestTimeoutMs}ms.`,
        () => server.cancel(requestId)
      );
    } catch (err) {
      throw remapSupervisorError(err);
    }
  }
}
