#!/usr/bin/env node
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { DEFAULT_ROLE_POLICY, QuotaPoolRegistry, ProviderHealthRegistry } from '../src/orchestrator/roleRouting.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { callAgy } from '../src/agy/agyClient.js';
import { assertRealProviderCallsAuthorized, REAL_PROVIDER_CALL_FLAG } from '../src/orchestrator/realProviderCallGuard.js';
import { parseAgyJsonObject } from '../src/agy/agyJson.js';
import { buildPlannerPrompt, parsePlannerJson } from '../src/orchestrator/planner.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const matrix = {};

function recordResult(role, family, status, details = {}) {
  if (!matrix[family]) matrix[family] = {};
  matrix[family][role] = { status, ...details };
}

async function smokePlanner(family, suppress = []) {
  console.log(`\n[SMOKE] Planner -> ${family} (suppressing: ${suppress.join(', ') || 'none'})...`);
  const usageTracker = new UsageTracker();
  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();

  for (const s of suppress) {
    if (s.startsWith('quota:')) quotaRegistry.recordCooldown(s.slice(6));
    else if (s.startsWith('health:')) providerHealth.record(s.slice(7), 'UNAVAILABLE');
  }

  const providers = selectProviders({
    callAgy,
    usageTracker,
    quotaRegistry,
    providerHealth,
    workflowId: 'smoke-planner',
  });

  const routing = providers.runtime.router.route('planner');
  if (!routing || routing.requestedFamily !== family) {
    throw new Error(`RoleRouter expected ${family} but routed to ${routing?.requestedFamily}`);
  }

  try {
    const res = await providers.runtime.invoke('planner', {
      resolve: async (call) => {
        const prompt = buildPlannerPrompt({
          userIntent: 'Implement a small parseNumber function in src/index.js and verify with a test.',
          repositoryContextBlock: 'repository_name: tiny-parser\ntracked files (1):\n  src/index.js',
        });
        return call({ prompt });
      },
    }, { operationId: 'smoke-planner' });

    const obj = parseAgyJsonObject(res.value);
    const parsed = parsePlannerJson(obj);
    const usageRec = usageTracker.records.find((r) => r.role === 'planner');

    console.log(`  ✔ LIVE VERIFIED: ${family} (tasks: ${parsed.tasks.length}, callId: ${usageRec?.callId}, duration: ${usageRec?.durationMs}ms)`);
    recordResult('Planner', family, 'LIVE VERIFIED', {
      callId: usageRec?.callId,
      resolvedModel: usageRec?.resolvedModel,
      usage: usageRec ? { in: usageRec.inputTokens, out: usageRec.outputTokens, cached: usageRec.cachedTokens } : null,
      durationMs: usageRec?.durationMs,
    });
  } catch (err) {
    const isQuota = /quota|rate.?limit|429|exhausted|usage.?limit/i.test(err.message || '');
    if (isQuota) {
      console.log(`  ⚠ WIRED + LIVE BLOCKED BY QUOTA: ${family} (${err.message})`);
      recordResult('Planner', family, 'WIRED + LIVE BLOCKED BY QUOTA', { error: err.message });
    } else {
      console.error(`  ✖ FAILED: ${family}`, err);
      throw err;
    }
  }
}

async function smokeSupervisor(family, suppress = []) {
  console.log(`\n[SMOKE] Supervisor -> ${family} (suppressing: ${suppress.join(', ') || 'none'})...`);
  const usageTracker = new UsageTracker();
  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();

  for (const s of suppress) {
    if (s.startsWith('quota:')) quotaRegistry.recordCooldown(s.slice(6));
    else if (s.startsWith('health:')) providerHealth.record(s.slice(7), 'UNAVAILABLE');
  }

  const providers = selectProviders({
    callAgy,
    usageTracker,
    quotaRegistry,
    providerHealth,
    workflowId: 'smoke-supervisor',
  });

  const routing = providers.runtime.router.route('supervisor');
  if (!routing || routing.requestedFamily !== family) {
    throw new Error(`RoleRouter expected ${family} but routed to ${routing?.requestedFamily}`);
  }

  const context = {
    workflowGoal: 'Add greeting function and test',
    repositoryContext: { repository_name: 'smoke-app', branch: 'main', commit_sha: '1234567' },
    history: [
      { task_id: 'task-1', decision: 'PASS', attempts: 1 }
    ],
    latestReviewResult: {
      task_id: 'task-1',
      decision: 'PASS',
      findings: ['Function implemented cleanly'],
      required_changes: 'none',
      rationale: 'All requirements met',
    },
    latestGateResult: { pass: true, results: [] },
  };

  try {
    const res = await providers.runtime.invoke('supervisor', context, { operationId: 'smoke-supervisor' });
    const decision = res.value;
    console.log(`  ✔ LIVE VERIFIED: ${family} (action: ${decision.action}, callId: ${decision.callId})`);
    recordResult('Supervisor', family, 'LIVE VERIFIED', {
      action: decision.action,
      callId: decision.callId,
      durationMs: decision.durationMs,
      usage: decision.usage,
    });
  } catch (err) {
    const isQuota = /quota|rate.?limit|429|exhausted|usage.?limit/i.test(err.message || '');
    if (isQuota) {
      console.log(`  ⚠ WIRED + LIVE BLOCKED BY QUOTA: ${family} (${err.message})`);
      recordResult('Supervisor', family, 'WIRED + LIVE BLOCKED BY QUOTA', { error: err.message });
    } else {
      console.error(`  ✖ FAILED: ${family}`, err);
      throw err;
    }
  }
}

async function smokeReviewer(family, suppress = []) {
  console.log(`\n[SMOKE] Reviewer -> ${family} (suppressing: ${suppress.join(', ') || 'none'})...`);
  const usageTracker = new UsageTracker();
  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();

  for (const s of suppress) {
    if (s.startsWith('quota:')) quotaRegistry.recordCooldown(s.slice(6));
    else if (s.startsWith('health:')) providerHealth.record(s.slice(7), 'UNAVAILABLE');
  }

  const providers = selectProviders({
    callAgy,
    usageTracker,
    quotaRegistry,
    providerHealth,
    workflowId: 'smoke-reviewer',
  });

  const routing = providers.runtime.router.route('reviewer');
  if (!routing || routing.requestedFamily !== family) {
    throw new Error(`RoleRouter expected ${family} but routed to ${routing?.requestedFamily}`);
  }

  const taskCard = {
    task_id: 'task-smoke',
    goal: 'Create hello.txt with content "hello world"',
    context: 'Minimal smoke test',
    scope: 'Create one file',
    allowed_files: ['hello.txt'],
    forbidden_files: [],
    acceptance_criteria: ['hello.txt contains "hello world"'],
    verification_commands: ['cat hello.txt'],
    completion_signal: 'hello.txt created and verified',
    repository_context: { repository_name: 'smoke', branch: 'main', commit_sha: 'abc1234' },
  };

  const executionReport = {
    task_id: 'task-smoke',
    status: 'DONE',
    changed_files: ['hello.txt'],
    tests_run: ['cat hello.txt'],
    test_results: ['cat hello.txt: pass — hello world'],
    issues: 'none',
    next_recommendation: 'proceed',
  };

  const evidence = {
    pass: true,
    diagnostics: { tracked_changed_files: 1, untracked_task_files: 0, diff_chars: 20, diff_bytes: 20 },
    diff: '+hello world\n',
    untracked_files: [],
  };

  try {
    const res = await providers.runtime.invoke('reviewer', {
      taskId: 'task-smoke',
      taskCard,
      executionReport,
      evidence,
      opts: { attempt: 1 },
    }, { operationId: 'smoke-reviewer' });

    const reviewResult = res.value;
    console.log(`  ✔ LIVE VERIFIED: ${family} (decision: ${reviewResult.decision}, callId: ${reviewResult.callId})`);
    recordResult('Reviewer', family, 'LIVE VERIFIED', {
      decision: reviewResult.decision,
      callId: reviewResult.callId,
      durationMs: reviewResult.durationMs,
      usage: reviewResult.usage,
    });
  } catch (err) {
    const isQuota = /quota|rate.?limit|429|exhausted|usage.?limit/i.test(err.message || '');
    if (isQuota) {
      console.log(`  ⚠ WIRED + LIVE BLOCKED BY QUOTA: ${family} (${err.message})`);
      recordResult('Reviewer', family, 'WIRED + LIVE BLOCKED BY QUOTA', { error: err.message });
    } else {
      console.error(`  ✖ FAILED: ${family}`, err);
      throw err;
    }
  }
}

async function smokeExecutor(family, suppress = [], rolePolicyOverride = null) {
  console.log(`\n[SMOKE] Executor -> ${family} (suppressing: ${suppress.join(', ') || 'none'})...`);
  const usageTracker = new UsageTracker();
  const quotaRegistry = new QuotaPoolRegistry({ filePath: null });
  const providerHealth = new ProviderHealthRegistry();

  for (const s of suppress) {
    if (s.startsWith('quota:')) quotaRegistry.recordCooldown(s.slice(6));
    else if (s.startsWith('health:')) providerHealth.record(s.slice(7), 'UNAVAILABLE');
  }

  const providers = selectProviders({
    rolePolicy: rolePolicyOverride,
    callAgy,
    usageTracker,
    quotaRegistry,
    providerHealth,
    workflowId: 'smoke-executor',
  });

  const routing = providers.runtime.router.route('executor');
  if (!routing || routing.requestedFamily !== family) {
    throw new Error(`RoleRouter expected ${family} but routed to ${routing?.requestedFamily}`);
  }

  // Create a disposable git repo in /tmp
  const smokeId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tmpDir = path.join(os.tmpdir(), smokeId);
  await mkdir(tmpDir, { recursive: true });

  try {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'SuperGPT Smoke'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'smoke@supergpt.dev'], { cwd: tmpDir, stdio: 'ignore' });
    await writeFile(path.join(tmpDir, 'README.md'), '# Smoke Workspace\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir, stdio: 'ignore' });

    const taskCard = {
      task_id: 'smoke-exec',
      goal: 'Write the number 42 into answer.txt so "cat answer.txt" outputs 42.',
      context: 'Disposable smoke task',
      scope: 'Create answer.txt only',
      allowed_files: ['answer.txt'],
      forbidden_files: [],
      acceptance_criteria: ['answer.txt exists and contains 42'],
      verification_commands: ['cat answer.txt'],
      completion_signal: 'answer.txt created',
      repository_context: {
        repository_name: 'smoke-repo',
        branch: 'main',
        commit_sha: 'head',
      },
    };

    const res = await providers.runtime.invoke('executor', {
      taskId: 'smoke-exec',
      workflowId: 'smoke-executor',
      cwd: tmpDir,
      taskCard,
    }, { operationId: 'smoke-executor' });

    const report = res.value;
    console.log(`  ✔ LIVE VERIFIED: ${family} (status: ${report.status}, changed: ${report.changed_files?.join(',')}, callId: ${report.callId})`);
    recordResult('Executor', family, 'LIVE VERIFIED', {
      status: report.status,
      changedFiles: report.changed_files,
      callId: report.callId,
      usage: report.usage,
    });
  } catch (err) {
    const isQuota = /quota|rate.?limit|429|exhausted|usage.?limit/i.test(err.message || '');
    if (isQuota) {
      console.log(`  ⚠ WIRED + LIVE BLOCKED BY QUOTA: ${family} (${err.message})`);
      recordResult('Executor', family, 'WIRED + LIVE BLOCKED BY QUOTA', { error: err.message });
    } else {
      console.error(`  ✖ FAILED: ${family}`, err);
      throw err;
    }
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  assertRealProviderCallsAuthorized({
    explicitLiveIntent: process.argv.slice(2).includes(REAL_PROVIDER_CALL_FLAG),
    entrypoint: 'scripts/live-smoke-active-pools.js',
  });

  console.log('========================================================================');
  console.log('SUPERGPT V1 LIVE SMOKE VALIDATION ACROSS ACTIVE ROLE POOLS');
  console.log('========================================================================');

  // 1. PLANNER
  console.log('\n--- 1. PLANNER POOL SMOKES ---');
  await smokePlanner('codex:default', []);
  await smokePlanner('agy:gemini', ['health:codex']);
  await smokePlanner('claude:opus', ['health:codex', 'quota:agy-gemini']);
  await smokePlanner('agy:gpt-oss', ['health:codex', 'quota:agy-gemini', 'quota:claude']);

  // 2. SUPERVISOR
  console.log('\n--- 2. SUPERVISOR POOL SMOKES ---');
  await smokeSupervisor('agy:gemini', []);
  await smokeSupervisor('codex:default', ['quota:agy-gemini']);
  await smokeSupervisor('claude:opus', ['quota:agy-gemini', 'health:codex']);
  await smokeSupervisor('agy:gpt-oss', ['quota:agy-gemini', 'health:codex', 'quota:claude']);

  // 3. REVIEWER
  console.log('\n--- 3. REVIEWER POOL SMOKES ---');
  await smokeReviewer('agy:gpt-oss', []);
  await smokeReviewer('codex:default', ['quota:agy-claude-gpt']);
  await smokeReviewer('agy:gemini', ['quota:agy-claude-gpt', 'health:codex']);
  await smokeReviewer('claude:opus', ['quota:agy-claude-gpt', 'health:codex', 'quota:agy-gemini']);

  // 4. EXECUTOR
  console.log('\n--- 4. EXECUTOR POOL SMOKES ---');
  await smokeExecutor('claude:sonnet', []);
  await smokeExecutor('codex:default', ['quota:claude']);
  await smokeExecutor('claude:opus', [], { ...DEFAULT_ROLE_POLICY, executor: [{ family: 'claude:opus' }] });

  console.log('\n========================================================================');
  console.log('FINAL LIVE SMOKE RESULTS MATRIX');
  console.log('========================================================================');
  console.log(JSON.stringify(matrix, null, 2));
}

// Only run the live smoke when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal live smoke error:', err.message ?? err);
    process.exit(err.exitCode ?? 1);
  });
}
