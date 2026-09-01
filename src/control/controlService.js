// SuperGPT Control Service.
//
// Single source of truth for all external frontend callers (PART 1 & PART 5).
// Frontends (Gemini, Claude Code, Codex, CLI, MCP) call this service, which delegates
// to SuperGPT Core without Core knowing anything about the caller.

import {
  supergptPlan,
  runSuperGPT,
  startSuperGPT,
  supergptResume,
  supergptStop,
  supergptWait,
  supergptWatch,
  supergptStatus,
  toCanonicalProgress,
  readCanonicalProgress,
  defaultOrganicReworkRecorder,
  SUPERGPT_WATCH_TIMEOUT_MS,
} from '../orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import {
  renderGenericProgress,
  renderGenericCompletion,
  renderGenericPlan,
} from '../renderers/genericTextRenderer.js';
import { compileSuperGptRequest } from './requestCompiler.js';
import { supergptRoute } from './autoRoutePolicy.js';
import { Persistence } from '../orchestrator/persistence.js';
import { workflowRuntimeDirectory } from '../orchestrator/supergpt.js';
import {
  amendAcceptance,
  supersedeAcceptance,
  deserializeAcceptanceChain,
  serializeAcceptanceChain,
  resolveActiveAcceptance,
  acceptanceAuditLog,
  assertAcceptanceMutationAllowed,
  ACCEPTANCE_APPROVERS,
  ACCEPTANCE_MUTATION_COMMANDS,
} from '../orchestrator/taskCard.js';
import {
  CONTROLLED_ACCEPTANCE_STATUS,
  getValidControlledHostAcceptance,
} from '../orchestrator/hostVerification.js';

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

  route({ goal, cwd } = {}) {
    return supergptRoute({ goal, cwd });
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
    return startSuperGPT({ ...options, env: this.env });
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
      predicate: (s) => (targetStatus ? s.workflowStatus === targetStatus : predicate ? predicate(s) : ['DONE', 'HUMAN_REQUIRED', 'FAILED', 'TIMEOUT', 'STALLED', 'STOPPED'].includes(s.workflowStatus)),
      timeoutMs,
      intervalMs,
    });
    return toCanonicalProgress(raw);
  }

  async watch({
    workflowId,
    intervalMs = 1000,
    timeoutMs = SUPERGPT_WATCH_TIMEOUT_MS,
    signal,
    onProgress,
    root = this.root,
  } = {}) {
    return supergptWatch({
      workflowId,
      root,
      intervalMs,
      timeoutMs,
      signal,
      onProgress,
    });
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

  // Read-only, zero-model-token view of the controlled Host Acceptance
  // decision. The persisted bundle is never trusted as-is: it is re-validated
  // against the live worktree (HEAD + fingerprint) and the supplied active
  // acceptance version, so a caller always sees whether the evidence would
  // still authorise delivery right now.
  controlledAcceptance({ workflowId, root = this.root, acceptanceVersion = null, verificationCommands = null } = {}) {
    const result = getValidControlledHostAcceptance({ workflowId, root, acceptanceVersion, verificationCommands });
    return {
      workflowId,
      status: result.bundle?.status ?? CONTROLLED_ACCEPTANCE_STATUS,
      valid: result.valid,
      reason: result.reason,
      acceptanceId: result.bundle?.acceptanceId ?? null,
      acceptanceVersion: result.bundle?.acceptanceVersion ?? null,
      head: result.bundle?.head ?? null,
      worktreeFingerprint: result.bundle?.worktreeFingerprint ?? null,
      verificationCommands: result.bundle?.verificationCommands ?? [],
      gate: result.bundle?.gate ?? null,
      reviewer: result.bundle?.reviewer ?? null,
      approvedBy: result.bundle?.approvedBy ?? null,
      approvedAt: result.bundle?.approvedAt ?? null,
    };
  }

  getReworkVerificationStatus() {
    return defaultOrganicReworkRecorder.getVerificationStatus();
  }

  // Controlled orchestrator entry point for the AMEND_ACCEPTANCE /
  // SUPERSEDE_ACCEPTANCE authorization commands. This is the ONLY sanctioned way
  // an acceptance change reaches persistence: the append-only chain is read,
  // a new version is appended, and the superset is written back. Any request
  // whose `originatedBy` identifies an Executor is rejected before the chain is
  // touched, and only HUMAN_REQUIRED / CONTROLLED_ORCHESTRATOR approvers pass
  // the authority check inside amend/supersede.
  async amendAcceptance({
    workflowId,
    taskId = null,
    command = ACCEPTANCE_MUTATION_COMMANDS.AMEND,
    newAcceptance,
    reason,
    approvedBy = ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
    approvedAt = new Date().toISOString(),
    supersedesVersion,
    originatedBy,
    persistence = new Persistence(workflowRuntimeDirectory(workflowId)),
  } = {}) {
    assertAcceptanceMutationAllowed({ originatedBy });

    const stored = await persistence.readAcceptanceChain(workflowId, taskId);
    if (!stored) {
      throw new Error(`amendAcceptance: no acceptance chain persisted for workflow ${workflowId}`);
    }
    const chain = deserializeAcceptanceChain(stored);
    const opts = { newAcceptance, reason, approvedBy, approvedAt, supersedesVersion, originatedBy };
    const next = command === ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE
      ? supersedeAcceptance(chain, opts)
      : amendAcceptance(chain, opts);

    await persistence.writeAcceptanceChain(workflowId, serializeAcceptanceChain(next), taskId);
    return {
      workflowId,
      taskId,
      command,
      active: resolveActiveAcceptance(next),
      audit: acceptanceAuditLog(next),
    };
  }
}

// Default singleton control service instance
export const defaultControlService = new SuperGptControlService();
