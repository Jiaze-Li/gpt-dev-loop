// Dashboard metadata & build identity module.
// Computes deterministic buildId and exports version information.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DASHBOARD_VERSION = '1.3.0';

// Read-only projection of the durable PR-closeout finding state.  In
// particular, resolution API failure never gets inferred as resolution from a
// code-fix lifecycle value.
export function projectReviewThreads(rawState) {
  const persisted = rawState?.prCloseout?.reviewFindings ?? rawState?.reviewFindings;
  const findings = (Array.isArray(persisted) ? persisted : []).map((finding) => {
    const resolution = String(finding?.threadResolutionStatus || 'NOT_ATTEMPTED').toUpperCase();
    let lifecycle = String(finding?.lifecycle || 'OPEN').toUpperCase();
    if (!['OPEN', 'FIXED', 'RESOLVED'].includes(lifecycle)) lifecycle = 'OPEN';
    if (resolution === 'FAILED' && lifecycle === 'RESOLVED') lifecycle = 'FIXED';
    if (lifecycle === 'RESOLVED' && resolution !== 'RESOLVED') lifecycle = 'FIXED';

    return {
      reviewId: finding?.reviewId ?? null,
      threadId: finding?.threadId ?? null,
      threadNodeId: finding?.threadNodeId ?? null,
      commentId: finding?.commentId ?? null,
      file: finding?.file ?? null,
      line: finding?.line ?? null,
      severity: finding?.severity ?? null,
      signature: finding?.signature ?? null,
      title: finding?.title ?? finding?.description ?? 'Review finding',
      lifecycle,
      threadResolutionStatus: resolution,
    };
  });

  const resolved = findings.filter((finding) =>
    finding.lifecycle === 'RESOLVED' && finding.threadResolutionStatus === 'RESOLVED').length;
  const resolutionFailed = findings.filter((finding) =>
    finding.threadResolutionStatus === 'FAILED').length;
  return {
    open: findings.length - resolved,
    resolved,
    resolutionFailed,
    findings,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function computeDashboardBuildId() {
  try {
    const viewPath = path.join(__dirname, 'view.js');
    const serverPath = path.join(__dirname, 'server.js');
    const timelinePath = path.join(__dirname, 'timeline.js');

    const h = crypto.createHash('sha256');
    h.update(DASHBOARD_VERSION);
    if (fs.existsSync(viewPath)) h.update(fs.readFileSync(viewPath));
    if (fs.existsSync(serverPath)) h.update(fs.readFileSync(serverPath));
    if (fs.existsSync(timelinePath)) h.update(fs.readFileSync(timelinePath));
    return h.digest('hex').slice(0, 16);
  } catch {
    return 'build-v1-static';
  }
}

// Single canonical workflow badge mapping for the Dashboard projection/view.
//
// The top header and the workflow selector MUST both render the result of this
// function so they can never disagree. Canonical stage/state is authoritative
// and always outranks a stale display status field (e.g. a lingering STARTING
// left behind after the Executor stage began).
const BADGE_PRESENTATION = {
  STARTING: { icon: '⟳' },
  RUNNING: { icon: '⟳' },
  DONE: { icon: '✓' },
  HUMAN_REQUIRED: { icon: '⚠' },
  FAILED: { icon: '✕' },
  STOPPED: { icon: '■' },
  SUPERSEDED: { icon: '⤸' },
  DISMISSED: { icon: '⊘' },
};

const RUNNING_STAGES = new Set(['EXECUTOR', 'GATE', 'REVIEWER', 'REWORK', 'ESCALATION', 'SUPERVISOR', 'APPLYING']);
const STARTING_STAGES = new Set(['STARTING', 'PLANNING', 'INIT', 'PREFLIGHT']);

export function getCanonicalWorkflowStatus({ stage, workflowStatus, isAlive = true } = {}) {
  const s = String(stage || '').toUpperCase();
  const w = String(workflowStatus || '').toUpperCase();

  // 1. Explicit terminal workflow states are authoritative — a stale stage cannot mask them.
  if (w === 'DONE') return 'DONE';
  if (w === 'SUPERSEDED') return 'SUPERSEDED';
  if (w === 'DISMISSED') return 'DISMISSED';
  if (w === 'HUMAN_REQUIRED') return 'HUMAN_REQUIRED';
  if (w === 'FAILED' || w === 'TIMEOUT' || w === 'STALLED') return 'FAILED';
  if (w === 'STOPPED') return 'STOPPED';

  if (isAlive === false) {
    return 'STOPPED';
  }

  // 2. Active stages -> RUNNING
  if (RUNNING_STAGES.has(s)) return 'RUNNING';
  if (RUNNING_STAGES.has(w)) return 'RUNNING';

  // 3. Starting stages -> STARTING
  if (STARTING_STAGES.has(s) || STARTING_STAGES.has(w) || w === 'STARTING') {
    return 'STARTING';
  }

  return 'STARTING';
}

export function canonicalWorkflowBadge({ stage, workflowStatus, isAlive = true } = {}) {
  const key = getCanonicalWorkflowStatus({ stage, workflowStatus, isAlive });
  const pres = BADGE_PRESENTATION[key] || BADGE_PRESENTATION.STARTING;
  return { key, icon: pres.icon, text: `SUPERGPT ${pres.icon} ${key}` };
}

export function computeRequiresAttention(live, { isAlive = true } = {}) {
  if (!live || typeof live !== 'object') return false;
  const workflowId = live.workflowId || '';
  const isTest = live.kind === 'INTERNAL_TEST' || /^(?:wf-)?(?:agy-)?test[-_]|^test[-_]/i.test(workflowId);
  if (isTest) return false;
  if (live.superseded || live.supersededBy || live.dismissed || live.archived) return false;
  if (live.isAlive === false || isAlive === false) return false;

  const canonicalStatus = getCanonicalWorkflowStatus({
    stage: live.stage,
    workflowStatus: live.workflowStatus,
    isAlive,
  });

  if (canonicalStatus === 'STARTING' || canonicalStatus === 'RUNNING') {
    return true;
  }

  if (canonicalStatus === 'HUMAN_REQUIRED') {
    // Unresolved human action: stays requiresAttention=true until the workflow
    // genuinely transitions out of HUMAN_REQUIRED (e.g. via successful resume -> RUNNING/DONE)
    // or is explicitly superseded / dismissed. Having humanAnswer/humanDecision in state does NOT clear it.
    return true;
  }

  if (canonicalStatus === 'FAILED') {
    if (live.requiresAttention === true) return true;
    if (live.evidence?.actionCode === 'RUN_HOST_VERIFICATION' && !live.superseded && !live.supersededBy && !live.dismissed && !live.archived) {
      return true;
    }
    return false;
  }

  return false;
}

export function getDashboardMeta() {
  return {
    name: 'supergpt-dashboard',
    dashboardVersion: DASHBOARD_VERSION,
    buildId: computeDashboardBuildId(),
    pid: process.pid,
  };
}
