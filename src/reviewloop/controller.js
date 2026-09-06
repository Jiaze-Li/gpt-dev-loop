// ReviewLoop controller — the two re-entrant operations behind the MCP tools.
//
//   reviewloop_begin(loopId, goal, cwd, prNumber?, reviewer?)  -> register
//     immutable objective + capture baseline/head. ZERO model calls.
//
//   reviewloop_review(loopId)  -> the one re-entrant operation:
//     detect changed state -> deterministic Gate -> Reviewer (if justified)
//     -> convergence policy -> Supervisor (only on evidence-backed escalation)
//     -> PASS | REWORK | HUMAN_REQUIRED | WAITING_FOR_REVIEW.
//
// The SAME Worker handles REWORK and calls reviewloop_review again. ReviewLoop
// never writes application code, never commits, never pushes, never merges.

import { randomUUID } from 'node:crypto';
import { Persistence } from '../orchestrator/persistence.js';
import { REVIEWLOOP_RUNTIME_ROOT } from './runtimeDir.js';
import {
  createReviewObjective,
  rehydrateObjective,
  assertObjectiveNotWeakened,
  REVIEW_MODES,
} from './objective.js';
import {
  REVIEW_LOOP_STATES,
  initialLoopState,
  recordTransition,
  ReviewLoopStore,
  assertNotLegacyWorkflow,
  isTerminal,
} from './state.js';
import { captureBaseline, collectWorkerDelta } from './gitEvidence.js';
import { discoverVerificationCommands, runGate, GATE_VERDICTS } from './gatePolicy.js';
import {
  normalizeReview,
  decideConvergence,
  compactReworkPayload,
  reviewFingerprint,
  REVIEW_VERDICTS,
} from './reviewPolicy.js';
import { createReviewLoopSpend } from './reviewSpend.js';
import { createPrReviewController, PR_REVIEW_OUTCOMES } from './prReviewController.js';

const RUNTIME_ROOT = REVIEWLOOP_RUNTIME_ROOT; // outside every target repo

function compactBaselineSummary(baseline) {
  return {
    head: baseline.head,
    dirtyFileCount: baseline.dirtyFiles?.length ?? 0,
    evidenceComplete: baseline.evidenceComplete !== false,
  };
}

// A no-op Reviewer/Supervisor that fails closed. Production wiring injects the
// real internal provider adapters; deterministic tests inject mocks.
function requireProvider(name) {
  return async () => {
    throw new Error(`ReviewLoop: no ${name} provider wired (real provider calls are not made in this context)`);
  };
}

export function createReviewLoopController({
  persistence: injectedPersistence = null,
  runtimeRoot = RUNTIME_ROOT,
  env = process.env,
  onEvent,
  recordSafetyEvent = null,
  // injected provider functions — production wiring supplies real adapters
  reviewerFn = requireProvider('Reviewer'),
  supervisorFn = requireProvider('Supervisor'),
  prBackend = null,
  triggerAuthority = null,
  // injected process seams for deterministic tests
  captureBaselineFn = captureBaseline,
  collectWorkerDeltaFn = collectWorkerDelta,
  runGateFn = runGate,
  discoverVerificationCommandsFn = discoverVerificationCommands,
  gateRunner = null,
  clock = () => Date.now(),
} = {}) {
  const persistence = injectedPersistence ?? new Persistence(runtimeRoot);
  const store = new ReviewLoopStore(persistence);
  const safetyEvents = [];
  const collectSafetyEvent = (e) => {
    safetyEvents.push(e);
    recordSafetyEvent?.(e);
  };

  async function begin({
    goal, cwd, prNumber = null, reviewer = null,
    verificationCommands = null, blockingSeverities, maxReviewRounds,
    constraints = [],
  } = {}) {
    if (!goal || !String(goal).trim()) throw new Error('reviewloop_begin: goal is required');
    if (!cwd) throw new Error('reviewloop_begin: cwd is required');
    const loopId = `rl-${new Date(clock()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const mode = prNumber != null ? REVIEW_MODES.PR : REVIEW_MODES.LOCAL;

    let baseline = null;
    let prHead = null;
    let repository = { root: cwd, name: null, url: null };

    if (mode === REVIEW_MODES.LOCAL) {
      baseline = await captureBaselineFn({ cwd });
    } else {
      const backend = prBackend;
      if (!backend) throw new Error('reviewloop_begin: PR mode requires a PR backend');
      prHead = await backend.getPrHead({ prNumber });
      if (!prHead) throw new Error(`reviewloop_begin: cannot resolve HEAD for PR #${prNumber}`);
    }

    const objective = createReviewObjective({
      loopId, goal, repository, mode, prNumber, reviewer, baseline, prHead,
      constraints, blockingSeverities, maxReviewRounds,
    });

    const loopState = initialLoopState(objective);
    loopState.verificationCommands = verificationCommands ?? null;
    if (mode === REVIEW_MODES.PR) loopState.lastReviewedPrHead = null;
    await store.save(loopId, loopState);
    onEvent?.({ type: 'REVIEWLOOP_BEGIN', loopId, mode });

    return {
      loopId,
      mode,
      status: 'READY',
      baseline: baseline ? compactBaselineSummary(baseline) : null,
      prHead: prHead ?? null,
      objectiveFingerprint: objective.fingerprint,
    };
  }

  async function loadLoop(loopId) {
    const raw = await store.load(loopId);
    if (!raw) throw new Error(`reviewloop_review: unknown loopId ${loopId}`);
    assertNotLegacyWorkflow(raw);
    const objective = rehydrateObjective(raw.objective);
    assertObjectiveNotWeakened(objective, raw.objective);
    raw.objective = objective;
    return raw;
  }

  function spendFor(loopId) {
    return createReviewLoopSpend({
      loopId, persistence, env, onEvent, recordSafetyEvent: collectSafetyEvent,
    });
  }

  async function review({ loopId, signal, onHeartbeat } = {}) {
    if (!loopId) throw new Error('reviewloop_review: loopId is required');
    const loopState = await loadLoop(loopId);
    const objective = loopState.objective;

    if (isTerminal(loopState.state) && loopState.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
      return terminalResult(loopState);
    }

    if (objective.mode === REVIEW_MODES.PR) {
      return reviewPr({ loopState, signal, onHeartbeat });
    }
    return reviewLocal({ loopState });
  }

  // ---- LOCAL mode ----------------------------------------------------------
  async function reviewLocal({ loopState }) {
    const objective = loopState.objective;
    const cwd = objective.repository?.root;
    const baseline = objective.baseline;

    recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'review requested');

    const delta = await collectWorkerDeltaFn({ cwd, baseline });

    // Deterministic Gate (zero model tokens).
    const discovered = discoverVerificationCommandsFn({
      cwd, configured: loopState.verificationCommands,
    });
    const gate = await runGateFn({
      cwd,
      commands: discovered.commands,
      runner: gateRunner,
      baselineGateEvidence: loopState.baselineGateEvidence ?? null,
    });
    gate.commandSource = discovered.source;

    const fp = reviewFingerprint({ deltaFingerprint: delta.fingerprint, gateFingerprint: gate.fingerprint });

    // No new information -> no new model call.
    if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === fp) {
      await store.save(loopState.loopId, loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'submitted state is identical to the last review; no Reviewer/Supervisor call made',
        lastReview: compactLastReview(loopState),
        telemetry: emptyTelemetry(),
        safetyEvents,
      };
    }

    // Gate FAIL with an actionable NEW regression -> REWORK directly, no
    // Reviewer / Supervisor spend.
    if (gate.verdict === GATE_VERDICTS.FAIL) {
      loopState.round += 1;
      loopState.lastReviewedFingerprint = fp;
      loopState.lastGateFingerprint = gate.fingerprint;
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate regression');
      await store.save(loopState.loopId, loopState);
      return {
        ...compactReworkPayload({ loopState, review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 }, gate }),
        reason: 'deterministic Gate failed with a new regression; fix it before Reviewer runs',
        telemetry: emptyTelemetry(),
        safetyEvents,
      };
    }

    // Gate PASS/WARN -> Reviewer.
    const spend = spendFor(loopState.loopId);
    loopState.round += 1;

    const diffEvidence = await spend.registerEvidence({
      kind: 'diff', taskId: loopState.loopId, diffHash: delta.fingerprint,
    });
    const gateEvidence = await spend.registerEvidence({
      kind: 'gate', taskId: loopState.loopId, fingerprint: gate.fingerprint,
    });

    const rawReview = await spend.meteredCall({
      role: 'reviewer',
      operationId: `${loopState.loopId}:round-${loopState.round}`,
      attempt: loopState.round,
      evidenceIds: [diffEvidence.evidenceId, gateEvidence.evidenceId],
      call: async () => {
        const out = await reviewerFn({
          objective, diff: delta.diff, changedFiles: delta.changedFiles, gate,
          round: loopState.round, previousFindings: loopState.lastReview?.blockingFindings ?? [],
        });
        return { value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null };
      },
    });
    loopState.reviewerCalls += 1;

    const review = normalizeReview({ raw: rawReview, reviewer: 'internal', provider: 'internal' });
    review.reviewedFingerprint = fp;
    loopState.lastReviewedFingerprint = fp;
    loopState.lastGateFingerprint = gate.fingerprint;
    loopState.lastReview = review;

    // decideConvergence compares against the PREVIOUS round's signatures, so
    // record this round's signatures only after the decision is made.
    const decision = decideConvergence({ loopState, review });
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      { round: loopState.round, signatures: review.findingSignatures },
    ];

    let supervisorGuidance = null;
    if (decision.verdict === REVIEW_VERDICTS.REWORK && decision.invokeSupervisor
      && !loopState.supervisorInvoked) {
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, 'non-convergence escalation');
      const findingsEvidence = await spend.registerEvidence({
        kind: 'findings', taskId: loopState.loopId, signature: review.findingSignatures.join('|') || 'none',
      });
      const guidance = await spend.meteredCall({
        role: 'supervisor',
        operationId: `${loopState.loopId}:supervise`,
        attempt: 1,
        evidenceIds: [findingsEvidence.evidenceId],
        call: async () => {
          const out = await supervisorFn({
            objective,
            blockingFindings: review.blockingFindings,
            gate,
            round: loopState.round,
            priorSignatures: loopState.findingSignatureHistory,
          });
          return { value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null };
        },
      });
      loopState.supervisorCalls += 1;
      loopState.supervisorInvoked = true;
      supervisorGuidance = typeof guidance === 'string' ? guidance : (guidance?.guidance ?? guidance?.text ?? null);
      loopState.lastSupervisorGuidance = supervisorGuidance;
      if (guidance?.recommendation === 'HUMAN_REQUIRED') {
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'supervisor recommends human');
        await store.save(loopState.loopId, loopState);
        return humanRequiredResult(loopState, review, spend, supervisorGuidance);
      }
    }

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, spend);
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await store.save(loopState.loopId, loopState);
      return humanRequiredResult(loopState, review, spend, supervisorGuidance);
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
    await store.save(loopState.loopId, loopState);
    return {
      ...compactReworkPayload({ loopState, review, gate, supervisorGuidance }),
      reason: decision.reason,
      telemetry: spend.telemetry(),
      safetyEvents,
    };
  }

  // ---- PR mode ------------------------------------------------------------
  async function reviewPr({ loopState, signal, onHeartbeat }) {
    const objective = loopState.objective;
    recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'PR review requested');

    const prCtl = createPrReviewController({
      loopId: loopState.loopId,
      persistence,
      prBackend,
      env,
      onEvent,
      recordSafetyEvent: collectSafetyEvent,
      triggerAuthority,
    });

    const result = await prCtl.obtainReview({ objective, loopState, signal, onHeartbeat });

    if (result.outcome === PR_REVIEW_OUTCOMES.PUSH_REQUIRED) {
      await store.save(loopState.loopId, loopState);
      return {
        status: 'PUSH_REQUIRED',
        loopId: loopState.loopId,
        head: result.head,
        reason: result.reason,
        telemetry: emptyTelemetry(),
        safetyEvents,
      };
    }

    if (result.outcome === PR_REVIEW_OUTCOMES.WAITING_FOR_REVIEW) {
      recordTransition(loopState, REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, 'external review pending');
      loopState.pendingExternalTrigger = loopState.pendingExternalTrigger
        ?? { head: result.head, reviewer: objective.reviewer, status: 'TRIGGERED' };
      await store.save(loopState.loopId, loopState);
      return {
        status: 'WAITING_FOR_REVIEW',
        loopId: loopState.loopId,
        head: result.head,
        reason: result.reason,
        telemetry: emptyTelemetry(),
        safetyEvents,
      };
    }

    if (result.outcome === PR_REVIEW_OUTCOMES.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, result.reason);
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        head: result.head ?? null,
        reason: result.reason,
        blockingFindings: loopState.lastReview?.blockingFindings ?? [],
        telemetry: emptyTelemetry(),
        safetyEvents,
      };
    }

    // REVIEW_READY
    const review = result.review;
    const newHead = result.head !== loopState.lastReviewedPrHead;
    if (newHead) {
      loopState.round += 1;
    }
    loopState.lastReviewedPrHead = result.head;
    loopState.lastReview = review;
    loopState.pendingExternalTrigger = null;

    const spend = spendFor(loopState.loopId);
    // Register the external result as evidence so a later identical head can't
    // re-authorize a Reviewer/Supervisor call.
    await spend.registerEvidence({
      kind: 'external', subject: `pr-${objective.prNumber}`, fingerprint: `${result.head}:${review.findingSignatures.join('|')}`,
    });

    const decision = decideConvergence({ loopState, review });
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      { round: loopState.round, signatures: review.findingSignatures },
    ];

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, spend);
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await store.save(loopState.loopId, loopState);
      return humanRequiredResult(loopState, review, spend, null);
    }

    let supervisorGuidance = null;
    if (decision.invokeSupervisor && !loopState.supervisorInvoked) {
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, 'PR non-convergence escalation');
      const findingsEvidence = await spend.registerEvidence({
        kind: 'findings', taskId: loopState.loopId, signature: review.findingSignatures.join('|') || 'none',
      });
      const guidance = await spend.meteredCall({
        role: 'supervisor',
        operationId: `${loopState.loopId}:supervise`,
        attempt: 1,
        evidenceIds: [findingsEvidence.evidenceId],
        call: async () => {
          const out = await supervisorFn({
            objective, blockingFindings: review.blockingFindings, round: loopState.round,
          });
          return { value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null };
        },
      });
      loopState.supervisorCalls += 1;
      loopState.supervisorInvoked = true;
      supervisorGuidance = typeof guidance === 'string' ? guidance : (guidance?.guidance ?? null);
      loopState.lastSupervisorGuidance = supervisorGuidance;
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
    await store.save(loopState.loopId, loopState);
    return {
      ...compactReworkPayload({ loopState, review, gate: null, supervisorGuidance }),
      head: result.head,
      reason: `${decision.reason}; push your fix so ReviewLoop can request a review of the new HEAD`,
      telemetry: spend.telemetry(),
      safetyEvents,
    };
  }

  // ---- result shaping ----------------------------------------------------
  function passResult(loopState, review, spend) {
    return {
      status: 'PASS',
      loopId: loopState.loopId,
      round: loopState.round,
      reviewer: review.reviewer,
      nonBlockingFindings: review.nonBlockingFindings,
      nonBlockingOmitted: review.nonBlockingOmitted ?? 0,
      telemetry: spend ? spend.telemetry() : emptyTelemetry(),
      safetyEvents,
    };
  }

  function humanRequiredResult(loopState, review, spend, supervisorGuidance) {
    return {
      status: 'HUMAN_REQUIRED',
      loopId: loopState.loopId,
      round: loopState.round,
      blockingFindings: review?.blockingFindings ?? [],
      supervisorGuidance: supervisorGuidance ?? loopState.lastSupervisorGuidance ?? null,
      reason: loopState.history?.slice(-1)[0]?.reason ?? 'review did not converge',
      telemetry: spend ? spend.telemetry() : emptyTelemetry(),
      safetyEvents,
    };
  }

  function terminalResult(loopState) {
    return {
      status: loopState.state,
      loopId: loopState.loopId,
      round: loopState.round,
      reason: 'loop already terminal',
      lastReview: compactLastReview(loopState),
      telemetry: emptyTelemetry(),
      safetyEvents,
    };
  }

  function compactLastReview(loopState) {
    const r = loopState.lastReview;
    if (!r) return null;
    return { status: r.status, blockingFindings: r.blockingFindings, findingSignatures: r.findingSignatures };
  }

  function emptyTelemetry() {
    return {
      reviewerCalls: 0,
      supervisorCalls: 0,
      externalTriggers: 0,
      workerUsage: 'external / not observable by ReviewLoop',
    };
  }

  return { begin, review, _store: store, _persistence: persistence };
}
