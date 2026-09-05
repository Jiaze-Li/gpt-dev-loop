import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createClaudeExecutorAdapter,
  buildAllowedVerificationTools,
  buildPrompt,
  isDangerousVerificationCommand,
  resolveExecutorBudgetLimits,
  evaluateExecutorBudget,
  dedupePermissionDenials,
  denialFingerprint,
  normalizeDeniedCommand,
  DENIAL_REPEAT_THRESHOLD,
} from '../src/orchestrator/adapters/claudeExecutorAdapter.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';

function demoRepositoryContext(overrides = {}) {
  return {
    repository_name: 'gpt-dev-loop',
    repository_url: 'https://github.com/example/gpt-dev-loop',
    branch: 'phase1-handshake',
    commit_sha: 'abc123',
    ...overrides,
  };
}

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'demo-task',
    repository_context: demoRepositoryContext(),
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function reportText({ taskId = 'demo-task', status = 'DONE' } = {}) {
  return `## task_id
${taskId}

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

## status
${status}

## changed_files
- src/foo.js

## tests_run
- \`npm test\`

## test_results
- \`npm test\`: pass — 3 passing

## issues
- none

## next_recommendation
proceed`;
}

// Fake child_process.spawn: emits stdout/stderr/close (or error, or hangs
// forever for the timeout test) asynchronously, like a real child would.
function makeFakeSpawn({ stdout = '', stderr = '', code = 0, spawnError = null, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const written = [];
    child.stdin = {
      write: (chunk) => written.push(chunk),
      end: () => {},
    };
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => child.emit('close', null));
    };
    child.written = written;

    if (!hang) {
      queueMicrotask(() => {
        if (spawnError) {
          child.emit('error', spawnError);
          return;
        }
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
      });
    }
    return child;
  };
  return { spawn, calls };
}

test('claude executor adapter: parses a DONE report into execution_report shape', async () => {
  const { spawn, calls } = makeFakeSpawn({ stdout: reportText({ status: 'DONE' }) });
  const adapter = createClaudeExecutorAdapter({ spawn });

  const report = await adapter.execute(demoTaskCard());

  assert.deepEqual(report, {
    task_id: 'demo-task',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'phase1-handshake',
      commit_sha: 'def456',
    },
    status: 'DONE',
    changed_files: ['src/foo.js'],
    tests_run: ['`npm test`'],
    test_results: ['`npm test`: pass — 3 passing'],
    issues: '- none',
    next_recommendation: 'proceed',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
});
test('claude executor adapter: sends the Task Card as the prompt over stdin', async () => {
  const { spawn } = makeFakeSpawn({ stdout: reportText() });
  let writtenChild;
  const wrappedSpawn = (...args) => {
    const child = spawn(...args);
    writtenChild = child;
    return child;
  };
  const adapter = createClaudeExecutorAdapter({ spawn: wrappedSpawn });

  await adapter.execute(demoTaskCard());

  const prompt = writtenChild.written.join('');
  assert.match(prompt, /## task_id\ndemo-task/);
  assert.match(prompt, /Execution Report/);
});

test('claude executor adapter: accepts BLOCKED and HUMAN_REQUIRED statuses', async () => {
  for (const status of ['BLOCKED', 'HUMAN_REQUIRED']) {
    const { spawn } = makeFakeSpawn({ stdout: reportText({ status }) });
    const adapter = createClaudeExecutorAdapter({ spawn });
    const report = await adapter.execute(demoTaskCard());
    assert.equal(report.status, status);
  }
});

test('claude executor adapter: "none" list fields parse to empty arrays', async () => {
  const text = `## task_id
demo-task

## repository_context
repository_name: gpt-dev-loop
repository_url: none
branch: phase1-handshake
commit_sha: def456

## status
DONE

## changed_files
none

## tests_run
none

## test_results
none

## issues
none

## next_recommendation
proceed`;
  const { spawn } = makeFakeSpawn({ stdout: text });
  const adapter = createClaudeExecutorAdapter({ spawn });
  const report = await adapter.execute(demoTaskCard());

  assert.deepEqual(report.changed_files, []);
  assert.deepEqual(report.tests_run, []);
  assert.deepEqual(report.test_results, []);
  assert.equal(report.repository_context.repository_url, null);
});

test('claude executor adapter: missing section throws EXECUTOR_INVALID_OUTPUT', async () => {
  const text = `## task_id
demo-task

## status
DONE`;
  const { spawn } = makeFakeSpawn({ stdout: text });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT);
    return true;
  });
});

test('claude executor adapter: invalid status value throws EXECUTOR_INVALID_OUTPUT', async () => {
  const { spawn } = makeFakeSpawn({ stdout: reportText({ status: 'MAYBE' }) });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT);
    return true;
  });
});

test('claude executor adapter: mismatched task_id throws EXECUTOR_INVALID_OUTPUT', async () => {
  const { spawn } = makeFakeSpawn({ stdout: reportText({ taskId: 'other-task' }) });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT);
    return true;
  });
});

test('claude executor adapter: unparseable output (no headings) throws EXECUTOR_INVALID_OUTPUT', async () => {
  const { spawn } = makeFakeSpawn({ stdout: 'not a report at all' });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_INVALID_OUTPUT);
    return true;
  });
});

test('claude executor adapter: spawn ENOENT throws EXECUTOR_UNAVAILABLE', async () => {
  const spawnError = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const { spawn } = makeFakeSpawn({ spawnError });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE);
    return true;
  });
});

test('claude executor adapter: non-zero exit code throws EXECUTOR_UNAVAILABLE', async () => {
  const { spawn } = makeFakeSpawn({ code: 1, stderr: 'boom' });
  const adapter = createClaudeExecutorAdapter({ spawn });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_UNAVAILABLE);
    assert.match(err.message, /boom/);
    return true;
  });
});

test('claude executor adapter: a hung process is mechanically killed and throws EXECUTOR_BUDGET_EXCEEDED', async () => {
  const { spawn } = makeFakeSpawn({ hang: true });
  let child;
  const adapter = createClaudeExecutorAdapter({
    spawn: (...args) => {
      child = spawn(...args);
      return child;
    },
    env: { EXECUTOR_MAX_RUNTIME_MS: '20' },
  });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED);
    assert.equal(err.details.budget.maxRuntimeMs, 20);
    assert.equal(err.details.processTreeTerminated, true);
    return true;
  });
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('claude executor adapter: a normal short process completes before its mechanical runtime limit', async () => {
  const { spawn } = makeFakeSpawn({ stdout: reportText() });
  const report = await createClaudeExecutorAdapter({ spawn, env: { EXECUTOR_MAX_RUNTIME_MS: '20' } }).execute(demoTaskCard());
  assert.equal(report.status, 'DONE');
});

test('claude executor adapter: extracts usage and cost from json output and triggers process hooks', async () => {
  const jsonStdout = JSON.stringify({
    result: reportText({ status: 'DONE' }),
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 4200,
      output_tokens: 350,
      cache_read_input_tokens: 1500,
      cache_creation_input_tokens: 500,
    },
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 4200, outputTokens: 350 },
    },
  });

  const activityEvents = [];
  let startedPid = null;
  const { spawn, calls } = makeFakeSpawn({ stdout: jsonStdout });

  const adapter = createClaudeExecutorAdapter({
    model: 'sonnet',
    spawn: (...args) => {
      const child = spawn(...args);
      child.pid = 9999;
      return child;
    },
    onActivity: (act) => activityEvents.push(act),
    onProcessStarted: (pid) => { startedPid = pid; },
  });

  const report = await adapter.execute(demoTaskCard());

  assert.equal(report.status, 'DONE');
  assert.equal(report.costUsd, 0.05);
  assert.equal(report.model, 'claude-sonnet-5');
  assert.deepEqual(report.permissionDenials, []);
  assert.deepEqual(report.usage, {
    input_tokens: 4200,
    output_tokens: 350,
    cache_read_tokens: 1500,
    cache_creation_tokens: 500,
    total_tokens: 4550,
    num_turns: null,
  });
  assert.equal(startedPid, 9999);
  assert.ok(activityEvents.length > 0);
  assert.ok(calls[0].args.includes('--model'));
  assert.ok(calls[0].args.includes('sonnet'));
  assert.ok(calls[0].args.includes('--max-turns'));
  assert.ok(calls[0].args.includes('30'));
  assert.ok(calls[0].args.includes('--output-format'));
  assert.ok(calls[0].args.includes('json'));
  // Scoped Executor loads zero MCP servers: --strict-mcp-config present,
  // no --mcp-config passed, so the user's SuperGPT MCP schemas never inject.
  assert.ok(calls[0].args.includes('--strict-mcp-config'));
  assert.ok(!calls[0].args.includes('--mcp-config'));
});

test('claude executor adapter: exposes provider permission denial telemetry', async () => {
  const payload = JSON.stringify({
    result: reportText(),
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'node -e 1' } }],
  });
  const { spawn } = makeFakeSpawn({ stdout: payload });
  const report = await createClaudeExecutorAdapter({ spawn }).execute(demoTaskCard());
  assert.equal(report.permissionDenials.length, 1);
  assert.equal(report.permissionDenials[0].tool_name, 'Bash');
  assert.equal(report.permissionDenials[0].tool_input.command, 'node -e 1');
  assert.equal(report.permissionDenials[0].repeatCount, 1);
  assert.match(report.permissionDenials[0].fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(report.permissionDenialAnalysis.maxRepeat, 1);
  assert.equal(report.verificationBlocked, undefined);
});

test('claude executor adapter: fixture cache growth trips EXECUTOR_BUDGET_EXCEEDED and preserves fresh-session flags', async () => {
  const payload = JSON.stringify({
    result: reportText(),
    usage: {
      input_tokens: 100,
      output_tokens: 12,
      cache_read_input_tokens: 3_500_000,
      cache_creation_input_tokens: 0,
    },
  });
  const { spawn, calls } = makeFakeSpawn({ stdout: payload });
  const adapter = createClaudeExecutorAdapter({
    spawn,
    env: { EXECUTOR_MAX_CACHE_READ_TOKENS: '250000', EXECUTOR_MAX_OUTPUT_TOKENS: '20000' },
  });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED);
    assert.match(err.message, /3500000\/250000/);
    return true;
  });
  assert.ok(calls[0].args.includes('--no-session-persistence'));
  assert.ok(calls[0].args.includes('--max-budget-usd'));
  assert.ok(!calls[0].args.includes('--resume'));
  assert.ok(!calls[0].args.includes('--continue'));
});

// --- Executor budget guard: metric selection (Fix A) ---------------------

test('budget guard: 8-turn trivial smoke (cacheRead 288k / creation 24k) is NOT killed by cumulative cacheRead', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: {
      output_tokens: 2010,
      cache_read_tokens: 287895,
      cache_creation_tokens: 23569,
      num_turns: 8,
    },
    costUsd: 0.172,
    limits,
  });
  assert.equal(result.exceeded, false, result.reason ?? 'expected within budget');
  assert.equal(result.observed.cacheReadPerTurn, Math.round(287895 / 8));
});

test('budget guard: abnormally large cacheCreation is a hard stop', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 10, cache_read_tokens: 400_000, cache_creation_tokens: 900_000, num_turns: 3 },
    limits,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /cacheCreation=900000\/200000/);
});

test('budget guard: abnormally large cacheRead-per-turn is a hard stop', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 10, cache_read_tokens: 1_200_000, cache_creation_tokens: 30_000, num_turns: 4 },
    limits,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /cacheReadPerTurn=300000\/150000/);
});

test('budget guard: num_turns over the cap is a hard stop', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 10, cache_read_tokens: 100_000, cache_creation_tokens: 10_000, num_turns: 90 },
    limits,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /numTurns=90\/30/);
});

test('budget guard: default turn cap is 30 — 30 turns PASS, 31 turns BLOCK', () => {
  const limits = resolveExecutorBudgetLimits({});
  assert.equal(limits.maxTurns, 30);

  const at = evaluateExecutorBudget({
    usage: { output_tokens: 10, cache_read_tokens: 30_000, cache_creation_tokens: 10_000, num_turns: 30 },
    costUsd: 0.01,
    limits,
  });
  assert.equal(at.exceeded, false, '30 turns is within the cap');

  const over = evaluateExecutorBudget({
    usage: { output_tokens: 10, cache_read_tokens: 31_000, cache_creation_tokens: 10_000, num_turns: 31 },
    costUsd: 0.01,
    limits,
  });
  assert.equal(over.exceeded, true, '31 turns trips the cap');
  assert.ok(over.checks.some((c) => c.metric === 'numTurns' && c.limit === 30 && c.value === 31));
});

test('budget guard: turn cap remains configurable via EXECUTOR_MAX_TURNS / override', () => {
  const overridden = resolveExecutorBudgetLimits({ EXECUTOR_MAX_TURNS: '45' });
  assert.equal(overridden.maxTurns, 45);
  const injected = resolveExecutorBudgetLimits({}, { maxTurns: 12 });
  assert.equal(injected.maxTurns, 12);
});

test('budget guard: provider-reported cost over the cap is a hard stop', () => {
  const limits = resolveExecutorBudgetLimits({}, { maxBudgetUsd: 0.5 });
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 100, cache_read_tokens: 50_000, cache_creation_tokens: 5_000, num_turns: 5 },
    costUsd: 7.05,
    limits,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /costUsd=7.05\/0.5/);
});

test('budget guard: historical multi-million cacheRead is still caught via per-turn / turns / cost', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 25_916, cache_read_tokens: 3_519_194, cache_creation_tokens: 73_357, num_turns: 49 },
    costUsd: 7.05,
    limits,
  });
  assert.equal(result.exceeded, true);
  // caught by output + cost, not by a fixed cumulative cacheRead threshold
  assert.match(result.reason, /outputTokens=25916\/20000/);
  assert.match(result.reason, /costUsd=7.05\/0.5/);
  assert.doesNotMatch(result.reason, /cumulativeCacheRead/);
});

test('budget guard: a single blown-up turn in an otherwise short run trips per-turn', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 500, cache_read_tokens: 1_709_521, cache_creation_tokens: 40_000, num_turns: 7 },
    costUsd: 0.3,
    limits,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason, /cacheReadPerTurn=244217\/150000/);
});

test('budget guard: cumulative cacheRead only enforced when explicitly configured > 0', () => {
  const off = evaluateExecutorBudget({
    usage: { cache_read_tokens: 5_000_000, cache_creation_tokens: 1000, output_tokens: 1, num_turns: 200 },
    limits: { maxCacheReadTokens: 0, maxCacheCreationTokens: 0, maxCacheReadPerTurn: 0, maxOutputTokens: 0, maxTurns: 0, maxCostUsd: 0 },
  });
  assert.equal(off.exceeded, false);
  const on = evaluateExecutorBudget({
    usage: { cache_read_tokens: 5_000_000, cache_creation_tokens: 1000, output_tokens: 1, num_turns: 200 },
    limits: { maxCacheReadTokens: 250_000 },
  });
  assert.equal(on.exceeded, true);
  assert.match(on.reason, /cumulativeCacheRead=5000000\/250000/);
});

test('budget guard: env overrides are honoured', () => {
  const limits = resolveExecutorBudgetLimits({
    EXECUTOR_MAX_CACHE_CREATION_TOKENS: '50000',
    EXECUTOR_MAX_CACHE_READ_PER_TURN: '40000',
    EXECUTOR_MAX_OUTPUT_TOKENS: '5000',
    EXECUTOR_MAX_COST_USD: '0.10',
  });
  assert.equal(limits.maxCacheCreationTokens, 50000);
  assert.equal(limits.maxCacheReadPerTurn, 40000);
  assert.equal(limits.maxOutputTokens, 5000);
  assert.equal(limits.maxCostUsd, 0.10);
});

test('budget guard: a normal small task stays within budget', () => {
  const limits = resolveExecutorBudgetLimits({});
  const result = evaluateExecutorBudget({
    usage: { output_tokens: 800, cache_read_tokens: 60_000, cache_creation_tokens: 22_000, num_turns: 3 },
    costUsd: 0.04,
    limits,
  });
  assert.equal(result.exceeded, false, result.reason ?? '');
});

test('budget guard: adapter records usage-with-callId in the thrown error on a hard stop', async () => {
  const payload = JSON.stringify({
    result: reportText(),
    total_cost_usd: 0.18,
    num_turns: 8,
    usage: {
      input_tokens: 16,
      output_tokens: 2010,
      cache_read_input_tokens: 287895,
      cache_creation_input_tokens: 900_000,
    },
  });
  const { spawn } = makeFakeSpawn({ stdout: payload });
  const adapter = createClaudeExecutorAdapter({ spawn });
  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_BUDGET_EXCEEDED);
    assert.ok(err.details.usage, 'usage must be attached to the error');
    assert.equal(err.details.usage.num_turns, 8);
    assert.equal(err.details.usage.output_tokens, 2010);
    assert.equal(err.details.usage.cache_read_tokens, 287895);
    assert.equal(err.details.costUsd, 0.18);
    assert.equal(err.details.numTurns, 8);
    assert.ok(String(err.details.callId).startsWith('call-claude-exe-'));
    assert.equal(err.details.usage.callId, err.details.callId);
    assert.match(err.details.budgetExceededReason, /cacheCreation=900000\/200000/);
    return true;
  });
});

// --- Permission-denial de-duplication (Fix B) ----------------------------

test('denial dedup: identical denied commands collapse to one entry with a repeatCount', () => {
  const denial = { tool_name: 'Bash', tool_input: { command: 'node -e "read(p)"' } };
  const spaced = { tool_name: 'Bash', tool_input: { command: '  node   -e   "read(p)"  ' } };
  const analysis = dedupePermissionDenials([denial, spaced, denial, denial], '/repo');
  assert.equal(analysis.deduped.length, 1);
  assert.equal(analysis.deduped[0].repeatCount, 4);
  assert.equal(analysis.maxRepeat, 4);
  assert.ok(analysis.verificationBlocked);
  assert.equal(analysis.verificationBlocked.repeatCount, 4);
  assert.equal(analysis.verificationBlocked.tool, 'Bash');
});

test('denial dedup: genuinely different commands are NOT merged', () => {
  const analysis = dedupePermissionDenials([
    { tool_name: 'Bash', tool_input: { command: 'node a.js' } },
    { tool_name: 'Bash', tool_input: { command: 'node b.js' } },
  ], '/repo');
  assert.equal(analysis.deduped.length, 2);
  assert.equal(analysis.maxRepeat, 1);
  assert.equal(analysis.verificationBlocked, null);
});

test('denial dedup: same command in a different cwd fingerprints differently', () => {
  const d = { tool_name: 'Bash', tool_input: { command: 'node t.js' } };
  assert.notEqual(denialFingerprint(d, '/repo-a'), denialFingerprint(d, '/repo-b'));
});

test('denial dedup: threshold constant and normalizer are stable', () => {
  assert.equal(DENIAL_REPEAT_THRESHOLD, 2);
  assert.equal(normalizeDeniedCommand('  a   b\tc\n'), 'a b c');
});

test('denial dedup: adapter flags verificationBlocked when one command is denied repeatedly', async () => {
  const d = { tool_name: 'Bash', tool_input: { command: 'node verify.js' } };
  const payload = JSON.stringify({ result: reportText({ status: 'BLOCKED' }), permission_denials: [d, d, d] });
  const { spawn } = makeFakeSpawn({ stdout: payload });
  const report = await createClaudeExecutorAdapter({ spawn }).execute(demoTaskCard());
  assert.equal(report.permissionDenials.length, 1);
  assert.equal(report.permissionDenials[0].repeatCount, 3);
  assert.ok(report.verificationBlocked);
  assert.equal(report.verificationBlocked.command, 'node verify.js');
  assert.equal(report.permissionDenialAnalysis.maxRepeat, 3);
});

test('claude executor adapter: builds only exact allowed tools for approved node and npm commands', () => {
  const taskCard = demoTaskCard({
    verification_commands: [
      'node --test tests/claudeExecutorAdapter.test.js tests/claudeSessionManager.test.js',
      'npm test',
      'npm run test',
    ],
  });

  const tools = buildAllowedVerificationTools(taskCard);
  assert.deepEqual(tools, [
    'Bash(node --test tests/claudeExecutorAdapter.test.js tests/claudeSessionManager.test.js)',
    'Bash(npm test)',
    'Bash(npm run test)',
  ]);
  assert.ok(!tools.some((tool) => tool.includes('*')));
});

test('claude executor adapter: rejects adjacent unapproved Node/npm commands and argument injection', () => {
  const tools = buildAllowedVerificationTools(demoTaskCard({
    verification_commands: [
      'node -e "console.log(1)"',
      'node',
      'npm t',
      'npm test -- --watch',
      'npm run test -- --watch',
      'npm run not-declared',
      'node scripts/live-smoke-active-pools.js $(whoami)',
    ],
  }));
  assert.deepEqual(tools, []);
});

test('claude executor adapter: approves an exact repository Node script command', () => {
  assert.deepEqual(
    buildAllowedVerificationTools(demoTaskCard({
      verification_commands: ['node scripts/live-smoke-active-pools.js'],
    })),
    ['Bash(node scripts/live-smoke-active-pools.js)']
  );
});

test('claude executor adapter: filters out dangerous commands and unauthorized paths from allowedTools', () => {
  const dangerousCommands = [
    'curl -I https://example.com',
    'wget https://example.com',
    'rm -rf /tmp/test',
    'git push origin main',
    'git checkout -b hack',
    'npm install malicious-package',
    'npm i evil',
    'npx some-package',
    'node /tmp/bad.js',
    'node ../escape.js',
    'node -e "process.exit(1)" ; rm -rf /',
    'npm test && curl https://evil.com',
    'sudo rm -rf .',
    'bash -c "echo evil"',
  ];

  for (const cmd of dangerousCommands) {
    assert.equal(isDangerousVerificationCommand(cmd), true, `should flag as dangerous: ${cmd}`);
  }

  const taskCard = demoTaskCard({
    verification_commands: dangerousCommands,
  });

  const tools = buildAllowedVerificationTools(taskCard);
  assert.deepEqual(tools, []);
});

test('executor contract: verification_commands are mandatory and authoritative in the prompt', () => {
  const prompt = buildPrompt(demoTaskCard({ verification_commands: ['npm test'] }));
  assert.match(prompt, /mandatory and authoritative verification gate/i);
  assert.match(prompt, /Run every one of them yourself/i);
  assert.match(prompt, /simple, fast, local, read-only auxiliary checks/i);
});

test('executor contract: without an explicit live-smoke command the prompt forbids elevating or launching it', () => {
  const prompt = buildPrompt(demoTaskCard({
    verification_commands: ['node --test tests/foo.test.js'],
  }));
  // The high-risk command is not part of the authoritative gate...
  assert.doesNotMatch(prompt, /live-smoke-active-pools/);
  // ...and the contract explicitly forbids treating undeclared smoke/agent/
  // network commands as necessary verification.
  assert.match(prompt, /MUST NOT invent additional "required" verification/i);
  assert.match(prompt, /spawns another agent|long-lived or background child process/i);
  assert.match(prompt, /performs live-smoke or integration-smoke testing/i);
  assert.match(prompt, /record it under issues instead of running it/i);
});

test('executor contract: an explicitly listed live-smoke command is permitted as required verification', () => {
  const prompt = buildPrompt(demoTaskCard({
    verification_commands: ['node scripts/live-smoke-active-pools.js'],
  }));
  // Rendered into the authoritative verification_commands section...
  assert.match(prompt, /## verification_commands\n- `node scripts\/live-smoke-active-pools\.js`/);
  // ...and the contract permits running it even though it is a live smoke.
  assert.match(prompt, /If such a command IS listed verbatim in verification_commands, run it as required verification/i);
});

test('claude executor adapter: passes --allowedTools and preserves --permission-mode acceptEdits to child process', async () => {
  const { spawn, calls } = makeFakeSpawn({ stdout: reportText() });
  const adapter = createClaudeExecutorAdapter({ spawn });

  const taskCard = demoTaskCard({
    verification_commands: ['node --test tests/foo.test.js', 'npm test'],
  });

  await adapter.execute(taskCard);

  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('acceptEdits'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('Bash(node --test tests/foo.test.js)'));
  assert.ok(args.includes('Bash(npm test)'));
});

test('executor contract: forbids treating a denied unlisted probe command as an environment blocker', () => {
  const prompt = buildPrompt(demoTaskCard({ verification_commands: ['npm test'] }));
  assert.match(prompt, /Do NOT run an undeclared test, build, or toolchain command as an environment probe/i);
  assert.match(prompt, /it is NOT evidence that node, npm, git, or the environment as a whole is unavailable/i);
  assert.match(prompt, /Report a permission\/environment BLOCKED only when one of this Task Card's own verification_commands is itself denied/i);
});

test('executor contract: renders unauthorized_probe_guidance steering the Executor back to approved commands', () => {
  const prompt = buildPrompt(demoTaskCard({
    verification_commands: ['npm test'],
    unauthorized_probe_guidance: {
      denied_commands: ['node --test tests/other.test.js'],
      approved_verification_commands: ['npm test'],
    },
  }));
  assert.match(prompt, /"verification_guidance": \{/);
  assert.match(prompt, /"node --test tests\/other\.test\.js"/);
  assert.match(prompt, /"approved_verification_commands": \[/);
  assert.match(prompt, /"npm test"/);
  assert.match(prompt, /compact_structured_handoff/);
});

test('executor prompt: emits the four scope-isolation layers in order', () => {
  const prompt = buildPrompt(demoTaskCard());
  const l1 = prompt.indexOf('LAYER 1 · WORKFLOW BACKGROUND');
  const l2 = prompt.indexOf('LAYER 2 · CURRENT TASK — THE ONLY EXECUTABLE AUTHORIZATION');
  const l3 = prompt.indexOf('LAYER 3 · EXECUTION RULES');
  const l4 = prompt.indexOf('LAYER 4 · HISTORICAL EVIDENCE');
  assert.ok(l1 >= 0 && l2 > l1 && l3 > l2 && l4 > l3, 'layers must appear once, in order');
  // The Task Card (authorization) sits inside layer 2, before the execution rules.
  const card = prompt.indexOf('## goal\ndemo');
  assert.ok(card > l2 && card < l3);
});

test('executor prompt: consecutive tasks do not inherit each other\'s goal, paths or verification commands', () => {
  const taskA = demoTaskCard({
    task_id: 'task-a',
    goal: 'rewrite the alpha parser',
    scope: 'alpha module only',
    allowed_files: ['src/alpha/parser.js'],
    verification_commands: ['node --test tests/alpha.test.js'],
    rework_feedback: { findings: ['alpha off-by-one'], required_changes: ['clamp alpha index'], rationale: 'bug' },
  });
  const taskB = demoTaskCard({
    task_id: 'task-b',
    goal: 'add beta telemetry',
    scope: 'beta module only',
    allowed_files: ['src/beta/telemetry.js'],
    verification_commands: ['node --test tests/beta.test.js'],
  });
  const taskC = demoTaskCard({
    task_id: 'task-c',
    goal: 'document gamma flags',
    scope: 'docs only',
    allowed_files: ['docs/gamma.md'],
    verification_commands: ['npm test'],
  });

  const promptA = buildPrompt(taskA);
  const promptB = buildPrompt(taskB);
  const promptC = buildPrompt(taskC);

  // Each prompt authorizes only its own task.
  assert.match(promptB, /## task_id\ntask-b/);
  assert.doesNotMatch(promptB, /rewrite the alpha parser/);
  assert.doesNotMatch(promptB, /src\/alpha\/parser\.js/);
  assert.doesNotMatch(promptB, /tests\/alpha\.test\.js/);
  assert.doesNotMatch(promptB, /alpha off-by-one/);
  assert.doesNotMatch(promptB, /document gamma flags/);
  assert.doesNotMatch(promptB, /docs\/gamma\.md/);

  assert.doesNotMatch(promptA, /add beta telemetry/);
  assert.doesNotMatch(promptC, /add beta telemetry/);
  assert.doesNotMatch(promptC, /src\/beta\/telemetry\.js/);

  // taskB carries no rework history at all.
  assert.match(promptB, /No prior attempts recorded for this task/);
});

test('executor prompt: prior-attempt evidence renders only in the read-only historical layer', () => {
  const prompt = buildPrompt(demoTaskCard({
    task_id: 'rework-task',
    rework_feedback: { findings: ['bad edge case'], required_changes: ['handle empty input'], rationale: 'reviewer' },
    unauthorized_probe_guidance: {
      denied_commands: ['node --test tests/other.test.js'],
      approved_verification_commands: ['npm test'],
    },
  }));
  const l3 = prompt.indexOf('LAYER 3 · EXECUTION RULES');
  const l4 = prompt.indexOf('LAYER 4 · HISTORICAL EVIDENCE');
  const rework = prompt.indexOf('"corrections": {');
  const probe = prompt.indexOf('"verification_guidance": {');
  assert.ok(rework > l4 && probe > l4, 'evidence sits in layer 4');
  assert.ok(l4 > l3);
  // Layer 4 is explicitly non-authorizing.
  assert.match(prompt, /do NOT expand allowed_files, add verification commands, or change the goal/i);
  assert.match(prompt, /read-only background/i);
});

test('executor adapter: allowedTools / permission config is not loosened (no wildcards, exact commands only)', async () => {
  const taskCard = demoTaskCard({
    verification_commands: ['npm test', 'node --test tests/a.test.js'],
  });
  const tools = buildAllowedVerificationTools(taskCard);
  assert.deepEqual(tools, ['Bash(npm test)', 'Bash(node --test tests/a.test.js)']);
  assert.ok(!tools.some((t) => t.includes('*')));

  const { spawn, calls } = makeFakeSpawn({ stdout: reportText() });
  await createClaudeExecutorAdapter({ spawn }).execute(taskCard);
  const args = calls[0].args;
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  // No blanket Bash/tool grant slipped in alongside the exact commands.
  assert.ok(!args.some((a) => typeof a === 'string' && /Bash\(\*|Bash$|--dangerously/i.test(a)));
  assert.ok(!args.includes('--allowedTools') || args.filter((a) => a === 'Bash(npm test)' || a === 'Bash(node --test tests/a.test.js)').length === 2);
});
