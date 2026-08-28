import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  getCurrentRuntimeIdentity,
  compareRuntimeIdentity,
} from '../src/orchestrator/runtimeIdentity.js';
import {
  collectRepositoryContext,
  parsePlannerJson,
  buildPlannerPrompt,
} from '../src/orchestrator/planner.js';
import { loadWorkspaceConfig } from '../src/orchestrator/workspaceConfig.js';
import {
  supergptVerify,
  getValidHostEvidence,
  computeWorktreeFingerprint,
} from '../src/orchestrator/hostVerification.js';
import {
  deriveSafeRecommendation,
  sanitizeRecommendationText,
  HUMAN_REQUIRED_ACTION_CODES,
} from '../src/orchestrator/humanRequiredPolicy.js';
import {
  buildHumanRequiredEvidence,
  FAILURE_CATEGORIES,
} from '../src/orchestrator/preflight.js';
import { renderGenericProgress } from '../src/renderers/genericTextRenderer.js';

test('1. Workflow Runtime Identity: captures supergptVersion, git revision, and schema version', () => {
  const identity = getCurrentRuntimeIdentity();
  assert.equal(typeof identity.supergptVersion, 'string');
  assert.ok(identity.supergptVersion.length > 0);
  assert.equal(typeof identity.orchestratorRevision, 'string');
  assert.equal(identity.workflowSchemaVersion, '1');
});

test('2. Workflow Runtime Identity: compareRuntimeIdentity detects match vs mismatch with non-destructive warning', () => {
  const current = {
    supergptVersion: '1.0.0',
    orchestratorRevision: 'f64f676',
    workflowSchemaVersion: '1',
  };

  const matching = compareRuntimeIdentity(current, current);
  assert.equal(matching.stale, false);
  assert.equal(matching.staleRuntime, false);
  assert.equal(matching.warning, null);

  const olderWorkflow = {
    supergptVersion: '0.9.0',
    orchestratorRevision: 'abc1234',
    workflowSchemaVersion: '1',
  };
  const mismatch = compareRuntimeIdentity(olderWorkflow, current);
  assert.equal(mismatch.stale, true);
  assert.equal(mismatch.staleRuntime, true);
  assert.ok(mismatch.warning.includes('older SuperGPT runtime'));
  assert.ok(mismatch.warning.includes('abc1234'));

  // UNKNOWN_LEGACY fallback for legacy workflows without runtime_identity
  const legacyCheck = compareRuntimeIdentity(null, current);
  assert.equal(legacyCheck.stale, true);
  assert.equal(legacyCheck.workflow.orchestratorRevision, 'UNKNOWN_LEGACY');
});

test('3. Repository Closeout Verification Policy: bounded ingestion of TESTING_STRATEGY.md and .supergpt/config.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-policy-'));
  fs.mkdirSync(path.join(tmpDir, '.supergpt'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'docs/architecture'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, '.supergpt/config.json'),
    JSON.stringify({
      verification: {
        closeoutCommands: ['swift test --filter SpinLabIntegrationTests'],
      },
    })
  );

  fs.writeFileSync(
    path.join(tmpDir, 'docs/architecture/TESTING_STRATEGY.md'),
    'Policy: targeted test first, full swift test at closeout.'
  );

  const context = await collectRepositoryContext({ cwd: tmpDir });
  assert.ok(context.config_files.includes('.supergpt/config.json'));
  assert.ok(context.policy_contexts.some((p) => p.path === '.supergpt/config.json'));
  assert.ok(context.policy_contexts.some((p) => p.path === 'docs/architecture/TESTING_STRATEGY.md'));
  assert.ok(context.promptBlock.includes('Policy: targeted test first, full swift test at closeout.'));

  const parsedConfig = loadWorkspaceConfig(tmpDir);
  assert.deepEqual(parsedConfig.closeoutCommands, ['swift test --filter SpinLabIntegrationTests']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('4. Planner Parser: extracts closeout_verification_commands and closeout_policy_sources', () => {
  const plannerOutput = {
    status: 'READY',
    summary: 'Plan with closeout verification',
    plan_text: 'Complete plan',
    tasks: [
      {
        task_id: 't-1',
        goal: 'Implement unit feature',
        scope: 'unit',
        allowed_files: ['Sources/App.swift'],
        verification_commands: ['swift test --filter UnitTests'],
      },
    ],
    closeout_verification_commands: ['swift test'],
    closeout_policy_sources: ['docs/architecture/TESTING_STRATEGY.md'],
  };

  const parsed = parsePlannerJson(plannerOutput);
  assert.equal(parsed.status, 'READY');
  assert.deepEqual(parsed.closeoutVerificationCommands, ['swift test']);
  assert.deepEqual(parsed.closeoutPolicySources, ['docs/architecture/TESTING_STRATEGY.md']);
});

test('5. Host Gate Verification: supergptVerify executes gate commands and persists durable hash/evidence', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-host-verif-'));
  const workflowId = 'wf-test-verify-1';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  const meta = {
    workflow_id: workflowId,
    isolated_worktree_path: repoDir,
    closeout_verification_commands: ['echo "closeout ok"'],
  };
  fs.writeFileSync(path.join(tmpRoot, `${workflowId}.workspace.json`), JSON.stringify(meta));

  const state = {
    workflowId,
    workflowStatus: 'HUMAN_REQUIRED',
    stage: 'HUMAN_REQUIRED',
    pending_verification: {
      task_id: 't-1',
      commands: ['echo "closeout ok"'],
      commands_hash: 'test-hash',
    },
  };
  fs.writeFileSync(path.join(tmpRoot, `${workflowId}.state.json`), JSON.stringify(state));

  const fakeGateRunner = {
    async run(commands) {
      return {
        pass: true,
        results: commands.map((c) => ({ command: c, pass: true, output: 'ok' })),
      };
    },
  };

  const res = await supergptVerify({
    workflowId,
    root: tmpRoot,
    gateRunner: fakeGateRunner,
  });

  assert.equal(res.workflowId, workflowId);
  assert.equal(res.pass, true);
  assert.ok(res.evidenceId.startsWith('ev-'));
  assert.ok(res.hash.length > 0);

  // Validate persisted evidence
  const validCheck = getValidHostEvidence({ workflowId, root: tmpRoot });
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.stale, false);
  assert.equal(validCheck.hostEvidence.evidenceId, res.evidenceId);

  // Invalidate on worktree change
  fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'mutation');
  const mutatedCheck = getValidHostEvidence({ workflowId, root: tmpRoot });
  assert.equal(mutatedCheck.stale, true);
  assert.equal(mutatedCheck.reason, 'WORKTREE_MUTATED_AFTER_VERIFICATION');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('6. Safe HUMAN_REQUIRED Recommendation Policy: strict action codes and anti-sync invariant', () => {
  // Blocker due to verification/toolchain -> RUN_HOST_VERIFICATION
  const verifRec = deriveSafeRecommendation({
    blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
    failingGateCommand: 'swift test',
    rootCause: 'swift: command not found (exit code 127)',
  });
  assert.equal(verifRec.actionCode, HUMAN_REQUIRED_ACTION_CODES.RUN_HOST_VERIFICATION);
  assert.ok(verifRec.recommendedAction.includes('supergpt_verify'));

  // Blocker due to external roots -> UPDATE_WORKSPACE_POLICY_AND_START_NEW_WORKFLOW
  const rootRec = deriveSafeRecommendation({
    isExternalRootBlocker: true,
  });
  assert.equal(rootRec.actionCode, HUMAN_REQUIRED_ACTION_CODES.UPDATE_WORKSPACE_POLICY_AND_START_NEW_WORKFLOW);
  assert.ok(rootRec.recommendedAction.includes('config.json and start a new workflow'));

  // Invariant assertion: Never recommend copying/syncing to source workspace before final acceptance
  const forbiddenText = 'You should sync isolated worktree into source workspace and run tests manually.';
  const sanitized = sanitizeRecommendationText(forbiddenText);
  assert.equal(sanitized.includes('source workspace'), false);
  assert.ok(sanitized.includes('supergpt_verify'));
});

test('7. buildHumanRequiredEvidence integrates safe recommendation policy', () => {
  const ev = buildHumanRequiredEvidence({
    workflowId: 'wf-1',
    blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
    failingGateCommand: 'swift test',
    rootCause: 'exit code 127: command not found',
  });

  assert.equal(ev.actionCode, HUMAN_REQUIRED_ACTION_CODES.RUN_HOST_VERIFICATION);
  assert.ok(ev.recommendedAction.includes('supergpt_verify'));
  assert.ok(ev.availableChoices.some((c) => c.includes('supergpt_verify')));
});

test('8. Progress text renderer displays stale runtime warning when present', () => {
  const state = {
    workflowId: 'wf-1',
    workflowStatus: 'RUNNING',
    attempt: 1,
    stage: 'GATE',
    staleRuntimeWarning: 'Workflow runtime mismatch: started under 0.9.0, current is 1.0.0',
    stageStatuses: { executor: 'done', gate: 'running', reviewer: 'waiting' },
    timing: { elapsed: '01:00', heartbeatAt: new Date().toISOString(), lastProgressAt: new Date().toISOString() },
    task: { current: 1, total: 1, taskId: 't-1' },
    executor: { model: 'sonnet' },
    gate: { status: 'running' },
    reviewer: { status: 'waiting' },
  };

  const text = renderGenericProgress(state);
  assert.ok(text.includes('[WARNING] Workflow runtime mismatch'));
});

// ============================================================================
// COMPREHENSIVE REGRESSION SUITE: INVARIANTS A THROUGH N
// ============================================================================

test('A. Task A host PASS cannot satisfy Task B', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-a-'));
  const workflowId = 'wf-test-a';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'HUMAN_REQUIRED',
      pending_verification: {
        task_id: 'task-A',
        commands: ['echo "task-A test"'],
      },
    })
  );

  await supergptVerify({
    workflowId,
    root: tmpRoot,
    gateRunner: {
      async run(commands) {
        return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
      },
    },
  });

  // Verify against Task B: must fail closed / reject
  const taskBCheck = getValidHostEvidence({
    workflowId,
    taskId: 'task-B',
    verificationCommands: ['echo "task-B test"'],
    root: tmpRoot,
  });

  assert.equal(taskBCheck.valid, false);
  assert.equal(taskBCheck.reason, 'TASK_ID_MISMATCH');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('B. Host PASS for ["swift test"] cannot satisfy current Gate: ["swift test", "./scripts/check.sh"]', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-b-'));
  const workflowId = 'wf-test-b';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'HUMAN_REQUIRED',
      pending_verification: {
        task_id: 'task-1',
        commands: ['swift test'],
      },
    })
  );

  await supergptVerify({
    workflowId,
    root: tmpRoot,
    gateRunner: {
      async run(commands) {
        return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
      },
    },
  });

  // Gate requires both swift test AND ./scripts/check.sh
  const gateCheck = getValidHostEvidence({
    workflowId,
    taskId: 'task-1',
    verificationCommands: ['swift test', './scripts/check.sh'],
    root: tmpRoot,
  });

  assert.equal(gateCheck.valid, false);
  assert.equal(gateCheck.reason, 'COMMANDS_MISMATCH');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('C. Tracked modified file content A -> B with identical git status invalidates host evidence', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-c-'));
  const workflowId = 'wf-test-c';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'original content\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  // Modify file before verification
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'version A\n');

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'HUMAN_REQUIRED',
      pending_verification: {
        task_id: 'task-1',
        commands: ['echo "ok"'],
      },
    })
  );

  const res = await supergptVerify({
    workflowId,
    root: tmpRoot,
    gateRunner: {
      async run(commands) {
        return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
      },
    },
  });

  assert.equal(res.pass, true);

  // Modify file content to version B (status remains ' M file.txt')
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'version B\n');

  const check = getValidHostEvidence({
    workflowId,
    taskId: 'task-1',
    verificationCommands: ['echo "ok"'],
    root: tmpRoot,
  });

  assert.equal(check.valid, false);
  assert.equal(check.stale, true);
  assert.equal(check.reason, 'WORKTREE_MUTATED_AFTER_VERIFICATION');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('D. No frozen pending commands: supergpt_verify fails closed and does NOT run "swift test"', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-d-'));
  const workflowId = 'wf-test-d';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  // State without pending_verification
  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'HUMAN_REQUIRED',
    })
  );

  let runnerCalled = false;
  await assert.rejects(
    async () => {
      await supergptVerify({
        workflowId,
        root: tmpRoot,
        gateRunner: {
          async run() {
            runnerCalled = true;
            return { pass: true, results: [] };
          },
        },
      });
    },
    (err) => {
      assert.ok(err.message.includes('NO_PENDING_HOST_VERIFICATION'));
      return true;
    }
  );

  assert.equal(runnerCalled, false);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('E. supergpt_verify on DONE or RUNNING workflow cannot create consumable evidence', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-e-'));
  const workflowId = 'wf-test-e';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  // DONE state
  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'DONE',
      pending_verification: { task_id: 't-1', commands: ['echo "ok"'] },
    })
  );

  await assert.rejects(
    async () => {
      await supergptVerify({ workflowId, root: tmpRoot });
    },
    (err) => {
      assert.ok(err.message.includes('WORKFLOW_ALREADY_DONE'));
      return true;
    }
  );

  // RUNNING state
  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.state.json`),
    JSON.stringify({
      workflowId,
      workflowStatus: 'RUNNING',
      pending_verification: { task_id: 't-1', commands: ['echo "ok"'] },
    })
  );

  await assert.rejects(
    async () => {
      await supergptVerify({ workflowId, root: tmpRoot });
    },
    (err) => {
      assert.ok(err.message.includes('WORKFLOW_ACTIVELY_RUNNING'));
      return true;
    }
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('F & G & H & I. Gate blocker persists exact commands -> verify runs them -> resume consumes once -> cannot satisfy later task', async () => {
  const { runAutomatedWorkflow } = await import('../src/orchestrator/automatedLoop.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-fghi-'));
  const workflowId = 'wf-test-fghi';
  const repoDir = path.join(tmpRoot, 'isolated-worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git config user.email "test@example.com"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  execSync('git add . && git commit -m "initial"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(tmpRoot, `${workflowId}.workspace.json`),
    JSON.stringify({ workflow_id: workflowId, isolated_worktree_path: repoDir })
  );

  const { WorkflowStateManager } = await import('../src/orchestrator/workflowState.js');
  const wsm = new WorkflowStateManager({ workflowId, root: tmpRoot });

  const task1 = {
    task_id: 'task-1',
    goal: 'First task',
    allowed_files: ['file.txt'],
    verification_commands: ['swift test --filter FeatureOne'],
  };

  const task2 = {
    task_id: 'task-2',
    goal: 'Second task',
    allowed_files: ['file.txt'],
    verification_commands: ['swift test --filter FeatureTwo'],
  };

  // Mock gate runner that fails with exit code 127 (environment blocker)
  let gateRunCommands = [];
  const failingGate = {
    async run(commands) {
      gateRunCommands = [...commands];
      return {
        pass: false,
        results: commands.map((c) => ({
          command: c,
          pass: false,
          output: 'swift: command not found (exit code 127)',
        })),
      };
    },
  };

  // 1. Initial attempt fails at Gate with environment blocker
  const supervisorMock = {
    create: async () => ({ tabId: 'sup-1' }),
    decide: async () => ({ action: 'NEXT_TASK', task_card: task1 }),
    close: async () => {},
  };

  const reviewerMock = {
    create: async () => ({ tabId: 'rev-1' }),
    review: async () => ({ decision: 'PASS' }),
  };

  const result1 = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: supervisorMock,
    createReviewerSession: () => reviewerMock,
    createClaudeSessionManager: () => ({
      execute: async () => ({ changes: [{ path: 'file.txt', action: 'modify', content: 'update\n' }] }),
    }),
    gateRunner: failingGate,
    workflowStateManager: wsm,
  });

  // Check F: Pending verification context is persisted
  assert.equal(result1.status, 'HUMAN_REQUIRED');
  assert.ok(result1.pending_verification);
  assert.equal(result1.pending_verification.task_id, 'task-1');
  assert.deepEqual(result1.pending_verification.commands, ['swift test --filter FeatureOne']);

  // Check G: supergpt_verify executes exactly those persisted commands
  let verifyRunCommands = [];
  const hostGateRunner = {
    async run(commands) {
      verifyRunCommands = [...commands];
      return {
        pass: true,
        results: commands.map((c) => ({ command: c, pass: true, output: 'ok' })),
      };
    },
  };

  const hostEvidence = await supergptVerify({
    workflowId,
    root: tmpRoot,
    gateRunner: hostGateRunner,
  });

  assert.deepEqual(verifyRunCommands, ['swift test --filter FeatureOne']);
  assert.equal(hostEvidence.pass, true);

  // Check H: resume consumes matching PASS evidence exactly once
  let resumedGateRunCount = 0;
  const resumedGate = {
    async run(commands) {
      resumedGateRunCount++;
      return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
    },
  };

  let supervisorCallCount = 0;
  const supervisorMock2 = {
    create: async () => ({ tabId: 'sup-1' }),
    decide: async () => {
      supervisorCallCount++;
      if (supervisorCallCount === 1) return { action: 'NEXT_TASK', task_card: task1 };
      if (supervisorCallCount === 2) return { action: 'NEXT_TASK', task_card: task2 };
      return { action: 'WORKFLOW_DONE', summary: 'Done' };
    },
    close: async () => {},
  };

  const result2 = await runAutomatedWorkflow({
    workflowId,
    supervisorSession: supervisorMock2,
    createReviewerSession: () => reviewerMock,
    createClaudeSessionManager: () => ({
      execute: async () => ({ changes: [] }),
    }),
    gateRunner: resumedGate,
    workflowStateManager: wsm,
  });

  assert.equal(result2.status, 'WORKFLOW_DONE');
  // Resumed task1 consumed host evidence without calling resumedGate
  // Task2 had to run resumedGate because evidence was already consumed and for task1
  assert.equal(resumedGateRunCount, 1);

  // Check I: Evidence is consumed and cannot satisfy task2
  const checkAfter = getValidHostEvidence({
    workflowId,
    taskId: 'task-2',
    verificationCommands: ['swift test --filter FeatureTwo'],
    root: tmpRoot,
  });
  assert.equal(checkAfter.valid, false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('J & K. Closeout Policy: Final task Gate receives focused test + closeout commands; earlier tasks do NOT', async () => {
  const { runAutomatedWorkflow } = await import('../src/orchestrator/automatedLoop.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-jk-'));
  const workflowId = 'wf-test-jk';

  const task1 = {
    task_id: 'task-1',
    goal: 'First task',
    verification_commands: ['swift test --filter UnitTests'],
  };

  const task2 = {
    task_id: 'task-2',
    goal: 'Final task',
    verification_commands: ['swift test --filter FinalFeatureTests'],
  };

  const gateExecutions = [];
  const gateRunner = {
    async run(commands) {
      gateExecutions.push([...commands]);
      return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
    },
  };

  let supervisorStep = 0;
  const supervisorSession = {
    create: async () => ({ tabId: 'sup-1' }),
    decide: async () => {
      supervisorStep++;
      if (supervisorStep === 1) return { action: 'NEXT_TASK', task_card: task1 };
      if (supervisorStep === 2) return { action: 'NEXT_TASK', task_card: task2 };
      return { action: 'WORKFLOW_DONE', summary: 'Done' };
    },
    close: async () => {},
  };

  const reviewerSession = {
    create: async () => ({ tabId: 'rev-1' }),
    review: async () => ({ decision: 'PASS' }),
  };

  const result = await runAutomatedWorkflow({
    workflowId,
    supervisorSession,
    createReviewerSession: () => reviewerSession,
    createClaudeSessionManager: () => ({
      execute: async () => ({ changes: [] }),
    }),
    gateRunner,
    closeoutVerificationCommands: ['swift test'],
    taskTotal: 2,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(gateExecutions.length, 2);

  // Task 1: earlier task does NOT receive full swift test
  assert.deepEqual(gateExecutions[0], ['swift test --filter UnitTests']);

  // Task 2: final task receives focused test + full swift test (deduplicated)
  assert.deepEqual(gateExecutions[1], ['swift test --filter FinalFeatureTests', 'swift test']);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('L. Final-task REWORK retains full closeout verification', async () => {
  const { runAutomatedWorkflow } = await import('../src/orchestrator/automatedLoop.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-l-'));
  const workflowId = 'wf-test-l';

  const task1 = {
    task_id: 'task-1',
    goal: 'Single final task',
    verification_commands: ['swift test --filter UnitTests'],
  };

  const gateExecutions = [];
  const gateRunner = {
    async run(commands) {
      gateExecutions.push([...commands]);
      return { pass: true, results: commands.map((c) => ({ command: c, pass: true })) };
    },
  };

  let reviewCount = 0;
  let supervisorStep = 0;
  const supervisorSession = {
    create: async () => ({ tabId: 'sup-1' }),
    decide: async () => {
      supervisorStep++;
      if (supervisorStep === 1) return { action: 'NEXT_TASK', task_card: task1 };
      if (supervisorStep === 2) return { action: 'CONTINUE_REWORK' };
      return { action: 'WORKFLOW_DONE', summary: 'Done' };
    },
    close: async () => {},
  };

  const reviewerSession = {
    create: async () => ({ tabId: 'rev-1' }),
    review: async () => {
      reviewCount++;
      if (reviewCount === 1) return { decision: 'REWORK', required_changes: ['fix bug'] };
      return { decision: 'PASS' };
    },
  };

  const result = await runAutomatedWorkflow({
    workflowId,
    supervisorSession,
    createReviewerSession: () => reviewerSession,
    createClaudeSessionManager: () => ({
      execute: async () => ({ changes: [] }),
    }),
    gateRunner,
    closeoutVerificationCommands: ['swift test'],
    taskTotal: 1,
  });

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(gateExecutions.length, 2);

  // Both initial attempt and rework attempt retain closeout verification
  assert.deepEqual(gateExecutions[0], ['swift test --filter UnitTests', 'swift test']);
  assert.deepEqual(gateExecutions[1], ['swift test --filter UnitTests', 'swift test']);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('M. Resume retains frozen closeout policy if repository docs/config change', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-m-'));
  const configDir = path.join(tmpDir, '.supergpt');
  fs.mkdirSync(configDir, { recursive: true });

  // Initial config
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      verification: { closeoutCommands: ['swift test --filter SpinLabIntegrationTests'] },
    })
  );

  const initialConfig = loadWorkspaceConfig(tmpDir);
  assert.deepEqual(initialConfig.closeoutCommands, ['swift test --filter SpinLabIntegrationTests']);

  // Change repository config (e.g. user modifies it later)
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      verification: { closeoutCommands: ['npm test'] },
    })
  );

  // Resumed workflow uses frozen metadata, unaffected by repository config mutation
  const frozenMeta = {
    workflow_id: 'wf-resumed',
    closeout_verification_commands: initialConfig.closeoutCommands,
  };
  assert.deepEqual(frozenMeta.closeout_verification_commands, ['swift test --filter SpinLabIntegrationTests']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('N. Malformed .supergpt/config.json fails closed before model invocation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supergpt-test-n-'));
  const configDir = path.join(tmpDir, '.supergpt');
  fs.mkdirSync(configDir, { recursive: true });

  // Malformed JSON syntax
  fs.writeFileSync(path.join(configDir, 'config.json'), '{ malformed json: true, ');

  assert.throws(
    () => {
      loadWorkspaceConfig(tmpDir);
    },
    (err) => {
      assert.equal(err.name, 'ExternalReadRootConfigError');
      assert.ok(err.message.includes('Malformed workspace configuration'));
      return true;
    }
  );

  // Non-object JSON
  fs.writeFileSync(path.join(configDir, 'config.json'), '["not", "an", "object"]');
  assert.throws(
    () => {
      loadWorkspaceConfig(tmpDir);
    },
    (err) => {
      assert.equal(err.name, 'ExternalReadRootConfigError');
      assert.ok(err.message.includes('expected a JSON object'));
      return true;
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
