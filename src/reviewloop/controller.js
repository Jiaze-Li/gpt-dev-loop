// ReviewLoop controller — the two re-entrant operations behind the MCP tools.
//
//   reviewloop_begin  -> register the immutable objective + capture the exact
//     pre-Worker baseline (LOCAL) or bind the PR HEAD (PR). Also captures
//     baseline Gate evidence when trusted verification is deterministically
//     discoverable. ZERO model calls.
//
//   reviewloop_review -> the one re-entrant operation: attribute the Worker's
//     delta -> deterministic Gate -> independent Reviewer over the FULL
//     attributed evidence (bounded or deterministically chunked) -> convergence
//     policy -> Supervisor (exception-only) -> PASS | REWORK | HUMAN_REQUIRED |
//     WAITING_FOR_REVIEW | NO_PROGRESS | PUSH_REQUIRED.
//
// The SAME Worker handles REWORK and calls reviewloop_review again. ReviewLoop
// never writes application code, never commits, pushes, merges, or force-pushes.

import { randomUUID, createHash } from 'node:crypto';
import { Persistence } from '../orchestrator/persistence.js';
import { isAuthorizationFailure } from '../orchestrator/errors.js';
import { DEFAULT_ROLE_POLICY } from '../orchestrator/roleRouting.js';
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
import { withInProcessLoopLock, acquireLoopFileLease } from './loopLease.js';
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
import { chunkDiffForReview } from './diffChunker.js';

const RUNTIME_ROOT = REVIEWLOOP_RUNTIME_ROOT;

// Absolute ceiling on physical provider attempts for one metered operation —
// purely a runaway guard. The EFFECTIVE bound is the role's own candidate count
// (see providerAttemptBudget): every DEFAULT_ROLE_POLICY candidate must be
// mechanically reachable when each earlier candidate fails safely, so a role
// with N candidates gets up to N attempts. The `tried` set already stops a
// family being re-attempted and `!selection` stops the loop when the pool is
// exhausted; this ceiling only exists so a pathological policy can never spin.
const PROVIDER_ATTEMPT_HARD_CEILING = 16;

function providerAttemptBudget(role) {
  const n = DEFAULT_ROLE_POLICY[role]?.length ?? 0;
  return Math.min(Math.max(n, 1), PROVIDER_ATTEMPT_HARD_CEILING);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function compactBaselineSummary(baseline) {
  return {
    head: baseline.head,
    dirtyFileCount: baseline.dirtyFiles?.length ?? 0,
    evidenceComplete: baseline.evidenceComplete !== false,
  };
}

function requireProvider(name) {
  return async () => {
    throw new Error(`ReviewLoop: no ${name} provider wired (real provider calls are not made in this context)`);
  };
}

// Provider-failure codes that a bounded failover attempt may follow. All are
// either "the call never reached the provider" (pre-send: unavailable, ENOENT,
// spawn failure, CLI not authenticated) or "reached it but produced no usable
// result and no unresolved spend" (rate limit, quota, protocol error, timeout
// classified as mechanically bounded). A mid-flight failure with unknown usage
// never lands here — dispatch() has already turned it into a spend-blocking
// AuthorizationError.
//
// PROVIDER_AUTH_FAILED is retryable-via-failover on purpose: an unauthenticated
// CLI transport (`codex` / `claude` not logged in) is a pre-send failure with
// no spend, and RoleRouter.recordFailure already treats it as health-affecting
// (family removed, AUTH_FAILED). Trying the next eligible family is exactly the
// intended recovery; if every family is unauthenticated the loop still
// exhausts and rethrows.
const RETRYABLE = new Set([
  'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_PROTOCOL_ERROR', 'PROVIDER_AUTH_FAILED',
  'EXECUTOR_TIMEOUT', 'AGY_ENOENT', 'AGY_SPAWN_FAILED',
]);

export function createReviewLoopController({
  persistence: injectedPersistence = null,
  runtimeRoot = RUNTIME_ROOT,
  env = process.env,
  onEvent,
  recordSafetyEvent = null,
  reviewerFn = requireProvider('Reviewer'),
  supervisorFn = requireProvider('Supervisor'),
  // optional pool routing (production wiring). Return { family, provider,
  // model, transport } or null. When present, the controller binds the real
  // selected family into the CallIntent and drives bounded failover.
  routeReviewerFn = null,
  routeSupervisorFn = null,
  recordProviderFailure = null,
  prBackend = null,
  triggerAuthority = null,
  captureBaselineFn = captureBaseline,
  collectWorkerDeltaFn = collectWorkerDelta,
  runGateFn = runGate,
  discoverVerificationCommandsFn = discoverVerificationCommands,
  gateRunner = null,
  clock = () => Date.now(),
} = {}) {
  const persistence = injectedPersistence ?? new Persistence(runtimeRoot);
  const store = new ReviewLoopStore(persistence);
  // The cross-process lock file lives under the real runtime dir. Only a
  // filesystem-backed persistence has one; an in-memory test persistence does
  // not, and there the in-process lock chain is the whole guarantee.
  const fileLeaseRoot = typeof persistence?.workflowDir === 'function' ? runtimeRoot : null;
  // Safety events are scoped to ONE reviewloop_review invocation. The array is
  // replaced (never appended-to across calls) at the top of review() so a
  // long-lived controller (one per MCP process, shared by every loopId) never
  // leaks one loop's safety events into another loop's result, and never grows
  // unbounded. Durable cumulative spend still comes from spend.telemetry(),
  // which reads the durable per-loop ledger.
  let safetyEvents = [];
  const collectSafetyEvent = (e) => {
    safetyEvents.push(e);
    recordSafetyEvent?.(e);
  };

  // Cumulative, durable per-loop spend telemetry with zero model calls — used
  // on every early-return path (NO_PROGRESS / WAITING_FOR_REVIEW /
  // PUSH_REQUIRED / terminal) so those results never understate spend that
  // earlier rounds already incurred.
  async function durableTelemetry(loopId) {
    try {
      return await spendFor(loopId).telemetry();
    } catch {
      return emptyTelemetry();
    }
  }

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
    const repository = { root: cwd, name: null, url: null };
    let baselineGate = null;
    let verificationPlan = null;

    if (mode === REVIEW_MODES.LOCAL) {
      baseline = await captureBaselineFn({ cwd });

      // Freeze the verification plan NOW. reviewloop_review always runs these
      // exact commands; a later edit to .reviewloop.json / package.json's test
      // script cannot weaken the Gate.
      const discovered = discoverVerificationCommandsFn({ cwd, configured: verificationCommands });
      verificationPlan = {
        source: String(discovered.source ?? 'unknown'),
        commands: (discovered.commands ?? []).map(String),
        manifestFingerprint: discovered.manifestFingerprint
          ?? sha256Hex(`fallback::${JSON.stringify(discovered.commands ?? [])}`),
        frozenAt: new Date(clock()).toISOString(),
      };

      // B8 — baseline Gate evidence, 0 model tokens, over the FROZEN plan. Only
      // when trusted/discoverable verification exists; a failure to run it is
      // recorded as incomplete coverage, never faked as PASS.
      try {
        if (verificationPlan.source !== 'mechanical' && verificationPlan.commands.length) {
          const g = await runGateFn({ cwd, commands: verificationPlan.commands, runner: gateRunner, env });
          baselineGate = {
            evidence: g.evidence ?? { results: g.results ?? [], pass: g.pass },
            pass: g.pass,
            capturedAt: new Date().toISOString(),
            source: verificationPlan.source,
          };
        }
      } catch (err) {
        baselineGate = { coverage: 'INCOMPLETE', reason: String(err?.message ?? err) };
      }
    } else {
      if (!prBackend) throw new Error('reviewloop_begin: PR mode requires a PR backend');
      prHead = await prBackend.getPrHead({ prNumber });
      if (!prHead) throw new Error(`reviewloop_begin: cannot resolve HEAD for PR #${prNumber}`);
    }

    // REVIEWLOOP_MAX_REVIEW_ROUNDS is a public tuning knob: an explicit begin
    // argument wins, otherwise the env value feeds the frozen objective (which
    // is the value decideConvergence() actually enforces), otherwise the
    // objective default. Never left resolved-but-ignored.
    const envMaxRounds = Number(env?.REVIEWLOOP_MAX_REVIEW_ROUNDS);
    const resolvedMaxRounds = Number.isInteger(maxReviewRounds) && maxReviewRounds > 0
      ? maxReviewRounds
      : (Number.isInteger(envMaxRounds) && envMaxRounds > 0 ? envMaxRounds : undefined);

    const objective = createReviewObjective({
      loopId, goal, repository, mode, prNumber, reviewer, baseline, prHead,
      constraints, blockingSeverities, maxReviewRounds: resolvedMaxRounds,
      verificationPlan,
    });

    const loopState = initialLoopState(objective);
    loopState.verificationCommands = verificationCommands ?? null;
    loopState.baselineGateEvidence = baselineGate;
    if (mode === REVIEW_MODES.PR) loopState.lastReviewedPrHead = null;
    await store.save(loopId, loopState);
    onEvent?.({ type: 'REVIEWLOOP_BEGIN', loopId, mode });

    return {
      loopId,
      mode,
      status: 'READY',
      baseline: baseline ? compactBaselineSummary(baseline) : null,
      prHead: prHead ?? null,
      reviewer: objective.reviewer,
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

  // One metered provider call with bounded failover. Each physical attempt
  // re-routes (excluding failed families), re-authorizes (fresh permit), and
  // re-binds the CallIntent to the actually-selected family. A provider
  // failure is not New Information: every attempt supplies the SAME single
  // composite evidenceId, and attempt 1 durably CONSUMES it. Attempts 2..N
  // (attempt > 1) are authorized by that same prior claim — one logical
  // (diff + gate) state authorizes exactly one dispatch SEQUENCE, bounded by
  // the role's candidate count — never a fresh consumption per attempt, and never
  // a fresh dispatch on identical evidence for a first attempt (crash/resume
  // re-call included).
  async function meteredWithFailover({
    spend, role, routeFn, defaultFamily, defaultProvider, operationId, evidenceIds, invoke, workflowId = null,
  }) {
    const tried = new Set();
    // Effective attempt bound = this role's candidate count, so every
    // DEFAULT_ROLE_POLICY candidate is reachable when each earlier one fails
    // safely. `tried` + a null selection still stop the loop early.
    const maxAttempts = providerAttemptBudget(role);
    let lastErr = null;
    // Resume/continuation: if this exact (role, operationId) already durably
    // CONSUMED its evidence in a prior (crashed) session, this call is not a
    // fresh first attempt — it continues that one authorized dispatch SEQUENCE.
    // Start the bounded attempt counter past 1 so authorize() takes the
    // failover-reuse path, which STILL refuses if any earlier attempt actually
    // reached the provider (non-zero settled usage / open DISPATCHING).
    let startAttempt = 1;
    try {
      const priorClaim = await spend.informationLedger?.findConsumedBy?.({
        workflowId, role, operationId, evidenceIds,
      });
      if (priorClaim) startAttempt = 2;
    } catch { /* treat as a first attempt; authorize() re-checks deterministically */ }
    for (let attempt = startAttempt; attempt < startAttempt + maxAttempts; attempt += 1) {
      let selection = null;
      if (routeFn) {
        selection = routeFn({ reworkCycles: attempt - startAttempt });
        if (!selection) break;
        if (tried.has(selection.family)) break;
        tried.add(selection.family);
      }
      const family = selection?.family ?? defaultFamily;
      const provider = selection?.provider ?? defaultProvider;
      try {
        // eslint-disable-next-line no-await-in-loop
        return await spend.meteredCall({
          role, family, provider, model: selection?.model ?? null,
          operationId, attempt, evidenceIds,
          call: () => invoke({ selection }),
        });
      } catch (err) {
        lastErr = err;
        if (isAuthorizationFailure(err)) throw err; // spend/objective denial — never retry
        const code = err?.code ?? err?.providerFailure ?? '';
        if (!RETRYABLE.has(code)) throw err;
        if (selection && recordProviderFailure) recordProviderFailure(selection, { code });
        // loop -> next attempt re-routes
      }
    }
    throw lastErr ?? new Error(`ReviewLoop: no eligible ${role} provider`);
  }

  async function review({ loopId, signal, onHeartbeat } = {}) {
    if (!loopId) throw new Error('reviewloop_review: loopId is required');
    // Serialize every reviewloop_review for this loopId. In-process: overlapping
    // calls run one after another (the second then hits the deterministic
    // NO_PROGRESS guard — one dispatch, no lost update). Cross-process: a live
    // foreign holder makes this call return BUSY without touching any state.
    return withInProcessLoopLock(loopId, async () => {
      const lease = await acquireLoopFileLease({ runtimeRoot: fileLeaseRoot, loopId });
      if (!lease.ok) {
        // Another reviewloop_review is already running for this loop (another
        // process). Report the in-contract "call again later" state — never run
        // a concurrent Reviewer or clobber the in-flight call's durable state.
        safetyEvents = [];
        // BUSY is a strictly READ-ONLY outcome: another process owns this loop
        // and is the one entitled to reconcile/settle its reservations. This
        // path must not call durableTelemetry() (it runs reconcileOnResume and
        // can rewrite RESERVED/DISPATCHING reservations under the live owner) —
        // it touches no durable state at all. The owning call reports accurate
        // telemetry when it finishes.
        return {
          status: 'WAITING_FOR_REVIEW',
          loopId,
          reason: 'another reviewloop_review is already running for this loop'
            + (lease.heldBy?.pid ? ` (holder pid ${lease.heldBy.pid} on ${lease.heldBy.host ?? '?'})` : '')
            + '; wait for it to finish, then call reviewloop_review again',
          nextAction: 'Wait for the in-flight review of this loop to finish, then call reviewloop_review again.',
          telemetry: { ...emptyTelemetry(), note: 'another process owns this loop; telemetry not read to keep this path side-effect-free' },
          safetyEvents: [],
        };
      }
      try {
        return await reviewInner({ loopId, signal, onHeartbeat });
      } finally {
        await lease.release();
      }
    });
  }

  async function reviewInner({ loopId, signal, onHeartbeat }) {
    // Per-invocation safety-event isolation: start this call with a clean list.
    safetyEvents = [];
    const loopState = await loadLoop(loopId);
    const objective = loopState.objective;

    if (isTerminal(loopState.state) && loopState.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED) {
      return terminalResult(loopState);
    }
    if (objective.mode === REVIEW_MODES.PR) return reviewPr({ loopState, signal, onHeartbeat });
    return reviewLocal({ loopState });
  }

  // ---- Reviewer over full attributed evidence (bounded or chunked) --------
  async function runReviewerOverEvidence({ spend, loopState, objective, delta, gate }) {
    // Round is bound to the LOGICAL review state (delta + gate fingerprint),
    // NOT to how many times reviewloop_review was invoked. A crash/resume that
    // re-enters with the SAME logical review state — its durable per-chunk
    // checkpoint is still on record — reuses the round it already assigned and
    // never consumes another of the objective's max review rounds.
    const checkpointKey = sha256Hex(`${delta.fingerprint}::${gate.fingerprint}`);
    const resumeCheckpoint = loopState.chunkReviewCheckpoint;
    if (resumeCheckpoint && resumeCheckpoint.key === checkpointKey
      && Number.isInteger(resumeCheckpoint.round)) {
      loopState.round = resumeCheckpoint.round;
    } else {
      loopState.round += 1;
    }

    const { chunks, oversized, reason } = chunkDiffForReview(delta.diff, { env });
    if (oversized) {
      return {
        review: {
          status: 'FAILED', reviewer: 'internal', provider: 'internal',
          blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
          findingSignatures: [], error: { reason: 'REVIEW_TOO_LARGE', message: reason },
        },
        chunkCount: chunks.length,
      };
    }

    // Durable per-chunk checkpoint. Keyed to the exact review state (delta +
    // gate); a changed diff invalidates it. On resume, a chunk already in the
    // checkpoint is NOT re-sent to the model — its normalized result is reused.
    // It also carries the round this logical review state was assigned so a
    // resume never re-increments it.
    let checkpoint = loopState.chunkReviewCheckpoint;
    if (!checkpoint || checkpoint.key !== checkpointKey) {
      checkpoint = {
        key: checkpointKey, chunkTotal: chunks.length, chunks: {}, round: loopState.round,
      };
      loopState.chunkReviewCheckpoint = checkpoint;
    } else if (!Number.isInteger(checkpoint.round)) {
      checkpoint.round = loopState.round;
    }

    const perChunk = [];
    for (const chunk of chunks) {
      const done = checkpoint.chunks[chunk.index];
      if (done) {
        // Resume: this chunk was already reviewed in a prior (crashed) attempt.
        if (done.status === 'FAILED') {
          return { review: done, chunkCount: chunks.length, failedChunk: chunk.index };
        }
        perChunk.push(done);
        continue;
      }
      const chunkId = `${loopState.loopId}:round-${loopState.round}:chunk-${chunk.index}`;
      // ONE composite logical review-state evidence per chunk: the diff chunk
      // AND the gate fingerprint together. A single logical (diff + gate) state
      // authorizes exactly ONE physical Reviewer dispatch SEQUENCE — bounded
      // failover retries of that same operation reuse this one claim, and it is
      // never re-earned by a re-call on identical evidence (crash/resume
      // included). Multiple evidenceIds no longer multiply dispatch eligibility.
      // eslint-disable-next-line no-await-in-loop
      const reviewStateEvidence = await spend.registerEvidence({
        kind: 'reviewstate', taskId: chunkId, diffHash: sha256Hex(`${chunk.hash}::${gate.fingerprint}`),
      });
      // eslint-disable-next-line no-await-in-loop
      const raw = await meteredWithFailover({
        spend,
        role: 'reviewer',
        routeFn: routeReviewerFn,
        defaultFamily: 'agy:gpt-oss',
        defaultProvider: 'agy',
        operationId: chunkId,
        workflowId: loopState.loopId,
        evidenceIds: [reviewStateEvidence.evidenceId],
        invoke: ({ selection }) => Promise.resolve(reviewerFn({
          objective,
          diff: chunk.text,
          changedFiles: delta.changedFiles,
          gate,
          round: loopState.round,
          chunk: { index: chunk.index, total: chunk.total },
          previousFindings: loopState.lastReview?.blockingFindings ?? [],
          selection,
        })).then((out) => ({
          value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
        })),
      });
      loopState.reviewerCalls += 1;
      const normalized = normalizeReview({ raw, reviewer: 'internal', provider: 'internal' });
      // Durable-before-next-chunk: persist this chunk's result so a crash before
      // the round completes does not re-call the model for it on resume.
      checkpoint.chunks[chunk.index] = normalized;
      // eslint-disable-next-line no-await-in-loop
      await store.save(loopState.loopId, loopState);
      // Any chunk we could not review successfully fails the whole review closed.
      if (normalized.status === 'FAILED') {
        return { review: normalized, chunkCount: chunks.length, failedChunk: chunk.index };
      }
      perChunk.push(normalized);
    }

    // Aggregate: union of findings across every successfully-reviewed chunk.
    const bySig = new Map();
    for (const r of perChunk) {
      for (const f of [...r.blockingFindings, ...r.nonBlockingFindings.map((n) => ({ ...n, signature: `${n.severity}:${n.file ?? ''}:${n.title ?? ''}` }))]) {
        if (f.signature && !bySig.has(f.signature)) bySig.set(f.signature, f);
      }
    }
    const findings = [...bySig.values()];
    const blocking = findings.filter((f) => objective.blockingSeverities.includes(f.severity));
    return {
      review: {
        status: blocking.length ? 'ACTIONABLE' : 'CLEAN',
        reviewer: 'internal',
        provider: 'internal',
        reviewedHead: delta.currentHead,
        blockingFindings: blocking,
        nonBlockingFindings: findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).slice(0, 8),
        nonBlockingOmitted: Math.max(0, findings.filter((f) => !objective.blockingSeverities.includes(f.severity)).length - 8),
        findingSignatures: [...new Set(blocking.map((f) => f.signature).filter(Boolean))].sort(),
        error: null,
      },
      chunkCount: chunks.length,
    };
  }

  // ---- LOCAL mode --------------------------------------------------------
  async function reviewLocal({ loopState }) {
    const objective = loopState.objective;
    const cwd = objective.repository?.root;
    const baseline = objective.baseline;

    const delta = await collectWorkerDeltaFn({ cwd, baseline });

    // B7 — no Worker change since begin -> deterministic NO_PROGRESS, 0 Reviewer.
    if (delta.noWorkerChangeYet) {
      await store.save(loopState.loopId, loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'no Worker change has been made since reviewloop_begin; do the work, then call reviewloop_review',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'review requested');

    // B7 — a pre-existing change that cannot be attributed away from the Worker
    // must not be sent to the Reviewer as Worker output.
    if (delta.evidenceComplete === false) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'baseline attribution incomplete');
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: `cannot reliably separate Worker changes from pre-existing work: ${(delta.incompleteReasons ?? []).join('; ')}`,
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    // The verification plan was FROZEN at reviewloop_begin. Use exactly those
    // commands — never re-derive from the (possibly Worker-edited) on-disk
    // config. Only fall back to fresh discovery for a legacy loop persisted
    // before the plan was frozen.
    const frozenPlan = objective.verificationPlan;
    let gateCommands;
    let commandSource;
    if (frozenPlan?.commands?.length) {
      gateCommands = frozenPlan.commands;
      commandSource = `${frozenPlan.source} (frozen at begin)`;
      // A Worker that rewrote `.reviewloop.json` / the `package.json` test
      // script after begin cannot weaken the Gate. Running the frozen command
      // array already defeats a `.reviewloop.json` edit; but a `package.json`
      // plan is the indirection `npm test`, so a rewritten test script would
      // still run. Any manifest drift therefore fails the review closed rather
      // than trusting the Gate: the Worker must revert the config or start a
      // fresh reviewloop_begin.
      try {
        const current = discoverVerificationCommandsFn({ cwd, configured: loopState.verificationCommands });
        if (current?.manifestFingerprint && frozenPlan.manifestFingerprint
          && current.manifestFingerprint !== frozenPlan.manifestFingerprint) {
          collectSafetyEvent({
            code: 'VERIFICATION_PLAN_DRIFT',
            severity: 'BLOCKING',
            role: 'gate',
            taskId: loopState.loopId,
            reason: `the verification config (${frozenPlan.source}) was modified after reviewloop_begin`,
            actionTaken: 'review blocked; frozen Gate cannot be trusted',
          });
          loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
          recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'verification plan drift');
          await store.save(loopState.loopId, loopState);
          return {
            ...compactReworkPayload({
              loopState,
              review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 },
              gate: { verdict: 'FAIL', failureIdentities: ['verification-plan-drift'] },
            }),
            reason: 'the verification configuration was changed after reviewloop_begin; revert '
              + '.reviewloop.json / the package.json test script to what it was, or start a new '
              + 'reviewloop_begin — ReviewLoop will not run a Gate the Worker can edit mid-loop',
            telemetry: await durableTelemetry(loopState.loopId),
            safetyEvents,
          };
        }
      } catch { /* discovery is best-effort here */ }
    } else {
      const discovered = discoverVerificationCommandsFn({ cwd, configured: loopState.verificationCommands });
      gateCommands = discovered.commands;
      commandSource = discovered.source;
    }
    const gate = await runGateFn({
      cwd, commands: gateCommands, runner: gateRunner, env,
      baselineGateEvidence: loopState.baselineGateEvidence?.evidence ?? null,
    });
    gate.commandSource = commandSource;

    const fp = reviewFingerprint({ deltaFingerprint: delta.fingerprint, gateFingerprint: gate.fingerprint });

    if (loopState.lastReviewedFingerprint && loopState.lastReviewedFingerprint === fp) {
      await store.save(loopState.loopId, loopState);
      return {
        status: 'NO_PROGRESS',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'submitted state is identical to the last review; no Reviewer/Supervisor call made',
        lastReview: compactLastReview(loopState),
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    if (gate.verdict === GATE_VERDICTS.FAIL) {
      // A deterministic Gate FAIL is a repair cycle, NOT a fresh Reviewer
      // round: it never consumes one of the objective's max review rounds and
      // the independent Reviewer has not run. An identical failing (diff+gate)
      // resubmission still deterministically returns NO_PROGRESS (above).
      loopState.gateRepairCount = (loopState.gateRepairCount ?? 0) + 1;
      loopState.lastReviewedFingerprint = fp;
      loopState.lastGateFingerprint = gate.fingerprint;
      recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, 'gate regression');
      await store.save(loopState.loopId, loopState);
      return {
        ...compactReworkPayload({ loopState, review: { blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0 }, gate }),
        reason: 'deterministic Gate failed with a new regression; fix it before Reviewer runs',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

    const spend = spendFor(loopState.loopId);
    // The fresh-round increment now lives in runReviewerOverEvidence, bound to
    // the logical (delta + gate) review state so a crash/resume of the same
    // review never consumes an extra round.

    let reviewOut;
    try {
      reviewOut = await runReviewerOverEvidence({ spend, loopState, objective, delta, gate });
    } catch (err) {
      return spendDenialResult(loopState, err, await spend.telemetry());
    }
    const review = reviewOut.review;
    review.reviewedFingerprint = fp;
    loopState.lastReviewedFingerprint = fp;
    loopState.lastGateFingerprint = gate.fingerprint;
    loopState.lastReview = review;
    // The round's chunks are all reviewed (or it failed closed) — the
    // checkpoint has served its purpose.
    loopState.chunkReviewCheckpoint = null;

    if (review.status === 'FAILED') {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, review.error?.reason ?? 'review failed');
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: `Reviewer did not produce a usable result (${review.error?.reason}): ${review.error?.message ?? ''}`,
        telemetry: await spend.telemetry(),
        safetyEvents,
      };
    }

    const decision = decideConvergence({ loopState, review });
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      { round: loopState.round, signatures: review.findingSignatures },
    ];

    let supervisorGuidance = null;
    if (decision.verdict === REVIEW_VERDICTS.REWORK && decision.invokeSupervisor && !loopState.supervisorInvoked) {
      const sup = await runSupervisor({ spend, loopState, objective, review, gate });
      if (sup.humanRequired) {
        recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, 'non-convergence escalation');
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, sup.reason);
        await store.save(loopState.loopId, loopState);
        return humanRequiredResult(loopState, review, await spend.telemetry(), sup.guidance);
      }
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, 'non-convergence escalation');
      supervisorGuidance = sup.guidance;
      loopState.lastSupervisorGuidance = supervisorGuidance;
    }

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, await spend.telemetry());
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await store.save(loopState.loopId, loopState);
      return humanRequiredResult(loopState, review, await spend.telemetry(), supervisorGuidance);
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
    await store.save(loopState.loopId, loopState);
    return {
      ...compactReworkPayload({ loopState, review, gate, supervisorGuidance }),
      reason: decision.reason,
      telemetry: await spend.telemetry(),
      safetyEvents,
    };
  }

  // Supervisor, exception-only. Returns { guidance } | { humanRequired, reason }
  // | { denied, error }.
  async function runSupervisor({ spend, loopState, objective, review, gate }) {
    const findingsEvidence = await spend.registerEvidence({
      kind: 'findings', taskId: loopState.loopId, signature: review.findingSignatures.join('|') || 'none',
    });
    let raw;
    try {
      raw = await meteredWithFailover({
        spend,
        role: 'supervisor',
        routeFn: routeSupervisorFn,
        defaultFamily: 'agy:gemini',
        defaultProvider: 'agy',
        operationId: `${loopState.loopId}:supervise`,
        workflowId: loopState.loopId,
        evidenceIds: [findingsEvidence.evidenceId],
        invoke: ({ selection }) => Promise.resolve(supervisorFn({
          objective, blockingFindings: review.blockingFindings, gate,
          round: loopState.round, priorSignatures: loopState.findingSignatureHistory, selection,
        })).then((out) => ({
          value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
        })),
      });
    } catch (err) {
      if (isAuthorizationFailure(err)) return { denied: true, error: err };
      return { humanRequired: true, reason: `Supervisor call failed: ${err?.message ?? err}` };
    }
    loopState.supervisorCalls += 1;
    loopState.supervisorInvoked = true;
    // B1 — malformed Supervisor output is never treated as valid REWORK guidance.
    if (!raw || raw.malformed === true || typeof raw.guidance !== 'string' || !raw.guidance.trim()) {
      return { humanRequired: true, reason: `Supervisor produced no usable repair guidance${raw?.reason ? ` (${raw.reason})` : ''}` };
    }
    if (String(raw.recommendation).toUpperCase() === 'HUMAN_REQUIRED') {
      return { humanRequired: true, reason: 'Supervisor recommends human involvement', guidance: raw.guidance };
    }
    return { guidance: raw.guidance };
  }

  // ---- PR mode ---------------------------------------------------------
  async function reviewPr({ loopState, signal, onHeartbeat }) {
    const objective = loopState.objective;
    recordTransition(loopState, REVIEW_LOOP_STATES.REVIEWING, 'PR review requested');

    const prCtl = createPrReviewController({
      loopId: loopState.loopId, persistence, prBackend, env, onEvent,
      recordSafetyEvent: collectSafetyEvent, triggerAuthority,
    });

    const result = await prCtl.obtainReview({ objective, loopState, signal, onHeartbeat });

    if (result.outcome === PR_REVIEW_OUTCOMES.PUSH_REQUIRED) {
      await store.save(loopState.loopId, loopState);
      return { status: 'PUSH_REQUIRED', loopId: loopState.loopId, head: result.head, reason: result.reason, telemetry: await durableTelemetry(loopState.loopId), safetyEvents };
    }
    if (result.outcome === PR_REVIEW_OUTCOMES.WAITING_FOR_REVIEW) {
      recordTransition(loopState, REVIEW_LOOP_STATES.WAITING_FOR_REVIEW, 'external review pending');
      loopState.pendingExternalTrigger = loopState.pendingExternalTrigger
        ?? { head: result.head, reviewer: objective.reviewer, status: 'TRIGGERED' };
      await store.save(loopState.loopId, loopState);
      return { status: 'WAITING_FOR_REVIEW', loopId: loopState.loopId, head: result.head, reason: result.reason, telemetry: await durableTelemetry(loopState.loopId), safetyEvents };
    }
    if (result.outcome === PR_REVIEW_OUTCOMES.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, result.reason);
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED', loopId: loopState.loopId, head: result.head ?? null, reason: result.reason,
        blockingFindings: loopState.lastReview?.blockingFindings ?? [], telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
      };
    }

    // REVIEW_READY
    const review = result.review;
    if (review.status === 'FAILED') {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, review.error?.reason ?? 'pr review failed');
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED', loopId: loopState.loopId, head: result.head,
        reason: `trusted PR review was not usable (${review.error?.reason}): ${review.error?.message ?? ''}`,
        telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
      };
    }

    const newHead = result.head !== loopState.lastReviewedPrHead;
    if (newHead) loopState.round += 1;
    loopState.lastReviewedPrHead = result.head;
    loopState.lastReview = review;
    loopState.pendingExternalTrigger = null;

    const spend = spendFor(loopState.loopId);
    await spend.registerEvidence({
      kind: 'external', subject: `pr-${objective.prNumber}`,
      fingerprint: `${result.head}:${review.findingSignatures.join('|')}`,
    });

    const decision = decideConvergence({ loopState, review });
    loopState.findingSignatureHistory = [
      ...(loopState.findingSignatureHistory ?? []),
      { round: loopState.round, signatures: review.findingSignatures },
    ];

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, await spend.telemetry());
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await store.save(loopState.loopId, loopState);
      return humanRequiredResult(loopState, review, await spend.telemetry(), null);
    }

    let supervisorGuidance = null;
    if (decision.invokeSupervisor && !loopState.supervisorInvoked) {
      const sup = await runSupervisor({ spend, loopState, objective, review, gate: null });
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, 'PR non-convergence escalation');
      if (sup.humanRequired) {
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, sup.reason);
        await store.save(loopState.loopId, loopState);
        return humanRequiredResult(loopState, review, await spend.telemetry(), sup.guidance);
      }
      supervisorGuidance = sup.guidance;
      loopState.lastSupervisorGuidance = supervisorGuidance;
    }

    recordTransition(loopState, REVIEW_LOOP_STATES.REWORK, decision.reason);
    await store.save(loopState.loopId, loopState);
    return {
      ...compactReworkPayload({ loopState, review, gate: null, supervisorGuidance }),
      head: result.head,
      reason: `${decision.reason}; push your fix so ReviewLoop can request a review of the new HEAD`,
      telemetry: await spend.telemetry(),
      safetyEvents,
    };
  }

  // ---- result shaping ------------------------------------------------
  function passResult(loopState, review, telemetry) {
    return {
      status: 'PASS', loopId: loopState.loopId, round: loopState.round, reviewer: review.reviewer,
      nonBlockingFindings: review.nonBlockingFindings, nonBlockingOmitted: review.nonBlockingOmitted ?? 0,
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  function humanRequiredResult(loopState, review, telemetry, supervisorGuidance) {
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      blockingFindings: review?.blockingFindings ?? [],
      supervisorGuidance: supervisorGuidance ?? loopState.lastSupervisorGuidance ?? null,
      reason: loopState.history?.slice(-1)[0]?.reason ?? 'review did not converge',
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  // A provider/spend failure that surfaces as HUMAN_REQUIRED MUST also latch the
  // durable loop state to HUMAN_REQUIRED — the returned status and the persisted
  // state can never disagree. (Before this, the caller was told HUMAN_REQUIRED
  // while the loop stayed at REVIEWING on disk.)
  async function spendDenialResult(loopState, err, telemetry) {
    recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, `model spend blocked: ${err?.code ?? err?.message ?? err}`);
    try { await store.save(loopState.loopId, loopState); } catch { /* best effort; the returned status still reflects intent */ }
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      reason: `ReviewLoop model spend blocked: ${err?.message ?? err}`,
      telemetry: telemetry ?? emptyTelemetry(), safetyEvents,
    };
  }
  async function terminalResult(loopState) {
    return {
      status: loopState.state, loopId: loopState.loopId, round: loopState.round,
      reason: 'loop already terminal', lastReview: compactLastReview(loopState),
      telemetry: await durableTelemetry(loopState.loopId), safetyEvents,
    };
  }
  function compactLastReview(loopState) {
    const r = loopState.lastReview;
    if (!r) return null;
    return { status: r.status, blockingFindings: r.blockingFindings, findingSignatures: r.findingSignatures };
  }
  function emptyTelemetry() {
    return { reviewerCalls: 0, supervisorCalls: 0, externalTriggers: 0, workerUsage: 'external / not observable by ReviewLoop' };
  }

  return { begin, review, _store: store, _persistence: persistence };
}
