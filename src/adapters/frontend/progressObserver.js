// Local, presentation-only workflow observer for chat-style frontends.
//
// It polls persisted canonical state; it never invokes a provider, owns no
// workflow resources, and never makes semantic decisions from model output.

import { toCanonicalProgress } from '../../orchestrator/workflowState.js';

const TERMINAL = new Set(['DONE', 'HUMAN_REQUIRED', 'FAILED', 'TIMEOUT', 'STALLED', 'STOPPED']);

function roleLabel(role) {
  if (!role) return null;
  const model = role.resolvedModel || role.requestedFamily;
  return model ? `${role.provider || role.requestedFamily} · ${model}` : null;
}

export function progressTransitionKey(progress) {
  if (!progress) return null;
  return JSON.stringify({
    workflowStatus: progress.workflowStatus,
    task: progress.task,
    attempt: progress.attempt,
    stage: progress.stage,
    executor: progress.executor?.status,
    gate: progress.gate?.status,
    reviewer: progress.reviewer?.status,
    routing: progress.routing,
    reason: progress.reason,
    question: progress.question,
  });
}

// One concise message per meaningful local transition.  Timers and heartbeat
// changes deliberately do not create messages, preventing chat spam.
export function renderProgressTransition(progress) {
  if (!progress) return null;
  if (progress.workflowStatus === 'HUMAN_REQUIRED') {
    return [
      'SUPERGPT · HUMAN_REQUIRED',
      progress.question || progress.reason || 'A human decision is required before this workflow can continue.',
    ].join('\n');
  }
  if (progress.terminal) {
    return `SUPERGPT · ${progress.workflowStatus}${progress.summary ? ` · ${progress.summary}` : progress.reason ? ` · ${progress.reason}` : ''}`;
  }
  const task = progress.task?.current && progress.task?.total
    ? `${progress.task.current}/${progress.task.total}${progress.task.title ? ` · ${progress.task.title}` : ''}`
    : progress.task?.title || progress.task?.taskId || 'starting';
  const stage = progress.stage || progress.workflowStatus;
  const routed = roleLabel(progress.routing?.[String(stage).toLowerCase()]);
  const actor = routed ? ` · ${routed}` : '';
  const result = stage === 'GATE' ? progress.gate?.status : stage === 'REVIEWER' ? progress.reviewer?.status : null;
  return `SuperGPT · Task ${task} · Attempt ${progress.attempt || 1} · ${stage}${actor}${result ? ` · ${result}` : ''}`;
}

export class FrontendProgressObserver {
  constructor({ controlService, workflowId, render, intervalMs = 500, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!controlService) throw new Error('FrontendProgressObserver requires controlService');
    if (!workflowId) throw new Error('FrontendProgressObserver requires workflowId');
    if (typeof render !== 'function') throw new Error('FrontendProgressObserver requires render');
    this.controlService = controlService;
    this.workflowId = workflowId;
    this.render = render;
    this.intervalMs = intervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.lastKey = null;
    this.stopped = false;
  }

  poll() {
    if (this.stopped) return null;
    const raw = this.controlService.status({ workflowId: this.workflowId });
    const progress = raw?.task && raw?.timing ? raw : toCanonicalProgress(raw);
    if (!progress) return null;
    const key = progressTransitionKey(progress);
    if (key !== this.lastKey) {
      this.lastKey = key;
      const message = renderProgressTransition(progress);
      if (message) this.render(message, progress);
    }
    if (progress.terminal || TERMINAL.has(progress.workflowStatus)) this.stop();
    return progress;
  }

  start() {
    if (this.timer || this.stopped) return this;
    this.poll();
    if (!this.stopped) {
      this.timer = this.setIntervalFn(() => this.poll(), this.intervalMs);
      // An observer must never keep a CLI/frontend process alive. This is
      // local presentation housekeeping, not workflow ownership.
      this.timer?.unref?.();
    }
    return this;
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.stopped = true;
  }
}
