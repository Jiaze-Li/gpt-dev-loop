import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ChromeUnavailableError, RequestTimeoutError } from './errors.js';
import { hideWindow as hideWindowCdp, showWindow as showWindowCdp } from './visibility.js';

const SINGLETON_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function log(message) {
  console.error(`gpt-loop: ${message}`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it (e.g. owned by
    // another user) — that's still "alive" from a lock-safety standpoint.
    // Only ESRCH (no such process) means it's safe to treat as dead.
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

// Chrome's SingletonLock is a symlink whose target ends in "-<pid>". If that
// pid is no longer running, the lock is left over from a crash/kill and is
// safe to remove; if it's alive (or we can't tell), another Chrome instance
// may genuinely own this profile and it must not be touched.
export function clearStaleSingletonLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return;
  }
  const match = target.match(/-(\d+)$/);
  if (!match) {
    throw new ChromeUnavailableError(
      `Chrome profile ${profileDir} has a SingletonLock in an unrecognized format (${target}); refusing to remove it automatically.`
    );
  }
  const pid = Number.parseInt(match[1], 10);
  if (isPidAlive(pid)) {
    throw new ChromeUnavailableError(
      `Chrome profile ${profileDir} is already in use by a running process (pid ${pid}).`
    );
  }
  log(`clearing stale SingletonLock (pid ${pid} not running) in ${profileDir}`);
  for (const name of SINGLETON_LOCK_FILES) {
    fs.rmSync(path.join(profileDir, name), { force: true });
  }
}

async function launchChromePersistentContext(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  clearStaleSingletonLock(profileDir);
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return context;
  } catch (err) {
    if (err instanceof ChromeUnavailableError) throw err;
    throw new ChromeUnavailableError(`Could not launch system Chrome: ${err.message}`);
  }
}

// GPT_BROWSER_MODE=cdp (config.js): attaches to a Chrome the user already
// has running with --remote-debugging-port, instead of launching/owning a
// dedicated profile. Reuses that Chrome's existing browser context (its
// real profile, cookies, and login state already sitting in it) rather
// than creating a new one, so this deliberately does not accept a
// profileDir.
async function connectChromeOverCdp(cdpUrl) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    throw new ChromeUnavailableError(`Could not attach to Chrome over CDP at ${cdpUrl}: ${err.message}`);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { browser, context };
}

// One ChromeRuntime keeps a single persistent context+page alive across many
// askGpt() calls instead of relaunching per call. Calls are serialized
// through a FIFO queue since one page can't safely handle concurrent
// navigations/sends.
export class ChromeRuntime {
  constructor(config, deps = {}) {
    this.profileDir = config.profileDir;
    this.mode = config.browserMode === 'cdp' ? 'cdp' : 'launch';
    this.cdpUrl = config.cdpUrl;
    this.backgroundWindow = config.backgroundWindow !== false;
    this.launchPersistentContext = deps.launchPersistentContext ?? launchChromePersistentContext;
    this.connectOverCdp = deps.connectOverCdp ?? connectChromeOverCdp;
    this.hideWindow = deps.hideWindow ?? hideWindowCdp;
    this.showWindow = deps.showWindow ?? showWindowCdp;
    this.context = null;
    this.page = null;
    // Only set in 'cdp' mode — the Browser handle connectOverCDP returns,
    // separate from `context` because closing it must disconnect the CDP
    // session without touching the context (the user's real browser
    // context, holding their other tabs) the way `context.close()` would.
    this.browser = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.poisoned = false;
    // Bumped by close(); lets an in-flight _ensurePage() launch notice it
    // was closed out from under it and discard the context it just started,
    // instead of adopting it after the runtime is supposed to be gone.
    this.generation = 0;
    this._onSignal = (signal) => this._handleSignal(signal);
    process.once('SIGINT', this._onSignal);
    process.once('SIGTERM', this._onSignal);
  }

  async _handleSignal(signal) {
    log(`received ${signal}, closing Chrome runtime...`);
    await this.close();
    // Deliberately does not call process.exit(): this runtime is used by
    // both a one-shot CLI process and a long-lived MCP server. Forcing exit
    // here could truncate an in-flight MCP stdio response. Cleanup is done;
    // whether/how the process exits is the host's call (a second SIGINT
    // hits Node's default handler once ours has fired via `.once`).
  }

  // Marks any in-flight or about-to-run task as unsafe to keep the context
  // for. Called when the caller's own deadline (askGpt's requestTimeoutMs)
  // has already fired, so we can no longer trust the page/context state.
  poison() {
    this.poisoned = true;
  }

  // Launches (mode 'launch') or attaches to (mode 'cdp') a browser context,
  // returning { context, browser } — browser is only present in 'cdp' mode.
  async _connect() {
    if (this.mode === 'cdp') {
      const { browser, context } = await this.connectOverCdp(this.cdpUrl);
      return { context, browser };
    }
    const context = await this.launchPersistentContext(this.profileDir);
    return { context, browser: null };
  }

  // Undoes _connect() for a context/browser pair that was never adopted
  // (this.context/this.browser). In 'cdp' mode this must not touch
  // `context` — it's the user's real browser context — so only the
  // connection itself is torn down.
  async _discard({ context, browser }) {
    if (this.mode === 'cdp') {
      await browser?.close().catch(() => {});
    } else {
      await context.close().catch(() => {});
    }
  }

  async _ensurePage() {
    if (this.context && this.page && !this.page.isClosed() && !this.poisoned) {
      return this.page;
    }
    if (this.poisoned) {
      this.poisoned = false;
      await this._rebuild();
    }
    const myGeneration = this.generation;
    const { context, browser } = await this._connect();
    if (this.closed || this.generation !== myGeneration) {
      await this._discard({ context, browser });
      throw new ChromeUnavailableError('Chrome runtime was closed while Chrome was starting.');
    }
    this.context = context;
    this.browser = browser;
    this.page = await context.newPage();
    if (this.backgroundWindow) {
      await this.hideWindow(this.context, this.page).catch((err) => {
        log(`could not hide the Chrome window, continuing visible: ${err.message}`);
      });
    }
    return this.page;
  }

  async _rebuild() {
    const stalePage = this.page;
    const staleContext = this.context;
    const staleBrowser = this.browser;
    this.context = null;
    this.page = null;
    this.browser = null;
    if (this.mode === 'cdp') {
      // Close only the tab this runtime opened, then disconnect — never
      // this.context.close(), which would close every tab in the user's
      // real browser context.
      if (stalePage) await stalePage.close().catch(() => {});
      if (staleBrowser) await staleBrowser.close().catch(() => {});
    } else if (staleContext) {
      await staleContext.close().catch(() => {});
    }
  }

  // Runs `task(page, controls)` after all previously queued tasks on this
  // runtime have settled (FIFO). `controls.showWindow`/`hideWindow` let the
  // task ask for manual attention (login/Cloudflare/passkey) and hand the
  // window back afterwards.
  run(task) {
    const runPromise = this.queue.then(() => this._runTask(task));
    this.queue = runPromise.then(
      () => {},
      () => {}
    );
    return runPromise;
  }

  async _runTask(task) {
    if (this.closed) throw new ChromeUnavailableError('Chrome runtime has been closed.');
    const page = await this._ensurePage();
    let result;
    let error;
    try {
      result = await task(page, {
        showWindow: () => this.showWindow(this.context, page),
        hideWindow: () => (this.backgroundWindow ? this.hideWindow(this.context, page) : Promise.resolve()),
      });
    } catch (err) {
      error = err;
    }
    // A timeout that fired while this task was running poisons the runtime
    // even on a success race (task finished just after the deadline): its
    // page state can no longer be trusted for the next queued call.
    if (error || this.poisoned) {
      this.poisoned = false;
      await this._rebuild();
    }
    if (error) throw error;
    return result;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    process.removeListener('SIGINT', this._onSignal);
    process.removeListener('SIGTERM', this._onSignal);
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    this.context = null;
    this.page = null;
    this.browser = null;
    if (this.mode === 'cdp') {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    } else if (context) {
      await context.close().catch(() => {});
    }
  }
}

let activeRuntime = null;

export function getChromeRuntime(config) {
  const mode = config.browserMode === 'cdp' ? 'cdp' : 'launch';
  const identityChanged =
    mode !== activeRuntime?.mode ||
    (mode === 'launch' ? activeRuntime?.profileDir !== config.profileDir : activeRuntime?.cdpUrl !== config.cdpUrl);
  if (activeRuntime && (activeRuntime.closed || identityChanged)) {
    activeRuntime = null;
  }
  if (!activeRuntime) {
    activeRuntime = new ChromeRuntime(config);
  } else {
    // Reused across calls, but a per-call config change (e.g. a test or a
    // future caller flipping backgroundWindow) should still take effect
    // rather than being silently pinned to whatever the runtime started
    // with.
    activeRuntime.backgroundWindow = config.backgroundWindow !== false;
  }
  return activeRuntime;
}

export async function closeChromeRuntime() {
  if (!activeRuntime) return;
  const runtime = activeRuntime;
  activeRuntime = null;
  await runtime.close();
}

export async function withTimeout(promise, timeoutMs, timeoutMessage, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new RequestTimeoutError(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
