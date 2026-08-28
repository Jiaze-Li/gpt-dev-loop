// Pure ChatGPT-page DOM interaction logic. No chrome.* APIs here — this
// file is imported two ways:
//   1. by content.js at runtime, via a dynamic import() of its
//      chrome.runtime.getURL() (see manifest.json's web_accessible_resources)
//   2. by tests/extensionDomActions.test.js directly, with a fake
//      `document`-like object (mirrors tests/waitForReply.test.js's
//      createFakePage pattern for the Playwright bridge)
//
// Selector values are kept in sync with src/bridge/chatgptWeb.js (the
// Playwright transport) by design — same ChatGPT DOM — but the send/reply
// pipeline below (2026-08-26 transport stabilization) is specific to this
// extension transport: it adds explicit send confirmation with bounded
// retry and drops the Playwright transport's fixed post-stream stability
// wait in favor of the stop-control DOM signal, per
// docs/handoff/2026-08-26-extension-transport-stabilization.md.

export const COMPOSER_SELECTORS = ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror'];

export const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button#composer-submit-button'];

export const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming response"]',
  'button[aria-label="Stop generating"]',
];

export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
export const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';

// ChatGPT renders an assistant turn's actual reply body inside its own
// nested node (class "markdown", stable across ChatGPT UI redesigns since
// it's how ChatGPT's own markdown renderer marks its output) — the message
// card matched by ASSISTANT_MESSAGE_SELECTOR also contains sibling toolbar
// chrome (Edit/Copy/Like/Dislike/Download buttons) INSIDE that same author-
// role node in some layouts, so reading the card's own innerText picks up
// that UI text too (observed live, 2026-08-26: a real reply came back
// prefixed with "Edit\n\n" from the card's "Edit" button). Reading only this
// narrower content node — a DOM boundary, not a text filter — excludes the
// toolbar regardless of what the reply's own text says, including a reply
// that legitimately starts with the word "Edit".
export const ASSISTANT_CONTENT_SELECTOR = '.markdown';

// The assistant turn's own response action/footer toolbar (Copy / good-
// response / bad-response / regenerate controls) — ChatGPT mounts this only
// once the current assistant message has reached its completed-message
// state; it is never present mid-stream. Scoped lookups always query it
// WITHIN the current assistant message node (see currentAssistantNode() in
// waitForReply below), never page-wide, since a page can carry this toolbar
// for other, older turns too. Ordered by preference for stable, semantic
// attributes (data-testid / aria-label tied to the action itself) over any
// nth-child/styling-only class — same reasoning as STOP_BUTTON_SELECTORS
// above. NOT confirmed against a live, logged-in ChatGPT session (no browser
// access while writing this, 2026-08-27) — same caveat as
// CONVERSATION_MENU_BUTTON_SELECTORS below: verify against a real completed
// turn before trusting this signal unattended, and update these constants
// (never the algorithm) if the UI has drifted.
export const ASSISTANT_COMPLETED_ACTION_SELECTORS = [
  '[data-testid="copy-turn-action-button"]',
  '[data-testid="good-response-turn-action-button"]',
  '[data-testid="bad-response-turn-action-button"]',
  'button[aria-label="Copy"]',
  'button[aria-label="Good response"]',
];

// Live evidence (2026-08-27, "completed footer never matches" follow-up): a
// real completed ChatGPT reply visibly showed the Copy/feedback/retry footer
// under the answer, yet a lookup scoped to just the assistant message/body
// node (ASSISTANT_MESSAGE_SELECTOR / ASSISTANT_CONTENT_SELECTOR) matched
// zero ASSISTANT_COMPLETED_ACTION_SELECTORS candidates — the footer is not a
// descendant of that narrower node, it is a SIBLING mounted inside a larger
// per-turn container. These are ChatGPT's known structural markers for that
// container (an `<article>` wrapping one whole turn — its own message body
// AND its action footer together), preferred over any styling class per the
// same reasoning as ASSISTANT_COMPLETED_ACTION_SELECTORS above. NOT
// confirmed against a live session while writing this fix — see
// resolveAssistantTurnRoot's bounded-ancestor fallback below for what
// happens if the UI has drifted and neither of these match.
export const ASSISTANT_TURN_ROOT_SELECTORS = [
  'article[data-turn="assistant"]',
  'article[data-testid^="conversation-turn-"]',
];

function isAssistantTurnRootShape(el) {
  if (!el || typeof el.getAttribute !== 'function') return false;
  const testId = el.getAttribute('data-testid');
  if (typeof testId === 'string' && testId.startsWith('conversation-turn-')) return true;
  return el.getAttribute('data-turn') === 'assistant';
}

function getAncestorElement(el) {
  if (!el) return null;
  return el.parentElement ?? el.parentNode ?? null;
}

// How many ancestor levels above the assistant body node this will climb
// looking for the turn root, before giving up and falling back to the body
// node itself. Bounded (never page-wide) so an older/unrelated turn's own
// footer — which lives under a DIFFERENT ancestor chain entirely, never an
// ancestor of the CURRENT assistant node — can never be reached by this
// walk, and neither can a stray page-wide control mounted near <body>.
export const ASSISTANT_TURN_ANCESTOR_SEARCH_DEPTH = 8;

// Finds the smallest ancestor of `assistantNode` (including the node itself)
// that has the structural shape of one whole ChatGPT turn (see
// ASSISTANT_TURN_ROOT_SELECTORS above) — the container that holds BOTH the
// current reply's body and that same reply's own action footer as siblings.
// Falls back to `assistantNode` itself (the pre-existing, narrower scope) if
// nothing in the bounded ancestor chain has that shape — selector drift or
// an unrecognized DOM/test double degrades to the old behavior rather than
// ever guessing wider. Returns { root, depth, matched } so callers can log
// which case happened without re-walking.
function resolveAssistantTurnRoot(assistantNode, { maxAncestors = ASSISTANT_TURN_ANCESTOR_SEARCH_DEPTH } = {}) {
  let candidate = assistantNode;
  let depth = 0;
  while (candidate && depth <= maxAncestors) {
    if (isAssistantTurnRootShape(candidate)) {
      return { root: candidate, depth, matched: true };
    }
    candidate = getAncestorElement(candidate);
    depth += 1;
  }
  return { root: assistantNode, depth: null, matched: false };
}

// Confirmed live 2026-08-26 (devtools inspection of the sidebar control) —
// see docs/handoff/2026-08-26-extension-transport-stabilization.md.
export const NEW_CHAT_BUTTON_SELECTORS = ['[data-testid="create-new-chat-button"]'];

const DEFAULT_POLL_MS = 300;
const DEFAULT_SEND_READY_TIMEOUT_MS = 3000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 3000;
const DEFAULT_MAX_SEND_ATTEMPTS = 3;
// Real elapsed wall-clock quiet time (not a tick count — see
// createNodeMutationWaiter's comment for why a tick count was the bug)
// required, with the stop indicator invisible and the assistant node's own
// text unchanged, before generation is trusted to have actually finished.
//
// 4th-pass fix (2026-08-27, live completion-provenance diagnostics): 900ms
// was observed live to be an insufficient quiet bound on its own. Exact
// sequence captured by waitForReply's own diagnostics on a real malformed
// NEXT_TASK reply: stop control became visible, assistant text went
// 8 -> 0 -> 26 (a React re-render pass, not a finished reply), stop control
// became absent, and — crucially — NOTHING changed for the next 1023ms, so
// the old 900ms bound trusted this as "confirmed ended" at 26 characters.
// Manual inspection (scripts/test-supervisor-next-task-diagnostics-live.js
// --keep-open-on-failure) confirmed the visible ChatGPT reply kept growing
// well after Node had already returned — i.e. this was a real mid-stream
// pause (Scenario B), not Scenario A (ChatGPT genuinely stopping early).
// Raised to comfortably clear that observed 1023ms pause with margin, while
// staying well inside the caller's own responseTimeoutMs. Every event that
// disproves "generation actually stopped" (text change, stop reappearing,
// text drop-to-zero-then-regrow, or the assistant node itself being
// replaced) still resets this window from scratch — see the "terminal quiet
// candidate" tracking below — so this is a bound on the LONGEST genuine
// pause ChatGPT is trusted to take mid-generation, never a fixed
// post-stream sleep.
const CONFIRM_QUIET_MS = 2500;
// Longer quiet window required when generation-active was never directly
// observed for this reply (stop selector never matched, or the reply
// finished within a single poll) — there is no positive evidence generation
// happened at all here, only the absence of further change, so that absence
// needs to hold longer before it's a meaningful signal.
const CONFIRM_QUIET_MS_NO_SIGNAL = 1800;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitterMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

// --- Conversation identity --------------------------------------------
//
// ChatGPT's only stable, unambiguous identity for a conversation is the
// `/c/<id>` segment of its own URL (assigned once the conversation's first
// message actually lands — a blank "New chat" has no id yet). Never fall
// back to matching by title: titles are user-visible text, can repeat, can
// be renamed/auto-generated late, and are explicitly out of scope as an
// identity source (see the 2026-08-26 conversation-deletion primitive).
export const CONVERSATION_ID_PATTERN = /\/c\/([a-zA-Z0-9-]+)/;

// A real ChatGPT conversation id is a server-assigned UUID (always
// hyphen-segmented) — never a bare word. CONVERSATION_ID_PATTERN above is
// deliberately loose (any /c/<alnum-or-hyphen> segment) so it still matches
// whatever exact id shape ChatGPT uses; this second check is what rejects a
// stray non-conversation anchor/URL segment (e.g. a nav/mode link that
// happens to start with "/c/") from ever being mistaken for one. This is
// the fix for the live bug where a bare token ("WEB") was captured and
// logged as "identity captured" before deletion refused it as not found in
// the sidebar — with this check it is never accepted as a candidate in the
// first place. Does not change the exact-string /c/<id> lookup used to
// locate a conversation's row for deletion (see conversationLinkSelector).
export const CONVERSATION_ID_SHAPE_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+$/;

export function isValidConversationId(id) {
  return typeof id === 'string' && CONVERSATION_ID_SHAPE_PATTERN.test(id);
}

export function extractConversationId(href) {
  const match = typeof href === 'string' ? href.match(CONVERSATION_ID_PATTERN) : null;
  const id = match ? match[1] : null;
  return isValidConversationId(id) ? id : null;
}

// Reads the current tab's conversation id straight off its own URL. Returns
// null if the URL has no `/c/<id>` segment yet (e.g. right after "New chat"
// before the first message is sent) — callers must treat that as "no
// identity yet", not retry with a guess.
export function readConversationId(doc) {
  return extractConversationId(doc?.location?.href ?? '');
}

// Reads the sidebar's own idea of which conversation is currently active —
// the anchor ChatGPT itself marks current (`aria-current="page"`), not just
// "the most recent /c/<...> link", since the sidebar can (and, mid-navigation,
// does) list other conversations too. This is a second, independent
// identity source alongside the URL: the SPA has been observed to update one
// before the other, so waitForConversationIdentity below checks both rather
// than trusting either alone.
function readActiveSidebarConversationId(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return null;
  const anchors = doc.querySelectorAll('a[href^="/c/"]') || [];
  for (const anchor of anchors) {
    const ariaCurrent = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('aria-current') : anchor.ariaCurrent;
    if (ariaCurrent !== 'page') continue;
    const href = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('href') : anchor.href;
    const id = extractConversationId(href);
    if (id) return id;
  }
  return null;
}

function conversationIdentityNotFoundError(message) {
  const err = new Error(message);
  err.code = 'CONVERSATION_IDENTITY_NOT_FOUND';
  return err;
}

const DEFAULT_IDENTITY_TIMEOUT_MS = 15000;

// Bounded budget for acquiring `/c/<id>` AFTER the assistant response has
// already completed — a distinct phase from DEFAULT_IDENTITY_TIMEOUT_MS, not
// a larger value of it. See observeReplyAndIdentity below: this window only
// ever elapses in the case the identity genuinely lagged the reply, and it
// still fails closed (CONVERSATION_IDENTITY_NOT_FOUND) if nothing valid
// appears within it — never a guess, never a weakened validation.
const DEFAULT_IDENTITY_GRACE_MS = 15000;

// Snapshot of both identity sources' raw state, attached to the timeout
// error so a caller without live DOM access (e.g. reading this from the
// Node-side error message/logs) can tell *why* neither source produced an
// id, instead of only "it didn't". Never includes prompt/reply text.
function captureIdentityDiagnostics(doc, baselineId) {
  const anchors = typeof doc?.querySelectorAll === 'function' ? doc.querySelectorAll('a[href^="/c/"]') || [] : [];
  let activeAnchorCount = 0;
  for (const anchor of anchors) {
    const ariaCurrent = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('aria-current') : anchor.ariaCurrent;
    if (ariaCurrent === 'page') activeAnchorCount += 1;
  }
  return {
    baselineId,
    finalUrl: doc?.location?.href ?? null,
    sidebarConversationLinkCount: anchors.length,
    sidebarActiveAnchorCount: activeAnchorCount,
  };
}

// Waits for the freshly-sent conversation's own identity to show up, after
// sendPromptReliably has already confirmed the send. ChatGPT is a SPA: the
// `/c/<id>` URL segment is assigned by client-side routing (history API), not
// a full navigation, so it is NOT guaranteed to be present the instant send
// confirms — reading location.href synchronously right after send (the prior
// bug) can observe the pre-send URL and either miss the id entirely or, worse
// if a stale conversation was still loaded, capture the WRONG id.
//
// Two independent sources are checked, either sufficient: the tab's own URL,
// and the sidebar anchor ChatGPT itself marks as the active conversation.
// Both are compared against `baselineId` (the identity read *before* send)
// so a slow-updating source that still reports the old id is never mistaken
// for the new one. Event-driven first (MutationObserver wakes the check the
// instant the SPA router mutates the DOM), with the timer only as a bounded
// timeout guard — never the sole trigger — matching waitForReply's own
// pattern for exactly the same background-tab-throttling reason.
//
// Returns the new conversation id, or throws CONVERSATION_IDENTITY_NOT_FOUND
// if bounded by timeoutMs with neither source ever producing one. Never
// falls back to a title, a "most recent" guess, or any other heuristic.
export async function waitForConversationIdentity(
  doc,
  {
    baselineId = null,
    timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS,
    sleep = defaultSleep,
    // Injectable wall clock, same reasoning/shape as waitForReply's `now`:
    // production leaves this as real Date.now (the deadline is genuine
    // elapsed time), tests inject a fake clock driven in lockstep with their
    // fake `sleep` so a bounded wait can be exercised deterministically.
    now = () => Date.now(),
    onStage = () => {},
  } = {}
) {
  onStage('waiting for conversation identity');

  function readCandidate() {
    const urlId = readConversationId(doc);
    if (urlId && urlId !== baselineId) return urlId;
    const sidebarId = readActiveSidebarConversationId(doc);
    if (sidebarId && sidebarId !== baselineId) return sidebarId;
    return null;
  }

  const immediate = readCandidate();
  if (immediate) {
    onStage(`identity captured (${immediate})`);
    return immediate;
  }

  const deadline = now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  try {
    while (now() < deadline) {
      await waiter.tick(DEFAULT_POLL_MS);
      const candidate = readCandidate();
      if (candidate) {
        onStage(`identity captured (${candidate})`);
        return candidate;
      }
    }
  } finally {
    waiter.disconnect();
  }

  onStage('identity timeout');
  const err = conversationIdentityNotFoundError(
    `No conversation identity (/c/<id>) appeared within ${timeoutMs}ms after send was confirmed — refusing to guess.`
  );
  err.diagnostics = captureIdentityDiagnostics(doc, baselineId);
  throw err;
}

function supervisorAttachMismatchError(expectedConversationId, actualConversationId) {
  const err = new Error(
    actualConversationId
      ? `Attached tab shows conversation "${actualConversationId}", not the requested "${expectedConversationId}" — refusing to continue in the wrong conversation.`
      : `No conversation is loaded in the attached tab (expected "${expectedConversationId}") — the conversation may not exist, require login, or have failed to load.`
  );
  err.code = 'SUPERVISOR_ATTACH_MISMATCH';
  return err;
}

const DEFAULT_ATTACH_VERIFY_TIMEOUT_MS = 8000;
// A tab freshly navigated straight to /c/<id> can show that id in its URL
// the instant it reaches "complete" and STILL get redirected away moments
// later by ChatGPT's own client-side router — e.g. a conversation that
// doesn't exist, isn't accessible to this account, or a login wall bouncing
// back to "/". Reading location.href exactly once at load is not enough to
// catch that; the id must hold stable for real elapsed time before attach
// trusts it (same reasoning as waitForReply's completion gate above).
const ATTACH_STABLE_QUIET_MS = 1200;

// Verifies that `doc` (a tab just navigated to /c/<expectedConversationId>)
// actually ends up showing EXACTLY that conversation, using only the URL's
// own /c/<id> segment as ground truth — never a sidebar title, never "close
// enough". Returns the verified id once it has held stable for
// ATTACH_STABLE_QUIET_MS; throws SUPERVISOR_ATTACH_MISMATCH (fail closed,
// never falls back to guessing or creating a new conversation) if the
// stable id ever differs from expected, or if no id is ever present at all.
export async function verifyAttachedConversationId(
  doc,
  expectedConversationId,
  {
    timeoutMs = DEFAULT_ATTACH_VERIFY_TIMEOUT_MS,
    sleep = defaultSleep,
    // Injectable wall clock, same reasoning/shape as waitForReply's `now`
    // above: completion is gated on genuine elapsed quiet time, and tests
    // need to exercise that gate deterministically without a real wait.
    now = () => Date.now(),
    onStage = () => {},
  } = {}
) {
  onStage('verifying attached conversation identity');
  onStage(`attach expected conversationId=${expectedConversationId}`);
  const deadline = now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  let lastSeen = readConversationId(doc);
  let stableSince = now();

  // Emits the exact observed-evidence diagnostic block (requested live,
  // 2026-08-26 attach-mismatch investigation) right before this function's
  // final verdict — never mid-loop, since only the final, settled reading is
  // the evidence the verdict is actually based on.
  const logObserved = (id) => {
    onStage(`attach observed url=${doc?.location?.href ?? 'none'}`);
    onStage(`attach observed conversationId=${id ?? 'null'}`);
  };

  try {
    while (true) {
      const current = readConversationId(doc);
      if (current !== lastSeen) {
        lastSeen = current;
        stableSince = now();
      }
      if (now() - stableSince >= ATTACH_STABLE_QUIET_MS) {
        logObserved(current);
        if (current !== expectedConversationId) {
          onStage('attach identity mismatch');
          throw supervisorAttachMismatchError(expectedConversationId, current);
        }
        onStage('attach identity confirmed');
        return current;
      }
      if (now() >= deadline) break;
      await waiter.tick(Math.min(DEFAULT_POLL_MS, deadline - now()));
    }
  } finally {
    waiter.disconnect();
  }

  // Deadline hit before the id ever held stable for the full quiet window —
  // judge on whatever the URL shows right now rather than looping forever.
  const finalId = readConversationId(doc);
  logObserved(finalId);
  if (finalId !== expectedConversationId) {
    onStage('attach identity mismatch');
    throw supervisorAttachMismatchError(expectedConversationId, finalId);
  }
  onStage('attach identity confirmed');
  return finalId;
}

// --- Rate-limit detection ------------------------------------------------
//
// ChatGPT's own throttling banner ("You're making requests too quickly...")
// is a distinct failure mode from any DOM/selector problem: it means
// ChatGPT itself is refusing to proceed for a while, so the right response
// is to back off and retry later (handled Node-side, see
// chatgptExtension.js), not to keep polling/retrying immediately.
const RATE_LIMIT_TEXT_PATTERN = /making requests too quickly|temporarily limited/i;

export function isRateLimited(doc) {
  const text = doc?.body?.innerText ?? doc?.body?.textContent ?? '';
  return RATE_LIMIT_TEXT_PATTERN.test(text);
}

function rateLimitedError(message) {
  const err = new Error(message);
  err.code = 'RATE_LIMITED';
  return err;
}

function firstVisible(doc, selectors) {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && el.isVisible !== false) return el;
  }
  return null;
}

function isAnyVisible(doc, selectors) {
  return selectors.some((selector) => {
    const el = doc.querySelector(selector);
    return !!el && el.isVisible !== false;
  });
}

function sendFailedError(message) {
  const err = new Error(message);
  err.code = 'SEND_FAILED';
  return err;
}

// Polls for the composer up to timeoutMs. Returns the element, or null if
// it never appears — content.js maps null to LOGIN_REQUIRED (Phase 1
// simplification: an absent composer is treated as "needs login", see the
// handoff's "Chrome Extension 内部结构" section).
export async function findComposer(doc, selectors = COMPOSER_SELECTORS, { timeoutMs = 5000, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while looking for the composer.');
    const el = firstVisible(doc, selectors);
    if (el) return el;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < deadline);
  return firstVisible(doc, selectors);
}

export const CHATGPT_PAGE_READY_TIMEOUT_MS = 15000;

// A matching COMPOSER_SELECTORS element is not sufficient proof the ChatGPT
// SPA has actually hydrated — firstVisible()'s `el.isVisible !== false`
// check only excludes elements a *test* fake explicitly marks hidden, and
// says nothing about a real DOM node's actual layout state. This adds the
// real-world checks: connected to the document (not a stale reference from
// before a since-completed SPA navigation), not disabled, and — when
// getClientRects is available (real browser, not the plain-object fakes
// tests/extensionDomActions.test.js uses) — actually laid out on the page.
function isComposerReady(el) {
  if (!el) return false;
  if (el.isConnected === false) return false;
  if (el.disabled) return false;
  const ariaDisabled = typeof el.getAttribute === 'function' ? el.getAttribute('aria-disabled') : null;
  if (ariaDisabled === 'true') return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  return true;
}

// Point-in-time composer lookup for snapshotReviewerPreflight below — unlike
// firstVisible (which only matches an `isVisible !== false` element),
// this returns the first matching element regardless of visibility, so a
// composer that exists but isn't currently laid out is reported as
// "exists but not interactive" rather than "does not exist".
function findAnyComposerElement(doc, selectors = COMPOSER_SELECTORS) {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el) return el;
  }
  return null;
}

// A single, non-waiting read of the Reviewer tab's current DOM state — the
// local preflight probe reviewerSession.js runs immediately before every
// review() send (see its own header comment). Deliberately does not poll or
// wait for anything (unlike waitForChatGptReady/findComposer above): this
// must report the tab's state as it is RIGHT NOW, never send a prompt, and
// never delay entering the real supervisorAsk timeout. Returns identifiers/
// state only — url and boolean flags — never page text, so a caller logging
// this snapshot can never leak page content.
export function snapshotReviewerPreflight(doc) {
  const composerEl = findAnyComposerElement(doc);
  const composerExists = !!composerEl;
  const composerConnected = composerExists && composerEl.isConnected !== false;
  const composerInteractive = composerExists && isComposerReady(composerEl);
  return {
    url: doc?.location?.href ?? null,
    pageReady: composerInteractive,
    composerExists,
    composerConnected,
    composerInteractive,
  };
}

function chatgptPageNotReadyError(doc, timeoutMs, composerFound) {
  const url = doc?.location?.href ?? 'unknown';
  const err = new Error(
    `ChatGPT page did not become ready (composer not usable) within ${timeoutMs}ms. url=${url} composerFound=${composerFound}`
  );
  err.code = 'CHATGPT_PAGE_NOT_READY';
  err.diagnostics = { url, composerFound };
  return err;
}

// Waits for the ChatGPT SPA to actually finish hydrating in a freshly
// created tab — chrome.tabs "complete" only means the outer document
// finished loading, not that ChatGPT's own app has mounted a usable
// composer yet (live evidence, 2026-08-27: a second Reviewer tab reached
// "complete" while still showing a blank page, and the ask sent right
// after it hung for the full responseTimeoutMs waiting on a composer that
// was never really interactive). Readiness here means: a composer element
// matches COMPOSER_SELECTORS AND is currently connected/enabled/laid-out
// (isComposerReady above) — not just "a matching selector exists somewhere
// in the DOM", which a stale or not-yet-mounted node could still satisfy.
// Event-driven via MutationObserver with a bounded poll fallback, same
// pattern as findComposer/waitForReply above. Never resolves on a composer
// reference that was valid a moment ago but is no longer — each iteration
// re-reads the DOM fresh, so a mid-wait SPA navigation that invalidates an
// earlier match is never mistaken for readiness (fail closed, not fail
// stale).
export async function waitForChatGptReady(
  doc,
  { timeoutMs = CHATGPT_PAGE_READY_TIMEOUT_MS, sleep = defaultSleep, onStage = () => {} } = {}
) {
  onStage('waiting for ChatGPT UI');
  const deadline = Date.now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  let lastComposer = null;
  try {
    do {
      if (isRateLimited(doc)) {
        throw rateLimitedError('ChatGPT reported "making requests too quickly" while waiting for the page to become ready.');
      }
      lastComposer = firstVisible(doc, COMPOSER_SELECTORS);
      if (isComposerReady(lastComposer)) {
        onStage('composer detected');
        onStage('ChatGPT page ready');
        return { ready: true, url: doc?.location?.href ?? null };
      }
      await waiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < deadline);
  } finally {
    waiter.disconnect();
  }

  onStage('ChatGPT page not ready (timeout)');
  throw chatgptPageNotReadyError(doc, timeoutMs, !!lastComposer);
}

// Clicks the sidebar "New chat" control before this review's prompt is
// typed in. Navigating a freshly created tab straight to chatgptUrl is not
// enough on its own — observed live (2026-08-26) restoring the same
// ongoing conversation instead of a blank one (ChatGPT's client-side
// router redirected the bare root URL back to the last active
// conversation), which is exactly the conversation-isolation bug this
// fixes. Never throws: returns a status object so a missing control (a
// layout change, or a chat that's already blank) degrades to "continue
// anyway" rather than failing the whole review — content.js logs whichever
// happened.
export async function startNewChat(
  doc,
  selectors = NEW_CHAT_BUTTON_SELECTORS,
  { timeoutMs = 5000, sleep = defaultSleep, simulateClick = defaultSimulateClick } = {}
) {
  const findDeadline = Date.now() + timeoutMs;
  let button = null;
  do {
    button = firstVisible(doc, selectors);
    if (button) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < findDeadline);

  if (!button) return { clicked: false, cleared: false };

  simulateClick(button);

  // Best-effort confirmation that the conversation actually cleared —
  // not fatal if it doesn't within the timeout (e.g. it was already blank).
  const clearDeadline = Date.now() + timeoutMs;
  do {
    const remaining = doc.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).length + doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
    if (remaining === 0) return { clicked: true, cleared: true };
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < clearDeadline);
  return { clicked: true, cleared: false };
}

function readComposerText(composer) {
  if ('value' in composer) return (composer.value ?? '').trim();
  return (composer.innerText ?? composer.textContent ?? '').trim();
}

// Chrome throttles setTimeout/setInterval in background/inactive tabs
// (observed live: 2026-08-26, a 120s responseTimeoutMs elapsed with zero
// polls landing while the ChatGPT tab sat behind the terminal window,
// producing a false RESPONSE_EMPTY even though ChatGPT had replied) — but
// MutationObserver callbacks are NOT subject to that throttling, since they
// fire as a direct consequence of the page's own script mutating the DOM in
// response to the streaming reply, not off a timer wheel. defaultTick races
// the plain poll-interval sleep against "a mutation happened", so a
// backgrounded tab still wakes the loop the instant new text lands instead
// of waiting out the throttled interval. Falls back to pure interval
// polling when MutationObserver/doc.body aren't available (real browser
// only — tests/extensionDomActions.test.js's fake `document` has neither,
// so it exercises the exact same polling path as before this change).
function createMutationWaiter(doc, sleep) {
  if (typeof MutationObserver === 'undefined' || !doc?.body) {
    return { tick: (ms) => sleep(ms), disconnect() {} };
  }

  let wake = null;
  const observer = new MutationObserver(() => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

  return {
    tick(ms) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          wake = null;
          resolve();
        };
        wake = finish;
        sleep(ms).then(finish);
      });
    },
    disconnect() {
      observer.disconnect();
    },
  };
}

// Scoped variant of createMutationWaiter, observing a single DOM node (the
// current assistant message container) rather than the whole document body.
//
// Root cause of the second live "partial reply" failure (2026-08-26, third
// pass): waitForReply's completion confirmation used createMutationWaiter
// (doc.body-wide) to drive its recheck ticks, then counted a fixed number of
// ticks with no textual change as proof generation had gone quiet. On a real
// ChatGPT page, doc.body mutates constantly for reasons that have nothing to
// do with the reply — timestamps, sidebar items, unrelated animations — so a
// burst of *unrelated* mutations could resolve all of those "confirmation"
// ticks in a few milliseconds of wall-clock time, long before the next
// paragraph of the actual reply had a chance to land. Counting ticks was
// never equivalent to waiting real time. This waiter instead observes only
// the current assistant message node's own subtree, so a tick only fires
// on a mutation that could plausibly be the reply itself changing — combined
// with waitForReply now gating completion on real elapsed quiet time (not a
// tick count), a burst of unrelated page churn can no longer collapse the
// confirmation window. tick() also reports whether it resolved because of an
// observed mutation or because its timeout elapsed with none, for stage
// diagnostics.
function createNodeMutationWaiter(doc, node, sleep) {
  if (typeof MutationObserver === 'undefined' || !node) {
    return { tick: async (ms) => (await sleep(ms), 'timeout'), disconnect() {} };
  }

  let wake = null;
  const observer = new MutationObserver(() => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve('mutation');
    }
  });
  observer.observe(node, { childList: true, subtree: true, characterData: true });

  return {
    tick(ms) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (source) => {
          if (settled) return;
          settled = true;
          wake = null;
          resolve(source);
        };
        wake = finish;
        sleep(ms).then(() => finish('timeout'));
      });
    },
    disconnect() {
      observer.disconnect();
    },
  };
}

// A Reviewer prompt (Task Card + Execution Report + Evidence) runs orders of
// magnitude larger and more multi-paragraph than a typical Supervisor
// prompt. `document.execCommand('insertText', ...)` on a live ChatGPT
// ProseMirror composer synthesizes the insertion as if typed, which for a
// large multi-paragraph string can force the editor to process it
// line-by-line/node-by-node — a SYNCHRONOUS, main-thread operation that
// nothing in insertPromptReliably's async timeout/verification loop below
// can interrupt once started (Promise.race cannot preempt a running
// synchronous call). Live evidence (2026-08-27): a Reviewer send whose
// preflight was fully healthy stuck at "prompt insertion started" for the
// entire 130s overall timeout with the composer visibly still empty — never
// even reaching the bounded 5s bound inside insertPromptReliably, which is
// only reachable once this synchronous write call itself returns. For any
// prompt at or above this size/structure, skip execCommand entirely and go
// straight to the direct-DOM write path below, which is a small number of
// property assignments and event dispatches — no per-line/per-node editor
// processing — regardless of string length.
const LARGE_PROMPT_LENGTH_THRESHOLD = 2000;
const LARGE_PROMPT_NEWLINE_THRESHOLD = 20;

// Structural-only metrics (length/newline/paragraph counts) for comparing
// Supervisor vs Reviewer payloads in diagnostics — never logs the prompt
// text itself.
export function promptStructuralMetrics(prompt) {
  const newlineCount = (prompt.match(/\n/g) ?? []).length;
  const paragraphCount = prompt.split(/\n{2,}/).length;
  return { length: prompt.length, newlineCount, paragraphCount };
}

function isLargeStructuredPrompt(prompt) {
  if (prompt.length > LARGE_PROMPT_LENGTH_THRESHOLD) return true;
  const { newlineCount } = promptStructuralMetrics(prompt);
  return newlineCount > LARGE_PROMPT_NEWLINE_THRESHOLD;
}

// Writes `prompt` directly onto the composer's own text property (never via
// execCommand) and fires the events ProseMirror's controller listens for.
// Deliberately just property assignment + event dispatch — no per-character
// or per-line editor processing — so this stays fast and bounded regardless
// of how large or multi-paragraph `prompt` is.
function writePromptDirectly(composer, prompt) {
  try {
    if ('value' in composer) {
      composer.value = prompt;
    } else {
      composer.textContent = prompt;
      composer.innerText = prompt;
    }
  } catch {
    return false; // composer's text properties aren't writable (e.g. frozen/replaced mid-flight)
  }
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: prompt }));
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return readComposerText(composer).length > 0;
}

// Single-attempt, synchronous write of `prompt` into `composer` — used as
// the low-level "content write" step inside insertPromptReliably below (and
// exercised directly by its own pre-existing tests). Verifies the composer's
// own text actually changed — `execCommand('insertText', ...)` has been
// observed to silently no-op on some ChatGPT ProseMirror builds
// (2026-08-26), which previously left gpt-loop waiting out the full
// responseTimeoutMs for a reply to a message that was never actually typed
// in. Falls back to setting the DOM directly and firing the input events
// ProseMirror's own controller listens for when execCommand doesn't take.
// Large/multi-paragraph prompts (see isLargeStructuredPrompt above) skip
// execCommand altogether and go straight to that same direct-DOM path.
export function insertPromptText(doc, composer, prompt, { execCommand } = {}) {
  composer.focus();

  if (isLargeStructuredPrompt(prompt)) {
    return writePromptDirectly(composer, prompt);
  }

  const runExecCommand = execCommand ?? ((...args) => doc.execCommand(...args));
  runExecCommand('insertText', false, prompt);
  // Always fire a real 'input' event after execCommand too, not only in the
  // DOM-fallback branch below — execCommand has been observed to update the
  // visible DOM (satisfying the check just below) without the ProseMirror
  // controller's own state actually registering the change every time,
  // which then leaves ChatGPT's send button permanently disabled even
  // though the composer visibly holds text (observed live, 2026-08-26).
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (readComposerText(composer).length > 0) return true;

  return writePromptDirectly(composer, prompt);
}

// Clears the composer via the same execCommand path insertion prefers (more
// likely to be recognized by ProseMirror's own state than a blunt DOM
// clear), falling back to setting the text directly if that doesn't take.
function clearComposer(doc, composer, { execCommand } = {}) {
  const runExecCommand = execCommand ?? ((...args) => doc.execCommand(...args));
  composer.focus();
  runExecCommand('selectAll');
  runExecCommand('delete');
  if (typeof InputEvent !== 'undefined') {
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  } else {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (readComposerText(composer).length === 0) return;

  try {
    if ('value' in composer) {
      composer.value = '';
    } else {
      composer.textContent = '';
      composer.innerText = '';
    }
  } catch {
    // best effort — insertPromptText's own execCommand call right after
    // this will still run regardless
  }
}

// --- Bounded, diagnosable prompt insertion (2026-08-27) -------------------
//
// Live evidence: a Reviewer request whose preflight (composer ready, page
// hydrated, tab active) was fully healthy still timed out the full
// responseTimeoutMs with the last recorded stage stuck at "prompt insertion
// started" — the composer visibly stayed on the blank ChatGPT home screen
// with no text ever typed. The prior insertPromptText() above is a single
// synchronous write with no timeout of its own and no verification beyond
// "is the composer non-empty" — not enough to fail fast or say why.
//
// insertPromptReliably() wraps that write in: explicit sub-stage diagnostics
// (never logging prompt content), a bounded verification wait independent of
// the overall request timeout, mechanical verification by length + a cheap
// digest (never by reading the text back into a log), and a single bounded
// re-resolve+retry if the composer element itself goes missing/gets replaced
// mid-flight (a React remount) — never an unbounded retry loop. On failure
// this throws a specific PROMPT_INSERTION_TIMEOUT or PROMPT_INSERTION_FAILED
// error and never proceeds to send.
const DEFAULT_PROMPT_INSERTION_TIMEOUT_MS = 5000;
const DEFAULT_PROMPT_INSERTION_POLL_MS = 150;
// Slack added on top of promptInsertionTimeoutMs for the OUTER hard-timeout
// wrapper in sendPromptReliably below — kept small since insertPromptReliably
// already bounds itself; this only exists to catch a bound that failed to
// fire (see sendPromptReliably's own comment for why).
const INSERTION_HARD_TIMEOUT_BUFFER_MS = 2000;

// Real-clock timer, deliberately independent of whatever `sleep` a caller
// injects into insertPromptReliably's own internal deadline loop — the whole
// point of this outer bound is to still fire even if THAT `sleep` (or the
// `now`/deadline math built on it) is itself the thing that's broken, so it
// must not share the same primitive.
function defaultScheduleHardTimeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Races `promise` against a real-clock timer of `budgetMs`, rejecting with
// PROMPT_INSERTION_TIMEOUT if the timer wins. Cannot interrupt a still-
// running synchronous call inside `promise` (nothing in JS can) — this only
// guards against `promise` itself never settling once whatever synchronous
// work it does finally returns control to the event loop, including the
// case where insertPromptReliably's OWN internal deadline check never fires
// (e.g. a bug in its `now`/`sleep`).
function withHardTimeout(promise, budgetMs, scheduleTimeout = defaultScheduleHardTimeout) {
  let settled = false;
  const guarded = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err) => {
      settled = true;
      throw err;
    }
  );
  const timeout = scheduleTimeout(budgetMs).then(() => {
    if (settled) return undefined; // never happens if the race already resolved via `promise`, kept for clarity
    throw promptInsertionTimeoutError(`Prompt insertion exceeded the overall insertion budget of ${budgetMs}ms.`);
  });
  return Promise.race([guarded, timeout]);
}

function promptInsertionTimeoutError(message, diagnostics) {
  const err = new Error(message);
  err.code = 'PROMPT_INSERTION_TIMEOUT';
  if (diagnostics) err.diagnostics = diagnostics;
  return err;
}

function promptInsertionFailedError(message, diagnostics) {
  const err = new Error(message);
  err.code = 'PROMPT_INSERTION_FAILED';
  if (diagnostics) err.diagnostics = diagnostics;
  return err;
}

// Cheap non-cryptographic digest (djb2 variant) used only as a mismatch
// signal alongside length in diagnostics/errors — never logs or exposes the
// prompt/observed text itself, only this numeric digest.
function textDigest(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function composerAttached(el) {
  return !!el && el.isConnected !== false;
}

// Strips/collapses characters that a contenteditable ProseMirror composer's
// own paragraph-per-line rendering introduces on readback but that carry no
// semantic content of their own — never anything that could hide truncation,
// duplication, or a genuine content change.
//
// Live evidence (2026-08-27): a prompt written successfully into the visible
// composer still failed verification — expectedLength=3783 (the raw source
// string) vs observedLength=3914 read back via readComposerText()'s
// innerText/textContent path. innerText reconstructs text from the DOM, and
// ChatGPT's composer represents each line as its own block-level node
// (paragraph-per-line, a ProseMirror doc structure) — reading that back
// inserts a line-break at every block boundary regardless of how many "\n"
// characters were actually written there, which inflates any run of blank
// lines (consecutive "\n") into more newline characters than the source
// prompt contained. Two further known-artifact sources are also normalized
// here even though this specific incident's diff is consistent with the
// newline-run cause alone: NBSP (contenteditable editors substitute U+00A0
// for a plain space at paragraph edges to stop it collapsing) and
// zero-width characters some editors insert as internal node boundaries
// (U+200B/U+200C/U+200D/U+FEFF) — none of these carry meaning a reviewer or
// Claude would ever intend to convey.
//
// Deliberately NOT included: collapsing intra-line whitespace, trimming
// individual words, or any transform that could make two DIFFERENT prompts
// compare equal — only representational noise proven to come from the
// editor's own DOM structure is touched here.
function canonicalizeComposerText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Bounded, diagnosable insertion pipeline. `composer` is the caller's
// already-resolved element; if it (or a later replacement) goes missing this
// re-resolves via `composerSelectors` against `doc` at most once. Resolves
// with whichever composer element ultimately holds the verified text (which
// may differ from the `composer` argument, if a re-resolve happened) —
// callers must use the returned element for anything after insertion, not
// the original argument.
export async function insertPromptReliably(
  doc,
  composer,
  prompt,
  {
    composerSelectors = COMPOSER_SELECTORS,
    execCommand,
    timeoutMs = DEFAULT_PROMPT_INSERTION_TIMEOUT_MS,
    pollMs = DEFAULT_PROMPT_INSERTION_POLL_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
    onStage = () => {},
  } = {}
) {
  const deadline = now() + timeoutMs;
  const expectedCanonical = canonicalizeComposerText(prompt);
  const expectedLength = expectedCanonical.length;
  const expectedDigest = textDigest(expectedCanonical);

  let current = composer;
  let reResolveUsed = false;

  for (;;) {
    if (!composerAttached(current)) {
      if (reResolveUsed) {
        throw promptInsertionFailedError(
          'Composer element was replaced/detached more than once during insertion; refusing to keep retrying.'
        );
      }
      const replacement = findAnyComposerElement(doc, composerSelectors);
      if (!replacement) {
        throw promptInsertionFailedError('Composer element is detached and no replacement composer could be found.');
      }
      reResolveUsed = true;
      current = replacement;
      onStage('insertion target re-resolved');
    }

    onStage('insertion target resolved');

    try {
      current.focus();
    } catch {
      // A focus() throw is not itself fatal — verification below is what
      // ultimately decides success or failure, not this call succeeding.
    }
    onStage('insertion target focused');

    onStage('content write started');
    let wrote = false;
    try {
      wrote = insertPromptText(doc, current, prompt, { execCommand });
    } catch {
      wrote = false;
    }
    onStage('content write finished');
    onStage('input/change events dispatched');

    if (!wrote) {
      if (!composerAttached(current)) {
        current = null;
        continue;
      }
      throw promptInsertionFailedError('Could not write the prompt into the composer (write reported failure).');
    }

    onStage('inserted-content verification started');
    let detachedDuringVerify = false;
    for (;;) {
      if (!composerAttached(current)) {
        detachedDuringVerify = true;
        break;
      }
      const observedCanonical = canonicalizeComposerText(readComposerText(current));
      const observedLength = observedCanonical.length;
      if (observedLength === expectedLength && textDigest(observedCanonical) === expectedDigest) {
        onStage('inserted-content verification succeeded');
        return current;
      }
      if (now() >= deadline) {
        throw promptInsertionTimeoutError(
          `Prompt insertion could not be verified within ${timeoutMs}ms ` +
            `(expectedLength=${expectedLength}, observedLength=${observedLength}).`,
          { expectedLength, observedLength }
        );
      }
      await sleep(Math.min(pollMs, deadline - now()));
    }

    if (detachedDuringVerify) {
      current = null;
      continue;
    }
  }
}

function isSendReady(el) {
  if (!el) return false;
  if (el.disabled) return false;
  const ariaDisabled = typeof el.getAttribute === 'function' ? el.getAttribute('aria-disabled') : null;
  if (ariaDisabled === 'true') return false;
  return true;
}

// Waits for a visible send button that is also enabled (ChatGPT disables
// it — `aria-disabled="true"` or `.disabled` — until the composer holds
// text it recognizes) before returning it. Returns null if none becomes
// ready in time, so the caller can fall back to the Enter-key path.
export async function waitForSendReady(doc, sendSelectors = SEND_BUTTON_SELECTORS, { timeoutMs = DEFAULT_SEND_READY_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const el = firstVisible(doc, sendSelectors);
    if (isSendReady(el)) return el;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

function defaultPressEnter(composer) {
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
}

// ChatGPT's send button is a Radix/Base-UI-style control that reacts to
// pointer events, not just `click`— a plain `el.click()` synthesizes a
// MouseEvent click but no pointerdown/pointerup, so the button's own
// handlers never fire and the prompt silently stays in the composer
// (observed live: 2026-08-25, aria-disabled="false" button, click() alone
// was a no-op). Only constructs PointerEvent/MouseEvent when those globals
// exist (real browser) — tests/extensionDomActions.test.js runs this
// against a fake `document` in Node, where they don't, and el.click() alone
// is enough to satisfy the fake element's click() stub.
function defaultSimulateClick(el) {
  if (typeof PointerEvent !== 'undefined') {
    const pointerOpts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0 };
    const mouseOpts = { bubbles: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    el.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  }
  el.click();
}

// Confirms the send actually took effect using real DOM evidence: either
// the user-message count increased, or the composer went back to empty
// (some UIs clear the composer before the new message node finishes
// rendering) — never just "we clicked something and assume it worked".
async function confirmSent(doc, composer, userBaselineCount, { timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  const waiter = createMutationWaiter(doc, sleep);
  try {
    do {
      const count = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
      if (count > userBaselineCount || readComposerText(composer).length === 0) return true;
      await waiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < deadline);
    const count = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;
    return count > userBaselineCount || readComposerText(composer).length === 0;
  } finally {
    waiter.disconnect();
  }
}

// Explicit staged send pipeline (docs/handoff/2026-08-26-extension-
// transport-stabilization.md): text inserted -> send control ready -> send
// triggered -> send confirmed, with real DOM evidence gating each
// transition into the next, and a bounded number of retries if a send
// can't be confirmed — never leaves the prompt sitting typed-but-unsent
// while the caller waits out the full reply timeout. `onStage(name)` is
// called synchronously at each transition for the caller's own timing
// diagnostics; this module stays chrome-API-free.
export async function sendPromptReliably(
  doc,
  composer,
  prompt,
  sendSelectors = SEND_BUTTON_SELECTORS,
  {
    maxAttempts = DEFAULT_MAX_SEND_ATTEMPTS,
    sendReadyTimeoutMs = DEFAULT_SEND_READY_TIMEOUT_MS,
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    promptInsertionTimeoutMs = DEFAULT_PROMPT_INSERTION_TIMEOUT_MS,
    composerSelectors = COMPOSER_SELECTORS,
    pressEnter = defaultPressEnter,
    simulateClick = defaultSimulateClick,
    sleep = defaultSleep,
    now,
    pollMs,
    scheduleHardTimeout = defaultScheduleHardTimeout,
    onStage = () => {},
  } = {}
) {
  // A small, randomized pause before the first keystroke — a script that
  // inserts text and clicks send in the same tick is a distinctive,
  // instantly-fireable signature; a brief human-scale jitter here costs
  // nothing functionally and avoids that.
  await sleep(randomJitterMs(150, 500));

  onStage('prompt insertion started');
  // Structural-only metrics (never prompt content) for comparing Supervisor
  // vs Reviewer payloads after the fact — see promptStructuralMetrics/
  // isLargeStructuredPrompt above for why a Reviewer-sized payload is routed
  // away from execCommand.
  const { length, newlineCount, paragraphCount } = promptStructuralMetrics(prompt);
  onStage(`payload metrics: length=${length} newlines=${newlineCount} paragraphs=${paragraphCount}`);
  // Bounded and diagnosable on its own — never lets prompt insertion consume
  // the caller's full response timeout, and throws a specific
  // PROMPT_INSERTION_TIMEOUT/PROMPT_INSERTION_FAILED rather than SEND_FAILED
  // so a stuck insertion is distinguishable from a stuck send. Never
  // proceeds to the send stages below on failure — the throw here exits
  // sendPromptReliably immediately.
  //
  // Wrapped in an outer hard timeout as a second, independent bound on top
  // of insertPromptReliably's own internal deadline: the internal bound only
  // covers awaited phases, so it cannot fire if a supposedly-synchronous
  // primitive inside it (e.g. execCommand on a huge payload) runs far longer
  // than expected — Promise.race cannot preempt an in-progress synchronous
  // call, but it CAN make sure that once that call finally returns (or if
  // some other unbounded await slips in later), this never silently waits
  // out the caller's full response timeout instead of failing fast with
  // PROMPT_INSERTION_TIMEOUT. The real fix for the synchronous-hang risk
  // itself is routing large prompts away from execCommand entirely (see
  // insertPromptText above) — this is defense-in-depth, not a substitute.
  const insertionOptions = { composerSelectors, timeoutMs: promptInsertionTimeoutMs, sleep, onStage };
  if (now) insertionOptions.now = now;
  if (pollMs) insertionOptions.pollMs = pollMs;
  let activeComposer = await withHardTimeout(
    insertPromptReliably(doc, composer, prompt, insertionOptions),
    promptInsertionTimeoutMs + INSERTION_HARD_TIMEOUT_BUFFER_MS,
    scheduleHardTimeout
  );
  onStage('prompt insertion completed');

  const userBaselineCount = doc.querySelectorAll(USER_MESSAGE_SELECTOR).length;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const sendButton = await waitForSendReady(doc, sendSelectors, { timeoutMs: sendReadyTimeoutMs, sleep });
    onStage('send ready');

    if (sendButton) {
      simulateClick(sendButton);
    } else {
      pressEnter(activeComposer);
    }
    onStage('send triggered');

    const confirmed = await confirmSent(doc, activeComposer, userBaselineCount, { timeoutMs: confirmTimeoutMs, sleep });
    if (confirmed) {
      onStage('new user message observed');
      onStage('send confirmed');
      return;
    }

    // Not confirmed. Retrying the click/Enter alone is not enough when the
    // real cause is that the composer's visible text was never actually
    // registered by ChatGPT's own controller (observed live, 2026-08-26 —
    // the send button then stays disabled and Enter does nothing no matter
    // how many times either is retried, since ChatGPT's own state still
    // thinks the composer is empty). So every retry clears the composer
    // and re-inserts the prompt fresh before trying to send again, rather
    // than only when the composer happens to look empty.
    if (attempt < maxAttempts) {
      clearComposer(doc, activeComposer);
      activeComposer = await withHardTimeout(
        insertPromptReliably(doc, activeComposer, prompt, insertionOptions),
        promptInsertionTimeoutMs + INSERTION_HARD_TIMEOUT_BUFFER_MS,
        scheduleHardTimeout
      );
    }
  }

  throw sendFailedError(`Could not confirm the prompt was sent after ${maxAttempts} attempt(s).`);
}

// Waits for the assistant message count to exceed baselineCount, then
// returns once generation is CONFIRMED to have actually finished — no fixed
// post-stream stability wait, and no fixed sleep as the success path.
//
// Root cause history:
//   - 1st pass (2026-08-26): treated "stop control not visible + some text
//     present" as proof of completion on the very first reading — the stop
//     control mounting is itself asynchronous, so this could fire before
//     generation had even properly started.
//   - 2nd pass (2026-08-26): added a fixed-count recheck ("N ticks with no
//     change") gated on having observed real activity first. Still failed
//     live: the recheck ticks were driven by createMutationWaiter observing
//     doc.body — which mutates constantly for reasons unrelated to the
//     reply (sidebar timestamps, unrelated re-renders). A burst of those
//     unrelated mutations could resolve all N "confirmation" ticks in a few
//     milliseconds of wall time, nowhere near the real gap before the next
//     paragraph landed. Counting ticks was never equivalent to waiting real
//     time, and the ticks weren't even scoped to the reply itself.
//   - 3rd pass (this one): completion is gated on real ELAPSED WALL-CLOCK
//     QUIET TIME since the last observed activity (CONFIRM_QUIET_MS /
//     CONFIRM_QUIET_MS_NO_SIGNAL), not a tick count — so an unrelated burst
//     of page churn can no longer collapse the confirmation window. The
//     waiter driving those ticks (createNodeMutationWaiter) is also now
//     scoped to the current assistant message node's own subtree, not
//     doc.body, so a tick firing is itself evidence the reply node changed,
//     not proof of arbitrary page activity. "Activity" that resets the
//     quiet-time clock is: the stop control visible, or the assistant node's
//     own text changing (covers growth and shrink/edits, e.g. a trailing
//     markdown re-render pass).
//
//   - 5th pass (2026-08-27, live "genuine mid-generation pause exceeds
//     CONFIRM_QUIET_MS" evidence): live diagnostics from the 4th pass proved
//     the quiet-time model alone is still not sufficient — a real, confirmed
//     mid-stream pause was observed to exceed CONFIRM_QUIET_MS (2500ms) on
//     its own, with the stop control genuinely absent throughout, while
//     ChatGPT kept generating well beyond that point. Raising the quiet
//     window further only chases the same race with a bigger number. Instead
//     of raising it again, completion (once generation has been observed
//     active) now additionally requires ChatGPT's own completed-message
//     signal: the current assistant turn's response action/footer toolbar
//     (ASSISTANT_COMPLETED_ACTION_SELECTORS), which ChatGPT mounts only once
//     that specific message has actually finished rendering. Stop-control
//     absence and text-quiet time remain necessary (a real mid-stream pause
//     still must not complete) but are no longer sufficient on their own;
//     the footer signal must also be present, checked against whichever DOM
//     node is currently the newest assistant message (never a stale one —
//     see the node-replace handling below). The no-signal fallback path
//     (generation never observed active at all) is untouched by this pass —
//     there is no reply-specific footer to check against if generation
//     itself was never confirmed to have started, so that branch still
//     relies purely on elapsed quiet time, same as before.
//
// Throws { code, message } (not a bridge/errors.js class — that mapping
// happens on the Node side, in chatgptExtension.js, after this crosses the
// WebSocket as a protocol error code):
//   - RESPONSE_EMPTY: deadline hit, no new assistant message ever appeared
//   - RESPONSE_TIMEOUT: a new assistant message appeared but never finished
//     (stop control never went away, or the completed-message signal never
//     appeared) before the deadline
// --- Metadata-only completed-signal diagnostics (2026-08-27, live-timeout
// follow-up) --------------------------------------------------------------
//
// A live run hit RESPONSE_TIMEOUT with the completed-message signal never
// appearing, and the existing onStage log said only "absent" — not enough
// to tell whether ASSISTANT_COMPLETED_ACTION_SELECTORS is simply wrong for
// the current ChatGPT DOM. These probes run only when waitForReply is about
// to give up (RESPONSE_TIMEOUT) and log STRUCTURAL metadata about the
// CURRENT assistant message's own descendants — selector identity, match
// counts, connectedness, and stable attribute values (aria-label / title /
// data-testid / role). They never read textContent, innerText, or any
// reply/prompt content — same invariant waitForReply's own onStage calls
// already hold to.

function describeElementAttrs(el) {
  if (!el || typeof el.getAttribute !== 'function') return {};
  const attrs = {};
  const ariaLabel = el.getAttribute('aria-label');
  const title = el.getAttribute('title');
  const dataTestid = el.getAttribute('data-testid');
  const role = el.getAttribute('role');
  if (ariaLabel != null) attrs.ariaLabel = ariaLabel;
  if (title != null) attrs.title = title;
  if (dataTestid != null) attrs.dataTestid = dataTestid;
  if (role != null) attrs.role = role;
  return attrs;
}

// Scoped lookup that degrades to a 0/1-result querySelector when `node`
// (real DOM or a test fake) has no querySelectorAll — never falls back to
// document-wide/page-wide lookup.
function queryAllScoped(node, selector) {
  if (!node) return [];
  if (typeof node.querySelectorAll === 'function') {
    return Array.from(node.querySelectorAll(selector));
  }
  if (typeof node.querySelector === 'function') {
    const el = node.querySelector(selector);
    return el ? [el] : [];
  }
  return [];
}

// Probes each ASSISTANT_COMPLETED_ACTION_SELECTORS candidate against the
// CURRENT assistant message only (never page-wide — same scoping rule as
// readCompletedFooterSignal above). Metadata only, never text content.
export function probeCompletedSignalCandidates(node) {
  return ASSISTANT_COMPLETED_ACTION_SELECTORS.map((selector) => {
    const matches = queryAllScoped(node, selector);
    const first = matches[0] ?? null;
    return {
      selector,
      matchedCount: matches.length,
      connected: first ? first.isConnected !== false : false,
      ...describeElementAttrs(first),
    };
  });
}

// Reports likely interactive footer descendants of the CURRENT assistant
// message by stable structural attributes only (button / [role="button"] /
// [data-testid] / [aria-label] / [title]) — lets a real completed-footer
// shape be seen when every ASSISTANT_COMPLETED_ACTION_SELECTORS candidate
// missed, without ever reading what the descendant actually says.
export function probeInteractiveFooterDescendants(node, { limit = 20 } = {}) {
  const found = queryAllScoped(node, 'button, [role="button"], [data-testid], [aria-label], [title]');
  return found.slice(0, limit).map((el) => ({
    tag: typeof el.tagName === 'string' ? el.tagName.toLowerCase() : null,
    connected: el.isConnected !== false,
    ...describeElementAttrs(el),
  }));
}

function countCompletedActionCandidates(el) {
  if (!el) return 0;
  return ASSISTANT_COMPLETED_ACTION_SELECTORS.reduce((sum, selector) => sum + queryAllScoped(el, selector).length, 0);
}

// Metadata-only probe (2026-08-27, turn-root anchoring follow-up) walking
// UP from the CURRENT assistant node through its own ancestor chain (same
// bound as resolveAssistantTurnRoot above), logging per-ancestor structural
// metadata — depth, tag, stable data-*/role attributes, and how many
// completed-action candidates that ancestor contains as descendants. Lets a
// real "the footer lives N levels up" shape be seen on a live run even when
// ASSISTANT_TURN_ROOT_SELECTORS misses, without ever reading textContent,
// innerText, or any reply/prompt content — same invariant every other probe
// here already holds to.
export function probeAssistantTurnAncestors(node, { maxDepth = ASSISTANT_TURN_ANCESTOR_SEARCH_DEPTH } = {}) {
  const results = [];
  let candidate = node;
  let depth = 0;
  while (candidate && depth <= maxDepth) {
    results.push({
      depth,
      tag: typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : null,
      connected: candidate.isConnected !== false,
      turnRootShape: isAssistantTurnRootShape(candidate),
      completedActionCandidateCount: countCompletedActionCandidates(candidate),
      ...describeElementAttrs(candidate),
    });
    candidate = getAncestorElement(candidate);
    depth += 1;
  }
  return results;
}

export async function waitForReply(
  doc,
  { responseTimeoutMs },
  baselineCount,
  {
    assistantSelector = ASSISTANT_MESSAGE_SELECTOR,
    stopSelectors = STOP_BUTTON_SELECTORS,
    sleep = defaultSleep,
    // Injectable wall clock. Production leaves this as the real Date.now —
    // completion is deliberately gated on genuine elapsed time (see the
    // header comment's 3rd-pass explanation). Tests inject a fake clock
    // driven in lockstep with their fake `sleep`/mutation ticks, since a
    // real elapsed-time gate can't be exercised deterministically against
    // an instant fake sleep otherwise.
    now = () => Date.now(),
    onStage = () => {},
  } = {}
) {
  const deadline = now() + responseTimeoutMs;
  const bodyWaiter = createMutationWaiter(doc, sleep);

  function currentAssistantNode() {
    const nodes = doc.querySelectorAll(assistantSelector);
    return nodes[nodes.length - 1] ?? null;
  }
  // Reads only the reply's own content node (see ASSISTANT_CONTENT_SELECTOR
  // above), never the whole message card — falls back to the card itself
  // when no content node is found (selector drift, or a fake/test DOM with
  // no querySelector), so a layout this doesn't recognize degrades to the
  // old whole-card behavior instead of returning nothing.
  function readNodeText(node) {
    if (node && typeof node.querySelector === 'function') {
      const content = node.querySelector(ASSISTANT_CONTENT_SELECTOR);
      if (content) return (content.innerText ?? '').trim();
    }
    return (node?.innerText ?? '').trim();
  }

  // Reads the completed-message footer signal scoped to the CURRENT
  // assistant turn's own root container (resolveAssistantTurnRoot above) —
  // never page-wide, and never an older/different turn's own footer (that
  // footer is not reachable by walking UP from the current node's own
  // ancestors — see the bounded search there). Degrades to "absent" (not
  // "present" — fail closed, matching the conservative intent of this whole
  // gate) when the resolved root has no querySelector (selector drift, node
  // not yet mounted, or a test/fake DOM that doesn't model it).
  function readCompletedFooterSignal(candidateNode) {
    const { root: turnRoot, depth: turnRootDepth, matched: turnRootMatched } = resolveAssistantTurnRoot(candidateNode);
    if (!turnRoot || typeof turnRoot.querySelector !== 'function') {
      return { present: false, selector: null, turnRootDepth, turnRootMatched };
    }
    for (const selector of ASSISTANT_COMPLETED_ACTION_SELECTORS) {
      const el = turnRoot.querySelector(selector);
      if (el && el.isVisible !== false) return { present: true, selector, turnRootDepth, turnRootMatched };
    }
    return { present: false, selector: null, turnRootDepth, turnRootMatched };
  }

  try {
    while (now() < deadline && doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while waiting for a reply.');
      await bodyWaiter.tick(DEFAULT_POLL_MS);
    }
    if (doc.querySelectorAll(assistantSelector).length <= baselineCount) {
      const err = new Error(`No assistant response appeared within ${responseTimeoutMs}ms.`);
      err.code = 'RESPONSE_EMPTY';
      throw err;
    }
    onStage('assistant started');
  } finally {
    bodyWaiter.disconnect();
  }

  // everObservedActive: true once we have direct evidence generation was
  // actually in progress (stop control seen visible, or the assistant
  // node's text observed changing) — as opposed to merely "we haven't seen
  // it end yet", which is not the same claim. Gates which quiet-time window
  // (CONFIRM_QUIET_MS vs CONFIRM_QUIET_MS_NO_SIGNAL) applies below.
  let everObservedActive = false;
  let loggedActive = false;
  let loggedMaybeEnded = false;
  let quietWindowMutationWakes = 0;
  let quietWindowTimeoutWakes = 0;
  // Completion-provenance tracking only (2026-08-27) — added to distinguish
  // "ChatGPT actually stopped generating after the first field" from
  // "domActions returned while ChatGPT was still generating" when a
  // NEXT_TASK reply comes back looking like a truncated prefix. These never
  // change what counts as complete (still gated on everObservedActive +
  // elapsedQuietMs above/below) — they only log metadata (lengths,
  // booleans, elapsed ms) about why this function believed generation had
  // finished. Never logs prompt/reply content.
  let prevStopVisible = false;
  // completedSignalPresent/completedSignalSelector: the current assistant
  // node's own completed-message footer state (see
  // ASSISTANT_COMPLETED_ACTION_SELECTORS / readCompletedFooterSignal above),
  // tracked so transitions can be logged as metadata and so the terminal
  // completion gate below can require it. Reset to false whenever the node
  // identity changes (see the node-replace branch) — it is only ever read
  // off whichever node is CURRENT.
  let completedSignalPresent = false;
  let completedSignalSelector = null;
  let loggedAwaitingCompletedSignal = false;

  let node = currentAssistantNode();
  let nodeWaiter = createNodeMutationWaiter(doc, node, sleep);
  let lastText = readNodeText(node);
  let lastActivityAt = now();
  const firstObservedAt = lastActivityAt;
  onStage(`assistant response first observed (initialTextLen=${lastText.length})`);

  // resetQuietCandidate(reason, now): the single place that treats
  // something as proof generation has NOT actually finished. Called for
  // every one of the reset conditions this state machine recognizes: the
  // assistant's own text changing (growth, shrink, or a drop-to-zero and
  // regrow — readNodeText comparison doesn't care which), the stop control
  // reappearing, and the assistant body DOM node itself being
  // replaced/recreated (a React remount can swap the node without the stop
  // control or text necessarily observed changing on the very same tick).
  // Logs a "terminal quiet candidate reset" diagnostic only when there was
  // an actual candidate in progress to reset (loggedMaybeEnded), so a
  // healthy, still-obviously-streaming reply doesn't spam this on every
  // tick.
  function resetQuietCandidate(reason, atMs) {
    if (loggedMaybeEnded) {
      onStage(`terminal quiet candidate reset (reason=${reason})`);
    }
    lastActivityAt = atMs;
    loggedMaybeEnded = false;
    loggedAwaitingCompletedSignal = false;
    quietWindowMutationWakes = 0;
    quietWindowTimeoutWakes = 0;
  }

  try {
    while (now() < deadline) {
      const freshNode = currentAssistantNode();
      if (freshNode !== node) {
        nodeWaiter.disconnect();
        node = freshNode;
        nodeWaiter = createNodeMutationWaiter(doc, node, sleep);
        // The node identity changing is itself proof-of-activity, independent
        // of whether its text happens to read the same as the old node's —
        // never let a coincidental text match at swap time be mistaken for a
        // stable, finished reply (requirement: "assistant body node is
        // replaced/recreated" must reset the terminal quiet timer).
        onStage('assistant body node replaced');
        resetQuietCandidate('node replaced', now());
        // The completed-message signal is only ever meaningful for whichever
        // node is CURRENT — a footer briefly seen on the old/replaced node
        // must never be carried over and mistaken for the new node's own
        // state (requirement: check the signal against the NEW current
        // node). Recomputed fresh below on every tick regardless; this just
        // makes the "signal became absent" transition explicit in the log
        // when the outgoing node had it present.
        if (completedSignalPresent) {
          onStage('completed-message signal absent (reason=node replaced)');
        }
        completedSignalPresent = false;
        completedSignalSelector = null;
      }

      const currentText = readNodeText(node);
      const stopVisible = isAnyVisible(doc, stopSelectors);
      const textChanged = currentText !== lastText;

      if (stopVisible !== prevStopVisible) {
        onStage(stopVisible ? 'stop control became visible' : 'stop control became absent');
        prevStopVisible = stopVisible;
      }

      const completedNow = readCompletedFooterSignal(node);
      if (completedNow.present !== completedSignalPresent) {
        completedSignalPresent = completedNow.present;
        completedSignalSelector = completedNow.selector;
        onStage(
          completedSignalPresent
            ? `completed-message signal present (selector=${completedSignalSelector}, ` +
                `turnRootDepth=${completedNow.turnRootDepth}, turnRootMatched=${completedNow.turnRootMatched})`
            : 'completed-message signal absent'
        );
      }

      if (stopVisible || textChanged) {
        if (textChanged) {
          onStage(`assistant text length changed: ${lastText.length} -> ${currentText.length}`);
        }
        if (stopVisible || currentText.length > lastText.length) {
          if (!everObservedActive) {
            onStage(`generation-active signal observed (source=${stopVisible ? 'stop-control' : 'text-growth'})`);
          }
          everObservedActive = true;
          if (!loggedActive) {
            onStage('generation active');
            loggedActive = true;
          }
        }
        lastText = currentText;
        // A single stop-control absent->visible flicker, or the text
        // changing at all (including a transient drop to zero followed by
        // regrowth — e.g. the live 8 -> 0 -> 26 sequence that exposed this
        // bug), is never sufficient evidence generation ended: it is
        // treated as ongoing activity and unconditionally restarts the
        // terminal quiet candidate from scratch, however far along it was.
        resetQuietCandidate(stopVisible ? 'stop control visible' : 'assistant text changed', now());
        await nodeWaiter.tick(DEFAULT_POLL_MS);
        continue;
      }

      if (currentText.length === 0) {
        // No text yet and no activity signal — still waiting for the first
        // token to actually render.
        await nodeWaiter.tick(DEFAULT_POLL_MS);
        continue;
      }

      // Stop invisible, assistant node's own text unchanged since
      // lastActivityAt. "Done" is only trusted once this state — the
      // "terminal quiet candidate" — has held CONTINUOUSLY for real elapsed
      // wall-clock time (not a tick count, see header comment), with every
      // tick in between re-checking both conditions above from scratch; any
      // single tick that finds either one violated resets the candidate via
      // resetQuietCandidate before this branch is ever reached again.
      const requiredQuietMs = everObservedActive ? CONFIRM_QUIET_MS : CONFIRM_QUIET_MS_NO_SIGNAL;
      const elapsedQuietMs = now() - lastActivityAt;
      if (elapsedQuietMs < requiredQuietMs) {
        if (!loggedMaybeEnded) {
          onStage(
            `terminal quiet candidate started (textLen=${currentText.length}, everActive=${everObservedActive}, ` +
              `requiredQuietMs=${requiredQuietMs})`
          );
          onStage(`generation maybe ended (textLen=${currentText.length}, everActive=${everObservedActive})`);
          loggedMaybeEnded = true;
        }
        const remaining = requiredQuietMs - elapsedQuietMs;
        // The wake source is scoped-node-mutation vs timeout, tracked only
        // for diagnostics — nodeWaiter already only observes the current
        // assistant node's own subtree (never doc.body), and completion
        // itself is gated on elapsedQuietMs above, not on which source woke
        // this tick or how many times it fired.
        const source = await nodeWaiter.tick(Math.min(DEFAULT_POLL_MS, remaining));
        if (source === 'mutation') quietWindowMutationWakes += 1;
        else quietWindowTimeoutWakes += 1;
        continue;
      }

      // Quiet time alone (stop absent + text unchanged) is no longer
      // sufficient once generation has actually been observed active — live
      // evidence (see the 5th-pass header comment) proved a genuine
      // mid-generation pause can exceed CONFIRM_QUIET_MS on its own. The
      // current assistant message's own completed-message footer signal
      // must also be present before this is trusted as real completion; if
      // it isn't yet, keep waiting (without resetting the quiet clock — the
      // text is still genuinely unchanged, this is just an additional gate,
      // not new evidence of activity) until it appears or the deadline hits.
      if (everObservedActive && !completedSignalPresent) {
        if (!loggedAwaitingCompletedSignal) {
          onStage(
            `quiet threshold reached but completed-message signal absent — not treating as complete ` +
              `(textLen=${currentText.length}, elapsedQuietMs=${elapsedQuietMs})`
          );
          loggedAwaitingCompletedSignal = true;
        }
        await nodeWaiter.tick(DEFAULT_POLL_MS);
        continue;
      }

      onStage(
        `terminal quiet candidate confirmed (textLen=${currentText.length}, elapsedQuietMs=${elapsedQuietMs}, ` +
          `requiredQuietMs=${requiredQuietMs})`
      );

      onStage(
        `generation confirmed ended (textLen=${currentText.length}, everActive=${everObservedActive}, ` +
          `branch=${everObservedActive ? 'active-confirmed' : 'no-signal-confirmed'}, ` +
          `completedSignal=${completedSignalPresent}${completedSignalSelector ? ` (selector=${completedSignalSelector})` : ''}, ` +
          `quietWindowWakes: mutation=${quietWindowMutationWakes} timeout=${quietWindowTimeoutWakes})`
      );
      onStage(`assistant body extracted (textLen=${currentText.length})`);
      onStage(
        `completion path chosen: ${everObservedActive ? 'generation-signal-ended' : 'no-generation-signal-fallback'} ` +
          `(finalTextLen=${currentText.length}, msSinceLastChange=${elapsedQuietMs}, totalMs=${now() - firstObservedAt}, ` +
          `completedSignal=${completedSignalPresent})`
      );
      return currentText;
    }

    onStage(
      `completion path chosen: timeout-no-completion-signal ` +
        `(lastTextLen=${lastText.length}, everActive=${everObservedActive}, stopVisible=${prevStopVisible}, ` +
        `completedSignal=${completedSignalPresent}, msSinceLastChange=${now() - lastActivityAt}, ` +
        `totalMs=${now() - firstObservedAt})`
    );
    if (!completedSignalPresent) {
      // Diagnose whether ASSISTANT_COMPLETED_ACTION_SELECTORS is simply
      // wrong for the current ChatGPT DOM — metadata only, never content
      // (see the probes' own header comment above).
      onStage(`completed-message candidate probe: ${JSON.stringify(probeCompletedSignalCandidates(node))}`);
      onStage(`completed-message footer descendant probe: ${JSON.stringify(probeInteractiveFooterDescendants(node))}`);
      onStage(`completed-message turn ancestor probe: ${JSON.stringify(probeAssistantTurnAncestors(node))}`);
    }
    const err = new Error(`Assistant response did not finish within ${responseTimeoutMs}ms.`);
    err.code = 'RESPONSE_TIMEOUT';
    throw err;
  } finally {
    nodeWaiter.disconnect();
  }
}

// --- Reply + identity orchestration (2026-08-27 decoupling) --------------
//
// Root cause it fixes (live evidence, 2026-08-27): the content-script send
// flow used to `await waitForConversationIdentity(...)` BEFORE it ever
// called waitForReply(...), making a delayed `/c/<id>` a hard blocker on
// reply observation. ChatGPT is a SPA — routing can stamp the `/c/<id>` URL
// segment well after generation has started or even finished — so a slow
// identity aborted the whole request (CONVERSATION_IDENTITY_NOT_FOUND,
// lastExtensionStage="user message observed") even though a perfectly good
// assistant answer was already on the page and never consumed.
//
// This helper begins reply observation FIRST — an order that structurally
// cannot prevent reply observation — and only then acquires and validates
// identity, within its own bounded budget measured from reply completion
// (DEFAULT_IDENTITY_GRACE_MS). It is NOT "raise the 15s timeout": the fix is
// the ordering. A successful return still requires BOTH:
//   1. a completed current-turn assistant response, AND
//   2. a validated EXACT `/c/<id>` for this same tab/conversation
// Identity is never guessed, the UUID-shape validation (isValidConversationId
// / waitForConversationIdentity) is unchanged, and identity is only ever
// read from THIS doc's own URL + THIS doc's active sidebar anchor — never
// another tab, never a title, never "most recent".
//
// Outcomes:
//   - identity already present at reply completion -> captured with no
//     extra wait ('conversation identity observed')
//   - identity still missing at reply completion   -> 'waiting for identity
//     after reply completion' + bounded wait (identityGraceMs); success if
//     it appears, CONVERSATION_IDENTITY_NOT_FOUND (fail closed, reply
//     discarded) if it does not
//   - reply never completes                        -> waitForReply's own
//     RESPONSE_TIMEOUT / RESPONSE_EMPTY propagates; identity never consulted
//   - resolved id !== expectedConversationId       -> onMismatch(expected,
//     got) if supplied, else a SUPERVISOR_IDENTITY_MISMATCH error
//
// Persistent stages emitted (for background.js's stage store, via
// content.js's stage map): 'assistant response completed', 'conversation
// identity observed (<id>)', 'waiting for identity after reply completion',
// 'returning response' — plus every stage waitForReply /
// waitForConversationIdentity already emit ('assistant response first
// observed', 'identity captured', ...).
export async function observeReplyAndIdentity(
  doc,
  {
    baselineCount,
    baselineId = null,
    responseTimeoutMs,
    identityGraceMs = DEFAULT_IDENTITY_GRACE_MS,
    expectedConversationId = null,
    // When false (the one-shot askGpt/handlePerform path, whose documented
    // contract is "conversationId may be null"), a failure to acquire
    // identity is NOT fatal: the completed reply is still returned with
    // conversationId null + identityDiagnostics. The default (true, the
    // persistent-Supervisor / task-scoped-Reviewer path) fails closed.
    identityRequired = true,
    assistantSelector = ASSISTANT_MESSAGE_SELECTOR,
    stopSelectors = STOP_BUTTON_SELECTORS,
    sleep = defaultSleep,
    now = () => Date.now(),
    onStage = () => {},
    onMismatch = null,
  } = {}
) {
  // 1. Reply observation — no identity precondition whatsoever.
  const text = await waitForReply(
    doc,
    { responseTimeoutMs },
    baselineCount,
    { assistantSelector, stopSelectors, sleep, now, onStage }
  );
  onStage('assistant response completed');

  // 2. Identity acquisition — only now, and bounded on its own budget.
  let conversationId = readConversationId(doc);
  let identityDiagnostics;
  const alreadyHaveFreshId =
    conversationId && conversationId !== baselineId && isValidConversationId(conversationId);
  if (alreadyHaveFreshId) {
    onStage(`conversation identity observed (${conversationId})`);
  } else {
    onStage('waiting for identity after reply completion');
    try {
      conversationId = await waitForConversationIdentity(doc, {
        baselineId,
        timeoutMs: identityGraceMs,
        sleep,
        now,
        onStage,
      });
      onStage(`conversation identity observed (${conversationId})`);
    } catch (err) {
      if (identityRequired || err.code !== 'CONVERSATION_IDENTITY_NOT_FOUND') throw err;
      identityDiagnostics = err.diagnostics;
      onStage(`identity diagnostics: ${JSON.stringify(identityDiagnostics)}`);
      onStage('returning response');
      return { text, conversationId: null, identityDiagnostics };
    }
  }

  // 3. Both preconditions met — hard-validate the exact identity.
  if (!isValidConversationId(conversationId)) {
    throw conversationIdentityNotFoundError(
      `Conversation identity "${conversationId}" is not shaped like a real ChatGPT conversation id (/c/<id>) — ` +
        'refusing to return a reply without a validated identity.'
    );
  }
  if (expectedConversationId && conversationId !== expectedConversationId) {
    if (onMismatch) throw onMismatch(expectedConversationId, conversationId);
    const err = new Error(
      `Conversation identity changed: expected "${expectedConversationId}" but the tab is now showing ` +
        `"${conversationId}" — refusing to continue in a different conversation.`
    );
    err.code = 'SUPERVISOR_IDENTITY_MISMATCH';
    throw err;
  }

  onStage('returning response');
  return { text, conversationId, identityDiagnostics };
}

// --- Conversation deletion (2026-08-26 primitive) -------------------------
//
// deleteConversation(doc, conversationId) verifies and deletes exactly one
// ChatGPT conversation, identified only by the `/c/<id>` it was created
// with — never by its sidebar title. It never throws away a real DOM
// postcondition for a click: every stage below is gated on real evidence
// (the row existing, the menu item existing, the confirm button existing,
// and finally the row actually disappearing from the sidebar), and it
// fails loudly with a specific error code rather than guessing when any of
// those don't show up.
//
// SELECTOR CAVEAT: the candidate selectors below were written from
// ChatGPT's known Radix-style sidebar/menu/dialog conventions (a
// conversation row exposing a per-row "options" button, a role="menu"
// popup, a role="dialog" confirmation with a "Delete" button) but were NOT
// confirmed against a live, logged-in ChatGPT session — no such session was
// reachable while writing this. Before this primitive is trusted for
// unattended use, run it once against a real conversation and, if the
// selectors below don't match, update these constants (the algorithm —
// identity-anchored lookup + real postconditions — should not need to
// change).
export const CONVERSATION_MENU_BUTTON_SELECTORS = [
  'button[aria-label="Open conversation options"]',
  'button[data-testid$="-options"]',
  'button[aria-haspopup="menu"]',
];

export const DELETE_MENU_ITEM_SELECTORS = ['[role="menuitem"]', 'div[role="menuitem"]'];
export const DELETE_MENU_ITEM_TEXT_PATTERN = /^delete( chat)?$/i;

export const DELETE_CONFIRM_BUTTON_SELECTORS = [
  '[data-testid="delete-conversation-confirm-button"]',
  'div[role="dialog"] button',
];
export const DELETE_CONFIRM_BUTTON_TEXT_PATTERN = /^delete$/i;

function conversationLinkSelector(conversationId) {
  return `a[href="/c/${conversationId}"]`;
}

// Locates the sidebar row for `conversationId` by its href — the one
// unambiguous identity ChatGPT exposes for a conversation — never by
// title. Returns null if the row isn't currently present in the DOM (not
// visible in the sidebar at all, e.g. scrolled out of the loaded window);
// the caller treats that as CONVERSATION_NOT_FOUND rather than falling back
// to a title search.
function findConversationRow(doc, conversationId) {
  const anchor = doc.querySelector(conversationLinkSelector(conversationId));
  if (!anchor) return null;
  if (typeof anchor.closest === 'function') {
    const li = anchor.closest('li');
    if (li) return li;
  }
  return anchor.parentElement || anchor;
}

function firstVisibleWithin(container, selectors) {
  if (!container || typeof container.querySelector !== 'function') return null;
  for (const selector of selectors) {
    const el = container.querySelector(selector);
    if (el && el.isVisible !== false) return el;
  }
  return null;
}

// Searches (globally, since Radix-style menus/dialogs portal to <body>, not
// into the row that opened them) for an element matching one of `selectors`
// whose own text matches `textPattern` — used for both the "Delete" menu
// item and the confirm-dialog "Delete" button, where a stable data-testid
// isn't known to exist. This is text matching scoped to a just-opened
// native ChatGPT menu/dialog control, not a conversation-title match.
function findControlByText(doc, selectors, textPattern) {
  for (const selector of selectors) {
    const nodes = doc.querySelectorAll(selector) || [];
    for (const node of nodes) {
      const text = (node.innerText ?? node.textContent ?? '').trim();
      if (textPattern.test(text)) return node;
    }
  }
  return null;
}

function conversationNotFoundError(conversationId) {
  const err = new Error(
    `Conversation "${conversationId}" is not visible in the sidebar by its /c/<id> link; refusing to guess by title.`
  );
  err.code = 'CONVERSATION_NOT_FOUND';
  return err;
}

function invalidConversationIdError(conversationId) {
  const err = new Error(
    `"${conversationId}" is not shaped like a real ChatGPT conversation id (/c/<id>); refusing to attempt deletion.`
  );
  err.code = 'CONVERSATION_NOT_FOUND';
  return err;
}

function deleteMenuNotFoundError(message) {
  const err = new Error(message);
  err.code = 'DELETE_MENU_NOT_FOUND';
  return err;
}

function deleteNotConfirmedError(message) {
  const err = new Error(message);
  err.code = 'DELETE_NOT_CONFIRMED';
  return err;
}

export async function deleteConversation(
  doc,
  conversationId,
  {
    menuButtonSelectors = CONVERSATION_MENU_BUTTON_SELECTORS,
    deleteMenuItemSelectors = DELETE_MENU_ITEM_SELECTORS,
    deleteMenuItemTextPattern = DELETE_MENU_ITEM_TEXT_PATTERN,
    confirmButtonSelectors = DELETE_CONFIRM_BUTTON_SELECTORS,
    confirmButtonTextPattern = DELETE_CONFIRM_BUTTON_TEXT_PATTERN,
    simulateClick = defaultSimulateClick,
    sleep = defaultSleep,
    menuOpenTimeoutMs = 3000,
    confirmDialogTimeoutMs = 3000,
    postconditionTimeoutMs = 5000,
    rowLookupTimeoutMs = 5000,
    onStage = () => {},
  } = {}
) {
  if (!conversationId) throw conversationNotFoundError('(missing)');
  if (!isValidConversationId(conversationId)) throw invalidConversationIdError(conversationId);

  // A tab freshly navigated to chatgptUrl reaches "complete" before its
  // sidebar's conversation list (populated by an async fetch) has
  // necessarily hydrated — a single synchronous lookup here was observed
  // live to fail fast with CONVERSATION_NOT_FOUND even though the
  // conversation existed and appeared moments later. This polls (still
  // matching only the exact /c/<id> href, never a title) until the row
  // shows up or rowLookupTimeoutMs elapses, mirroring the menu-open and
  // confirm-dialog waits below.
  const rowWaiter = createMutationWaiter(doc, sleep);
  let row;
  try {
    const rowDeadline = Date.now() + rowLookupTimeoutMs;
    do {
      row = findConversationRow(doc, conversationId);
      if (row) break;
      if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while locating the conversation to delete.');
      await rowWaiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < rowDeadline);
  } finally {
    rowWaiter.disconnect();
  }
  if (!row) throw conversationNotFoundError(conversationId);
  onStage('conversation row located');

  const menuButton = firstVisibleWithin(row, menuButtonSelectors);
  if (!menuButton) {
    throw deleteMenuNotFoundError(
      `Conversation "${conversationId}" was found in the sidebar but no options/menu button matched the known selectors.`
    );
  }
  await sleep(randomJitterMs(150, 400));
  simulateClick(menuButton);
  onStage('conversation menu opened');

  const menuDeadline = Date.now() + menuOpenTimeoutMs;
  let deleteItem = null;
  do {
    if (isRateLimited(doc)) throw rateLimitedError('ChatGPT reported "making requests too quickly" while deleting a conversation.');
    deleteItem = findControlByText(doc, deleteMenuItemSelectors, deleteMenuItemTextPattern);
    if (deleteItem) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < menuDeadline);
  if (!deleteItem) {
    throw deleteMenuNotFoundError(`Delete menu item did not appear within ${menuOpenTimeoutMs}ms after opening the conversation menu.`);
  }
  onStage('delete menu item found');

  simulateClick(deleteItem);
  onStage('delete clicked');

  const confirmDeadline = Date.now() + confirmDialogTimeoutMs;
  let confirmButton = null;
  do {
    confirmButton = findControlByText(doc, confirmButtonSelectors, confirmButtonTextPattern);
    if (confirmButton) break;
    await sleep(DEFAULT_POLL_MS);
  } while (Date.now() < confirmDeadline);
  if (!confirmButton) {
    throw deleteMenuNotFoundError(`Delete confirmation dialog did not appear within ${confirmDialogTimeoutMs}ms.`);
  }
  onStage('delete confirmation dialog found');

  simulateClick(confirmButton);
  onStage('delete triggered');

  const waiter = createMutationWaiter(doc, sleep);
  try {
    const postDeadline = Date.now() + postconditionTimeoutMs;
    do {
      if (!doc.querySelector(conversationLinkSelector(conversationId))) {
        onStage('delete confirmed');
        return { deleted: true };
      }
      await waiter.tick(DEFAULT_POLL_MS);
    } while (Date.now() < postDeadline);
  } finally {
    waiter.disconnect();
  }

  if (!doc.querySelector(conversationLinkSelector(conversationId))) {
    onStage('delete confirmed');
    return { deleted: true };
  }
  onStage('cleanup failed');
  throw deleteNotConfirmedError(
    `Conversation "${conversationId}" is still visible in the sidebar ${postconditionTimeoutMs}ms after confirming delete — treating this as a failed cleanup rather than assuming success.`
  );
}
