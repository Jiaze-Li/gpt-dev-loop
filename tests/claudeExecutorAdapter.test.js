import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createClaudeExecutorAdapter } from '../src/orchestrator/adapters/claudeExecutorAdapter.js';
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
    child.kill = () => {
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

test('claude executor adapter: a hung process throws EXECUTOR_TIMEOUT', async () => {
  const { spawn } = makeFakeSpawn({ hang: true });
  const adapter = createClaudeExecutorAdapter({ spawn, timeoutMs: 20 });

  await assert.rejects(() => adapter.execute(demoTaskCard()), (err) => {
    assert.equal(err.code, ADAPTER_ERROR_CODES.EXECUTOR_TIMEOUT);
    return true;
  });
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
  assert.deepEqual(report.usage, {
    input_tokens: 4200,
    output_tokens: 350,
    cache_read_tokens: 1500,
    cache_creation_tokens: 500,
    total_tokens: 4550,
  });
  assert.equal(startedPid, 9999);
  assert.ok(activityEvents.length > 0);
  assert.ok(calls[0].args.includes('--model'));
  assert.ok(calls[0].args.includes('sonnet'));
  assert.ok(calls[0].args.includes('--output-format'));
  assert.ok(calls[0].args.includes('json'));
});
