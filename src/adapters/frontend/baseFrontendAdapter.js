// Base Frontend Adapter interface.
//
// Every frontend adapter (Gemini, Claude Code, Codex, Generic) implements this
// contract so the front agent can supervise SuperGPT without embedding
// orchestrator or task-state logic.

import { defaultControlService } from '../../control/controlService.js';
import { decideAutoRoute } from '../../control/autoRoutePolicy.js';
import { FrontendProgressObserver } from './progressObserver.js';

export class BaseFrontendAdapter {
  constructor({
    controlService = defaultControlService,
    name = 'base',
  } = {}) {
    this.controlService = controlService;
    this.name = name;
  }

  formatPlan(planResult) {
    return this.controlService.formatPlan(planResult);
  }

  formatProgress(stateOrCanonical) {
    return this.controlService.formatProgress(stateOrCanonical);
  }

  formatCompletion(result) {
    return this.controlService.formatCompletion(result);
  }

  formatHumanRequired({ question, reason, workflowId }) {
    return [
      'SuperGPT needs one decision:',
      question || reason || 'Clarification required.',
      '',
      `Workflow ID: ${workflowId || 'current'}`,
      'Please reply with your answer to resume.',
    ].join('\n');
  }

  // Frontends use this before `prepare`; it is local and returns no plan.
  route(goal) { return decideAutoRoute(goal); }

  // The frontend is only a local state subscriber. `render` is supplied by
  // the host chat/agent UI; no provider call is possible along this path.
  observeProgress({ workflowId, render, intervalMs } = {}) {
    return new FrontendProgressObserver({
      controlService: this.controlService,
      workflowId,
      render,
      intervalMs,
    }).start();
  }

  // Long-running live watch stream with zero model tokens.
  async watchProgress({ workflowId, render, intervalMs, timeoutMs, signal } = {}) {
    return this.controlService.watch({
      workflowId,
      intervalMs,
      timeoutMs,
      signal,
      onProgress: ({ formattedProgress, canonical }) => {
        if (typeof render === 'function') render(formattedProgress, canonical);
      },
    });
  }

  // Host integrations call this for their non-blocking `supergpt_start`
  // operation.  The returned workflow id is immediately observed locally;
  // disconnecting this adapter stops only its subscription, never the run.
  async startAndObserve({ start, render, intervalMs, ...request } = {}) {
    const startWorkflow = start ?? ((options) => this.controlService.start(options));
    const started = await startWorkflow(request);
    const workflowId = started?.workflowId;
    if (!workflowId) throw new Error('SuperGPT start did not return a workflowId');
    const observer = this.observeProgress({ workflowId, render, intervalMs });
    return { ...started, observer };
  }

  generateConfig(_options = {}) {
    throw new Error(`generateConfig() not implemented for adapter ${this.name}`);
  }
}
