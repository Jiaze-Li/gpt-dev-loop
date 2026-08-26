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
  ReviewerTaskMismatchError,
  ReviewerTabLostError,
  ReviewerIdentityMismatchError,
} from './errors.js';
import { ExtensionProtocolError } from './extensionProtocol.js';
import { buildReviewPrompt, parseReviewResult } from '../orchestrator/adapters/gptReviewerAdapter.js';

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

async function runSupervisorCreate(server, config, requestId) {
  try {
    return await server.supervisorCreate({
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
  return err;
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
  async create(taskId) {
    if (!taskId) throw new Error('ReviewerSession.create(taskId) requires a non-empty taskId.');
    if (this._taskId !== null) throw new Error(ALREADY_CREATED_MESSAGE);
    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    const result = await withTimeout(
      runSupervisorCreate(server, this.config, requestId),
      this.config.requestTimeoutMs,
      `Reviewer create request did not complete within ${this.config.requestTimeoutMs}ms.`,
      () => server.cancel(requestId)
    );
    this._taskId = taskId;
    this._tabId = result.tabId;
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
  async review(taskId, taskCard, executionReport, evidence) {
    if (this._tabId === null) throw new Error(NOT_CREATED_MESSAGE);
    if (taskId !== this._taskId) throw new ReviewerTaskMismatchError(taskMismatchMessage(this._taskId, taskId));

    this._attempt += 1;
    const prompt = buildSessionPrompt(this._attempt, taskCard, executionReport, evidence);

    const requestId = randomUUID();
    const server = getExtensionServer(this.config);
    let result;
    try {
      result = await withTimeout(
        runSupervisorAsk(server, this.config, requestId, this._tabId, prompt, this._conversationId),
        this.config.requestTimeoutMs,
        `Reviewer review request did not complete within ${this.config.requestTimeoutMs}ms.`,
        () => server.cancel(requestId)
      );
    } catch (err) {
      throw remapSupervisorError(err);
    }
    this._conversationId = result.conversationId;
    return parseReviewResult(taskCard.task_id, result.text);
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
