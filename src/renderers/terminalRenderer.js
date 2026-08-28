// Terminal Live UI Renderer for SuperGPT.
//
// Features (PART 3):
//   - When stream is an interactive TTY (stdout.isTTY), renders clean in-place live status.
//   - Local spinner, local elapsed timer, local heartbeat display.
//   - Zero additional model calls / tokens.
//   - Does NOT reprint full status block every second (in-place ANSI overwrite).
//   - Concise durable lines for meaningful transition events above the live UI.
//   - Degrades cleanly to line-based output in non-TTY environments (pipes/redirects).
//   - Machine-readable / JSON mode emits 0 ANSI / spinner noise.
//   - Clean cursor management and signal safety.

import { toCanonicalProgress, formatTransitionEvent } from '../orchestrator/workflowState.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class TerminalRenderer {
  constructor({
    stream = process.stdout,
    isTTY = null,
    spinnerIntervalMs = 80,
    showSpinner = true,
  } = {}) {
    this.stream = stream;
    this.isTTY = isTTY !== null ? Boolean(isTTY) : Boolean(stream?.isTTY);
    this.spinnerIntervalMs = spinnerIntervalMs;
    this.showSpinner = showSpinner;

    this.spinnerIndex = 0;
    this.timer = null;
    this.lastLineCount = 0;
    this.currentCanonical = null;
    this.active = false;
    this.cursorHidden = false;
  }

  start(initialState = null) {
    if (this.active) return;
    this.active = true;

    if (initialState) {
      this.currentCanonical = toCanonicalProgress(initialState);
    }

    if (this.isTTY) {
      this.hideCursor();
      this.timer = setInterval(() => {
        this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
        this.renderLiveBlock();
      }, this.spinnerIntervalMs);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  hideCursor() {
    if (this.isTTY && !this.cursorHidden && this.stream?.write) {
      try {
        this.stream.write('\x1b[?25l');
        this.cursorHidden = true;
      } catch {
        /* ignore */
      }
    }
  }

  showCursor() {
    if (this.cursorHidden && this.stream?.write) {
      try {
        this.stream.write('\x1b[?25h');
        this.cursorHidden = false;
      } catch {
        /* ignore */
      }
    }
  }

  updateState(rawState) {
    // CLI observers already read canonical persisted progress. Avoid
    // canonicalizing it a second time, which would discard task and role
    // fields because canonical names differ from the raw state-file schema.
    this.currentCanonical = rawState?.task && rawState?.timing
      ? rawState
      : toCanonicalProgress(rawState);
    if (this.isTTY) {
      this.renderLiveBlock();
    }
  }

  emitTransition(event) {
    const formatted = formatTransitionEvent(event);
    if (!formatted) return;

    if (this.isTTY) {
      this.clearLiveBlock();
      this.stream.write(`${formatted}\n`);
      this.renderLiveBlock();
    } else {
      this.stream.write(`${formatted}\n`);
    }
  }

  formatLiveBlock() {
    const c = this.currentCanonical;
    if (!c) return '';

    const spinner = this.showSpinner ? `${SPINNER_FRAMES[this.spinnerIndex]} ` : '';
    const taskPart = c.task.current && c.task.total
      ? `${c.task.current} / ${c.task.total}`
      : c.task.taskId || '1 / 1';
    const titlePart = c.task.title ? ` — ${c.task.title}` : '';

    const formatTime = (iso) => {
      if (!iso) return '--:--:--';
      try {
        return new Date(iso).toTimeString().split(' ')[0];
      } catch {
        return '--:--:--';
      }
    };

    const lines = [
      `SUPERGPT ${spinner}${c.workflowStatus}`,
      '',
      `Task       ${taskPart}${titlePart}`,
      `Attempt    ${c.attempt}`,
      `Stage      ${c.stage}`,
      '',
      `Planner    ${roleText(c, 'planner')}`,
      `Supervisor ${roleText(c, 'supervisor')}`,
      `Executor   ${roleText(c, 'executor', c.executor.status)}`,
      `Gate       ${c.gate.status}`,
      `Reviewer   ${roleText(c, 'reviewer', c.reviewer.status)}`,
      '',
      `Elapsed       ${c.timing.elapsed}`,
      `Heartbeat     ${formatTime(c.timing.heartbeatAt)}`,
      `Last progress ${formatTime(c.timing.lastProgressAt)}`,
    ];

    if (c.timing.lastActivityAt) {
      lines.push(`Last activity ${formatTime(c.timing.lastActivityAt)}`);
    }

    if (c.executor.escalated) {
      lines.push(`Model         ${c.executor.model} (Escalated: ${c.executor.escalationReason || 'yes'})`);
    }
    const supervisor = c.routing?.supervisor;
    if (supervisor?.requestedFamily) lines.splice(7, 0, `Supervisor ${supervisor.resolvedModel || supervisor.requestedFamily}${supervisor.effort ? ` · ${supervisor.effort}` : ''}`);
    if (c.reviewer.routing?.requestedFamily) lines.splice(11, 0, `Reviewer model ${c.reviewer.routing.resolvedModel || c.reviewer.routing.requestedFamily}${c.reviewer.routing.effort ? ` · ${c.reviewer.routing.effort}` : ''}`);

    return lines.join('\n');
  }

  renderLiveBlock() {
    if (!this.isTTY || !this.stream?.write) return;
    const text = this.formatLiveBlock();
    if (!text) return;

    this.clearLiveBlock();
    const lines = text.split('\n');
    this.stream.write(`${text}\n`);
    this.lastLineCount = lines.length;
  }

  clearLiveBlock() {
    if (!this.isTTY || this.lastLineCount <= 0 || !this.stream?.write) return;
    try {
      // Move cursor up by lastLineCount and clear screen downwards
      this.stream.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
      this.lastLineCount = 0;
    } catch {
      /* ignore */
    }
  }

  stop(result = null) {
    if (!this.active) return;
    this.active = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.isTTY) {
      this.clearLiveBlock();
      this.showCursor();
    }

    if (result) {
      this.renderCompletion(result);
    }
  }

  renderCompletion(result) {
    if (!this.stream?.write) return;
    const isDone = result.status === 'WORKFLOW_DONE';
    const statusSymbol = isDone ? '✓' : '✖';

    const lines = [
      `SUPERGPT ${statusSymbol} ${result.status}`,
      '',
    ];

    if (result.summary) {
      lines.push(`Summary:    ${result.summary}`);
    }
    if (Array.isArray(result.deliveredFiles) && result.deliveredFiles.length > 0) {
      lines.push(`Delivered:  ${result.deliveredFiles.join(', ')}`);
    }
    if (result.reason) {
      lines.push(`Reason:     ${result.reason}`);
    }
    if (result.question) {
      lines.push(`Question:   ${result.question}`);
    }

    this.stream.write(`${lines.join('\n')}\n\n`);
  }

  cleanup() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.showCursor();
  }
}

function roleText(c, role, explicitStatus = null) {
  const route = c.routing?.[role];
  const status = explicitStatus || (c.stage === role.toUpperCase() ? 'running' : route ? 'done' : 'waiting');
  const model = route?.resolvedModel || route?.requestedFamily || (role === 'executor' ? c.executor?.model : null);
  return [route?.provider, model, status].filter(Boolean).join(' · ');
}
