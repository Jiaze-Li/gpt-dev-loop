// Timeline derivation module for SuperGPT Local Dashboard.
//
// Converts raw canonical workflow state, task attempts, and historical events
// into a clean chronological list of safe, sanitized status milestone events.
// Consumes ZERO model tokens and exposes NO secrets or raw shell dumps.

import { projectReviewThreads } from './meta.js';

function formatTimestamp(isoString) {
  if (!isoString) return '--:--:--';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toTimeString().split(' ')[0];
  } catch {
    return '--:--:--';
  }
}

const EVENT_ORDER = {
  START: 10,
  PLANNER: 20,
  ACCEPTANCE_AMENDED: 25,
  TASK_START: 30,
  RETRY: 35,
  EXECUTOR_DONE: 40,
  GATE_PASS: 50,
  GATE_FAIL: 50,
  REVIEWER_PASS: 60,
  REVIEWER_REWORK: 60,
  REWORK: 65,
  ESCALATION: 70,
  CONTROLLED_ACCEPTANCE: 75,
  TERMINAL_DONE: 80,
  TERMINAL_HUMAN_REQUIRED: 80,
  TERMINAL_FAILED: 80,
  TERMINAL_TIMEOUT: 80,
  TERMINAL_STOPPED: 80,
};

export function deriveWorkflowTimeline(rawState) {
  if (!rawState || typeof rawState !== 'object') return [];

  const rawEvents = [];
  const startIso = rawState.startedAt || null;

  const reviewThreads = projectReviewThreads(rawState);
  if (reviewThreads.findings.length > 0) {
    rawEvents.push({
      iso: rawState.lastProgressAt || startIso,
      type: 'REVIEW_THREADS',
      label: `Review Threads: Open ${reviewThreads.open}, Resolved ${reviewThreads.resolved}, Resolution Failed ${reviewThreads.resolutionFailed}`,
      detail: reviewThreads.findings.map((finding) =>
        `${finding.lifecycle} ${finding.severity || ''} ${finding.file || finding.title}`.replace(/\s+/g, ' ').trim()).join('; '),
    });
  }

  // 1. Workflow Start
  if (startIso) {
    rawEvents.push({
      iso: startIso,
      type: 'START',
      label: 'Workflow started',
      detail: rawState.workflowPath ? `Path: ${rawState.workflowPath}` : null,
    });
  }

  // Acceptance version-chain audit trail: every AMEND/SUPERSEDE beyond the
  // initial version 1 surfaces as a sanitized milestone carrying the reason and
  // the approving authority.
  const acceptanceChain = rawState.acceptanceChain;
  if (acceptanceChain && Array.isArray(acceptanceChain.versions)) {
    for (const v of acceptanceChain.versions) {
      if (!v || v.version === 1) continue;
      rawEvents.push({
        iso: v.approvedAt || rawState.lastProgressAt || startIso,
        type: 'ACCEPTANCE_AMENDED',
        label: `Acceptance ${v.command} → v${v.version} (active v${acceptanceChain.activeVersion})`,
        detail: `${v.reason || 'no reason recorded'} [approved by ${v.approvedBy || 'unknown'}]`,
      });
    }
  }

  // Controlled Host Acceptance: the auditable milestone where passing host
  // verification evidence — bound to the worktree fingerprint and the approved
  // acceptance version — supersedes local acceptance for delivery.
  const controlled = rawState.controlledAcceptance;
  if (controlled && controlled.status) {
    const fingerprint = controlled.worktreeFingerprint ? String(controlled.worktreeFingerprint).slice(0, 12) : 'unknown';
    rawEvents.push({
      iso: controlled.approvedAt || rawState.lastProgressAt || startIso,
      type: 'CONTROLLED_ACCEPTANCE',
      label: `${controlled.status} (acceptance v${controlled.acceptanceVersion ?? '?'})`,
      detail: `Gate ${controlled.gate?.decision ?? 'unknown'}, Reviewer ${controlled.reviewer?.decision ?? 'unknown'}, worktree ${fingerprint} [approved by ${controlled.approvedBy || 'unknown'}]`,
    });
  }

  const stageHistory = Array.isArray(rawState.stageHistory) ? rawState.stageHistory : [];

  if (stageHistory.length > 0) {
    // 2A. Real Stage History Available
    let planningEntry = null;

    for (let i = 0; i < stageHistory.length; i++) {
      const entry = stageHistory[i];
      const stage = entry.stage;
      const iso = entry.startedAt;
      const taskId = entry.taskId || rawState.taskId || 'current';
      const attempt = entry.attempt || rawState.attempt || 1;

      if (stage === 'PLANNING') {
        planningEntry = entry;
      } else if (planningEntry) {
        // Planner completed at the moment the next stage started
        rawEvents.push({
          iso: iso,
          type: 'PLANNER',
          label: 'Planner completed',
          detail: rawState.taskTotal ? `${rawState.taskTotal} task(s) planned` : null,
        });
        planningEntry = null;
      }

      if (stage === 'EXECUTOR') {
        rawEvents.push({
          iso: iso,
          type: attempt === 1 ? 'TASK_START' : 'RETRY',
          label: attempt === 1 ? `Task started: ${taskId}` : `Attempt ${attempt} started: ${taskId}`,
          detail: null,
        });
      } else if (stage === 'GATE') {
        rawEvents.push({
          iso: iso,
          type: 'EXECUTOR_DONE',
          label: `Executor completed: ${taskId} (attempt ${attempt})`,
          detail: null,
        });
      } else if (stage === 'SUPERVISOR' && (rawState.modelEscalated || rawState.escalationActive)) {
        rawEvents.push({
          iso: iso,
          type: 'ESCALATION',
          label: 'Supervisor escalation started',
          detail: rawState.escalationReason || 'Normal attempts exhausted',
        });
      }
    }

    if (planningEntry && (rawState.stageStatuses?.planner === 'done' || rawState.taskTotal || ['DONE', 'HUMAN_REQUIRED', 'FAILED'].includes(rawState.workflowStatus))) {
      rawEvents.push({
        iso: rawState.lastProgressAt || planningEntry.startedAt || startIso,
        type: 'PLANNER',
        label: 'Planner completed',
        detail: rawState.taskTotal ? `${rawState.taskTotal} task(s) planned` : null,
      });
      planningEntry = null;
    } else if (!stageHistory.some((s) => s.stage === 'PLANNING') && (rawState.stageStatuses?.planner === 'done' || (rawState.taskTotal && rawState.workflowPath !== 'FAST'))) {
      rawEvents.push({
        iso: startIso,
        type: 'PLANNER',
        label: 'Planner completed',
        detail: rawState.taskTotal ? `${rawState.taskTotal} task(s) planned` : null,
      });
    }

    // 2B. Task Attempts Verification & Review Results
    const attempts = Array.isArray(rawState.taskAttempts) ? rawState.taskAttempts : [];
    for (const att of attempts) {
      const taskId = att.taskId || 'task';
      const attempt = att.attempt || 1;
      const resultIso = att.updatedAt || att.createdAt || rawState.lastProgressAt || startIso;

      if (att.gateResult) {
        rawEvents.push({
          iso: resultIso,
          type: att.gateResult === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL',
          label: `Gate ${att.gateResult}: ${taskId} (attempt ${attempt})`,
          detail: null,
        });

        if (att.gateResult === 'FAIL') {
          rawEvents.push({
            iso: resultIso,
            type: 'REWORK',
            label: `REWORK #${attempt}: ${taskId}`,
            detail: 'Gate verification command failed',
          });
        }
      }

      if (att.reviewerDecision) {
        rawEvents.push({
          iso: resultIso,
          type: att.reviewerDecision === 'PASS' ? 'REVIEWER_PASS' : 'REVIEWER_REWORK',
          label: `Reviewer ${att.reviewerDecision}: ${taskId} (attempt ${attempt})`,
          detail: Array.isArray(att.requiredChanges) && att.requiredChanges.length > 0 && att.requiredChanges[0] !== 'none'
            ? att.requiredChanges[0]
            : null,
        });

        if (att.reviewerDecision === 'REWORK') {
          rawEvents.push({
            iso: resultIso,
            type: 'REWORK',
            label: `REWORK #${attempt}: ${taskId}`,
            detail: Array.isArray(att.requiredChanges) ? att.requiredChanges[0] : null,
          });
        }
      }
    }

    if (attempts.length === 0 && Array.isArray(rawState.taskHistory) && rawState.taskHistory.length > 0) {
      for (const th of rawState.taskHistory) {
        const taskId = th.taskId || 'task';
        const attempt = th.attempts || 1;
        rawEvents.push({
          iso: rawState.lastProgressAt || startIso,
          type: 'GATE_PASS',
          label: `Gate PASS: ${taskId} (attempt ${attempt})`,
          detail: null,
        });
        rawEvents.push({
          iso: rawState.lastProgressAt || startIso,
          type: 'REVIEWER_PASS',
          label: `Reviewer ${th.decision || 'PASS'}: ${taskId} (attempt ${attempt})`,
          detail: null,
        });
      }
    }
  } else {
    // 3. Fallback for Legacy States without stageHistory
    if (rawState.stageStatuses?.planner === 'done' || rawState.taskTotal) {
      rawEvents.push({
        iso: startIso,
        type: 'PLANNER',
        label: 'Planner completed',
        detail: rawState.taskTotal ? `${rawState.taskTotal} task(s) planned` : null,
      });
    }

    const attempts = Array.isArray(rawState.taskAttempts) ? rawState.taskAttempts : [];
    for (let idx = 0; idx < attempts.length; idx++) {
      const att = attempts[idx];
      const taskId = att.taskId || `task-${idx + 1}`;
      const attemptNum = att.attempt || idx + 1;
      const attIso = att.createdAt || startIso;
      const resIso = att.updatedAt || att.createdAt || rawState.lastProgressAt || startIso;

      rawEvents.push({
        iso: attIso,
        type: attemptNum === 1 ? 'TASK_START' : 'RETRY',
        label: attemptNum === 1 ? `Task started: ${taskId}` : `Attempt ${attemptNum} started: ${taskId}`,
        detail: null,
      });

      if (att.gateResult) {
        rawEvents.push({
          iso: resIso,
          type: att.gateResult === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL',
          label: `Gate ${att.gateResult}: ${taskId} (attempt ${attemptNum})`,
          detail: null,
        });
        if (att.gateResult === 'FAIL') {
          rawEvents.push({
            iso: resIso,
            type: 'REWORK',
            label: `REWORK #${attemptNum}: ${taskId}`,
            detail: 'Gate verification command failed',
          });
        }
      }

      if (att.reviewerDecision) {
        rawEvents.push({
          iso: resIso,
          type: att.reviewerDecision === 'PASS' ? 'REVIEWER_PASS' : 'REVIEWER_REWORK',
          label: `Reviewer ${att.reviewerDecision}: ${taskId} (attempt ${attemptNum})`,
          detail: Array.isArray(att.requiredChanges) && att.requiredChanges.length > 0 && att.requiredChanges[0] !== 'none'
            ? att.requiredChanges[0]
            : null,
        });

        if (att.reviewerDecision === 'REWORK') {
          rawEvents.push({
            iso: resIso,
            type: 'REWORK',
            label: `REWORK #${attemptNum}: ${taskId}`,
            detail: Array.isArray(att.requiredChanges) ? att.requiredChanges[0] : null,
          });
        }
      }
    }

    if (attempts.length === 0 && Array.isArray(rawState.taskHistory) && rawState.taskHistory.length > 0) {
      for (const th of rawState.taskHistory) {
        const taskId = th.taskId || 'task';
        const attempt = th.attempts || 1;
        rawEvents.push({
          iso: rawState.lastProgressAt || startIso,
          type: 'GATE_PASS',
          label: `Gate PASS: ${taskId} (attempt ${attempt})`,
          detail: null,
        });
        rawEvents.push({
          iso: rawState.lastProgressAt || startIso,
          type: 'REVIEWER_PASS',
          label: `Reviewer ${th.decision || 'PASS'}: ${taskId} (attempt ${attempt})`,
          detail: null,
        });
      }
    }

    if (rawState.modelEscalated || rawState.escalationActive || (rawState.escalationAttempts && rawState.escalationAttempts > 0)) {
      rawEvents.push({
        iso: rawState.lastProgressAt || startIso,
        type: 'ESCALATION',
        label: 'Supervisor escalation activated',
        detail: rawState.escalationReason || 'Normal attempts exhausted',
      });
    }
  }

  // 4. Terminal State
  const status = rawState.workflowStatus;
  if (['DONE', 'HUMAN_REQUIRED', 'FAILED', 'TIMEOUT', 'STOPPED'].includes(status)) {
    const termIso = rawState.lastProgressAt || startIso;
    rawEvents.push({
      iso: termIso,
      type: `TERMINAL_${status}`,
      label: status === 'DONE'
        ? 'Workflow completed successfully'
        : status === 'HUMAN_REQUIRED'
          ? `Human decision required: ${rawState.reason || rawState.question || 'Action needed'}`
          : `Workflow ${status.toLowerCase()}`,
      detail: rawState.summary || rawState.reason || null,
    });
  }

  // Sort strictly by real timestamp, using event type hierarchy for equal timestamps
  rawEvents.sort((a, b) => {
    const ta = a.iso ? new Date(a.iso).getTime() : 0;
    const tb = b.iso ? new Date(b.iso).getTime() : 0;
    if (ta !== tb) return ta - tb;
    const orderA = EVENT_ORDER[a.type] || 50;
    const orderB = EVENT_ORDER[b.type] || 50;
    return orderA - orderB;
  });

  // Map to clean presentation objects
  return rawEvents.map((ev) => ({
    time: formatTimestamp(ev.iso),
    timestamp: ev.iso ? new Date(ev.iso).getTime() : 0,
    type: ev.type,
    label: ev.label,
    detail: ev.detail || null,
  }));
}
