import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  createDashboardServer,
  listRecentWorkflows,
  getWorkflowDetail,
  computeTaskProjection,
} from '../src/dashboard/server.js';
import { deriveWorkflowTimeline } from '../src/dashboard/timeline.js';
import { canonicalWorkflowBadge } from '../src/dashboard/meta.js';
import {
  chooseWorkflow,
  DASHBOARD_POLL_INTERVAL_MS,
  renderDashboardHtml,
} from '../src/dashboard/view.js';
import { recordDashboardFocus, getDashboardFocus } from '../src/dashboard/focus.js';

function requestGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json() { return JSON.parse(body); },
        });
      });
    }).on('error', reject);
  });
}

function requestPost(url, payload = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json() { return JSON.parse(body); },
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function makeTempWorktreeRoot() {
  const root = path.join(os.tmpdir(), `test-dashboard-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test('1. Security: Dashboard default binds to loopback and rejects 0.0.0.0 or foreign hosts', () => {
  assert.throws(
    () => createDashboardServer({ host: '0.0.0.0' }),
    /Security Error: SuperGPT Dashboard can only bind to loopback/
  );
  assert.throws(
    () => createDashboardServer({ host: '192.168.1.100' }),
    /Security Error: SuperGPT Dashboard can only bind to loopback/
  );
  // Loopback hosts allowed
  assert.doesNotThrow(() => createDashboardServer({ host: '127.0.0.1' }));
  assert.doesNotThrow(() => createDashboardServer({ host: 'localhost' }));
});

test('2. Port in use (EADDRINUSE) provides a clear and friendly error', async () => {
  const serverA = createDashboardServer({ port: 0 });
  const { port } = await serverA.start();
  try {
    const serverB = createDashboardServer({ port });
    await assert.rejects(
      async () => serverB.start(),
      new RegExp(`Error: Port ${port} is already in use`)
    );
  } finally {
    await serverA.close();
  }
});

test('3. API reads RUNNING and DONE workflows accurately without model tokens', async () => {
  const root = makeTempWorktreeRoot();
  const wfRunning = 'wf-agy-running-1111-2222-3333-444455556666';
  const wfDone = 'wf-agy-done-1111-2222-3333-444455556666';

  const runningState = {
    workflowId: wfRunning,
    workflowStatus: 'RUNNING',
    stage: 'EXECUTOR',
    taskIndex: 1,
    taskTotal: 3,
    taskId: 'task-auth',
    taskName: 'Implement user authentication',
    attempt: 1,
    normalAttempts: 1,
    maxAttemptsPerTask: 3,
    escalationAttempts: 0,
    maxEscalationAttempts: 2,
    modelEscalated: false,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    executorModel: 'claude-sonnet-5',
    tokenUsage: {
      planner: { totalTokens: 1200 },
      supervisor: { totalTokens: 0 },
      executor: { totalTokens: 2500 },
      reviewer: { totalTokens: 0 },
      total: { totalTokens: 3700 },
    },
    taskAttempts: [
      { taskId: 'task-auth', attempt: 1, executorCallId: 'c1' },
    ],
  };

  const doneState = {
    workflowId: wfDone,
    workflowStatus: 'DONE',
    stage: 'DONE',
    taskIndex: 3,
    taskTotal: 3,
    taskId: 'task-deploy',
    taskName: 'Configure deployment pipeline',
    attempt: 1,
    normalAttempts: 3,
    maxAttemptsPerTask: 3,
    escalationAttempts: 1,
    maxEscalationAttempts: 2,
    modelEscalated: true,
    escalationReason: 'Normal attempts exhausted',
    startedAt: '2026-08-31T03:00:00.000Z',
    heartbeatAt: '2026-08-31T03:05:00.000Z',
    lastProgressAt: '2026-08-31T03:05:00.000Z',
    lastActivityAt: '2026-08-31T03:04:50.000Z',
    executorModel: 'claude-sonnet-5',
    tokenUsage: {
      planner: { totalTokens: 1500 },
      supervisor: { totalTokens: 16100 },
      executor: { totalTokens: 8500 },
      reviewer: { totalTokens: 6200 },
      total: { totalTokens: 32300 },
    },
    taskAttempts: [
      { taskId: 'task-deploy', attempt: 1, gateResult: 'FAIL', reviewerDecision: 'REWORK', requiredChanges: ['Fix config'] },
      { taskId: 'task-deploy', attempt: 2, gateResult: 'PASS', reviewerDecision: 'PASS' },
    ],
  };

  fs.writeFileSync(path.join(root, `${wfRunning}.state.json`), JSON.stringify(runningState, null, 2));
  fs.writeFileSync(path.join(root, `${wfDone}.state.json`), JSON.stringify(doneState, null, 2));

  const dashboard = createDashboardServer({ port: 49153, root });
  const { url } = await dashboard.start();

  try {
    // List workflows (default Attention returns running)
    const listRes = await requestGet(`${url}/api/workflows`);
    assert.equal(listRes.statusCode, 200);
    const list = listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].workflowId, wfRunning);

    // All workflows (running + done)
    const allRes = await requestGet(`${url}/api/workflows?all=1`);
    assert.equal(allRes.statusCode, 200);
    const allList = allRes.json();
    assert.equal(allList.length, 2);
    assert.equal(allList[0].workflowId, wfRunning);
    assert.equal(allList[1].workflowId, wfDone);

    // Detail for running workflow
    const runRes = await requestGet(`${url}/api/workflows/${wfRunning}`);
    assert.equal(runRes.statusCode, 200);
    const runDetail = runRes.json();
    assert.equal(runDetail.workflowId, wfRunning);
    assert.equal(runDetail.workflowStatus, 'RUNNING');
    assert.equal(runDetail.task.title, 'Implement user authentication');
    assert.equal(runDetail.normalAttempts, 1);
    assert.equal(runDetail.escalationActive, false);
    assert.equal(runDetail.usage.total.totalTokens, 3700);

    // Detail for done workflow
    const doneRes = await requestGet(`${url}/api/workflows/${wfDone}`);
    assert.equal(doneRes.statusCode, 200);
    const doneDetail = doneRes.json();
    assert.equal(doneDetail.workflowId, wfDone);
    assert.equal(doneDetail.workflowStatus, 'DONE');
    assert.equal(doneDetail.escalationActive, true);
    assert.equal(doneDetail.usage.supervisor.totalTokens, 16100);

    // Timeline verification
    assert.ok(doneDetail.timeline.length >= 3);
    assert.ok(doneDetail.timeline.some(e => e.label.includes('Workflow started')));
    assert.ok(doneDetail.timeline.some(e => e.label.includes('Gate FAIL')));
    assert.ok(doneDetail.timeline.some(e => e.label.includes('Supervisor escalation')));
    assert.ok(doneDetail.timeline.some(e => e.label.includes('Workflow completed')));

    // Unknown workflow returns 404
    const notFoundRes = await requestGet(`${url}/api/workflows/wf-agy-unknown-0000-0000-0000-000000000000`);
    assert.equal(notFoundRes.statusCode, 404);
    assert.match(notFoundRes.json().error, /not found/i);

    // HTML endpoints
    const htmlIndex = await requestGet(`${url}/`);
    assert.equal(htmlIndex.statusCode, 200);
    assert.match(htmlIndex.body, /SuperGPT Local Dashboard/);

    const htmlWorkflow = await requestGet(`${url}/workflow/${wfRunning}`);
    assert.equal(htmlWorkflow.statusCode, 200);
    assert.match(htmlWorkflow.body, new RegExp(wfRunning));

    // Invariant: Dashboard reads do not modify the state files
    const runningAfter = JSON.parse(fs.readFileSync(path.join(root, `${wfRunning}.state.json`), 'utf8'));
    assert.deepEqual(runningAfter, runningState);
  } finally {
    await dashboard.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('4. deriveWorkflowTimeline sanitizes and orders milestones cleanly', () => {
  const state = {
    startedAt: '2026-08-31T04:00:00.000Z',
    workflowPath: 'FULL',
    taskTotal: 2,
    stageStatuses: { planner: 'done' },
    taskAttempts: [
      { taskId: 'task-1', attempt: 1, gateResult: 'FAIL', reviewerDecision: 'REWORK', requiredChanges: ['Fix unit test'] },
      { taskId: 'task-1', attempt: 2, gateResult: 'PASS', reviewerDecision: 'PASS' },
    ],
    modelEscalated: true,
    escalationReason: 'Escalated to Supervisor for guidance',
    workflowStatus: 'DONE',
    summary: 'All tasks completed cleanly',
  };

  const timeline = deriveWorkflowTimeline(state);
  assert.ok(timeline.length >= 6);
  assert.equal(timeline[0].label, 'Workflow started');
  assert.equal(timeline[1].label, 'Planner completed');
  assert.ok(timeline.some(e => e.label.includes('Task started: task-1')));
  assert.ok(timeline.some(e => e.label.includes('Gate FAIL')));
  assert.ok(timeline.some(e => e.label.includes('Reviewer REWORK')));
  assert.ok(timeline.some(e => e.label.includes('Attempt 2 started')));
  assert.ok(timeline.some(e => e.label.includes('Workflow completed successfully')));
});

test('5. Lifecycle order: Workflow started -> Planner completed -> Task started -> Executor completed -> Gate -> Reviewer -> Terminal is strictly monotonic', () => {
  const state = {
    startedAt: '2026-08-31T04:00:00.000Z',
    workflowPath: 'FULL',
    taskTotal: 1,
    stageHistory: [
      { stage: 'INIT', startedAt: '2026-08-31T04:00:00.000Z' },
      { stage: 'PLANNING', startedAt: '2026-08-31T04:00:01.000Z' },
      { stage: 'EXECUTOR', startedAt: '2026-08-31T04:00:10.000Z', taskId: 'task-crypto', attempt: 1 },
      { stage: 'GATE', startedAt: '2026-08-31T04:00:35.000Z', taskId: 'task-crypto', attempt: 1 },
      { stage: 'REVIEWER', startedAt: '2026-08-31T04:00:38.000Z', taskId: 'task-crypto', attempt: 1 },
      { stage: 'DONE', startedAt: '2026-08-31T04:00:45.000Z' },
    ],
    taskAttempts: [
      {
        taskId: 'task-crypto',
        attempt: 1,
        createdAt: '2026-08-31T04:00:10.000Z',
        updatedAt: '2026-08-31T04:00:40.000Z',
        gateResult: 'PASS',
        reviewerDecision: 'PASS',
      },
    ],
    workflowStatus: 'DONE',
    lastProgressAt: '2026-08-31T04:00:45.000Z',
    summary: 'Crypto helper completed',
  };

  const timeline = deriveWorkflowTimeline(state);
  assert.ok(timeline.length >= 6);

  // Check monotonic timestamps
  for (let i = 0; i < timeline.length - 1; i++) {
    assert.ok(
      timeline[i].timestamp <= timeline[i + 1].timestamp,
      `Event ${timeline[i].label} (${timeline[i].time}) must be <= ${timeline[i + 1].label} (${timeline[i + 1].time})`
    );
  }

  // Check labels sequence
  assert.equal(timeline[0].label, 'Workflow started');
  assert.equal(timeline[1].label, 'Planner completed');
  assert.equal(timeline[2].label, 'Task started: task-crypto');
  assert.equal(timeline[3].label, 'Executor completed: task-crypto (attempt 1)');
  assert.ok(timeline[4].label.includes('Gate PASS') || timeline[4].label.includes('Reviewer PASS'));
  assert.equal(timeline[timeline.length - 1].label, 'Workflow completed successfully');
});

// --- Regression: Dashboard projection/view display fixes (A–E) ---

test('A. Current task ordinal reflects real position: 6 planned, currentTaskId on the 4th => Task 4 / 6 with the right title', () => {
  const root = makeTempWorktreeRoot();
  const wf = 'wf-agy-ordinal-1111-2222-3333-444455556666';
  const state = {
    workflowId: wf,
    workflowStatus: 'RUNNING',
    stage: 'EXECUTOR',
    taskTotal: 6,
    taskId: 'task-4',
    taskName: 'Wire up the projection layer',
    currentTaskId: 'task-4',
    plannedTasks: [
      { task_id: 'task-1', title: 'One' },
      { task_id: 'task-2', title: 'Two' },
      { task_id: 'task-3', title: 'Three' },
      { task_id: 'task-4', title: 'Four' },
      { task_id: 'task-5', title: 'Five' },
      { task_id: 'task-6', title: 'Six' },
    ],
    taskHistory: [
      { taskId: 'task-1', decision: 'PASS' },
      { taskId: 'task-2', decision: 'PASS' },
      { taskId: 'task-3', decision: 'PASS' },
    ],
    startedAt: '2026-08-31T04:00:00.000Z',
  };
  fs.writeFileSync(path.join(root, `${wf}.state.json`), JSON.stringify(state, null, 2));

  try {
    const detail = getWorkflowDetail({ workflowId: wf, root });
    assert.equal(detail.task.current, 4);
    assert.equal(detail.task.total, 6);
    assert.equal(detail.task.title, 'Wire up the projection layer');

    // Never fabricate Task 1 when the position is genuinely unknown.
    const blind = computeTaskProjection({ workflowStatus: 'RUNNING', stage: 'EXECUTOR', taskTotal: 6 });
    assert.equal(blind.current, null);

    // Completed-task-count compatibility path (no plannedTasks available).
    const viaHistory = computeTaskProjection({
      workflowStatus: 'RUNNING',
      taskTotal: 6,
      taskHistory: [{ taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }],
    });
    assert.equal(viaHistory.current, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('B. Stage EXECUTOR maps to RUNNING even when the display status is a stale STARTING', () => {
  const badge = canonicalWorkflowBadge({ stage: 'EXECUTOR', workflowStatus: 'STARTING' });
  assert.equal(badge.key, 'RUNNING');
  assert.equal(badge.text, 'SUPERGPT ⟳ RUNNING');
  assert.notEqual(badge.key, 'STARTING');
});

test('C. Workflow selector badge is identical to the header badge (single canonical mapping)', () => {
  const root = makeTempWorktreeRoot();
  const wf = 'wf-agy-badgesync-1111-2222-3333-444455556666';
  const state = {
    workflowId: wf,
    workflowStatus: 'STARTING', // stale display status
    stage: 'REVIEWER',
    taskTotal: 2,
    taskId: 'task-x',
    taskName: 'Review stage in progress',
    startedAt: '2026-08-31T04:00:00.000Z',
  };
  fs.writeFileSync(path.join(root, `${wf}.state.json`), JSON.stringify(state, null, 2));

  try {
    const detail = getWorkflowDetail({ workflowId: wf, root });
    const listed = listRecentWorkflows({ root }).find((w) => w.workflowId === wf);
    assert.deepEqual(listed.badge, detail.badge);
    assert.equal(detail.badge.key, 'RUNNING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D. Timeline shows newest-first in the view while the derived API stays chronological with untouched timestamps', () => {
  const root = makeTempWorktreeRoot();
  const wf = 'wf-agy-timeline-1111-2222-3333-444455556666';
  const state = {
    workflowId: wf,
    workflowStatus: 'RUNNING',
    stage: 'GATE',
    startedAt: '2026-08-31T09:59:00.000Z',
    workflowPath: 'FULL',
    stageHistory: [
      { stage: 'PLANNING', startedAt: '2026-08-31T10:00:00.000Z' },
      { stage: 'EXECUTOR', startedAt: '2026-08-31T10:01:00.000Z', taskId: 'task-1', attempt: 1 },
      { stage: 'GATE', startedAt: '2026-08-31T10:02:00.000Z', taskId: 'task-1', attempt: 1 },
    ],
  };
  fs.writeFileSync(path.join(root, `${wf}.state.json`), JSON.stringify(state, null, 2));

  try {
    const chronological = deriveWorkflowTimeline(state);
    // Underlying API contract unchanged: oldest first, strictly monotonic.
    assert.equal(chronological[0].label, 'Workflow started');
    for (let i = 0; i < chronological.length - 1; i++) {
      assert.ok(chronological[i].timestamp <= chronological[i + 1].timestamp);
    }
    const startEvent = chronological.find((e) => e.label === 'Workflow started');
    assert.equal(startEvent.timestamp, new Date('2026-08-31T09:59:00.000Z').getTime());

    const detail = getWorkflowDetail({ workflowId: wf, root });
    // View copy is the exact reverse — newest first — with identical values.
    assert.deepEqual(detail.timeline, [...chronological].reverse());
    const viewLabels = detail.timeline.map((e) => e.label);
    assert.match(viewLabels[0], /Executor completed/);
    assert.match(viewLabels[1], /Task started/);
    assert.match(viewLabels[2], /Planner completed/);
    assert.equal(viewLabels[viewLabels.length - 1], 'Workflow started');

    // Source event timestamps are not mutated by the display reversal.
    assert.equal(
      deriveWorkflowTimeline(state)[0].timestamp,
      new Date('2026-08-31T09:59:00.000Z').getTime()
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Home-page stable current-workflow selection (F–L) ---

const run = (id, startedAt, kind = 'USER') => ({ workflowId: id, kind, badge: { key: 'RUNNING' }, startedAt });
const done = (id, startedAt, kind = 'USER') => ({ workflowId: id, kind, badge: { key: 'DONE' }, startedAt });

test('F. No current selection: auto-selects the newest RUNNING USER workflow by startedAt', () => {
  const workflows = [
    run('wf-a', '2026-08-31T04:00:00.000Z'),
    run('wf-b', '2026-08-31T05:00:00.000Z'),
    run('wf-test-c', '2026-08-31T06:00:00.000Z', 'INTERNAL_TEST'),
    done('wf-d', '2026-08-31T07:00:00.000Z'),
  ];
  // Picks wf-b (newest active USER workflow), ignoring wf-test-c (test)
  assert.equal(chooseWorkflow({ currentId: '', lastKnownId: '', workflows }), 'wf-b');
});

test('G. Current RUNNING is not disturbed by status changes on older workflows', () => {
  const before = [
    run('wf-cur', '2026-08-31T05:00:00.000Z'),
    run('wf-old', '2026-08-31T04:00:00.000Z'),
  ];
  assert.equal(chooseWorkflow({ currentId: 'wf-cur', lastKnownId: 'wf-cur', workflows: before }), 'wf-cur');
  // wf-old turns DONE -> still no jump.
  const after = [
    run('wf-cur', '2026-08-31T05:00:00.000Z'),
    done('wf-old', '2026-08-31T04:00:00.000Z'),
  ];
  assert.equal(chooseWorkflow({ currentId: 'wf-cur', lastKnownId: 'wf-cur', workflows: after }), 'wf-cur');
});

test('H. Current RUNNING is NEVER preempted by a newer RUNNING or test workflow', () => {
  const workflows = [
    run('wf-cur', '2026-08-31T05:00:00.000Z'),
    run('wf-new', '2026-08-31T05:30:00.000Z'),
    run('wf-test-other', '2026-08-31T05:40:00.000Z', 'INTERNAL_TEST'),
  ];
  // Invariant: current selection is pinned and never preempted
  assert.equal(chooseWorkflow({ currentId: 'wf-cur', lastKnownId: 'wf-cur', workflows }), 'wf-cur');
});

test('I. Current turned DONE: stays on current selection final result without jumping to other RUNNING', () => {
  const workflows = [
    done('wf-cur', '2026-08-31T05:00:00.000Z'),
    run('wf-r1', '2026-08-31T04:00:00.000Z'),
    run('wf-r2', '2026-08-31T05:30:00.000Z'),
  ];
  // Invariant: once selected, stays on current workflow even when DONE
  assert.equal(chooseWorkflow({ currentId: 'wf-cur', lastKnownId: 'wf-cur', workflows }), 'wf-cur');
});

test('J. No RUNNING workflow anywhere: keeps the current / most recent selection', () => {
  const workflows = [
    done('wf-cur', '2026-08-31T05:00:00.000Z'),
    done('wf-other', '2026-08-31T06:00:00.000Z'),
  ];
  assert.equal(chooseWorkflow({ currentId: 'wf-cur', lastKnownId: 'wf-cur', workflows }), 'wf-cur');
  // Current no longer listed -> fall back to last known, not a status-based jump.
  assert.equal(
    chooseWorkflow({ currentId: 'wf-gone', lastKnownId: 'wf-other', workflows }),
    'wf-other'
  );
});

test('K. Manual /workflow/<id> target is honoured and folded into the same rule', () => {
  const workflows = [
    run('wf-manual', '2026-08-31T05:00:00.000Z'),
    done('wf-x', '2026-08-31T06:00:00.000Z'),
  ];
  // Viewing a RUNNING target stays on wf-manual
  assert.equal(chooseWorkflow({ currentId: 'wf-manual', lastKnownId: 'wf-manual', workflows }), 'wf-manual');
  // Viewing a DONE target stays on wf-x (never auto-jumps away to a RUNNING one)
  assert.equal(chooseWorkflow({ currentId: 'wf-x', lastKnownId: 'wf-x', workflows }), 'wf-x');
});

test('L. Home page polls /api/workflows every 1s with no model or Core dependency', () => {
  assert.equal(DASHBOARD_POLL_INTERVAL_MS, 1000);
  const html = renderDashboardHtml();
  assert.match(html, /const POLL_INTERVAL_MS = 1000;/);
  assert.match(html, /}, POLL_INTERVAL_MS\);/);
  assert.match(html, /\/api\/workflows/);
  assert.match(html, /function chooseWorkflow/);
  // Pure view module: no orchestrator / Core state-machine imports.
  const viewSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/dashboard/view.js'),
    'utf8'
  );
  assert.doesNotMatch(viewSrc, /from '\.\.\/orchestrator/);
});

test('E. Terminal states map to their own badge and never fall back to STARTING/RUNNING', () => {
  const cases = [
    ['DONE', '✓'],
    ['HUMAN_REQUIRED', '⚠'],
    ['FAILED', '✕'],
    ['STOPPED', '■'],
  ];
  for (const [status, icon] of cases) {
    // Even with a stale non-terminal stage lingering in the record.
    const badge = canonicalWorkflowBadge({ stage: 'STARTING', workflowStatus: status });
    assert.equal(badge.key, status);
    assert.equal(badge.icon, icon);
    assert.equal(badge.text, `SUPERGPT ${icon} ${status}`);
    assert.ok(badge.key !== 'STARTING' && badge.key !== 'RUNNING');
  }
});

test('M. /api/workflows returns Attention workflows by default, supports history view, and limits terminal workflows', async () => {
  const root = makeTempWorktreeRoot();
  try {
    // 2 active
    fs.writeFileSync(path.join(root, 'wf-real-active-1.state.json'), JSON.stringify({ workflowId: 'wf-real-active-1', workflowStatus: 'RUNNING', stage: 'EXECUTOR', startedAt: '2026-08-31T10:00:00.000Z' }));
    fs.writeFileSync(path.join(root, 'wf-real-active-2.state.json'), JSON.stringify({ workflowId: 'wf-real-active-2', workflowStatus: 'STARTING', stage: 'PLANNING', startedAt: '2026-08-31T09:00:00.000Z' }));
    // 1 HUMAN_REQUIRED
    fs.writeFileSync(path.join(root, 'wf-real-hr-1.state.json'), JSON.stringify({ workflowId: 'wf-real-hr-1', workflowStatus: 'HUMAN_REQUIRED', stage: 'HUMAN_REQUIRED', startedAt: '2026-08-31T08:00:00.000Z' }));
    // 25 terminal workflows
    for (let i = 1; i <= 25; i++) {
      const pad = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(root, `wf-real-done-${pad}.state.json`), JSON.stringify({ workflowId: `wf-real-done-${pad}`, workflowStatus: 'DONE', stage: 'DONE', startedAt: `2026-08-30T${pad}:00:00.000Z` }));
    }
    // 5 test workflows
    fs.writeFileSync(path.join(root, 'wf-test-1.state.json'), JSON.stringify({ workflowId: 'wf-test-1', workflowStatus: 'DONE', stage: 'DONE', startedAt: '2026-08-31T11:00:00.000Z' }));
    fs.writeFileSync(path.join(root, 'wf-agy-test-2.state.json'), JSON.stringify({ workflowId: 'wf-agy-test-2', workflowStatus: 'RUNNING', stage: 'EXECUTOR', startedAt: '2026-08-31T11:00:00.000Z' }));
    fs.writeFileSync(path.join(root, 'test-unit-3.state.json'), JSON.stringify({ workflowId: 'test-unit-3', workflowStatus: 'FAILED', stage: 'FAILED', startedAt: '2026-08-31T11:00:00.000Z' }));

    const server = createDashboardServer({ port: 0, root });
    const { url } = await server.start();
    try {
      // Default: Attention only (2 active + 1 HR = 3)
      const res = await requestGet(`${url}/api/workflows`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-supergpt-running-count'], '2');
      assert.equal(res.headers['x-supergpt-attention-count'], '1');
      assert.equal(res.headers['x-supergpt-history-count'], '25');
      const list = res.json();
      assert.equal(list.length, 3);
      assert.ok(!list.some(w => w.workflowId.startsWith('wf-test-') || w.workflowId.startsWith('wf-agy-test-') || w.workflowId.startsWith('test-')));
      assert.ok(list.some(w => w.workflowId === 'wf-real-active-1'));
      assert.ok(list.some(w => w.workflowId === 'wf-real-active-2'));
      assert.ok(list.some(w => w.workflowId === 'wf-real-hr-1'));

      // ?view=history: returns history workflows (capped at limit 20 by default)
      const histRes = await requestGet(`${url}/api/workflows?view=history`);
      const histList = histRes.json();
      assert.equal(histList.length, 20);
      assert.ok(histList.every(w => w.status === 'DONE'));

      // ?all=1: includes all workflows (25 history + 2 active + 1 HR = 28)
      const allRes = await requestGet(`${url}/api/workflows?all=1`);
      const allList = allRes.json();
      assert.equal(allList.length, 28);

      // ?test=1&all=1: includes test workflows
      const testRes = await requestGet(`${url}/api/workflows?test=1&all=1`);
      const testList = testRes.json();
      assert.ok(testList.some(w => w.workflowId === 'wf-test-1'));
      assert.ok(testList.some(w => w.workflowId === 'wf-agy-test-2'));
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('M2. User-facing semantics: Default selector shows ONLY active/unresolved workflows (A, B) and excludes C/D/E/F/G', async () => {
  const root = makeTempWorktreeRoot();
  try {
    // A: RUNNING
    fs.writeFileSync(path.join(root, 'wf-agy-a-running.state.json'), JSON.stringify({ workflowId: 'wf-agy-a-running', workflowStatus: 'RUNNING', stage: 'EXECUTOR', startedAt: '2026-08-31T10:00:00.000Z' }));
    // B: HUMAN_REQUIRED unresolved
    fs.writeFileSync(path.join(root, 'wf-agy-b-hr.state.json'), JSON.stringify({ workflowId: 'wf-agy-b-hr', workflowStatus: 'HUMAN_REQUIRED', stage: 'HUMAN_REQUIRED', startedAt: '2026-08-31T09:00:00.000Z' }));
    // C: DONE
    fs.writeFileSync(path.join(root, 'wf-agy-c-done.state.json'), JSON.stringify({ workflowId: 'wf-agy-c-done', workflowStatus: 'DONE', stage: 'DONE', startedAt: '2026-08-31T08:00:00.000Z' }));
    // D: STOPPED
    fs.writeFileSync(path.join(root, 'wf-agy-d-stopped.state.json'), JSON.stringify({ workflowId: 'wf-agy-d-stopped', workflowStatus: 'STOPPED', stage: 'STOPPED', startedAt: '2026-08-31T07:00:00.000Z' }));
    // E: SUPERSEDED
    fs.writeFileSync(path.join(root, 'wf-agy-e-superseded.state.json'), JSON.stringify({ workflowId: 'wf-agy-e-superseded', workflowStatus: 'STOPPED', stage: 'STOPPED', superseded: true, supersededBy: 'wf-agy-b-hr', startedAt: '2026-08-31T06:00:00.000Z' }));
    // F: FAILED but no user action
    fs.writeFileSync(path.join(root, 'wf-agy-f-failed.state.json'), JSON.stringify({ workflowId: 'wf-agy-f-failed', workflowStatus: 'FAILED', stage: 'FAILED', startedAt: '2026-08-31T05:00:00.000Z' }));
    // G: INTERNAL_TEST
    fs.writeFileSync(path.join(root, 'wf-test-g.state.json'), JSON.stringify({ workflowId: 'wf-test-g', kind: 'INTERNAL_TEST', workflowStatus: 'RUNNING', stage: 'EXECUTOR', startedAt: '2026-08-31T11:00:00.000Z' }));

    const attentionList = listRecentWorkflows({ root, view: 'attention' });
    const attentionIds = attentionList.map(w => w.workflowId);

    // Default selector MUST contain only A and B
    assert.deepEqual(attentionIds, ['wf-agy-b-hr', 'wf-agy-a-running']); // HUMAN_REQUIRED prioritized first

    // History view contains C, D, E, F
    const historyList = listRecentWorkflows({ root, view: 'history' });
    const historyIds = historyList.map(w => w.workflowId);
    assert.ok(historyIds.includes('wf-agy-c-done'));
    assert.ok(historyIds.includes('wf-agy-d-stopped'));
    assert.ok(historyIds.includes('wf-agy-e-superseded'));
    assert.ok(historyIds.includes('wf-agy-f-failed'));
    assert.ok(!historyIds.includes('wf-test-g')); // test excluded without includeTest
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario A: Starting unrelated USER workflow C does NOT supersede A or B in HUMAN_REQUIRED', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfA = 'wf-agy-a-hr';
    const wfB = 'wf-agy-b-hr';
    const wfC = 'wf-agy-c-new';

    fs.writeFileSync(path.join(root, `${wfA}.state.json`), JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));
    fs.writeFileSync(path.join(root, `${wfB}.state.json`), JSON.stringify({
      workflowId: wfB,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      startedAt: '2026-08-31T08:30:00.000Z',
    }));

    // Start unrelated workflow C (without supersedesWorkflowId)
    const { startSuperGPT } = await import('../src/orchestrator/supergpt.js');
    startSuperGPT({
      workflowId: wfC,
      kind: 'USER',
      root,
      _pipeline: async () => ({ status: 'RUNNING' }),
    });
    fs.writeFileSync(path.join(root, `${wfC}.state.json`), JSON.stringify({
      workflowId: wfC,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'EXECUTOR',
      startedAt: '2026-08-31T09:00:00.000Z',
    }));

    // Verify A and B are NOT modified and remain in HUMAN_REQUIRED
    const rawA = JSON.parse(fs.readFileSync(path.join(root, `${wfA}.state.json`), 'utf8'));
    assert.equal(rawA.workflowStatus, 'HUMAN_REQUIRED');
    assert.equal(rawA.superseded, undefined);

    const rawB = JSON.parse(fs.readFileSync(path.join(root, `${wfB}.state.json`), 'utf8'));
    assert.equal(rawB.workflowStatus, 'HUMAN_REQUIRED');
    assert.equal(rawB.superseded, undefined);

    // Attention list must contain ALL THREE: A, B, and C
    const att = listRecentWorkflows({ root, view: 'attention' });
    const attIds = att.map(w => w.workflowId);
    assert.ok(attIds.includes(wfA));
    assert.ok(attIds.includes(wfB));
    assert.ok(attIds.includes(wfC));
    assert.equal(att.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario B: Explicit replacement B starting with supersedesWorkflowId marks A as SUPERSEDED', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfA = 'wf-agy-a-hr';
    const wfB = 'wf-agy-b-replacement';

    fs.writeFileSync(path.join(root, `${wfA}.state.json`), JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));

    const { startSuperGPT } = await import('../src/orchestrator/supergpt.js');
    startSuperGPT({
      workflowId: wfB,
      supersedesWorkflowId: wfA,
      kind: 'USER',
      root,
      _pipeline: async () => ({ status: 'RUNNING' }),
    });
    fs.writeFileSync(path.join(root, `${wfB}.state.json`), JSON.stringify({
      workflowId: wfB,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'EXECUTOR',
      startedAt: '2026-08-31T09:00:00.000Z',
    }));

    // A is superseded
    const rawA = JSON.parse(fs.readFileSync(path.join(root, `${wfA}.state.json`), 'utf8'));
    assert.equal(rawA.workflowStatus, 'STOPPED');
    assert.equal(rawA.superseded, true);
    assert.equal(rawA.supersededBy, wfB);

    // Attention selector: contains ONLY B, A is gone
    const att = listRecentWorkflows({ root, view: 'attention' });
    assert.equal(att.length, 1);
    assert.equal(att[0].workflowId, wfB);

    // History: contains A
    const hist = listRecentWorkflows({ root, view: 'history' });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].workflowId, wfA);
    assert.equal(hist[0].superseded, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario C: Workflow A in HUMAN_REQUIRED with humanAnswer when resume fails remains in Attention', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfA = 'wf-agy-a-hr';
    const stateFile = path.join(root, `${wfA}.state.json`);
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      humanAnswer: 'Here is my fix',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));

    // Even though humanAnswer is recorded, resume did not succeed (status is still HUMAN_REQUIRED)
    const { computeRequiresAttention } = await import('../src/dashboard/meta.js');
    const rawA = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(computeRequiresAttention(rawA), true, 'HUMAN_REQUIRED must require attention until resume succeeds');

    const att = listRecentWorkflows({ root, view: 'attention' });
    assert.equal(att.length, 1);
    assert.equal(att[0].workflowId, wfA);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scenario D: Workflow A in HUMAN_REQUIRED when resume succeeds transitions to RUNNING -> DONE -> History', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfA = 'wf-agy-a-hr';
    const stateFile = path.join(root, `${wfA}.state.json`);
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));

    let att = listRecentWorkflows({ root, view: 'attention' });
    assert.equal(att.length, 1);
    assert.equal(att[0].workflowId, wfA);

    // Resume succeeds -> status updates to RUNNING
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'EXECUTOR',
      humanAnswer: 'Proceed',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));

    att = listRecentWorkflows({ root, view: 'attention' });
    assert.equal(att.length, 1);
    assert.equal(att[0].status, 'RUNNING');

    // Finished -> DONE
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId: wfA,
      kind: 'USER',
      workflowStatus: 'DONE',
      stage: 'DONE',
      startedAt: '2026-08-31T08:00:00.000Z',
    }));

    // DONE workflow disappears from Attention and enters History
    att = listRecentWorkflows({ root, view: 'attention' });
    assert.equal(att.length, 0);

    const hist = listRecentWorkflows({ root, view: 'history' });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].workflowId, wfA);
    assert.equal(hist[0].status, 'DONE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('N. Full lifecycle timeline contains all standard milestone events', () => {
  const fullDoneState = {
    startedAt: '2026-08-31T04:00:00.000Z',
    workflowStatus: 'DONE',
    stage: 'DONE',
    stageHistory: [
      { stage: 'INIT', startedAt: '2026-08-31T04:00:00.000Z' },
      { stage: 'PLANNING', startedAt: '2026-08-31T04:00:01.000Z' },
      { stage: 'PREFLIGHT', startedAt: '2026-08-31T04:00:05.000Z', taskId: 'task-1' },
      { stage: 'EXECUTOR', startedAt: '2026-08-31T04:00:06.000Z', taskId: 'task-1', attempt: 1 },
      { stage: 'GATE', startedAt: '2026-08-31T04:00:20.000Z', taskId: 'task-1', attempt: 1 },
      { stage: 'REVIEWER', startedAt: '2026-08-31T04:00:25.000Z', taskId: 'task-1', attempt: 1 },
      { stage: 'APPLYING', startedAt: '2026-08-31T04:00:35.000Z' },
      { stage: 'DONE', startedAt: '2026-08-31T04:00:40.000Z' },
    ],
    taskAttempts: [
      {
        taskId: 'task-1',
        attempt: 1,
        createdAt: '2026-08-31T04:00:06.000Z',
        updatedAt: '2026-08-31T04:00:30.000Z',
        gateResult: 'PASS',
        reviewerDecision: 'PASS',
      },
    ],
    lastProgressAt: '2026-08-31T04:00:40.000Z',
  };

  const timeline = deriveWorkflowTimeline(fullDoneState);
  const labels = timeline.map(e => e.label);

  assert.ok(labels.some(l => l === 'Workflow started'));
  assert.ok(labels.some(l => l === 'Planner completed' || l.includes('Planner completed')));
  assert.ok(labels.some(l => l.includes('Task started')));
  assert.ok(labels.some(l => l.includes('Executor completed')));
  assert.ok(labels.some(l => l.includes('Gate PASS')));
  assert.ok(labels.some(l => l.includes('Reviewer PASS')));
  assert.ok(labels.some(l => l === 'Workflow completed successfully'));
});

test('P. Focus tracking: INTERNAL_TEST and test workflow IDs cannot set user focus', () => {
  const root = makeTempWorktreeRoot();
  try {
    const focus1 = recordDashboardFocus({ workflowId: 'wf-test-sub', kind: 'INTERNAL_TEST', root });
    assert.equal(focus1, null);
    assert.equal(getDashboardFocus({ root }), null);

    const focus2 = recordDashboardFocus({ workflowId: 'wf-agy-test-999', kind: 'USER', root });
    assert.equal(focus2, null);
    assert.equal(getDashboardFocus({ root }), null);

    const focus3 = recordDashboardFocus({ workflowId: 'wf-agy-user-real-123', kind: 'USER', root });
    assert.ok(focus3);
    assert.equal(focus3.focusWorkflowId, 'wf-agy-user-real-123');
    assert.equal(getDashboardFocus({ root })?.focusWorkflowId, 'wf-agy-user-real-123');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Q. API /api/focus and /api/workflows return active focus and header', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wf = 'wf-agy-focus-test-1111-2222-3333-444455556666';
    fs.writeFileSync(path.join(root, `${wf}.state.json`), JSON.stringify({ workflowId: wf, workflowStatus: 'RUNNING', stage: 'EXECUTOR', startedAt: '2026-08-31T10:00:00.000Z' }));
    recordDashboardFocus({ workflowId: wf, kind: 'USER', root });

    const server = createDashboardServer({ port: 0, root });
    const { url } = await server.start();
    try {
      const focusRes = await requestGet(`${url}/api/focus`);
      assert.equal(focusRes.statusCode, 200);
      assert.equal(focusRes.json().focusWorkflowId, wf);

      const metaRes = await requestGet(`${url}/api/meta`);
      assert.equal(metaRes.statusCode, 200);
      assert.equal(metaRes.json().focusWorkflowId, wf);

      const workflowsRes = await requestGet(`${url}/api/workflows`);
      assert.equal(workflowsRes.statusCode, 200);
      assert.equal(workflowsRes.headers['x-supergpt-focus'], wf);
      const list = workflowsRes.json();
      assert.equal(list[0].isFocused, true);
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R. Dashboard Archive/Dismiss: POST /api/workflows/:id/dismiss moves HUMAN_REQUIRED to History without deleting data', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wf = 'wf-agy-hr-dismiss-test-1111-2222';
    const stateFile = path.join(root, `${wf}.state.json`);
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId: wf,
      kind: 'USER',
      workflowStatus: 'HUMAN_REQUIRED',
      stage: 'HUMAN_REQUIRED',
      startedAt: '2026-08-31T10:00:00.000Z',
      timeline: [{ label: 'Workflow started' }],
      evidence: { reason: 'Missing dependency' },
    }));

    const server = createDashboardServer({ port: 0, root });
    const { url } = await server.start();
    try {
      // 1. Initially appears in Attention
      let attRes = await requestGet(`${url}/api/workflows`);
      assert.equal(attRes.statusCode, 200);
      assert.equal(attRes.json().length, 1);
      assert.equal(attRes.json()[0].workflowId, wf);

      // 2. Call Dismiss endpoint
      const postRes = await requestPost(`${url}/api/workflows/${wf}/dismiss`);
      assert.equal(postRes.statusCode, 200);
      const postBody = postRes.json();
      assert.equal(postBody.ok, true);
      assert.equal(postBody.status, 'STOPPED');
      assert.equal(postBody.dismissed, true);

      // 3. Attention selector: now empty!
      attRes = await requestGet(`${url}/api/workflows`);
      assert.equal(attRes.statusCode, 200);
      assert.equal(attRes.json().length, 0);

      // 4. History view: contains the workflow with preserved state & evidence
      const histRes = await requestGet(`${url}/api/workflows?view=history`);
      assert.equal(histRes.statusCode, 200);
      const histList = histRes.json();
      assert.equal(histList.length, 1);
      assert.equal(histList[0].workflowId, wf);
      assert.equal(histList[0].dismissed, true);

      // 5. State file on disk is NOT deleted, evidence is preserved
      assert.ok(fs.existsSync(stateFile));
      const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(diskState.dismissed, true);
      assert.equal(diskState.dismissedReason, 'user_archived');
      assert.ok(diskState.dismissedAt);
      assert.equal(diskState.evidence.reason, 'Missing dependency');
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S. Security: Dismiss is forbidden on active RUNNING / STARTING / APPLYING workflows', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfRunning = 'wf-agy-running-security-1111';
    fs.writeFileSync(path.join(root, `${wfRunning}.state.json`), JSON.stringify({
      workflowId: wfRunning,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'EXECUTOR',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    const wfApplying = 'wf-agy-applying-security-2222';
    fs.writeFileSync(path.join(root, `${wfApplying}.state.json`), JSON.stringify({
      workflowId: wfApplying,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'APPLYING',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    const server = createDashboardServer({ port: 0, root });
    const { url } = await server.start();
    try {
      const resRunning = await requestPost(`${url}/api/workflows/${wfRunning}/dismiss`);
      assert.equal(resRunning.statusCode, 400);
      assert.equal(resRunning.json().error, 'DISMISS_NOT_ALLOWED');

      const resApplying = await requestPost(`${url}/api/workflows/${wfApplying}/dismiss`);
      assert.equal(resApplying.statusCode, 400);
      assert.equal(resApplying.json().error, 'DISMISS_NOT_ALLOWED');
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('T. Zombie / stale workflow lifecycle: dead process & expired heartbeat reconciles to STOPPED and moves out of Running', async () => {
  const root = makeTempWorktreeRoot();
  try {
    const wfZombie = 'wf-agy-zombie-old-1111';
    fs.writeFileSync(path.join(root, `${wfZombie}.state.json`), JSON.stringify({
      workflowId: wfZombie,
      kind: 'USER',
      workflowStatus: 'STARTING',
      stage: 'EXECUTOR',
      startedAt: '2026-08-28T10:00:00.000Z',
      heartbeatAt: '2026-08-28T10:05:00.000Z',
      taskName: 'Old zombie task',
    }));

    const wfLive = 'wf-agy-live-active-2222';
    fs.writeFileSync(path.join(root, `${wfLive}.state.json`), JSON.stringify({
      workflowId: wfLive,
      kind: 'USER',
      workflowStatus: 'RUNNING',
      stage: 'EXECUTOR',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      taskName: 'Real live active task',
    }));

    const server = createDashboardServer({ port: 0, root });
    const { url } = await server.start();
    try {
      // 1. GET /api/workflows
      const res = await requestGet(`${url}/api/workflows`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-supergpt-running-count'], '1', 'Only real live workflow counts in Running');

      const workflows = res.json();
      // Zombie workflow should NOT be in default Attention view
      assert.equal(workflows.some(w => w.workflowId === wfZombie), false);
      assert.equal(workflows.some(w => w.workflowId === wfLive), true);

      // 2. View History -> Zombie workflow has been reconciled to STOPPED
      const historyRes = await requestGet(`${url}/api/workflows?view=history`);
      const history = historyRes.json();
      const zombieInHistory = history.find(w => w.workflowId === wfZombie);
      assert.ok(zombieInHistory);
      assert.equal(zombieInHistory.canonicalStatus, 'STOPPED');
      assert.equal(zombieInHistory.requiresAttention, false);

      // 3. Check persisted state file on disk: reconciled with reason and data preserved
      const disk = JSON.parse(fs.readFileSync(path.join(root, `${wfZombie}.state.json`), 'utf8'));
      assert.equal(disk.workflowStatus, 'STOPPED');
      assert.equal(disk.stage, 'STOPPED');
      assert.ok(disk.stoppedReason.includes('zombie_reconciled'));
      assert.equal(disk.taskName, 'Old zombie task', 'Preserves task and history');
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

