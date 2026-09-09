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
  baselineGateEvidenceIdentity,
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
import { reviewerLoginAllowlist } from './prTrust.js';
import {
  registerManagedThreads,
  clearedPriorThreads,
  unresolvedClearedThreads,
  applyResolutionResult,
  scopeCheckThread,
} from './threadResolution.js';
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
  // Re-collect the Worker delta AFTER the review-time Gate (a snapshot / codegen
  // / format check can mutate tracked files). Defaults to the real collector
  // only when the delta collector itself is the real one — an injected test
  // fake is a fixed script that cannot observe Gate mutation, so re-invoking it
  // there would only drift the harness. Pass explicitly to exercise this path.
  collectPostGateDeltaFn = null,
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
    constraints = [], signal = null,
  } = {}) {
    if (!goal || !String(goal).trim()) throw new Error('reviewloop_begin: goal is required');
    if (!cwd) throw new Error('reviewloop_begin: cwd is required');
    if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the baseline was captured');
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
      if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller before the baseline Gate ran');
      let baselineGateRan = false;
      try {
        if (verificationPlan.source !== 'mechanical' && verificationPlan.commands.length) {
          const g = await runGateFn({
            cwd, commands: verificationPlan.commands, runner: gateRunner, env, signal,
          });
          baselineGateRan = true;
          baselineGate = {
            evidence: g.evidence ?? { results: g.results ?? [], pass: g.pass },
            pass: g.pass,
            capturedAt: new Date().toISOString(),
            source: verificationPlan.source,
          };
        }
      } catch (err) {
        // A caller cancellation is NOT "incomplete Gate coverage" — it aborts
        // reviewloop_begin so no loop is registered for an abandoned request.
        if (signal?.aborted) {
          throw new Error(`reviewloop_begin: cancelled by the caller during the baseline Gate (${String(err?.message ?? err)})`);
        }
        baselineGate = { coverage: 'INCOMPLETE', reason: String(err?.message ?? err) };
      }
      if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller after the baseline Gate ran');
      // The baseline Gate may itself mutate tracked files (a snapshot test, a
      // codegen/format check). Re-capture the baseline AFTER it runs so those
      // Gate-caused edits are part of the baseline and are never later
      // attributed to the Worker's delta. If this recapture FAILS we must NOT
      // fall back to the pre-Gate baseline — that reintroduces the exact
      // misattribution the recapture prevents. Abort reviewloop_begin instead.
      if (baselineGateRan) {
        try {
          baseline = await captureBaselineFn({ cwd });
        } catch (err) {
          throw new Error(
            `reviewloop_begin: the baseline Gate ran but the post-Gate baseline could not be re-captured (${err?.message ?? err}); `
            + 'refusing to start a loop whose baseline would misattribute the Gate\'s own edits to the Worker',
          );
        }
      }
    } else {
      if (!prBackend) throw new Error('reviewloop_begin: PR mode requires a PR backend');
      if (signal?.aborted) throw new Error('reviewloop_begin: cancelled by the caller');
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
      baselineGateEvidence: baselineGate,
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

    // One user instruction buys ONE ReviewLoop execution budget (default 3
    // review rounds). When the CONVERGENCE POLICY gives up — 3 rounds spent,
    // findings still blocking — the loop is DONE: `budgetExhausted` is set and a
    // further reviewloop_review returns the terminal result, never re-enters.
    // Only a new user message (a brand-new reviewloop_begin) starts a fresh
    // budget. A HUMAN_REQUIRED from a transient failure (a chunk-review crash, a
    // provider blip) is NOT budget-exhausted and stays resumable.
    if (isTerminal(loopState.state)
      && (loopState.state !== REVIEW_LOOP_STATES.HUMAN_REQUIRED || loopState.budgetExhausted)) {
      return terminalResult(loopState);
    }

    if (objective.mode === REVIEW_MODES.PR) return reviewPr({ loopState, signal, onHeartbeat });
    return reviewLocal({ loopState, signal });
  }

  // ---- Reviewer over full attributed evidence (bounded or chunked) --------
  async function runReviewerOverEvidence({
    spend, loopState, objective, delta, gate, signal,
  }) {
    // Round is bound to the LOGICAL review state (delta + gate fingerprint),
    // NOT to how many times reviewloop_review was invoked. A crash/resume that
    // re-enters with the SAME logical review state — its durable per-chunk
    // checkpoint is still on record — reuses the round it already assigned and
    // never consumes another of the objective's max review rounds.
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

    // The checkpoint identity MUST cover the actual chunk layout, not just the
    // (delta + gate) fingerprints. `chunkDiffForReview` depends on
    // REVIEWLOOP_MAX_REVIEW_DIFF_CHARS; a crash/resume under a larger value
    // re-chunks the same diff into different boundaries. Without the layout in
    // the key, the stored result for old chunk 0 would be reused for the new,
    // larger chunk 0 and its added portion never reviewed — yet aggregation
    // could still return CLEAN/PASS. Any layout change now yields a new key, a
    // fresh checkpoint, and a full re-review.
    const chunkLayoutHash = sha256Hex(`${chunks.length}::${chunks.map((c) => c.hash).join('::')}`);
    const checkpointKey = sha256Hex(`${delta.fingerprint}::${gate.fingerprint}::${chunkLayoutHash}`);
    const resumeCheckpoint = loopState.chunkReviewCheckpoint;
    if (resumeCheckpoint && resumeCheckpoint.key === checkpointKey
      && resumeCheckpoint.chunkTotal === chunks.length
      && Number.isInteger(resumeCheckpoint.round)) {
      loopState.round = resumeCheckpoint.round;
    } else {
      loopState.round += 1;
    }

    // Durable per-chunk checkpoint. Keyed to the exact review state (delta +
    // gate); a changed diff invalidates it. On resume, a chunk already in the
    // checkpoint is NOT re-sent to the model — its normalized result is reused.
    // It also carries the round this logical review state was assigned so a
    // resume never re-increments it.
    let checkpoint = loopState.chunkReviewCheckpoint;
    if (!checkpoint || checkpoint.key !== checkpointKey || checkpoint.chunkTotal !== chunks.length) {
      checkpoint = {
        key: checkpointKey, chunkTotal: chunks.length, chunks: {}, round: loopState.round,
      };
      loopState.chunkReviewCheckpoint = checkpoint;
    } else if (!Number.isInteger(checkpoint.round)) {
      checkpoint.round = loopState.round;
    }

    const perChunk = [];
    for (const chunk of chunks) {
      if (signal?.aborted) {
        // The MCP client cancelled the review. Do NOT start another paid model
        // dispatch — fail the review closed (never CLEAN/PASS on a cancel).
        return {
          review: {
            status: 'FAILED', reviewer: 'internal', provider: 'internal',
            blockingFindings: [], nonBlockingFindings: [], nonBlockingOmitted: 0,
            findingSignatures: [], error: { reason: 'REVIEW_CANCELLED', message: 'the review was cancelled by the caller' },
          },
          chunkCount: chunks.length,
        };
      }
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
          signal,
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
  async function reviewLocal({ loopState, signal }) {
    const objective = loopState.objective;
    const cwd = objective.repository?.root;
    const baseline = objective.baseline;

    let delta = await collectWorkerDeltaFn({ cwd, baseline });

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
    // The baseline Gate evidence can downgrade a review-time FAIL to WARN by
    // treating shared failures as pre-existing. It lives in workflow.json,
    // OUTSIDE the tamper-checked objective — so a state editor could inject the
    // CURRENT failures into it and mask a real regression. Use it ONLY when its
    // identity still matches the objective-bound fingerprint captured at begin;
    // otherwise ignore it (no suppression → a real regression stays FAIL).
    let trustedBaselineGateEvidence = null;
    const persistedBaselineGate = loopState.baselineGateEvidence ?? null;
    if (persistedBaselineGate?.evidence) {
      const boundIdentity = objective.baselineGateEvidence ?? null;
      const currentIdentity = baselineGateEvidenceIdentity(persistedBaselineGate);
      if (boundIdentity && JSON.stringify(boundIdentity) === JSON.stringify(currentIdentity)) {
        trustedBaselineGateEvidence = persistedBaselineGate.evidence;
      } else {
        collectSafetyEvent({
          code: 'REVIEWLOOP_BASELINE_GATE_EVIDENCE_UNVERIFIED',
          severity: 'NON_BLOCKING',
          role: 'gate',
          taskId: loopState.loopId,
          reason: boundIdentity
            ? 'baseline Gate evidence no longer matches the objective-bound identity captured at reviewloop_begin'
            : 'objective carries no baseline Gate evidence binding (legacy loop)',
          actionTaken: 'ignoring baseline Gate evidence for FAIL->WARN suppression this review',
        });
      }
    }
    const gate = await runGateFn({
      cwd, commands: gateCommands, runner: gateRunner, env, signal,
      baselineGateEvidence: trustedBaselineGateEvidence,
    });
    gate.commandSource = commandSource;

    // The review-time Gate may itself have mutated tracked files. The delta was
    // collected BEFORE it ran, so re-collect now — otherwise the Reviewer sees
    // pre-Gate evidence and the NO_PROGRESS fingerprint no longer matches the
    // tree. (begin-time recapture already covers the baseline Gate; this is the
    // review path.)
    const postGateFn = collectPostGateDeltaFn
      ?? (collectWorkerDeltaFn === collectWorkerDelta ? collectWorkerDelta : null);
    if (postGateFn && !signal?.aborted && gate.verdict !== GATE_VERDICTS.FAIL) {
      let postDelta = null;
      let postGateError = null;
      try { postDelta = await postGateFn({ cwd, baseline }); }
      catch (err) { postGateError = err; postDelta = null; }

      // Fail closed on EVERY post-Gate evidence failure — a throw, a missing
      // result, a missing fingerprint, or incomplete attribution — before
      // comparing fingerprints. The fingerprint excludes completeness metadata,
      // so a Gate that creates an untracked file while this recollection fails
      // would otherwise send stale pre-Gate evidence to the Reviewer and reach
      // PASS without that file being reviewed.
      if (!postDelta || !postDelta.fingerprint || postDelta.evidenceComplete === false) {
        const why = postGateError
          ? [`post-Gate delta collection threw: ${postGateError?.message ?? postGateError}`]
          : !postDelta
            ? ['post-Gate delta collection returned no result']
            : !postDelta.fingerprint
              ? ['post-Gate delta collection returned no fingerprint']
              : (postDelta.incompleteReasons ?? ['post-Gate Worker delta could not be attributed']);
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'post-Gate attribution incomplete');
        await store.save(loopState.loopId, loopState);
        return {
          status: 'HUMAN_REQUIRED',
          loopId: loopState.loopId,
          round: loopState.round,
          reason: `the deterministic Gate ran and the post-Gate Worker delta could not be re-collected safely: ${why.join('; ')}`,
          telemetry: await durableTelemetry(loopState.loopId),
          safetyEvents,
        };
      }
      if (postDelta.fingerprint !== delta.fingerprint) {
        collectSafetyEvent({
          code: 'GATE_MUTATED_TRACKED_FILES',
          severity: 'NON_BLOCKING',
          role: 'gate',
          taskId: loopState.loopId,
          reason: 'the review-time Gate modified tracked files; re-collected the Worker delta over the post-Gate tree',
          actionTaken: 'review proceeds over post-Gate evidence',
        });
        delta = postDelta;

        // A mutating Gate (formatter, snapshot writer, …) may have reverted the
        // Worker's only changes back to the captured baseline. Re-run the
        // no-change guard over the adopted post-Gate delta — otherwise the
        // Reviewer is called with an empty diff and a clean response PASSes,
        // certifying work that no longer exists in the tree.
        if (delta.noWorkerChangeYet) {
          await store.save(loopState.loopId, loopState);
          return {
            status: 'NO_PROGRESS',
            loopId: loopState.loopId,
            round: loopState.round,
            reason: 'the deterministic Gate reverted the Worker delta back to the reviewloop_begin baseline; '
              + 'no Worker change remains to review',
            telemetry: await durableTelemetry(loopState.loopId),
            safetyEvents,
          };
        }
      }
    }

    if (signal?.aborted) {
      // Cancelled during the Gate — never proceed to a paid Reviewer dispatch.
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'review cancelled by caller');
      await store.save(loopState.loopId, loopState);
      return {
        status: 'HUMAN_REQUIRED',
        loopId: loopState.loopId,
        round: loopState.round,
        reason: 'the review was cancelled by the caller before the Reviewer ran',
        telemetry: await durableTelemetry(loopState.loopId),
        safetyEvents,
      };
    }

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
      reviewOut = await runReviewerOverEvidence({
        spend, loopState, objective, delta, gate, signal,
      });
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
      const sup = await runSupervisor({
        spend, loopState, objective, review, gate, signal,
      });
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      const outcome = await applySupervisorOutcome({
        sup, loopState, review, spend, escalationReason: 'non-convergence escalation',
      });
      if (outcome.result) return outcome.result;
      supervisorGuidance = outcome.guidance;
    }

    if (decision.verdict === REVIEW_VERDICTS.PASS) {
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, await spend.telemetry());
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      loopState.budgetExhausted = true; // 3 rounds spent, still blocking — terminal
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
  async function runSupervisor({
    spend, loopState, objective, review, gate, signal,
  }) {
    if (signal?.aborted) {
      return { humanRequired: true, reason: 'the review was cancelled by the caller before the Supervisor ran' };
    }
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
          round: loopState.round, priorSignatures: loopState.findingSignatureHistory, selection, signal,
        })).then((out) => ({
          value: out?.value ?? out, usage: out?.usage ?? null, model: out?.model ?? null, costUsd: out?.costUsd, meta: out?.meta ?? null,
        })),
      });
    } catch (err) {
      // A spend/authorization denial (SPEND_DENIED, MODEL_SPEND_USAGE_UNRESOLVED
      // — a call was dispatched but its usage could not be settled, UNKNOWN !=
      // ZERO) is a deliberate fail-closed stop, NOT a degradable transient: it
      // returns `denied` and the caller surfaces it as-is. Any other error
      // (provider pool exhausted with settled accounting, non-auth non-retryable
      // failure) is a degradable transient.
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
      // The Supervisor actually adjudicated the loop non-convergent. Only this
      // path is terminal — a cancellation, transport throw, or malformed
      // response above returns `humanRequired` WITHOUT `terminal`, so the round
      // stays resumable.
      return { humanRequired: true, terminal: true, reason: 'Supervisor recommends human involvement', guidance: raw.guidance };
    }
    return { guidance: raw.guidance };
  }

  // Apply a Supervisor result to the loop. Returns:
  //   { result }   — ready to return from the caller (terminal HUMAN_REQUIRED)
  //   { guidance } — continue the in-line REWORK path with this guidance
  // A `terminal` "Supervisor recommends human involvement" spends the budget. A
  // degradable TRANSIENT failure (`humanRequired` WITHOUT `terminal`: caller
  // cancelled before dispatch, provider pool exhausted with settled accounting,
  // output unusable but the call settled) does NOT stall the loop: it degrades
  // to a plain REWORK round (guidance: null). The Worker still has the finding,
  // the round cap is still the stagnation circuit-breaker, and a later
  // persistent-finding round can retry the Supervisor (supervisorInvoked reset).
  // NOTE: a dispatched call whose usage cannot be settled
  // (MODEL_SPEND_USAGE_UNRESOLVED) never reaches here — runSupervisor returns
  // `denied` and the caller fails closed, by design (UNKNOWN != ZERO).
  async function applySupervisorOutcome({
    sup, loopState, review, spend, escalationReason,
  }) {
    if (sup.humanRequired && sup.terminal) {
      loopState.budgetExhausted = true;
      recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, sup.reason);
      await store.save(loopState.loopId, loopState);
      return { result: humanRequiredResult(loopState, review, await spend.telemetry(), sup.guidance) };
    }
    if (sup.humanRequired) {
      loopState.supervisorInvoked = false; // transient — let a later round retry
      collectSafetyEvent({
        code: 'REVIEWLOOP_SUPERVISOR_UNAVAILABLE', severity: 'NON_BLOCKING', role: 'supervisor',
        taskId: loopState.loopId, reason: sup.reason,
        actionTaken: 'Supervisor guidance skipped; proceeding as a plain REWORK round',
      });
      return { guidance: null };
    }
    recordTransition(loopState, REVIEW_LOOP_STATES.SUPERVISING, escalationReason);
    loopState.lastSupervisorGuidance = sup.guidance;
    return { guidance: sup.guidance };
  }

  // Resolve the GitHub review threads for prior-round findings that a trusted
  // review bound to the exact newer HEAD has independently cleared. Mutates the
  // managed-thread records in place. `targets` overrides the default
  // (OPEN prior-head threads cleared by `review`) — used for the PASS retry.
  async function reconcileReviewThreads({
    loopState, objective, review, head, targets = null,
  }) {
    if (!prBackend || typeof prBackend.resolveReviewThread !== 'function') return;
    const cleared = targets
      ?? clearedPriorThreads({ managedThreads: loopState.managedThreads, review, head });
    if (cleared.length === 0) return;

    let liveThreads = null;
    if (typeof prBackend.listReviewThreads === 'function') {
      try {
        liveThreads = await prBackend.listReviewThreads({ prNumber: objective.prNumber });
      } catch { liveThreads = null; }
    }
    const allowlist = reviewerLoginAllowlist(objective.reviewer, env) ?? [];
    const verificationReviewId = review.reviewId ?? review.review_id ?? null;

    for (const mt of cleared) {
      const scope = scopeCheckThread(mt, liveThreads, { allowlist });
      if (!scope.ok) {
        applyResolutionResult(mt, { success: false, error: `scope check failed: ${scope.reason}` });
        collectSafetyEvent({
          code: 'REVIEWLOOP_THREAD_RESOLVE_SKIPPED', severity: 'NON_BLOCKING', role: 'pr-review',
          taskId: loopState.loopId, reason: `${mt.threadNodeId}: ${scope.reason}`,
          actionTaken: 'thread left unresolved',
        });
        continue;
      }
      if (scope.alreadyResolved) {
        applyResolutionResult(mt, { success: true, head, verificationReviewId });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await prBackend.resolveReviewThread({
          prNumber: objective.prNumber, threadNodeId: mt.threadNodeId,
          reviewer: objective.reviewer, headSha: head,
        });
        applyResolutionResult(mt, { success: true, head, verificationReviewId });
        collectSafetyEvent({
          code: 'REVIEWLOOP_THREAD_RESOLVED', severity: 'NON_BLOCKING', role: 'pr-review',
          taskId: loopState.loopId,
          reason: `resolved cleared finding ${mt.signature} (thread ${mt.threadNodeId}) on ${head}`,
          actionTaken: 'GitHub review thread resolved',
        });
      } catch (err) {
        applyResolutionResult(mt, { success: false, error: err?.message ?? err });
        collectSafetyEvent({
          code: 'REVIEWLOOP_THREAD_RESOLVE_FAILED', severity: 'BLOCKING', role: 'pr-review',
          taskId: loopState.loopId, reason: `${mt.threadNodeId}: ${err?.message ?? err}`,
          actionTaken: 'thread left unresolved; PASS withheld',
        });
      }
    }
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

    const priorReviewedHead = loopState.lastReviewedPrHead;
    const newHead = result.head !== priorReviewedHead;
    if (newHead) loopState.round += 1;
    loopState.lastReviewedPrHead = result.head;
    loopState.lastReview = review;
    loopState.pendingExternalTrigger = null;

    // Review-thread reconciliation. Only a trusted review bound to the EXACT
    // newer HEAD (this `review`) can clear a prior-round thread; a recurring
    // finding keeps its prior thread open. A REWORK round may therefore resolve
    // old findings while introducing new open ones.
    loopState.managedThreads = Array.isArray(loopState.managedThreads) ? loopState.managedThreads : [];
    if (newHead && priorReviewedHead) {
      await reconcileReviewThreads({ loopState, objective, review, head: result.head });
    }
    loopState.managedThreads = registerManagedThreads({
      managedThreads: loopState.managedThreads, review, head: result.head,
      reviewer: objective.reviewer, round: loopState.round,
    });

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
      // Every ReviewLoop-managed blocking thread that has been independently
      // cleared MUST be resolved before PASS. A GitHub resolution failure is an
      // infrastructure/retry condition — never a silent PASS.
      let stuck = unresolvedClearedThreads({ managedThreads: loopState.managedThreads, review, head: result.head });
      if (stuck.length) {
        await reconcileReviewThreads({ loopState, objective, review, head: result.head, targets: stuck });
        stuck = unresolvedClearedThreads({ managedThreads: loopState.managedThreads, review, head: result.head });
      }
      if (stuck.length) {
        recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, 'ReviewLoop-managed review threads could not be resolved');
        await store.save(loopState.loopId, loopState);
        return {
          status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
          head: result.head, blockingFindings: [],
          reason: `PASS withheld: ${stuck.length} ReviewLoop-managed review thread(s) were independently cleared but could not be resolved on GitHub (${stuck.map((s) => s.threadNodeId).join(', ')}). This is an infrastructure/retry condition — retry reviewloop_review once GitHub is reachable, or resolve the threads manually.`,
          telemetry: await spend.telemetry(), safetyEvents,
        };
      }
      recordTransition(loopState, REVIEW_LOOP_STATES.PASS, decision.reason);
      await store.save(loopState.loopId, loopState);
      return passResult(loopState, review, await spend.telemetry());
    }
    if (decision.verdict === REVIEW_VERDICTS.HUMAN_REQUIRED) {
      loopState.budgetExhausted = true; // 3 rounds spent, still blocking — terminal
      recordTransition(loopState, REVIEW_LOOP_STATES.HUMAN_REQUIRED, decision.reason);
      await store.save(loopState.loopId, loopState);
      return humanRequiredResult(loopState, review, await spend.telemetry(), null);
    }

    let supervisorGuidance = null;
    if (decision.invokeSupervisor && !loopState.supervisorInvoked) {
      const sup = await runSupervisor({
        spend, loopState, objective, review, gate: null, signal,
      });
      if (sup.denied) return spendDenialResult(loopState, sup.error, await spend.telemetry());
      const outcome = await applySupervisorOutcome({
        sup, loopState, review, spend, escalationReason: 'PR non-convergence escalation',
      });
      if (outcome.result) return outcome.result;
      supervisorGuidance = outcome.guidance;
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
    const budgetExhausted = loopState.budgetExhausted === true;
    return {
      status: 'HUMAN_REQUIRED', loopId: loopState.loopId, round: loopState.round,
      // This HUMAN_REQUIRED is TERMINAL — the loop's review-round budget is
      // spent. The Worker must report to the user and stop: not another
      // reviewloop_review on this loop, not a fresh reviewloop_begin in the
      // same task. A new user instruction starts a new task and a new budget.
      terminal: budgetExhausted || undefined,
      budgetExhausted: budgetExhausted || undefined,
      blockingFindings: review?.blockingFindings ?? [],
      supervisorGuidance: supervisorGuidance ?? loopState.lastSupervisorGuidance ?? null,
      reason: (loopState.history?.slice(-1)[0]?.reason ?? 'review did not converge')
        + (budgetExhausted ? ' — this ReviewLoop budget is spent; report to the user and stop, do not start another loop for this task' : ''),
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
    const budgetExhausted = loopState.state === REVIEW_LOOP_STATES.HUMAN_REQUIRED
      && loopState.budgetExhausted === true;
    return {
      status: loopState.state, loopId: loopState.loopId, round: loopState.round,
      terminal: true,
      budgetExhausted: budgetExhausted || undefined,
      reason: budgetExhausted
        ? 'this loop already reached HUMAN_REQUIRED — its review-round budget is spent. Report to the '
          + 'user and stop; do NOT reviewloop_begin again in this task. A new user instruction starts a fresh loop.'
        : 'loop already terminal',
      lastReview: compactLastReview(loopState),
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
