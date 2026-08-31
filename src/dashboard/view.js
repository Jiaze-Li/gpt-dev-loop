// Dashboard HTML UI Template for SuperGPT Local Dashboard.
// Single-page, zero heavy frameworks, clean GitHub-inspired light theme.

// Home page polls /api/workflows on this cadence. Zero model tokens, no Core
// state-machine dependency -- it is a plain GET against the read-only server.
export const DASHBOARD_POLL_INTERVAL_MS = 1000;

// Stable current-workflow selection rule shared by the server-rendered page and
// this module's tests (injected verbatim into the client via toString()).
//
// Inputs:
//   currentId    - the workflow currently being viewed ('' if none yet)
//   lastKnownId  - the most recent workflow that was actually available
//   workflows    - list from /api/workflows (workflowId, kind, status, badge, startedAt, requiresAttention)
//
// Rules:
//   - An active selection (currentId or lastKnownId still in list) NEVER auto-switches.
//     Whether it is RUNNING, STARTING, HUMAN_REQUIRED, or DONE/FAILED/STOPPED (terminal),
//     it remains pinned to that workflow until the human manually chooses another or
//     an explicit new workflow URL is opened.
//   - No preemption: newer RUNNING workflows and internal test workflows never steal focus.
//   - Initial auto-selection (no current selection): prioritizes Attention USER workflows
//     (unresolved HUMAN_REQUIRED first, then newest RUNNING/STARTING), falls back to
//     newest USER workflow, then to the first entry.
export function chooseWorkflow({ currentId = '', lastKnownId = '', workflows = [] } = {}) {
  const list = Array.isArray(workflows) ? workflows : [];
  const isTestId = (id) => /^(?:wf-)?(?:agy-)?test[-_]|^test[-_]/i.test(String(id || ''));
  const isUserWorkflow = (w) => (w && w.kind ? w.kind === 'USER' : !isTestId(w?.workflowId));
  const isAttention = (w) => {
    if (!isUserWorkflow(w)) return false;
    if (w.requiresAttention === true) return true;
    const key = String((w && w.badge && w.badge.key) || (w && w.status) || '').toUpperCase();
    return key === 'RUNNING' || key === 'STARTING' || key === 'HUMAN_REQUIRED';
  };
  const isHR = (w) => {
    const key = String((w && w.badge && w.badge.key) || (w && w.status) || '').toUpperCase();
    return key === 'HUMAN_REQUIRED';
  };
  const startedMs = (w) => (w && w.startedAt ? new Date(w.startedAt).getTime() : 0);

  // 1. If current selection exists in the list, KEEP IT.
  // Pinned/selected workflow stays put while RUNNING and remains on its final result when DONE.
  const current = list.find((w) => w.workflowId === currentId) || null;
  if (current) {
    return current.workflowId;
  }

  // 2. If lastKnownId exists in the list, stay on it.
  const lastKnown = list.find((w) => w.workflowId === lastKnownId) || null;
  if (lastKnown) {
    return lastKnown.workflowId;
  }

  // 3. No current selection: prioritize Attention USER workflows (HUMAN_REQUIRED first, then newest RUNNING/STARTING).
  const userWorkflows = list.filter(isUserWorkflow);
  const attentionCandidates = userWorkflows.filter(isAttention);
  if (attentionCandidates.length > 0) {
    const hr = attentionCandidates.filter(isHR).sort((a, b) => startedMs(b) - startedMs(a));
    if (hr.length > 0) return hr[0].workflowId;
    const running = attentionCandidates.sort((a, b) => startedMs(b) - startedMs(a));
    return running[0].workflowId;
  }

  const sortedCandidates = [...userWorkflows].sort((a, b) => startedMs(b) - startedMs(a));
  if (sortedCandidates.length > 0) {
    return sortedCandidates[0].workflowId;
  }

  return currentId || (list[0] && list[0].workflowId) || '';
}

export function renderDashboardHtml({ initialWorkflowId = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperGPT Local Dashboard</title>
  <style>
    :root {
      --bg: #f6f8fa;
      --card-bg: #ffffff;
      --card-border: #d0d7de;
      --text: #24292f;
      --text-bright: #1f2328;
      --text-muted: #57606a;
      --accent: #0969da;
      --success: #1a7f37;
      --warning: #9a6700;
      --danger: #cf222e;
      --idle: #6e7781;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .badge {
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.9rem;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .badge-RUNNING { background: #ddf4ff; color: #0969da; border: 1px solid #54aeff; }
    .badge-STARTING { background: #ddf4ff; color: #0969da; border: 1px solid #54aeff; }
    .badge-DONE { background: #dafbe1; color: #1a7f37; border: 1px solid #4ac26b; }
    .badge-HUMAN_REQUIRED { background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c; }
    .badge-FAILED { background: #ffebe9; color: #cf222e; border: 1px solid #ff8182; }
    .badge-STOPPED { background: #f6f8fa; color: #57606a; border: 1px solid #d0d7de; }
    .badge-SUPERSEDED { background: #f6f8fa; color: #57606a; border: 1px solid #d0d7de; }
    .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    select {
      background: var(--card-bg);
      color: var(--text-bright);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
      outline: none;
      cursor: pointer;
    }
    .btn-toggle {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.85rem;
      cursor: pointer;
      color: var(--text-muted);
      font-weight: 600;
      transition: all 0.15s ease;
    }
    .btn-toggle:hover {
      border-color: var(--text-muted);
    }
    .btn-toggle.active {
      color: var(--accent);
      border-color: var(--accent);
      background: #ddf4ff;
    }
    .summary-counts {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 600;
      display: inline-flex;
      gap: 12px;
      margin-left: 8px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--success);
      display: inline-block;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(26, 127, 55, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(26, 127, 55, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(26, 127, 55, 0); }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(31, 35, 40, 0.05);
    }
    .card-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 12px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
    }
    .prop-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 6px 0;
      border-bottom: 1px solid #eaeef2;
      font-size: 0.9rem;
    }
    .prop-row:last-child { border-bottom: none; }
    .prop-key { color: var(--text-muted); }
    .prop-val { font-weight: 600; color: var(--text-bright); text-align: right; word-break: break-all; }
    .tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      border: 1px solid transparent;
    }
    .tag-waiting { background: #f6f8fa; color: #57606a; border-color: #d0d7de; }
    .tag-running { background: #ddf4ff; color: #0969da; border-color: #54aeff; }
    .tag-done, .tag-pass { background: #dafbe1; color: #1a7f37; border-color: #4ac26b; }
    .tag-fail, .tag-rework { background: #ffebe9; color: #cf222e; border-color: #ff8182; }
    .tag-idle { background: #f6f8fa; color: #57606a; border-color: #d0d7de; }
    
    .timeline-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(31, 35, 40, 0.05);
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 12px;
    }
    .timeline-item {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      position: relative;
      padding-left: 20px;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 6px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
    }
    .timeline-item.pass::before { background: var(--success); }
    .timeline-item.fail::before, .timeline-item.rework::before { background: var(--danger); }
    .timeline-item.escalation::before { background: var(--warning); }
    .time-col {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85rem;
      color: var(--text-muted);
      min-width: 75px;
      font-weight: 500;
    }
    .content-col { flex: 1; font-size: 0.9rem; }
    .content-label { color: var(--text-bright); font-weight: 600; }
    .content-detail { color: var(--text-muted); font-size: 0.8rem; margin-top: 2px; }
    .empty-state { text-align: center; color: var(--text-muted); padding: 40px 0; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <span class="badge badge-STARTING" id="status-badge">SUPERGPT ⟳ STARTING</span>
        <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 500;" id="header-task">-</span>
        <div class="summary-counts" id="summary-counts">
          <span>Running <strong id="cnt-running" style="color: var(--accent);">0</strong></span>
          <span>Needs attention <strong id="cnt-attention" style="color: var(--warning);">0</strong></span>
        </div>
      </div>
      <div class="controls">
        <span class="pulse-dot" title="Live Polling (1s)"></span>
        <select id="workflow-select" onchange="onSelectWorkflow(this.value)">
          <option value="">Loading workflows...</option>
        </select>
        <button id="btn-dismiss" class="btn-toggle" style="display: none; color: #cf222e; border-color: #ff8182;" onclick="dismissCurrentWorkflow()">Dismiss</button>
        <button id="btn-history" class="btn-toggle" onclick="toggleHistory()">History</button>
        <label style="font-size: 0.8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; cursor: pointer;">
          <input type="checkbox" id="chk-test" onchange="toggleTestWorkflows(this.checked)"> Show test
        </label>
      </div>
    </header>

    <div class="grid">
      <!-- 1. Task Card Overview -->
      <div class="card">
        <div class="card-title">Workflow &amp; Task</div>
        <div class="prop-row">
          <span class="prop-key">Workflow</span>
          <span class="prop-val" id="val-workflow-id">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Task</span>
          <span class="prop-val" id="val-task">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Attempt</span>
          <span class="prop-val" id="val-attempt">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Stage</span>
          <span class="prop-val" id="val-stage">-</span>
        </div>
      </div>

      <!-- 2. Role Statuses -->
      <div class="card">
        <div class="card-title">Role Statuses</div>
        <div class="prop-row">
          <span class="prop-key">Planner</span>
          <span class="prop-val"><span class="tag tag-idle" id="role-planner">-</span></span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Supervisor</span>
          <span class="prop-val"><span class="tag tag-idle" id="role-supervisor">-</span></span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Executor</span>
          <span class="prop-val"><span class="tag tag-idle" id="role-executor">-</span></span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Gate</span>
          <span class="prop-val"><span class="tag tag-idle" id="role-gate">-</span></span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Reviewer</span>
          <span class="prop-val"><span class="tag tag-idle" id="role-reviewer">-</span></span>
        </div>
      </div>

      <!-- 3. Retries & Escalation -->
      <div class="card">
        <div class="card-title">Retry &amp; Escalation</div>
        <div class="prop-row">
          <span class="prop-key">Normal retry</span>
          <span class="prop-val" id="val-normal-retry">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Escalation retry</span>
          <span class="prop-val" id="val-escalation-retry">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Escalation active</span>
          <span class="prop-val" id="val-escalation-active">No</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Terminal</span>
          <span class="prop-val" id="val-terminal">-</span>
        </div>
      </div>

      <!-- 4. Timing & Heartbeat -->
      <div class="card">
        <div class="card-title">Activity &amp; Timing</div>
        <div class="prop-row">
          <span class="prop-key">Elapsed</span>
          <span class="prop-val" id="val-elapsed">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Heartbeat</span>
          <span class="prop-val" id="val-heartbeat">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Last progress</span>
          <span class="prop-val" id="val-progress">-</span>
        </div>
        <div class="prop-row">
          <span class="prop-key">Last activity</span>
          <span class="prop-val" id="val-activity">-</span>
        </div>
      </div>

      <!-- 5. Execution & Usage -->
      <div class="card" style="grid-column: 1 / -1;">
        <div class="card-title">Token Breakdown &amp; Execution</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">
          <!-- Col 1: Local Measured Roles -->
          <div>
            <div style="font-weight: 600; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); text-transform: uppercase;">Token Breakdown</div>
            <div class="prop-row"><span class="prop-key">Planner</span><span class="prop-val" id="tok-planner">0</span></div>
            <div class="prop-row"><span class="prop-key">Executor</span><span class="prop-val" id="tok-executor">0</span></div>
            <div class="prop-row"><span class="prop-key">Internal Reviewer</span><span class="prop-val" id="tok-internal-reviewer">0</span></div>
            <div class="prop-row"><span class="prop-key">Supervisor</span><span class="prop-val" id="tok-supervisor">0</span></div>
            <div class="prop-row" style="margin-top: 4px; border-top: 1px dashed var(--border); padding-top: 4px;">
              <span class="prop-key" style="font-weight: 700;">Measured Total</span>
              <span class="prop-val" style="color: var(--accent); font-weight: 700;" id="tok-measured-total">0</span>
            </div>
          </div>

          <!-- Col 2: Executor Models Breakdown -->
          <div>
            <div style="font-weight: 600; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); text-transform: uppercase;">Executor Models</div>
            <div id="tok-executor-models" style="font-size: 12px;">
              <span style="color: var(--text-secondary);">-</span>
            </div>
          </div>

          <div>
            <div style="font-weight: 600; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); text-transform: uppercase;">Executor Input Breakdown</div>
            <div id="tok-executor-input-breakdown" style="font-size: 12px;"><span style="color: var(--text-secondary);">Unavailable (legacy usage)</span></div>
            <div id="tok-executor-input-calls" style="font-size: 12px; margin-top: 8px;"></div>
          </div>

          <!-- Col 3: PR Reviewer (External) vs Internal Reviewer -->
          <div>
            <div style="font-weight: 600; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); text-transform: uppercase;">Reviewers (PR vs Internal)</div>
            <div class="prop-row">
              <span class="prop-key">PR Reviewer</span>
              <span class="prop-val" id="val-pr-reviewer">-</span>
            </div>
            <div class="prop-row">
              <span class="prop-key">PR Reviewer Tokens</span>
              <span class="prop-val" id="val-pr-reviewer-tokens" style="color: var(--text-secondary); font-style: italic;">External / unavailable</span>
            </div>
            <div class="prop-row" style="margin-top: 4px; border-top: 1px dashed var(--border); padding-top: 4px;">
              <span class="prop-key">Internal Reviewer</span>
              <span class="prop-val" id="val-internal-reviewer-status">Not invoked</span>
            </div>
            <div class="prop-row">
              <span class="prop-key">Internal Reviewer Tokens</span>
              <span class="prop-val" id="tok-internal-reviewer-tokens">0</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Timeline -->
    <div class="timeline-card" id="review-threads-card" style="display: none;">
      <div class="card-title">Review Threads</div>
      <div id="review-threads-summary" class="content-label">Open 0 · Resolved 0 · Resolution Failed 0</div>
      <div id="review-findings" style="margin-top: 12px;"></div>
    </div>

    <div class="timeline-card">
      <div class="card-title">Workflow Timeline</div>
      <div class="timeline" id="timeline-container">
        <div class="empty-state">No events recorded yet.</div>
      </div>
    </div>
  </div>

  <script>
    let currentWorkflowId = '${initialWorkflowId}';
    let lastKnownWorkflowId = currentWorkflowId;
    let lastSeenServerFocusId = '';
    let knownWorkflows = [];
    let showHistory = false;
    let showTest = false;
    const POLL_INTERVAL_MS = ${DASHBOARD_POLL_INTERVAL_MS};

    ${chooseWorkflow.toString()}

    function formatTime(iso) {
      if (!iso) return '-';
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toTimeString().split(' ')[0];
      } catch { return iso; }
    }

    function setTag(elId, text, type) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = text || '-';
      el.className = 'tag tag-' + (type || 'idle').toLowerCase();
    }

    function toggleHistory() {
      showHistory = !showHistory;
      const btn = document.getElementById('btn-history');
      if (btn) {
        btn.className = showHistory ? 'btn-toggle active' : 'btn-toggle';
        btn.textContent = showHistory ? 'Attention Only' : 'History';
      }
      fetchWorkflowList();
    }

    function toggleTestWorkflows(checked) {
      showTest = Boolean(checked);
      fetchWorkflowList();
    }

    async function dismissCurrentWorkflow() {
      if (!currentWorkflowId) return;
      try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(currentWorkflowId) + '/dismiss', { method: 'POST' });
        if (res.ok) {
          fetchWorkflowList();
          updateWorkflowDetail();
        }
      } catch (err) {}
    }

    async function fetchWorkflowList() {
      try {
        const params = new URLSearchParams();
        if (showTest) params.set('test', '1');
        if (showHistory) params.set('all', '1');
        const res = await fetch('/api/workflows' + (params.toString() ? '?' + params.toString() : ''));
        if (!res.ok) return;
        const list = await res.json();
        knownWorkflows = list;

        const runningCount = res.headers.get('X-SuperGPT-Running-Count');
        const attentionCount = res.headers.get('X-SuperGPT-Attention-Count');
        if (runningCount != null) {
          const el = document.getElementById('cnt-running');
          if (el) el.textContent = runningCount;
        }
        if (attentionCount != null) {
          const el = document.getElementById('cnt-attention');
          if (el) el.textContent = attentionCount;
        }

        const serverFocusId = res.headers.get('X-SuperGPT-Focus') || (list.find(w => w.isFocused)?.workflowId) || '';
        let changed = false;

        // When a new user prompt explicitly starts a new USER workflow, the server focus changes.
        // In that event, update focus to the new workflow in this same tab.
        if (serverFocusId && lastSeenServerFocusId && serverFocusId !== lastSeenServerFocusId) {
          lastSeenServerFocusId = serverFocusId;
          changed = (serverFocusId !== currentWorkflowId);
          currentWorkflowId = serverFocusId;
          lastKnownWorkflowId = serverFocusId;
        } else {
          if (!lastSeenServerFocusId && serverFocusId) {
            lastSeenServerFocusId = serverFocusId;
            if (!currentWorkflowId) {
              currentWorkflowId = serverFocusId;
              lastKnownWorkflowId = serverFocusId;
              changed = true;
            }
          }
          const nextId = chooseWorkflow({
            currentId: currentWorkflowId,
            lastKnownId: lastKnownWorkflowId,
            workflows: list,
          });
          if (nextId && nextId !== currentWorkflowId) {
            currentWorkflowId = nextId;
            changed = true;
          }
        }

        if (currentWorkflowId && list.some(w => w.workflowId === currentWorkflowId)) {
          lastKnownWorkflowId = currentWorkflowId;
        }

        const select = document.getElementById('workflow-select');
        select.innerHTML = '';

        const attentionItems = list.filter(w => w.requiresAttention);
        const historyItems = list.filter(w => !w.requiresAttention);

        if (showHistory) {
          if (attentionItems.length > 0) {
            const grpAtt = document.createElement('optgroup');
            grpAtt.label = 'Attention (' + attentionItems.length + ')';
            attentionItems.forEach(w => {
              const opt = document.createElement('option');
              opt.value = w.workflowId;
              const badgeKey = (w.badge && w.badge.key) || w.status;
              opt.textContent = '[' + badgeKey + '] ' + w.workflowId.slice(0, 18) + '... (' + (w.elapsed || '00:00') + ')';
              if (w.workflowId === currentWorkflowId) opt.selected = true;
              grpAtt.appendChild(opt);
            });
            select.appendChild(grpAtt);
          }
          if (historyItems.length > 0) {
            const grpHist = document.createElement('optgroup');
            grpHist.label = 'History (' + historyItems.length + ')';
            historyItems.forEach(w => {
              const opt = document.createElement('option');
              opt.value = w.workflowId;
              const badgeKey = (w.badge && w.badge.key) || w.status;
              opt.textContent = '[' + badgeKey + '] ' + w.workflowId.slice(0, 18) + '... (' + (w.elapsed || '00:00') + ')';
              if (w.workflowId === currentWorkflowId) opt.selected = true;
              grpHist.appendChild(opt);
            });
            select.appendChild(grpHist);
          }
          if (select.children.length === 0) {
            select.innerHTML = '<option value="">No workflows found</option>';
          }
        } else {
          // Attention-only view
          if (attentionItems.length === 0 && !currentWorkflowId) {
            select.innerHTML = '<option value="">No active workflows</option>';
          } else {
            attentionItems.forEach(w => {
              const opt = document.createElement('option');
              opt.value = w.workflowId;
              const badgeKey = (w.badge && w.badge.key) || w.status;
              opt.textContent = '[' + badgeKey + '] ' + w.workflowId.slice(0, 18) + '... (' + (w.elapsed || '00:00') + ')';
              if (w.workflowId === currentWorkflowId) opt.selected = true;
              select.appendChild(opt);
            });

            // If user is currently looking at a finished/history workflow X, keep X in the dropdown so selection isn't lost
            if (currentWorkflowId && !attentionItems.some(w => w.workflowId === currentWorkflowId)) {
              const curHist = historyItems.find(w => w.workflowId === currentWorkflowId);
              const opt = document.createElement('option');
              opt.value = currentWorkflowId;
              const badgeKey = (curHist && curHist.badge && curHist.badge.key) || (curHist && curHist.status) || 'CURRENT';
              opt.textContent = '[' + badgeKey + '] ' + currentWorkflowId.slice(0, 18) + '... (Current)';
              opt.selected = true;
              select.appendChild(opt);
            }
          }
        }

        if (currentWorkflowId) {
          select.value = currentWorkflowId;
        }

        if (changed) {
          window.history.replaceState(null, '', '/workflow/' + encodeURIComponent(currentWorkflowId));
          updateWorkflowDetail();
        }
      } catch (err) {}
    }

    async function updateWorkflowDetail() {
      if (!currentWorkflowId) return;
      try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(currentWorkflowId));
        if (!res.ok) return;
        const data = await res.json();

        // 1. Badge — single canonical mapping computed server-side; header and
        //    workflow selector both consume it so they can never disagree.
        const badge = document.getElementById('status-badge');
        const badgeInfo = data.badge || { key: 'STARTING', text: 'SUPERGPT ⟳ STARTING' };
        badge.className = 'badge badge-' + badgeInfo.key;
        badge.textContent = badgeInfo.text;

        // 2. Header Task — ordinal is the real current-task position from the
        //    projection; show it as unknown rather than faking "Task 1".
        const taskObj = data.task || {};
        let taskText = (taskObj.current && taskObj.total)
          ? \`Task \${taskObj.current} / \${taskObj.total}\${taskObj.title ? ' — ' + taskObj.title : ''}\`
          : (taskObj.title || taskObj.taskId || '-');
        if (data.prCloseout) {
          taskText = \`Mode: PR CLOSEOUT | PR #\${data.prCloseout.prNumber || '-'}\`;
        }
        document.getElementById('header-task').textContent = taskText;

        // Dismiss action: allowed only on HUMAN_REQUIRED or actionable FAILED
        const btnDismiss = document.getElementById('btn-dismiss');
        if (btnDismiss) {
          const canDismiss = data.requiresAttention && (data.canonicalStatus === 'HUMAN_REQUIRED' || data.canonicalStatus === 'FAILED');
          btnDismiss.style.display = canDismiss ? 'inline-block' : 'none';
        }

        // 3. Grid Values
        document.getElementById('val-workflow-id').textContent = data.workflowId || '-';
        document.getElementById('val-task').textContent = data.prCloseout
          ? \`PR #\${data.prCloseout.prNumber} (Head: \${(data.prCloseout.prHead || data.prCloseout.reviewedPrHead || '-').slice(0, 7)})\`
          : taskText;
        document.getElementById('val-attempt').textContent = data.prCloseout
          ? \`Round \${data.prCloseout.repairRounds || 0} / \${data.prCloseout.maxRepairRounds || 3}\`
          : (data.attempt || 1);
        document.getElementById('val-stage').textContent = data.prCloseout
          ? \`PR Closeout (\${data.prCloseout.lastAction || 'TRIGGERED'})\`
          : (data.stage || '-');

        // 4. Role Statuses
        if (data.prCloseout) {
          setTag('role-planner', 'BYPASSED', 'idle');
          setTag('role-supervisor', data.prCloseout.escalated ? 'ESCALATED' : 'IDLE', data.prCloseout.escalated ? 'running' : 'idle');
          setTag('role-executor', data.prCloseout.repairRounds > 0 ? \`REPAIR R\${data.prCloseout.repairRounds}\` : 'IDLE', data.prCloseout.repairRounds > 0 ? 'running' : 'idle');
          setTag('role-gate', 'PASS', 'done');
          const revName = (data.prCloseout.activeReviewer || data.prCloseout.prReviewer || data.prCloseout.configuredReviewer || 'codex').toUpperCase();
          const revStatus = data.prCloseout.reviewedPrHead ? 'REVIEWED' : 'TRIGGERED';
          setTag('role-reviewer', \`\${revName} (\${revStatus})\`, data.prCloseout.reviewedPrHead ? 'done' : 'running');
        } else {
          setTag('role-planner', data.stageStatuses?.planner || (data.taskTotal ? 'DONE' : 'WAITING'), data.stageStatuses?.planner || 'done');
          setTag('role-supervisor', data.stageStatuses?.supervisor || (data.modelEscalated ? 'ESCALATED' : 'IDLE'), data.stageStatuses?.supervisor || 'idle');
          setTag('role-executor', data.executor?.status || 'WAITING', data.executor?.status || 'waiting');
          setTag('role-gate', data.gate?.status || 'WAITING', data.gate?.status || 'waiting');
          setTag('role-reviewer', data.reviewer?.status || 'WAITING', data.reviewer?.status || 'waiting');
        }

        // 5. Retries
        document.getElementById('val-normal-retry').textContent = \`\${data.normalAttempts || 0} / \${data.maxAttemptsPerTask || 3}\`;
        document.getElementById('val-escalation-retry').textContent = \`\${data.escalationAttempts || 0} / \${data.maxEscalationAttempts || 2}\`;
        document.getElementById('val-escalation-active').textContent = data.escalationActive ? 'Yes' : 'No';
        document.getElementById('val-terminal').textContent = data.terminal ? 'Yes' : 'No';

        // 6. Timing
        const timing = data.timing || {};
        document.getElementById('val-elapsed').textContent = timing.elapsed || '00:00';
        document.getElementById('val-heartbeat').textContent = formatTime(timing.heartbeatAt);
        document.getElementById('val-progress').textContent = formatTime(timing.lastProgressAt);
        document.getElementById('val-activity').textContent = formatTime(timing.lastActivityAt);

        // 7. Execution & Token Breakdown
        const usage = data.usage || {};
        const isPrCloseout = data.path === 'PR_CLOSEOUT' || Boolean(data.prCloseout);

        // Planner
        const pTok = usage.planner?.totalTokens || 0;
        document.getElementById('tok-planner').textContent = pTok > 0 ? pTok.toLocaleString() : (usage.planner?.calls > 0 ? \`\${usage.planner.calls} calls\` : '0');

        // Executor
        const eTok = usage.executor?.totalTokens || 0;
        document.getElementById('tok-executor').textContent = eTok > 0 ? eTok.toLocaleString() : (usage.executor?.calls > 0 ? \`\${usage.executor.calls} calls\` : '0');

        // Internal Reviewer
        const irTok = (usage.internalReviewer?.totalTokens ?? usage.reviewer?.totalTokens) || 0;
        const irCalls = (usage.internalReviewer?.calls ?? usage.reviewer?.calls) || 0;
        document.getElementById('tok-internal-reviewer').textContent = irTok > 0 ? irTok.toLocaleString() : (irCalls > 0 ? \`\${irCalls} calls\` : '0');
        document.getElementById('tok-internal-reviewer-tokens').textContent = irTok > 0 ? irTok.toLocaleString() : (irCalls > 0 ? \`\${irCalls} calls\` : '0');

        // Supervisor
        const sTok = usage.supervisor?.totalTokens || 0;
        document.getElementById('tok-supervisor').textContent = sTok > 0 ? sTok.toLocaleString() : (usage.supervisor?.calls > 0 ? \`\${usage.supervisor.calls} calls\` : '0');

        // Measured Total
        const mTot = (usage.measuredTotal?.totalTokens ?? usage.total?.totalTokens) ?? (pTok + eTok + irTok + sTok);
        const mCalls = (usage.measuredTotal?.calls ?? usage.total?.calls) ?? ((usage.planner?.calls || 0) + (usage.executor?.calls || 0) + irCalls + (usage.supervisor?.calls || 0));
        document.getElementById('tok-measured-total').textContent = mTot > 0 ? mTot.toLocaleString() : (mCalls > 0 ? \`\${mCalls} calls\` : '0');

        // Executor models breakdown
        const execModelsContainer = document.getElementById('tok-executor-models');
        const execByModel = usage.executor?.byModel || {};
        const execModelKeys = Object.keys(execByModel);
        if (execModelKeys.length > 0) {
          execModelsContainer.innerHTML = execModelKeys.map(k => {
            const m = execByModel[k];
            const tokStr = m.totalTokens > 0 ? \`\${m.totalTokens.toLocaleString()} tok\` : \`\${m.calls} calls\`;
            return \`<div class="prop-row"><span class="prop-key">\${escapeHtml(k)}</span><span class="prop-val">\${escapeHtml(tokStr)}</span></div>\`;
          }).join('');
        } else if (data.executor?.model || data.executor?.provider) {
          const providerStr = \`\${data.executor.provider || 'claude'}:\${data.executor.model || 'sonnet'}\`;
          execModelsContainer.innerHTML = \`<div class="prop-row"><span class="prop-key">\${escapeHtml(providerStr)}</span><span class="prop-val">\${eTok > 0 ? \`\${eTok.toLocaleString()} tok\` : '-'}</span></div>\`;
        } else {
          execModelsContainer.innerHTML = '<span style="color: var(--text-secondary);">-</span>';
        }

        const categoryLabels = { taskCard: 'Task Card', repoContext: 'Repo Context', history: 'History', evidence: 'Evidence', other: 'Other' };
        const inputAggregate = usage.executorInputBreakdownAggregate;
        const inputCalls = Array.isArray(usage.executorInputBreakdownCalls) ? usage.executorInputBreakdownCalls : [];
        const inputBreakdownContainer = document.getElementById('tok-executor-input-breakdown');
        const inputCallsContainer = document.getElementById('tok-executor-input-calls');
        if (inputAggregate && inputAggregate.callsWithBreakdown > 0) {
          inputBreakdownContainer.innerHTML = Object.keys(categoryLabels).map(k => {
            const item = inputAggregate.categories?.[k] || {};
            return \`<div class="prop-row"><span class="prop-key">\${categoryLabels[k]}</span><span class="prop-val">\${(item.tokens || 0).toLocaleString()} input tok</span></div>\`;
          }).join('') + \`<div class="prop-row"><span class="prop-key">Provider totals</span><span class="prop-val">\${(inputAggregate.providerInputTokens || 0).toLocaleString()} input · \${(inputAggregate.cachedTokens || 0).toLocaleString()} cached (subset)</span></div>\`;
          inputCallsContainer.innerHTML = inputCalls.map((call, index) => {
            if (!call.breakdown) return \`<div class="prop-row"><span class="prop-key">Call \${index + 1}</span><span class="prop-val">Unavailable (legacy)</span></div>\`;
            const composition = Object.keys(categoryLabels).map(k => \`\${categoryLabels[k]} \${(call.breakdown.categories?.[k]?.tokens || 0).toLocaleString()}\`).join(' · ');
            return \`<div class="prop-row"><span class="prop-key">\${escapeHtml(call.taskId || call.callId || 'Call ' + (index + 1))}</span><span class="prop-val">\${escapeHtml(composition)} · provider \${(call.inputTokens || 0).toLocaleString()} input / \${(call.cachedTokens || 0).toLocaleString()} cached</span></div>\`;
          }).join('');
        } else {
          inputBreakdownContainer.innerHTML = '<span style="color: var(--text-secondary);">Unavailable (legacy usage)</span>';
          inputCallsContainer.innerHTML = '';
        }

        // PR Reviewer (External) vs Internal Reviewer
        if (isPrCloseout) {
          const revName = data.prCloseout?.configuredReviewer || data.prCloseout?.activeReviewer || usage.externalPrReviewer?.reviewer || 'Codex';
          const isReviewed = Boolean(data.prCloseout?.reviewedPrHead);
          const prRevStatus = isReviewed ? \`\${revName.toUpperCase()} · REVIEWED\` : \`\${revName.toUpperCase()} · TRIGGERED\`;
          document.getElementById('val-pr-reviewer').textContent = prRevStatus;
          document.getElementById('val-pr-reviewer-tokens').textContent = 'External / unavailable';
          document.getElementById('val-internal-reviewer-status').textContent = 'Not invoked';
        } else {
          document.getElementById('val-pr-reviewer').textContent = 'N/A (Standard Path)';
          document.getElementById('val-pr-reviewer-tokens').textContent = 'N/A';
          const hasIntRev = irTok > 0 || irCalls > 0;
          document.getElementById('val-internal-reviewer-status').textContent = hasIntRev ? 'Invoked' : 'Not invoked';
        }

        // 8. Durable review-thread state. Counts and finding badges are a
        // direct rendering of the server projection; the browser infers no
        // resolution from head movement or other review metadata.
        const reviewThreads = data.reviewThreads || { open: 0, resolved: 0, resolutionFailed: 0, findings: [] };
        const reviewCard = document.getElementById('review-threads-card');
        reviewCard.style.display = reviewThreads.findings.length > 0 ? 'block' : 'none';
        document.getElementById('review-threads-summary').textContent =
          \`Open \${reviewThreads.open} · Resolved \${reviewThreads.resolved} · Resolution Failed \${reviewThreads.resolutionFailed}\`;
        document.getElementById('review-findings').innerHTML = reviewThreads.findings.map(finding => {
          const status = ['OPEN', 'FIXED', 'RESOLVED'].includes(finding.lifecycle) ? finding.lifecycle : 'OPEN';
          const tagClass = status === 'RESOLVED' ? 'done' : (finding.threadResolutionStatus === 'FAILED' ? 'failed' : status === 'FIXED' ? 'running' : 'waiting');
          const location = finding.file ? finding.file + (finding.line == null ? '' : ':' + finding.line) : (finding.title || 'Review finding');
          const failed = finding.threadResolutionStatus === 'FAILED' ? ' · Resolution Failed' : '';
          return \`<div class="prop-row"><span class="prop-key">\${escapeHtml(location)}</span><span class="prop-val"><span class="tag tag-\${tagClass}">\${escapeHtml(status)}</span>\${escapeHtml(failed)}</span></div>\`;
        }).join('');

        // 9. Timeline
        const tlContainer = document.getElementById('timeline-container');
        const events = data.timeline || [];
        if (events.length === 0) {
          tlContainer.innerHTML = '<div class="empty-state">No events recorded yet.</div>';
        } else {
          tlContainer.innerHTML = events.map(ev => {
            const cls = ev.type.includes('PASS') ? 'pass' : (ev.type.includes('FAIL') || ev.type.includes('REWORK')) ? 'fail' : ev.type.includes('ESCALATION') ? 'escalation' : '';
            const safeTime = escapeHtml(ev.time || '--:--:--');
            const safeLabel = escapeHtml(ev.label || '');
            const safeDetail = ev.detail ? \`<div class="content-detail">\${escapeHtml(ev.detail)}</div>\` : '';
            return \`
              <div class="timeline-item \${cls}">
                <div class="time-col">\${safeTime}</div>
                <div class="content-col">
                  <div class="content-label">\${safeLabel}</div>
                  \${safeDetail}
                </div>
              </div>
            \`;
          }).join('');
        }
      } catch (err) {}
    }

    function onSelectWorkflow(id) {
      if (!id) return;
      currentWorkflowId = id;
      lastKnownWorkflowId = id;
      lastSeenServerFocusId = id;
      window.history.replaceState(null, '', '/workflow/' + encodeURIComponent(id));
      updateWorkflowDetail();
    }

    // Auto-poll loop: refresh the workflow list and current detail every 1s.
    fetchWorkflowList().then(() => updateWorkflowDetail());
    setInterval(() => {
      fetchWorkflowList();
      updateWorkflowDetail();
    }, POLL_INTERVAL_MS);
  </script>
</body>
</html>`;
}
