// SuperGPT Local Dashboard HTTP Server.
//
// Read-only, zero model tokens, loopback-only local status dashboard.
// Exposes no secrets, does not invoke models, and does not alter workflow state.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import {
  readLiveWorkflowState,
  toCanonicalProgress,
  checkWorkflowLiveness,
  reconcileStaleWorkflowState,
} from '../orchestrator/workflowState.js';
import { validateWorkflowId } from '../orchestrator/workflowId.js';
import { readControl } from '../orchestrator/workflowControl.js';
import { deriveWorkflowTimeline } from './timeline.js';
import { renderDashboardHtml } from './view.js';
import { getDashboardMeta, canonicalWorkflowBadge, getCanonicalWorkflowStatus, computeRequiresAttention } from './meta.js';
import { getDashboardFocus } from './focus.js';

const TERMINAL_STATES = new Set(['DONE', 'HUMAN_REQUIRED', 'FAILED', 'STOPPED', 'TIMEOUT', 'STALLED', 'SUPERSEDED']);
const TEST_WORKFLOW_REGEX = /^(?:wf-)?(?:agy-)?test[-_]|^test[-_]/i;

export function isTestWorkflowId(workflowId) {
  if (!workflowId || typeof workflowId !== 'string') return false;
  return TEST_WORKFLOW_REGEX.test(workflowId);
}

// Derive the current-task ordinal for the Dashboard header/overview.
//
// Ordinal is the real position of the current task, never a Timeline-count
// guess and never an unconditional "Task 1" fallback. Preference order:
//   1. index of currentTaskId within plannedTasks (+1)
//   2. completed-task count (taskHistory / checkpoint history) + 1 in-flight
//   3. a reliable persisted canonical taskIndex
//   4. null — unknown, and the view renders it as unknown rather than faking 1
export function computeTaskProjection(live, checkpoint = null) {
  const cp = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const planned = Array.isArray(live.plannedTasks)
    ? live.plannedTasks
    : Array.isArray(cp.plannedTasks) ? cp.plannedTasks : [];
  const completed = Array.isArray(live.taskHistory)
    ? live.taskHistory
    : Array.isArray(cp.history) ? cp.history : [];
  const total = live.taskTotal ?? (planned.length || null);
  const currentTaskId = live.currentTaskId
    ?? cp.currentTaskId
    ?? cp.currentTaskCard?.task_id
    ?? live.taskId
    ?? null;
  const terminal = TERMINAL_STATES.has(String(live.workflowStatus || '').toUpperCase());

  const idOf = (t) => t?.task_id ?? t?.taskId ?? t?.id ?? null;
  let current = null;
  let title = live.taskName ?? cp.currentTaskCard?.goal ?? null;

  if (currentTaskId && planned.length > 0) {
    const idx = planned.findIndex((t) => idOf(t) === currentTaskId);
    if (idx >= 0) {
      current = idx + 1;
      if (!title) title = planned[idx].title ?? planned[idx].goal ?? idOf(planned[idx]);
    }
  }
  if (current == null && completed.length > 0) {
    current = terminal ? completed.length : completed.length + 1;
    if (total != null) current = Math.min(current, total);
  }
  if (current == null && Number.isInteger(live.taskIndex) && live.taskIndex >= 1) {
    current = live.taskIndex;
  }

  return { current, total, taskId: currentTaskId, title: title ?? null };
}

function readCheckpoint({ workflowId, root }) {
  try {
    return readControl({ workflowId, root })?.checkpoint ?? null;
  } catch {
    return null;
  }
}

export function listRecentWorkflows({
  root = SUPERGPT_WORKTREE_ROOT,
  includeTest = false,
  view = 'attention', // 'attention' | 'history' | 'all'
  all = false,
  limitTerminal = 20,
} = {}) {
  if (!fs.existsSync(root)) return [];
  try {
    const files = fs.readdirSync(root);
    const attentionWorkflows = [];
    const historyWorkflows = [];

    for (const file of files) {
      if (!file.endsWith('.state.json')) continue;
      const workflowId = file.replace(/\.state\.json$/, '');
      try {
        validateWorkflowId(workflowId);
        let live = readLiveWorkflowState({ workflowId, root });
        if (!live) continue;

        const liveness = checkWorkflowLiveness({ workflowId, root, state: live });
        if (liveness.isZombie) {
          live = reconcileStaleWorkflowState({ workflowId, root, state: live }) || live;
        }

        const kind = live.kind || (isTestWorkflowId(workflowId) ? 'INTERNAL_TEST' : 'USER');
        const isTest = kind === 'INTERNAL_TEST' || isTestWorkflowId(workflowId);
        if (!includeTest && isTest) {
          continue;
        }

        const canonical = toCanonicalProgress(live);
        const canonicalStatus = getCanonicalWorkflowStatus({
          stage: live.stage,
          workflowStatus: live.workflowStatus,
          isAlive: liveness.isAlive,
        });
        const focus = getDashboardFocus({ root });
        const isFocused = focus?.focusWorkflowId ? workflowId === focus.focusWorkflowId : false;
        const requiresAttention = computeRequiresAttention(live, { isAlive: liveness.isAlive });

        const item = {
          workflowId,
          kind,
          parentWorkflowId: live.parentWorkflowId || null,
          isFocused,
          rawStatus: live.workflowStatus || 'UNKNOWN',
          status: canonicalStatus,
          canonicalStatus,
          badge: canonicalWorkflowBadge({ stage: live.stage, workflowStatus: live.workflowStatus, isAlive: liveness.isAlive }),
          task: canonical?.task?.title || live.taskName || live.taskId || '-',
          stage: live.stage || 'INIT',
          elapsed: canonical?.timing?.elapsed || '00:00',
          startedAt: live.startedAt || null,
          requiresAttention,
          superseded: Boolean(live.superseded || live.supersededBy),
          supersededBy: live.supersededBy || null,
          dismissed: Boolean(live.dismissed),
          isAlive: liveness.isAlive,
        };

        if (requiresAttention) {
          attentionWorkflows.push(item);
        } else {
          historyWorkflows.push(item);
        }
      } catch {
        // Skip unreadable or invalid entries
      }
    }

    const byStartedAtDesc = (a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    };

    // Sort Attention: unresolved HUMAN_REQUIRED first (by startedAt desc), then RUNNING/STARTING (by startedAt desc)
    const hrAttention = attentionWorkflows.filter((w) => w.canonicalStatus === 'HUMAN_REQUIRED').sort(byStartedAtDesc);
    const otherAttention = attentionWorkflows.filter((w) => w.canonicalStatus !== 'HUMAN_REQUIRED').sort(byStartedAtDesc);
    const sortedAttention = [...hrAttention, ...otherAttention];

    historyWorkflows.sort(byStartedAtDesc);
    const limitedHistory = (all || view === 'all') ? historyWorkflows : historyWorkflows.slice(0, Math.max(0, limitTerminal));

    if (view === 'history') {
      return limitedHistory;
    }
    if (view === 'all' || all) {
      return [...sortedAttention, ...limitedHistory];
    }

    // Default 'attention' view
    return sortedAttention;
  } catch {
    return [];
  }
}

export function getWorkflowDetail({ workflowId, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  validateWorkflowId(workflowId);
  let live = readLiveWorkflowState({ workflowId, root });
  if (!live) return null;

  const liveness = checkWorkflowLiveness({ workflowId, root, state: live });
  if (liveness.isZombie) {
    live = reconcileStaleWorkflowState({ workflowId, root, state: live }) || live;
  }

  const canonical = toCanonicalProgress(live);
  const checkpoint = readCheckpoint({ workflowId, root });
  const task = computeTaskProjection(live, checkpoint);
  const canonicalStatus = getCanonicalWorkflowStatus({ stage: live.stage, workflowStatus: live.workflowStatus, isAlive: liveness.isAlive });
  const badge = canonicalWorkflowBadge({ stage: live.stage, workflowStatus: live.workflowStatus, isAlive: liveness.isAlive });
  const kind = live.kind || (isTestWorkflowId(workflowId) ? 'INTERNAL_TEST' : 'USER');
  const focus = getDashboardFocus({ root });
  const isFocused = focus?.focusWorkflowId ? workflowId === focus.focusWorkflowId : false;

  // Timeline: the underlying deriveWorkflowTimeline output stays chronological
  // (its API contract, relied on by other consumers). The Dashboard only wants
  // newest-first, so reverse a display copy — never reverse in place.
  const timelineChronological = deriveWorkflowTimeline(live);
  const timeline = [...timelineChronological].reverse();

  return {
    ...canonical,
    kind,
    parentWorkflowId: live.parentWorkflowId || null,
    isFocused,
    rawStatus: live.workflowStatus || 'UNKNOWN',
    status: canonicalStatus,
    canonicalStatus,
    task,
    badge,
    taskTotal: live.taskTotal ?? task.total ?? canonical?.task?.total ?? null,
    normalAttempts: live.normalAttempts ?? (live.attempt || 1),
    maxAttemptsPerTask: live.maxAttemptsPerTask ?? 3,
    escalationAttempts: live.escalationAttempts ?? 0,
    maxEscalationAttempts: live.maxEscalationAttempts ?? 2,
    escalationActive: Boolean(live.escalationActive || live.modelEscalated),
    requiresAttention: computeRequiresAttention(live, { isAlive: liveness.isAlive }),
    dismissed: Boolean(live.dismissed),
    superseded: Boolean(live.superseded),
    supersededBy: live.supersededBy || null,
    stageStatuses: live.stageStatuses ?? {},
    timeline,
    isAlive: liveness.isAlive,
  };
}

export function dismissWorkflow({ workflowId, root = SUPERGPT_WORKTREE_ROOT } = {}) {
  validateWorkflowId(workflowId);
  const statePath = path.join(root, `${workflowId}.state.json`);
  if (!fs.existsSync(statePath)) {
    const err = new Error(`Workflow ${workflowId} not found`);
    err.code = 'WORKFLOW_NOT_FOUND';
    throw err;
  }
  const raw = fs.readFileSync(statePath, 'utf8');
  const state = JSON.parse(raw);
  const canonicalStatus = getCanonicalWorkflowStatus({ stage: state.stage, workflowStatus: state.workflowStatus });

  // Security: dismiss/archive is strictly forbidden on active / starting / in-flight workflows
  if (canonicalStatus === 'RUNNING' || canonicalStatus === 'STARTING' || state.stage === 'APPLYING') {
    const err = new Error(`Cannot dismiss active workflow in ${canonicalStatus} status (stage: ${state.stage || 'unknown'})`);
    err.code = 'DISMISS_NOT_ALLOWED';
    throw err;
  }

  // Record dismiss metadata atomically
  state.workflowStatus = 'STOPPED';
  state.stage = 'STOPPED';
  state.dismissed = true;
  state.dismissedAt = new Date().toISOString();
  state.dismissedReason = 'user_archived';
  state.requiresAttention = false;

  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { ok: true, workflowId, status: 'STOPPED', dismissed: true };
}

export function createDashboardServer({
  port = 4317,
  host = '127.0.0.1',
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  // Security check: loopback only
  const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
  if (!allowedHosts.includes(host)) {
    throw new Error(`Security Error: SuperGPT Dashboard can only bind to loopback (127.0.0.1/localhost), received '${host}'`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const pathname = url.pathname;

    // Handle dismiss / archive POST endpoint
    if (pathname.startsWith('/api/workflows/') && (pathname.endsWith('/dismiss') || pathname.endsWith('/archive'))) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      const rest = pathname.slice('/api/workflows/'.length);
      const rawId = rest.replace(/\/(?:dismiss|archive)$/, '');
      try {
        const workflowId = decodeURIComponent(rawId);
        const result = dismissWorkflow({ workflowId, root });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(JSON.stringify(result));
        return;
      } catch (dismissErr) {
        const status = dismissErr.code === 'DISMISS_NOT_ALLOWED' ? 400 : (dismissErr.code === 'WORKFLOW_NOT_FOUND' ? 404 : 500);
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(JSON.stringify({ error: dismissErr.code || 'DISMISS_FAILED', message: dismissErr.message }));
        return;
      }
    }

    // All other endpoints are GET requests only
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // 1. API: Meta & Version Info
    if (pathname === '/api/meta') {
      const focus = getDashboardFocus({ root });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(JSON.stringify({ ...getDashboardMeta(), focusWorkflowId: focus?.focusWorkflowId || null }));
      return;
    }

    // 1B. API: Dashboard Focus
    if (pathname === '/api/focus') {
      const focus = getDashboardFocus({ root });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(JSON.stringify(focus || { focusWorkflowId: null }));
      return;
    }

    // 2. API: List workflows
    if (pathname === '/api/workflows') {
      const includeTest = url.searchParams.get('test') === '1' ||
                          url.searchParams.get('test') === 'true' ||
                          url.searchParams.get('includeTest') === '1' ||
                          url.searchParams.get('includeTest') === 'true' ||
                          url.searchParams.get('showTest') === '1' ||
                          url.searchParams.get('showTest') === 'true';
      const allParam = url.searchParams.get('all') === '1' ||
                       url.searchParams.get('all') === 'true';
      const viewParam = url.searchParams.get('view') || (allParam || includeTest ? 'all' : (url.searchParams.get('history') === '1' ? 'history' : 'attention'));
      const limitParam = url.searchParams.get('limit');
      const limitTerminal = limitParam ? parseInt(limitParam, 10) : 20;

      // Zero-model-token summary counts for header
      const allWorkflows = listRecentWorkflows({ root, includeTest, view: 'all', all: true });
      const runningCount = allWorkflows.filter((w) => (w.canonicalStatus === 'RUNNING' || w.canonicalStatus === 'STARTING') && w.kind === 'USER').length;
      const attentionCount = allWorkflows.filter((w) => w.canonicalStatus === 'HUMAN_REQUIRED' && w.requiresAttention).length;
      const historyCount = allWorkflows.filter((w) => !w.requiresAttention).length;

      const list = listRecentWorkflows({ root, includeTest, view: viewParam, all: allParam, limitTerminal });
      const focus = getDashboardFocus({ root });
      const focusWorkflowId = focus?.focusWorkflowId || '';

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-SuperGPT-Focus': focusWorkflowId,
        'X-SuperGPT-Running-Count': String(runningCount),
        'X-SuperGPT-Attention-Count': String(attentionCount),
        'X-SuperGPT-History-Count': String(historyCount),
      });
      res.end(JSON.stringify(list));
      return;
    }

    // 3. API: Workflow detail
    if (pathname.startsWith('/api/workflows/')) {
      const rawId = pathname.slice('/api/workflows/'.length);
      try {
        const workflowId = decodeURIComponent(rawId);
        const detail = getWorkflowDetail({ workflowId, root });
        if (!detail) {
          res.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(JSON.stringify({ error: 'Workflow not found', workflowId }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        res.end(JSON.stringify(detail));
        return;
      } catch (err) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(JSON.stringify({ error: 'Invalid workflow ID' }));
        return;
      }
    }

    // 4. HTML View: /workflow/:workflowId
    if (pathname.startsWith('/workflow/')) {
      const rawId = pathname.slice('/workflow/'.length);
      const workflowId = decodeURIComponent(rawId);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(renderDashboardHtml({ initialWorkflowId: workflowId }));
      return;
    }

    // 5. HTML View: Index (/)
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(renderDashboardHtml());
      return;
    }

    // 404 for other paths
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Error: Port ${port} is already in use.`));
          } else {
            reject(err);
          }
        });
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve({
            host,
            port: actualPort,
            url: `http://${host}:${actualPort}`,
          });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
