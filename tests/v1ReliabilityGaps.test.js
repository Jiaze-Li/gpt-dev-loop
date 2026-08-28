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
