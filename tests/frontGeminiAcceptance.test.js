import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer } from '../bin/supergpt-mcp.js';
import {
  runSuperGPT,
  supergptStatus,
  supergptStop,
  supergptResume,
  formatTransitionEvent,
} from '../src/orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { WorkflowStateManager } from '../src/orchestrator/workflowState.js';

const execFileAsync = promisify(execFile);

async function createTestMcpClient(options = {}) {
  const server = createSuperGptMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'front-gemini-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}

test('TASK 5: Full Front-Gemini Acceptance Test across MCP interface', async () => {
  const testDir = path.join('/tmp', `supergpt-acceptance-${Date.now()}`);
  const repoDir = path.join(testDir, 'target-project');
  await mkdir(repoDir, { recursive: true });

  // 1. Initialize real git repository
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'SuperGPT Tester'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'tester@supergpt.local'], { cwd: repoDir });

  // Initial committed file
  await writeFile(path.join(repoDir, 'main.js'), 'console.log("initial version");\n', 'utf8');
  await execFileAsync('git', ['add', 'main.js'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });

  // 2. Add harmless pre-existing uncommitted changes (both modified tracked file and untracked file)
  await writeFile(path.join(repoDir, 'main.js'), 'console.log("initial version");\n// USER_UNCOMMITTED_WIP\n', 'utf8');
  await writeFile(path.join(repoDir, 'notes.txt'), 'USER_SCRATCHPAD_UNTRACKED\n', 'utf8');

  // Verify workspace is dirty
  const { stdout: statusBefore } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoDir });
  assert.match(statusBefore, /M main\.js/);
  assert.match(statusBefore, /\?\? notes\.txt/);

  // 3. Connect Front-Gemini MCP client
  let executorAttempts = [];
  let reviewerCalls = [];
  let recordedTransitions = [];

  const mockPipeline = async ({
    goal,
    cwd,
    emit,
    workflowId,
    workflowStateManager,
    lifecycleManager,
    isResume,
    answer,
  }) => {
    // Stage 1: Planning
    workflowStateManager?.startStage('PLANNING');
    emit('stage_changed', { stage: 'planning' });
    workflowStateManager?.recordProgress({ taskTotal: 2 });

    // Stage 2: Executing Task 1
    workflowStateManager?.startStage('EXECUTOR', { taskId: 'task-greeting', attempt: 1, taskIndex: 1, taskTotal: 2 });
    emit('task_started', { taskId: 'task-greeting' });
    emit('task_attempt_started', { taskId: 'task-greeting', attempt: 1 });
    executorAttempts.push({ taskId: 'task-greeting', attempt: 1, model: 'sonnet' });

    // Attempt 1 fails verification -> Reviewer requests REWORK
    emit('verification_finished', { taskId: 'task-greeting', attempt: 1, result: 'FAIL' });
    reviewerCalls.push({ taskId: 'task-greeting', attempt: 1, decision: 'REWORK' });
    emit('review_finished', { taskId: 'task-greeting', attempt: 1, decision: 'REWORK', requiredChanges: ['Fix typo in export'] });
    emit('rework_requested', { taskId: 'task-greeting', attempt: 1 });

    // Attempt 2 starts (fresh session)
    workflowStateManager?.startStage('EXECUTOR', { taskId: 'task-greeting', attempt: 2, taskIndex: 1, taskTotal: 2 });
    emit('task_attempt_started', { taskId: 'task-greeting', attempt: 2 });
    executorAttempts.push({ taskId: 'task-greeting', attempt: 2, model: 'sonnet' });

    // Attempt 2 passes verification -> Reviewer PASS
    emit('verification_finished', { taskId: 'task-greeting', attempt: 2, result: 'PASS' });
    reviewerCalls.push({ taskId: 'task-greeting', attempt: 2, decision: 'PASS' });
    emit('review_finished', { taskId: 'task-greeting', attempt: 2, decision: 'PASS' });

    // Task 2 starts
    workflowStateManager?.startStage('EXECUTOR', { taskId: 'task-math', attempt: 1, taskIndex: 2, taskTotal: 2 });
    emit('task_started', { taskId: 'task-math' });
    emit('task_attempt_started', { taskId: 'task-math', attempt: 1 });
    executorAttempts.push({ taskId: 'task-math', attempt: 1, model: 'sonnet' });
    emit('verification_finished', { taskId: 'task-math', attempt: 1, result: 'PASS' });
    reviewerCalls.push({ taskId: 'task-math', attempt: 1, decision: 'PASS' });
    emit('review_finished', { taskId: 'task-math', attempt: 1, decision: 'PASS' });

    // Stage 3: Delivery
    workflowStateManager?.startStage('APPLYING');
    emit('stage_changed', { stage: 'delivery' });

    // Simulate delivering new files into the invocation workspace without touching user WIP
    await writeFile(path.join(cwd, 'greeting.js'), 'export function hello() { return "hello"; }\n', 'utf8');
    await writeFile(path.join(cwd, 'math.js'), 'export function add(a, b) { return a + b; }\n', 'utf8');

    emit('delivery_succeeded', { changedFiles: ['greeting.js', 'math.js'] });
    workflowStateManager?.transitionTerminal('DONE', { summary: 'Implemented greeting and math helpers' });
    emit('workflow_finished', { status: 'WORKFLOW_DONE', summary: 'Implemented greeting and math helpers' });

    return {
      status: 'WORKFLOW_DONE',
      summary: 'Implemented greeting and math helpers',
      deliveredFiles: ['greeting.js', 'math.js'],
      workflowId,
      tokenUsage: {
        total: { calls: 5, inputTokens: 42000, outputTokens: 3500 },
      },
    };
  };

  const { client } = await createTestMcpClient({
    runSuperGptFn: (opts) => {
      opts.onEvent = (e) => {
        const trans = formatTransitionEvent(e);
        if (trans) recordedTransitions.push(trans);
      };
      return runSuperGPT({ ...opts, _pipeline: mockPipeline });
    },
    resolveWorkflowPlanFn: async ({ planArg, cwd }) => ({
      status: 'READY',
      summary: 'Plan: add greeting and math helpers',
      plan: '1. Add greeting.js\n2. Add math.js',
      tasks: [{ task_id: 'task-greeting' }, { task_id: 'task-math' }],
    }),
  });

  try {
    // 4. Test supergpt_plan through MCP
    const planResult = await client.callTool({
      name: 'supergpt_plan',
      arguments: {
        goal: 'Add greeting and math helpers',
        cwd: repoDir,
      },
    });
    assert.equal(planResult.structuredContent.status, 'READY');
    assert.equal(planResult.structuredContent.tasks.length, 2);

    // 5. Test supergpt_run through MCP
    const runResult = await client.callTool({
      name: 'supergpt_run',
      arguments: {
        goal: 'Add greeting and math helpers',
        cwd: repoDir,
      },
    });

    assert.equal(runResult.structuredContent.status, 'WORKFLOW_DONE');
    assert.deepEqual(runResult.structuredContent.deliveredFiles, ['greeting.js', 'math.js']);
    assert.ok(runResult.structuredContent.workflowId);

    // 6. Verify Acceptance Invariants:
    // a. New delivered files exist in the invocation workspace
    assert.equal(existsSync(path.join(repoDir, 'greeting.js')), true);
    assert.equal(existsSync(path.join(repoDir, 'math.js')), true);

    // b. Pre-existing uncommitted changes remain INTACT!
    const mainContent = await readFile(path.join(repoDir, 'main.js'), 'utf8');
    assert.match(mainContent, /\/\/ USER_UNCOMMITTED_WIP/);
    const notesContent = await readFile(path.join(repoDir, 'notes.txt'), 'utf8');
    assert.match(notesContent, /USER_SCRATCHPAD_UNTRACKED/);

    // c. Fresh sessions & REWORK occurred
    assert.equal(executorAttempts.length, 3); // 2 attempts on task 1, 1 attempt on task 2
    assert.equal(reviewerCalls.length, 3);
    assert.equal(reviewerCalls[0].decision, 'REWORK');
    assert.equal(reviewerCalls[1].decision, 'PASS');

    // d. Semantic transitions captured
    assert.ok(recordedTransitions.some((t) => t.includes('TASK_STARTED')));
    assert.ok(recordedTransitions.some((t) => t.includes('GATE_FAIL')));
    assert.ok(recordedTransitions.some((t) => t.includes('REVIEWER_REWORK')));
    assert.ok(recordedTransitions.some((t) => t.includes('CONTINUE_REWORK')));
    assert.ok(recordedTransitions.some((t) => t.includes('GATE_PASS')));
    assert.ok(recordedTransitions.some((t) => t.includes('WORKFLOW_DONE')));

    // e. Token usage reported
    assert.ok(runResult.structuredContent.tokenUsage);
    assert.equal(runResult.structuredContent.tokenUsage.total.calls, 5);

    // 7. Test HUMAN_REQUIRED -> Resume flow through MCP
    let humanFlowCalls = 0;
    const humanWorkflowId = 'wf-human-acceptance-1';

    const humanPipeline = async ({ answer, workflowStateManager }) => {
      humanFlowCalls += 1;
      if (humanFlowCalls === 1) {
        workflowStateManager?.transitionTerminal('HUMAN_REQUIRED', {
          question: 'Should the greeting support localization?',
          reason: 'Architecture clarification needed',
        });
        return {
          status: 'HUMAN_REQUIRED',
          question: 'Should the greeting support localization?',
          reason: 'Architecture clarification needed',
          workflowId: humanWorkflowId,
        };
      }
      // Resumed call
      workflowStateManager?.transitionTerminal('DONE', {
        summary: `Configured localization=${answer}`,
      });
      return {
        status: 'WORKFLOW_DONE',
        summary: `Configured localization=${answer}`,
        deliveredFiles: ['i18n.js'],
        workflowId: humanWorkflowId,
      };
    };

    // Initialize mock workspace metadata for resume
    await mkdir(SUPERGPT_WORKTREE_ROOT, { recursive: true });
    await writeFile(
      path.join(SUPERGPT_WORKTREE_ROOT, `${humanWorkflowId}.workspace.json`),
      JSON.stringify({
        workflow_id: humanWorkflowId,
        source_workspace: repoDir,
        source_repo_root: repoDir,
        source_branch: 'main',
        baseline_head: 'mock',
        worktree_path: path.join(testDir, 'mock-worktree'),
      })
    );

    const { client: humanClient } = await createTestMcpClient({
      runSuperGptFn: (opts) => runSuperGPT({ ...opts, workflowId: humanWorkflowId, _pipeline: humanPipeline }),
      resumeSuperGptFn: (opts) => supergptResume({ ...opts, _pipeline: humanPipeline }),
    });

    // Run triggers HUMAN_REQUIRED
    const initialRun = await humanClient.callTool({
      name: 'supergpt_run',
      arguments: { goal: 'Configure localization', cwd: repoDir },
    });
    assert.equal(initialRun.structuredContent.status, 'HUMAN_REQUIRED');
    assert.equal(initialRun.structuredContent.question, 'Should the greeting support localization?');

    // Resume with user answer
    const resumedRun = await humanClient.callTool({
      name: 'supergpt_resume',
      arguments: {
        workflowId: humanWorkflowId,
        answer: 'Yes, support en and es',
        cwd: repoDir,
      },
    });
    assert.equal(resumedRun.structuredContent.status, 'WORKFLOW_DONE');
    assert.match(resumedRun.structuredContent.summary, /localization=Yes, support en and es/);

    // 8. Test supergpt_stop through MCP
    const { client: stopClient } = await createTestMcpClient();
    const stopRes = await stopClient.callTool({
      name: 'supergpt_stop',
      arguments: {
        workflowId: humanWorkflowId,
        reason: 'testing stop tool',
      },
    });
    assert.equal(stopRes.structuredContent.status, 'STOPPED');
    assert.equal(stopRes.structuredContent.reason, 'testing stop tool');
  } finally {
    await client.close();
    await rm(testDir, { recursive: true, force: true });
  }
});
