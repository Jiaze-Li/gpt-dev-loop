// SuperGPT Control Service.
//
// Single source of truth for all external frontend callers (PART 1 & PART 5).
// Frontends (Gemini, Claude Code, Codex, CLI, MCP) call this service, which delegates
// to SuperGPT Core without Core knowing anything about the caller.

import {
  supergptPlan,
  runSuperGPT,
  supergptResume,
  supergptStop,
  supergptWait,
  supergptStatus,
  toCanonicalProgress,
  readCanonicalProgress,
  defaultOrganicReworkRecorder,
} from '../orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import {
  renderGenericProgress,
  renderGenericCompletion,
  renderGenericPlan,
} from '../renderers/genericTextRenderer.js';
import { compileSuperGptRequest } from './requestCompiler.js';

export class SuperGptControlService {
  constructor({
    root = SUPERGPT_WORKTREE_ROOT,
    callAgy,
    env = process.env,
  } = {}) {
    this.root = root;
    this.callAgy = callAgy;
    this.env = env;
  }

  async plan({ goal, planPath, cwd, constraints, _resolveWorkflowPlan } = {}) {
    return supergptPlan({
      goal,
      planPath,
      cwd,
      constraints,
      callAgy: this.callAgy,
      _resolveWorkflowPlan,
    });
  }

  prepare({ goal, cwd, constraints, preferences, mode = 'prepare' } = {}) {
    return compileSuperGptRequest({ goal, cwd, constraints, preferences, mode });
  }

  async run({
    goal,
    planPath,
    cwd,
    signal,
    onEvent,
    outputFormat,
    workflowId,
    isResume,
    answer,
    _pipeline,
  } = {}) {
    return runSuperGPT({
      goal,
      planPath,
      cwd,
      signal,
      onEvent,
      outputFormat,
      env: this.env,
      workflowId,
      isResume,
      answer,
      _pipeline,
    });
  }

  async start(options = {}) {
    return this.run(options);
  }

  status({ workflowId, root = this.root } = {}) {
    if (!workflowId) {
      // Return status of live/recent workflows
      return supergptStatus({ root });
    }
    return readCanonicalProgress({ workflowId, root });
  }

  async wait({
    workflowId,
    targetStatus,
    timeoutMs = 60000,
    intervalMs = 250,
    predicate,
    root = this.root,
  } = {}) {
    const raw = await supergptWait({
      workflowId,
      root,
      predicate: (s) => (targetStatus ? s.workflowStatus === targetStatus : predicate ? predicate(s) : true),
      timeoutMs,
      intervalMs,
    });
    return toCanonicalProgress(raw);
  }

  async resume({
    workflowId,
    answer,
    cwd,
    signal,
    onEvent,
    outputFormat,
    _pipeline,
  } = {}) {
    return supergptResume({
      workflowId,
      answer,
      cwd,
      signal,
      onEvent,
      outputFormat,
      env: this.env,
      _pipeline,
    });
  }

  async stop({ workflowId, reason = 'stopped by user', root = this.root } = {}) {
    return supergptStop({ workflowId, reason, root });
  }

  formatProgress(stateOrCanonical) {
    return renderGenericProgress(stateOrCanonical);
  }

  formatCompletion(result) {
    return renderGenericCompletion(result);
  }

  formatPlan(planResult) {
    return renderGenericPlan(planResult);
  }

  getReworkVerificationStatus() {
    return defaultOrganicReworkRecorder.getVerificationStatus();
  }
}

// Default singleton control service instance
export const defaultControlService = new SuperGptControlService();
