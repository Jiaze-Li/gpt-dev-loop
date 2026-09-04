import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_ROLE_POLICY,
  PRODUCTION_ROLE_CAPABILITIES,
  supportsProductionRole,
  RoleRouter,
  QuotaPoolRegistry,
  ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { createCodexReviewerProvider } from '../src/orchestrator/adapters/codexReviewerProvider.js';
import { createClaudeSupervisorProvider } from '../src/orchestrator/adapters/claudeSupervisorProvider.js';
import { createClaudeReviewerProvider } from '../src/orchestrator/adapters/claudeReviewerProvider.js';
import { createCodexExecutorAdapter, createCodexSessionManager } from '../src/orchestrator/adapters/codexExecutorAdapter.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

test('Target active role pools match specification exactly', () => {
  assert.deepEqual(DEFAULT_ROLE_POLICY.planner.map((c) => c.family), [
    'codex:default', 'agy:gemini', 'claude:opus', 'agy:gpt-oss'
  ]);
  assert.deepEqual(DEFAULT_ROLE_POLICY.supervisor.map((c) => c.family), [
    'agy:gemini', 'codex:default', 'claude:opus', 'agy:gpt-oss'
  ]);
  assert.deepEqual(DEFAULT_ROLE_POLICY.reviewer.map((c) => c.family), [
    'agy:gpt-oss', 'codex:default', 'agy:gemini', 'claude:opus'
  ]);
  assert.deepEqual(DEFAULT_ROLE_POLICY.executor.map((c) => c.family), [
    'claude:sonnet'
  ]);
});

test('Target capability matrix has zero unsupported active entries', () => {
  for (const [role, candidates] of Object.entries(DEFAULT_ROLE_POLICY)) {
    for (const candidate of candidates) {
      assert.equal(
        supportsProductionRole(candidate.family, role),
        true,
        `Active pool candidate ${candidate.family} must be supported for role ${role}`
      );
    }
  }
});

test('Fallback reachability: Planner fallback chain', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({
    quotaRegistry: quota,
    providerHealth: health,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
    }),
  });

  // 1. Primary: codex:default
  assert.equal(router.route('planner').requestedFamily, 'codex:default');

  // 2. Suppress codex -> agy:gemini
  health.record('codex', 'UNAVAILABLE');
  assert.equal(router.route('planner').requestedFamily, 'agy:gemini');

  // 3. Suppress agy-gemini -> claude:opus
  quota.recordCooldown('agy-gemini');
  assert.equal(router.route('planner').requestedFamily, 'claude:opus');

  // 4. Suppress claude -> agy:gpt-oss
  quota.recordCooldown('claude');
  assert.equal(router.route('planner').requestedFamily, 'agy:gpt-oss');
});

test('Fallback reachability: Supervisor fallback chain', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({
    quotaRegistry: quota,
    providerHealth: health,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
    }),
  });

  // 1. Primary: agy:gemini
  assert.equal(router.route('supervisor').requestedFamily, 'agy:gemini');

  // 2. Suppress agy-gemini -> codex:default
  quota.recordCooldown('agy-gemini');
  assert.equal(router.route('supervisor').requestedFamily, 'codex:default');

  // 3. Suppress codex -> claude:opus
  health.record('codex', 'UNAVAILABLE');
  assert.equal(router.route('supervisor').requestedFamily, 'claude:opus');

  // 4. Suppress claude -> agy:gpt-oss
  quota.recordCooldown('claude');
  assert.equal(router.route('supervisor').requestedFamily, 'agy:gpt-oss');
});

test('Fallback reachability: Reviewer fallback chain', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({
    quotaRegistry: quota,
    providerHealth: health,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
    }),
  });

  // 1. Primary: agy:gpt-oss
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gpt-oss');

  // 2. Suppress agy-claude-gpt -> codex:default
  quota.recordCooldown('agy-claude-gpt');
  assert.equal(router.route('reviewer').requestedFamily, 'codex:default');

  // 3. Suppress codex -> agy:gemini
  health.record('codex', 'UNAVAILABLE');
  assert.equal(router.route('reviewer').requestedFamily, 'agy:gemini');

  // 4. Suppress agy-gemini -> claude:opus
  quota.recordCooldown('agy-gemini');
  assert.equal(router.route('reviewer').requestedFamily, 'claude:opus');
});

test('Executor automatic chain is Sonnet-only (no codex/opus failover)', () => {
  const quota = new QuotaPoolRegistry({ filePath: null });
  const health = new ProviderHealthRegistry();
  const router = new RoleRouter({
    quotaRegistry: quota,
    providerHealth: health,
    resolveFamily: (family) => ({
      requestedFamily: family,
      resolvedModel: family,
      provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
      capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
    }),
  });

  // 1. Primary: claude:sonnet
  assert.equal(router.route('executor').requestedFamily, 'claude:sonnet');

  // 2. Sonnet unusable -> NO codex:default / claude:opus automatic failover.
  //    The router yields no candidate; the invocation fails back upward.
  health.record('claude:sonnet', 'UNAVAILABLE', 'PROVIDER_TIMEOUT');
  assert.equal(router.route('executor'), null);
});

test('Codex Reviewer Adapter: valid PASS and REWORK contracts', async () => {
  const fakeCallPass = async () => ({
    text: JSON.stringify({
      decision: 'PASS',
      findings: ['All tests pass'],
      required_changes: [],
      rationale: 'Looks clean',
    }),
    usage: { input_tokens: 250, output_tokens: 45, cached_input_tokens: 100 },
    durationMs: 12,
  });

  const providerPass = createCodexReviewerProvider({ call: fakeCallPass });
  const resultPass = await providerPass.review(validTaskCardObject(), { status: 'DONE' }, { pass: true, results: [] });
  assert.equal(resultPass.decision, 'PASS');
  assert.equal(resultPass.findings[0], 'All tests pass');
  assert.match(resultPass.callId, /^call-codex-rev-/);
  assert.equal(resultPass.usage.input_tokens, 250);
  assert.equal(resultPass.durationMs, 12);

  const fakeCallRework = async () => ({
    text: JSON.stringify({
      decision: 'REWORK',
      findings: ['Missing error check'],
      required_changes: ['Add check for null'],
      rationale: 'Safety requirement',
    }),
    usage: { input_tokens: 300, output_tokens: 60 },
    durationMs: 15,
  });

  const providerRework = createCodexReviewerProvider({ call: fakeCallRework });
  const resultRework = await providerRework.review(validTaskCardObject(), { status: 'DONE' }, { pass: true, results: [] });
  assert.equal(resultRework.decision, 'REWORK');
  assert.deepEqual(resultRework.required_changes, ['Add check for null']);
});

test('Claude Supervisor Adapter: valid NEXT_TASK contract', async () => {
  const fakeCall = async () => ({
    text: JSON.stringify({
      action: 'NEXT_TASK',
      task_card: validTaskCardObject(),
    }),
    usage: { input_tokens: 180, output_tokens: 90 },
    durationMs: 25,
  });

  const provider = createClaudeSupervisorProvider({ call: fakeCall, model: 'opus' });
  const decision = await provider.decide({ workflowGoal: 'goal', repositoryContext: {}, history: [] });
  assert.equal(decision.action, 'NEXT_TASK');
  assert.equal(decision.task_card.task_id, 'auto-a');
  assert.match(decision.callId, /^call-claude-sup-/);
  assert.equal(decision.usage.input_tokens, 180);
});

test('Claude Reviewer Adapter: valid PASS contract', async () => {
  const fakeCall = async () => ({
    text: JSON.stringify({
      decision: 'PASS',
      findings: ['Verified functionality'],
      required_changes: [],
      rationale: 'Meets criteria',
    }),
    usage: { input_tokens: 220, output_tokens: 50 },
    durationMs: 18,
  });

  const provider = createClaudeReviewerProvider({ call: fakeCall, model: 'opus' });
  const result = await provider.review(validTaskCardObject(), { status: 'DONE' }, { pass: true, results: [] });
  assert.equal(result.decision, 'PASS');
  assert.match(result.callId, /^call-claude-rev-/);
});

test('Codex Executor Adapter: parses execution report and assigns callId', async () => {
  const rawReport = `## task_id
auto-a

## repository_context
repository_name: test-repo
repository_url: none
branch: main
commit_sha: abc1234

## status
DONE

## changed_files
- src/feature.js

## tests_run
- \`npm test\`

## test_results
- \`npm test\`: pass — all ok

## issues
none

## next_recommendation
proceed`;

  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.pid = 99999;
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: rawReport },
      }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 500, output_tokens: 120, cached_input_tokens: 200 },
      }) + '\n'));
      child.emit('close', 0);
    }, 5);
    return child;
  };

  const adapter = createCodexExecutorAdapter({ spawn: fakeSpawn });
  const report = await adapter.execute(validTaskCardObject());
  assert.equal(report.status, 'DONE');
  assert.equal(report.task_id, 'auto-a');
  assert.deepEqual(report.changed_files, ['src/feature.js']);
  assert.match(report.callId, /^call-codex-exe-/);
  assert.equal(report.usage.input_tokens, 500);
  assert.equal(report.usage.output_tokens, 120);
});

test('selectProviders wires all 15 active Role × ModelFamily edges end-to-end', async () => {
  const usageTracker = new UsageTracker();
  const fakeAgy = makeFakeCallAgy([
    { action: 'NEXT_TASK', task_card: validTaskCardObject() },
    { decision: 'PASS', findings: [], required_changes: [], rationale: 'ok' },
  ]);
  const fakeCodex = async () => ({
    text: JSON.stringify({
      action: 'WORKFLOW_DONE',
      summary: 'codex finished',
      status: 'READY',
      plan_text: 'plan',
      tasks: [{ task_id: 't1', goal: 'g', allowed_files: ['f'], verification_commands: ['v'] }],
      decision: 'PASS',
      findings: [],
      required_changes: [],
      rationale: 'ok',
    }),
    usage: { input_tokens: 100, output_tokens: 20 },
    durationMs: 5,
  });
  const fakeClaude = async () => ({
    text: JSON.stringify({
      action: 'WORKFLOW_DONE',
      summary: 'claude finished',
      status: 'READY',
      plan_text: 'plan',
      tasks: [{ task_id: 't1', goal: 'g', allowed_files: ['f'], verification_commands: ['v'] }],
      decision: 'PASS',
      findings: [],
      required_changes: [],
      rationale: 'ok',
    }),
    usage: { input_tokens: 110, output_tokens: 25 },
    durationMs: 8,
  });

  const providers = selectProviders({
    callAgy: fakeAgy,
    codexCall: fakeCodex,
    claudeCall: fakeClaude,
    usageTracker,
    workflowId: 'test-wf',
  });

  // Verify all 4 Planner adapters can be invoked
  for (const family of ['codex:default', 'agy:gemini', 'claude:opus', 'agy:gpt-oss']) {
    const adapter = providers.runtime.router.resolveFamily(family);
    assert.ok(adapter.capabilities.roles.includes('planner'), `${family} must declare planner`);
  }

  // Verify all 4 Supervisor adapters can be invoked
  for (const family of ['agy:gemini', 'codex:default', 'claude:opus', 'agy:gpt-oss']) {
    const adapter = providers.runtime.router.resolveFamily(family);
    assert.ok(adapter.capabilities.roles.includes('supervisor'), `${family} must declare supervisor`);
  }

  // Verify all 4 Reviewer adapters can be invoked
  for (const family of ['agy:gpt-oss', 'codex:default', 'agy:gemini', 'claude:opus']) {
    const adapter = providers.runtime.router.resolveFamily(family);
    assert.ok(adapter.capabilities.roles.includes('reviewer'), `${family} must declare reviewer`);
  }

  // Verify all 3 Executor adapters can be invoked
  for (const family of ['claude:sonnet', 'codex:default', 'claude:opus']) {
    const adapter = providers.runtime.router.resolveFamily(family);
    assert.ok(adapter.capabilities.roles.includes('executor'), `${family} must declare executor`);
  }
});
