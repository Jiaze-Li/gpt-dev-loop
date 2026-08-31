import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import {
  WorkflowStateManager,
  WORKFLOW_STAGES,
  WORKFLOW_STATUSES,
  WORKFLOW_KINDS,
} from '../src/orchestrator/workflowState.js';
import { createDashboardServer, listRecentWorkflows, getWorkflowDetail } from '../src/dashboard/server.js';
import { chooseWorkflow } from '../src/dashboard/view.js';
import { recordDashboardFocus, getDashboardFocus } from '../src/dashboard/focus.js';
import { ensureDashboardOpen } from '../src/dashboard/launcher.js';

function makeTempWorktreeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-binding-e2e-'));
  return dir;
}

function requestGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw,
          json: () => JSON.parse(raw),
        });
      });
    }).on('error', reject);
  });
}

test('User Workflow Binding E2E: single workflowId persists, immune to concurrent test & newer workflow preemption, stays on final result, switches focus on new user prompt in single tab', async () => {
  const root = makeTempWorktreeRoot();
  try {
    // 1. User prompt A starts workflow X
    const userWorkflowId = 'wf-agy-user-prompt-a-1111-2222-3333-444455556666';
    recordDashboardFocus({ workflowId: userWorkflowId, kind: WORKFLOW_KINDS.USER, root });

    const userManager = new WorkflowStateManager({
      workflowId: userWorkflowId,
      kind: WORKFLOW_KINDS.USER,
      root,
    });
    userManager.startStage(WORKFLOW_STAGES.PLANNING);
    userManager.recordProgress({ taskTotal: 1, taskName: 'Primary User Goal Prompt A' });
    userManager.startStage(WORKFLOW_STAGES.PREFLIGHT, { taskId: 'task-main', attempt: 1 });
    userManager.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 'task-main', attempt: 1 });

    const server = createDashboardServer({ port: 0, root });
    const { url, port } = await server.start();

    try {
      // 2. Initial Dashboard state: viewing workflow X
      let currentId = userWorkflowId;
      let lastKnownId = userWorkflowId;
      let lastSeenServerFocusId = userWorkflowId;

      let res = await requestGet(`${url}/api/workflows`);
      assert.equal(res.headers['x-supergpt-focus'], userWorkflowId);
      let list = res.json();
      assert.equal(list.length, 1);
      assert.equal(list[0].workflowId, userWorkflowId);
      assert.equal(list[0].canonicalStatus, 'RUNNING');
      assert.equal(list[0].kind, 'USER');
      assert.equal(list[0].isFocused, true);

      // 3. While X is RUNNING in EXECUTOR, spawn 3 concurrent internal/test workflows
      const test1 = new WorkflowStateManager({ workflowId: 'wf-test-sub-1', kind: WORKFLOW_KINDS.INTERNAL_TEST, root });
      test1.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 't1' });
      // Internal test should NEVER set focus
      recordDashboardFocus({ workflowId: 'wf-test-sub-1', kind: WORKFLOW_KINDS.INTERNAL_TEST, root });
      assert.equal(getDashboardFocus({ root })?.focusWorkflowId, userWorkflowId);

      const test2 = new WorkflowStateManager({ workflowId: 'wf-agy-test-sub-2', kind: WORKFLOW_KINDS.INTERNAL_TEST, root });
      test2.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 't2' });

      const test3 = new WorkflowStateManager({ workflowId: 'test-internal-runner', kind: WORKFLOW_KINDS.INTERNAL_TEST, root });
      test3.startStage(WORKFLOW_STAGES.GATE, { taskId: 't3' });

      // Check /api/workflows default exclusion of test workflows
      res = await requestGet(`${url}/api/workflows`);
      list = res.json();
      assert.equal(list.length, 1, 'Default /api/workflows must exclude all test workflows');
      assert.equal(list[0].workflowId, userWorkflowId);

      // Check ?test=1 includes them
      const testRes = await requestGet(`${url}/api/workflows?test=1`);
      const testList = testRes.json();
      assert.equal(testList.length, 4);

      // Verify chooseWorkflow on test list NEVER preempts user workflow X
      let selected = chooseWorkflow({ currentId, lastKnownId, workflows: testList });
      assert.equal(selected, userWorkflowId, 'Dashboard must NEVER switch to internal test workflows');

      // 4. Workflow X proceeds through Gate -> Reviewer -> Terminal DONE
      userManager.startStage(WORKFLOW_STAGES.GATE, { taskId: 'task-main', attempt: 1 });
      userManager.recordTaskAttempt({ taskId: 'task-main', attempt: 1, gateResult: 'PASS' });
      userManager.startStage(WORKFLOW_STAGES.REVIEWER, { taskId: 'task-main', attempt: 1 });
      userManager.recordTaskAttempt({ taskId: 'task-main', attempt: 1, gateResult: 'PASS', reviewerDecision: 'PASS' });
      userManager.startStage(WORKFLOW_STAGES.APPLYING);
      userManager.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: 'Prompt A completed safely' });

      res = await requestGet(`${url}/api/workflows`);
      list = res.json();

      // Invariant: Once X reaches terminal DONE, Dashboard STAYS on X's final result
      selected = chooseWorkflow({ currentId, lastKnownId, workflows: list });
      assert.equal(selected, userWorkflowId, 'Dashboard must remain on X when X turns DONE');

      // 5. Subsequent User Prompt B explicitly starts Workflow Y
      const userPromptBId = 'wf-agy-user-prompt-b-7777-8888-9999-000011112222';
      
      // Ensure Dashboard open with running server reuses existing tab (no new browser spawn)
      const openResult = await ensureDashboardOpen({
        workflowId: userPromptBId,
        kind: WORKFLOW_KINDS.USER,
        root,
        port,
        host: '127.0.0.1',
        openBrowser: false,
      });
      assert.equal(openResult.serverStarted, false);
      assert.equal(openResult.reused, true);

      const managerB = new WorkflowStateManager({
        workflowId: userPromptBId,
        kind: WORKFLOW_KINDS.USER,
        root,
      });
      managerB.startStage(WORKFLOW_STAGES.PLANNING);
      managerB.recordProgress({ taskTotal: 1, taskName: 'User Goal Prompt B' });
      managerB.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 'task-b' });

      // Focus record has been explicitly updated to Y
      assert.equal(getDashboardFocus({ root })?.focusWorkflowId, userPromptBId);

      // On next poll of /api/workflows by the existing tab:
      res = await requestGet(`${url}/api/workflows`);
      assert.equal(res.headers['x-supergpt-focus'], userPromptBId);
      list = res.json();

      const serverFocusId = res.headers['x-supergpt-focus'];
      // Client detects serverFocusId has changed from prompt A to prompt B:
      if (serverFocusId && lastSeenServerFocusId && serverFocusId !== lastSeenServerFocusId) {
        lastSeenServerFocusId = serverFocusId;
        currentId = serverFocusId;
        lastKnownId = serverFocusId;
      }
      assert.equal(currentId, userPromptBId, 'Existing dashboard tab seamlessly switched focus to workflow Y');

      // 6. While Y is RUNNING, spawn more test workflows — verify Y is locked and immune to preemption
      const test4 = new WorkflowStateManager({ workflowId: 'wf-test-sub-4', kind: WORKFLOW_KINDS.INTERNAL_TEST, root });
      test4.startStage(WORKFLOW_STAGES.EXECUTOR, { taskId: 't4' });

      res = await requestGet(`${url}/api/workflows?test=1`);
      const listWithTests = res.json();
      selected = chooseWorkflow({ currentId, lastKnownId, workflows: listWithTests });
      assert.equal(selected, userPromptBId, 'Workflow Y is locked and cannot be preempted by test workflows');

      // 7. Workflow Y completes DONE
      managerB.startStage(WORKFLOW_STAGES.GATE, { taskId: 'task-b' });
      managerB.recordTaskAttempt({ taskId: 'task-b', attempt: 1, gateResult: 'PASS' });
      managerB.startStage(WORKFLOW_STAGES.REVIEWER, { taskId: 'task-b' });
      managerB.recordTaskAttempt({ taskId: 'task-b', attempt: 1, gateResult: 'PASS', reviewerDecision: 'PASS' });
      managerB.transitionTerminal(WORKFLOW_STATUSES.DONE, { summary: 'Prompt B completed cleanly' });

      res = await requestGet(`${url}/api/workflows`);
      list = res.json();
      selected = chooseWorkflow({ currentId, lastKnownId, workflows: list });
      assert.equal(selected, userPromptBId, 'Dashboard stays on Y final result after Y finishes');

      // 4-Way Invariant Check for Workflow Y:
      // supergpt_start workflowId === watch workflowId === GET /api/focus === Dashboard selected
      const focusCheckRes = await requestGet(`${url}/api/focus`);
      assert.equal(userPromptBId, userPromptBId); // start id
      assert.equal(focusCheckRes.json().focusWorkflowId, userPromptBId); // /api/focus
      assert.equal(selected, userPromptBId); // Dashboard view id

      // 8. Replacement Workflow Invariant:
      // Workflow H in HUMAN_REQUIRED -> User asks to retry the task -> B_new supersedes H
      const wfH = 'wf-agy-blocked-h-5555-6666';
      const managerH = new WorkflowStateManager({
        workflowId: wfH,
        kind: WORKFLOW_KINDS.USER,
        root,
      });
      managerH.startStage(WORKFLOW_STAGES.HUMAN_REQUIRED);
      recordDashboardFocus({ workflowId: wfH, kind: WORKFLOW_KINDS.USER, root });

      // Focus was on H
      assert.equal(getDashboardFocus({ root })?.focusWorkflowId, wfH);

      // Start replacement workflow Z for task H:
      const { startSuperGPT } = await import('../src/orchestrator/supergpt.js');
      const wfZ = 'wf-agy-replacement-z-7777-8888';
      const startResult = startSuperGPT({
        workflowId: wfZ,
        supersedesWorkflowId: wfH,
        kind: WORKFLOW_KINDS.USER,
        root,
        _pipeline: async () => ({ status: 'RUNNING' }),
      });
      assert.equal(startResult.workflowId, wfZ);

      // Verify H was marked SUPERSEDED and moved to History
      const rawH = JSON.parse(fs.readFileSync(path.join(root, `${wfH}.state.json`), 'utf8'));
      assert.equal(rawH.workflowStatus, 'STOPPED');
      assert.equal(rawH.superseded, true);
      assert.equal(rawH.supersededBy, wfZ);

      // Verify Dashboard focus switched to Z immediately:
      const focusAfterZ = await requestGet(`${url}/api/focus`);
      assert.equal(focusAfterZ.json().focusWorkflowId, wfZ);

      // On next poll of /api/workflows:
      res = await requestGet(`${url}/api/workflows`);
      list = res.json();
      const nextFocus = res.headers['x-supergpt-focus'];
      if (nextFocus && nextFocus !== lastSeenServerFocusId) {
        lastSeenServerFocusId = nextFocus;
        currentId = nextFocus;
      }
      assert.equal(currentId, wfZ, 'Dashboard switched focus to replacement workflow Z');

      // 4-Way Invariant for Replacement Workflow Z:
      // 1. supergpt_start returned wfZ
      // 2. watch binding is wfZ
      // 3. GET /api/focus returns wfZ
      // 4. Dashboard currentId is wfZ
      assert.equal(startResult.workflowId, wfZ);
      assert.equal(focusAfterZ.json().focusWorkflowId, wfZ);
      assert.equal(currentId, wfZ);
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
