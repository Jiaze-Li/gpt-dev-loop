// SuperGPT Organic Rework Evidence Recorder.
//
// Passively monitors production Reviewer decisions and task attempt progressions.
// When a real Reviewer emits REWORK with structured required_changes, opens a durable
// evidence record. When the same task retries with a fresh Executor and converges
// to a Reviewer PASS, validates invariants and promotes the record to REWORK_LIVE_VERIFIED = true.
//
// Rules:
// 1. Zero behavior change: purely passive observation, zero model calls, zero prompt alterations.
// 2. Task-scoped tracking: tracks attempts on the same task across reworks.
// 3. Durable persistence: stored in ~/.supergpt/evidence/rework-evidence.jsonl (outside disposable worktrees).
// 4. Fail-closed consistency: only marks LIVE_VERIFIED if call IDs differ, required_changes are non-empty,
//    and attempt sequences strictly converge.

import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const DEFAULT_EVIDENCE_ROOT = path.join(os.homedir(), '.supergpt', 'evidence');
export const DEFAULT_EVIDENCE_FILE = 'rework-evidence.jsonl';

export const REWORK_VERIFICATION_STATUSES = Object.freeze({
  NOT_YET_OBSERVED: 'NOT YET OBSERVED',
  OBSERVED_IN_PROGRESS: 'OBSERVED IN PROGRESS',
  LIVE_VERIFIED: 'LIVE VERIFIED',
});

function sha256(content) {
  if (typeof content !== 'string') return null;
  return createHash('sha256').update(content).digest('hex');
}

export class OrganicReworkRecorder {
  constructor({
    root = DEFAULT_EVIDENCE_ROOT,
    fileName = DEFAULT_EVIDENCE_FILE,
  } = {}) {
    this.root = root;
    this.filePath = path.join(root, fileName);
    this.inFlightSequences = new Map(); // key: `${workflowId}:${taskId}`
  }

  _ensureDirectory() {
    if (!existsSync(this.root)) {
      try {
        mkdirSync(this.root, { recursive: true });
      } catch {
        /* best-effort directory creation */
      }
    }
  }

  _readAllRecords() {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  _appendRecord(record) {
    this._ensureDirectory();
    try {
      const line = JSON.stringify(record) + '\n';
      writeFileSync(this.filePath, line, { flag: 'a', encoding: 'utf8' });
    } catch {
      /* non-blocking passive capture */
    }
  }

  _rewriteAllRecords(records) {
    this._ensureDirectory();
    try {
      const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
      writeFileSync(this.filePath, content, 'utf8');
    } catch {
      /* non-blocking passive capture */
    }
  }

  /**
   * Observe an attempt completion. Called upon Review completion for each task attempt.
   */
  observeAttempt({
    workflowId,
    taskId,
    attempt,
    executorCallId,
    executorModel,
    executorProvider = 'claude',
    processId = null,
    gateResult,
    reviewerDecision,
    reviewerCallId,
    reviewerModel = null,
    reviewerProvider = 'agy',
    requiredChanges = [],
    evidence = null,
    round = null,
    nonConvergence = false,
  }) {
    if (!workflowId || !taskId || !attempt) return;

    const key = `${workflowId}:${taskId}`;

    // Stale-sequence isolation: an in-flight REWORK sequence for this
    // (workflow, task) that belongs to an earlier round has been superseded —
    // e.g. the task was re-run under a fresh plan/round. A new initial REWORK
    // on a strictly newer round retires the stale sequence instead of being
    // dropped or appended to it.
    const priorInFlight = this.inFlightSequences.get(key);
    if (
      priorInFlight
      && Number.isFinite(round)
      && Number.isFinite(priorInFlight.round)
      && round > priorInFlight.round
      && reviewerDecision === 'REWORK'
    ) {
      priorInFlight.supersededAt = new Date().toISOString();
      priorInFlight.superseded = true;
      const records = this._readAllRecords();
      const i = records.findIndex((r) => r.workflowId === workflowId && r.taskId === taskId && !r.reworkLiveVerified);
      if (i >= 0) { records[i] = priorInFlight; this._rewriteAllRecords(records); }
      this.inFlightSequences.delete(key);
    }
    const normalizedChanges = Array.isArray(requiredChanges)
      ? requiredChanges.filter((c) => typeof c === 'string' && c.trim() !== '' && c !== 'none')
      : typeof requiredChanges === 'string' && requiredChanges.trim() !== '' && requiredChanges !== 'none'
      ? [requiredChanges]
      : [];

    const evidenceHash = evidence?.diff ? sha256(evidence.diff) : null;

    // Case A: Initial REWORK observed on this task
    if (reviewerDecision === 'REWORK' && normalizedChanges.length > 0 && !this.inFlightSequences.has(key)) {
      const initialRecord = {
        schema: 'supergpt.rework-evidence/v1',
        workflowId,
        taskId,
        round: Number.isFinite(round) ? round : null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reworkLiveVerified: false,
        initialAttempt: {
          attempt,
          executorProvider,
          executorModel,
          executorCallId: executorCallId ?? null,
          processId,
          gateResult: gateResult ?? 'PASS',
          reviewerProvider,
          reviewerModel,
          reviewerCallId: reviewerCallId ?? null,
          reviewerDecision: 'REWORK',
          requiredChanges: normalizedChanges,
          evidenceHash,
        },
        retryAttempts: [],
        convergence: null,
      };

      this.inFlightSequences.set(key, initialRecord);
      this._appendRecord(initialRecord);
      return;
    }

    // Case B: Subsequent attempt on an in-flight REWORK sequence for the same task
    const inFlight = this.inFlightSequences.get(key);
    if (!inFlight) return;

    // Record this retry attempt
    const retryRecord = {
      attempt,
      executorProvider,
      executorModel,
      executorCallId: executorCallId ?? null,
      processId,
      gateResult,
      reviewerProvider,
      reviewerModel,
      reviewerCallId: reviewerCallId ?? null,
      reviewerDecision,
      requiredChanges: normalizedChanges,
      evidenceHash,
      nonConvergence: Boolean(nonConvergence),
    };

    inFlight.retryAttempts.push(retryRecord);
    inFlight.updatedAt = new Date().toISOString();

    // OUT_OF_SCOPE is a deterministic terminal for the task, not a convergence:
    // the sequence closes without ever being promoted to LIVE_VERIFIED.
    if (reviewerDecision === 'OUT_OF_SCOPE') {
      inFlight.closedOutOfScope = true;
      inFlight.closedAt = new Date().toISOString();
      const all = this._readAllRecords();
      const i = all.findIndex((r) => r.workflowId === workflowId && r.taskId === taskId && !r.reworkLiveVerified && !r.superseded);
      if (i >= 0) { all[i] = inFlight; this._rewriteAllRecords(all); }
      this.inFlightSequences.delete(key);
      return;
    }

    // Check for valid convergence:
    // 1. Prior attempt was REWORK with structured required_changes
    // 2. Current attempt Gate is PASS
    // 3. Current attempt Reviewer is PASS
    // 4. Current Executor callId differs from initial Executor callId
    // 5. Current Reviewer callId differs from initial Reviewer callId
    // 6. No non-convergence flag
    const isDistinctExecutor = retryRecord.executorCallId && retryRecord.executorCallId !== inFlight.initialAttempt.executorCallId;
    const isDistinctReviewer = retryRecord.reviewerCallId && retryRecord.reviewerCallId !== inFlight.initialAttempt.reviewerCallId;
    const isGatePass = gateResult === 'PASS';
    const isReviewerPass = reviewerDecision === 'PASS';
    const isConverged = isDistinctExecutor && isDistinctReviewer && isGatePass && isReviewerPass && !nonConvergence;

    if (isConverged) {
      inFlight.reworkLiveVerified = true;
      inFlight.convergence = {
        convergedAt: new Date().toISOString(),
        finalAttempt: attempt,
        executorCallId: retryRecord.executorCallId,
        reviewerCallId: retryRecord.reviewerCallId,
      };
    }

    // Sync back to storage — target this sequence's own record, never a
    // superseded or already-verified one for the same (workflow, task).
    const allRecords = this._readAllRecords();
    let idx = allRecords.findIndex(
      (r) => r.workflowId === workflowId && r.taskId === taskId
        && !r.superseded && !r.reworkLiveVerified
        && (!Number.isFinite(inFlight.round) || !Number.isFinite(r.round) || r.round === inFlight.round)
    );
    if (idx < 0) idx = allRecords.findIndex((r) => r.workflowId === workflowId && r.taskId === taskId && !r.superseded);
    if (idx >= 0) {
      allRecords[idx] = inFlight;
      this._rewriteAllRecords(allRecords);
    } else {
      this._appendRecord(inFlight);
    }

    if (inFlight.reworkLiveVerified) {
      this.inFlightSequences.delete(key);
    }
  }

  /**
   * Returns verification status summary locally with zero model tokens.
   */
  getVerificationStatus() {
    const all = this._readAllRecords();
    const verified = all.find((r) => r.reworkLiveVerified === true);
    if (verified) {
      return {
        status: REWORK_VERIFICATION_STATUSES.LIVE_VERIFIED,
        verifiedRecord: {
          workflowId: verified.workflowId,
          taskId: verified.taskId,
          timestamp: verified.convergence?.convergedAt ?? verified.updatedAt,
          initialAttempt: verified.initialAttempt,
          convergence: verified.convergence,
        },
      };
    }

    const inProgress = all.find(
      (r) => !r.reworkLiveVerified && r.initialAttempt && !r.superseded && !r.closedOutOfScope
    );
    if (inProgress) {
      return {
        status: REWORK_VERIFICATION_STATUSES.OBSERVED_IN_PROGRESS,
        inProgressRecord: {
          workflowId: inProgress.workflowId,
          taskId: inProgress.taskId,
          startedAt: inProgress.startedAt,
        },
      };
    }

    return {
      status: REWORK_VERIFICATION_STATUSES.NOT_YET_OBSERVED,
      verifiedRecord: null,
    };
  }
}

export const defaultOrganicReworkRecorder = new OrganicReworkRecorder();
