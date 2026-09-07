// Stage 3 — production Codex / Claude Reviewer+Supervisor transports.
// Narrow, stateless, single-turn; output through the SAME strict normalization
// as agy. No real provider call: every spawn is a deterministic fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  makeCodexReviewTransport,
  makeClaudeReviewTransport,
  probeReviewTransportRuntime,
} from '../src/reviewloop/adapters/cliReviewTransports.js';
import { CLI_FAILURE } from '../src/reviewloop/adapters/boundedCli.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';
import { narrowReviewTransportCwd } from '../src/reviewloop/adapters/scratchCwd.js';

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    const r = handler({ command, args }) ?? {};
    child.kill = (signal) => { (child.killCalls ??= []).push(signal); return true; };
    if (r.neverCloses) return child;
    queueMicrotask(() => {
      if (r.spawnError) { child.emit('error', Object.assign(new Error('spawn fail'), { code: r.spawnError })); return; }
      if (r.writesOutFile) {
        const i = args.indexOf('-o');
        if (i !== -1) writeFileSync(args[i + 1], r.writesOutFile);
      }
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('codex transport: narrow argv, scratch cwd, reads the -o last message', async () => {
  const spawn = fakeSpawn(() => ({
    writesOutFile: '```json\n{"findings":[{"severity":"P1","file":"a.js","line":2,"title":"npe"}]}\n```',
    stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 120 }, model: 'gpt-5-codex' }) + '\n',
  }));
  const transport = makeCodexReviewTransport({ spawn });
  const res = await transport('REVIEW THIS');
  const { args } = spawn.calls[0];
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual([args[args.indexOf('-s')], args[args.indexOf('-s') + 1]], ['-s', 'read-only']);
  assert.equal(args[args.indexOf('-C') + 1], narrowReviewTransportCwd());
  assert.equal(args.at(-1), 'REVIEW THIS');
  assert.ok(!args.includes('-m'), 'no --model for codex:default');
  assert.match(res.text, /findings/);
  assert.equal(res.usage.input_tokens, 900);
  assert.equal(res.model, 'gpt-5-codex');
  assert.equal(res.meta.promptChars, 'REVIEW THIS'.length);
});

test('codex transport: post-dispatch auth / rate-limit / quota / enoent / protocol classify correctly', async () => {
  const cases = [
    [{ code: 1, stderr: 'Error: 401 Unauthorized' }, CLI_FAILURE.AUTH_REJECTED],
    [{ code: 1, stderr: 'stream error: 429 rate limit exceeded' }, CLI_FAILURE.RATE_LIMITED],
    [{ code: 1, stderr: 'insufficient_quota: add billing' }, CLI_FAILURE.QUOTA_EXHAUSTED],
    [{ spawnError: 'ENOENT' }, CLI_FAILURE.UNAVAILABLE],
    [{ code: 1, stderr: 'some other blowup' }, CLI_FAILURE.PROTOCOL_ERROR],
  ];
  for (const [resp, expected] of cases) {
    const transport = makeCodexReviewTransport({ spawn: fakeSpawn(() => resp), timeoutMs: 5000 });
    await assert.rejects(transport('x'), (err) => {
      assert.equal(err.code, expected, JSON.stringify(resp));
      assert.equal(err.providerFailure, expected);
      return true;
    });
  }
});

test('codex transport: wall-clock timeout -> PROVIDER_TIMEOUT (signals intercepted, never real)', async () => {
  const originalKill = process.kill;
  const signalled = [];
  process.kill = (pid, sig) => {
    signalled.push([pid, sig]);
    const err = new Error('no such process'); err.code = 'ESRCH'; throw err;
  };
  try {
    const spawn = fakeSpawn(() => ({ neverCloses: true }));
    const transport = makeCodexReviewTransport({ spawn, timeoutMs: 40 });
    await assert.rejects(transport('x'), (err) => err.code === CLI_FAILURE.TIMEOUT);
    assert.ok(signalled.every(([pid]) => pid !== -1), 'never POSIX kill(-1) broadcast');
    assert.ok(signalled.every(([pid]) => pid < 0), 'only negative-PGID group targets reached the stubbed primitive');
  } finally {
    process.kill = originalKill;
  }
});

test('claude transport: narrow argv + stable opus alias + json envelope -> text/usage/cost', async () => {
  const spawn = fakeSpawn(() => ({
    stdout: JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: '{"findings":[]}', model: 'claude-opus-current',
      usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 5 },
      total_cost_usd: 0.012,
    }),
  }));
  const transport = makeClaudeReviewTransport({ spawn, model: 'opus' });
  const res = await transport('REVIEW');
  const { args } = spawn.calls[0];
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual([args[args.indexOf('--mcp-config')], args[args.indexOf('--mcp-config') + 1]], ['--mcp-config', '{}']);
  assert.ok(args.includes('--exclude-dynamic-system-prompt-sections'));
  assert.ok(args.includes('--disallowedTools'));
  assert.match(args[args.indexOf('--disallowedTools') + 1], /Bash/);
  assert.deepEqual([args[args.indexOf('--model')], args[args.indexOf('--model') + 1]], ['--model', 'opus']);
  assert.equal(res.text, '{"findings":[]}');
  assert.equal(res.usage.input_tokens, 1200);
  assert.equal(res.usage.cache_read_input_tokens, 5);
  assert.equal(res.costUsd, 0.012);
  assert.equal(res.model, 'claude-opus-current');
});

test('claude transport: error subtype / non-JSON -> classified failure', async () => {
  const errEnvelope = makeClaudeReviewTransport({
    spawn: fakeSpawn(() => ({ code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '429 rate limited' }) })),
  });
  await assert.rejects(errEnvelope('x'), (err) => err.code === CLI_FAILURE.RATE_LIMITED);

  const garbage = makeClaudeReviewTransport({ spawn: fakeSpawn(() => ({ code: 0, stdout: 'not json at all' })) });
  await assert.rejects(garbage('x'), (err) => err.code === CLI_FAILURE.PROTOCOL_ERROR);
});

test('pool: an available CLI runtime is actually wired and selectable', async () => {
  const spawn = fakeSpawn(() => ({
    writesOutFile: '{"findings":[]}',
    stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n',
  }));
  const health = new (await import('../src/orchestrator/roleRouting.js')).ProviderHealthRegistry();
  health.record('agy:gemini', 'UNAVAILABLE');
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({}),
    providerHealth: health,
    transportRuntime: { 'codex:default': { available: true, reason: 'ok' }, 'claude:opus': { available: false, reason: 'CLI not installed' } },
    spawn,
  });
  assert.equal(pool.runtimeStatus['codex:default'].runtimeAvailable, true);
  assert.equal(pool.runtimeStatus['codex:default'].adapterImplemented, true);
  assert.equal(pool.runtimeStatus['claude:opus'].runtimeAvailable, false);
  assert.match(pool.runtimeStatus['claude:opus'].reason, /adapter present; runtime unavailable/);

  const sel = pool.route('supervisor');
  assert.equal(sel.family, 'codex:default');
  assert.ok(typeof sel.transport === 'function');
  const out = await sel.transport('P');
  assert.match(out.text, /findings/);
});

test('pool: no runtime probe -> CLI families reported UNAVAILABLE, never phantom-selected', () => {
  const pool = createReviewLoopProviderPool({ callAgy: async () => ({}) });
  assert.equal(pool.route('reviewer').family, 'agy:gpt-oss');
  assert.equal(pool.runtimeStatus['codex:default'].runtimeAvailable, false);
  assert.equal(pool.runtimeStatus['claude:opus'].runtimeAvailable, false);
});

test('probeReviewTransportRuntime: missing CLI or local unauthenticated status is unavailable pre-dispatch', async () => {
  const missing = await probeReviewTransportRuntime({ spawn: fakeSpawn(() => ({ spawnError: 'ENOENT' })) });
  assert.equal(missing['codex:default'].available, false);
  assert.equal(missing['codex:default'].reason, 'CLI not installed');
  assert.equal(missing['claude:opus'].available, false);

  const spawn = fakeSpawn(({ command, args }) => {
    if (args[0] === '--version') return { code: 0, stdout: `${command}-version` };
    if (command === 'codex' && args[0] === 'login' && args[1] === 'status') return { code: 1, stderr: 'Not logged in' };
    if (command === 'claude' && args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: '{"loggedIn":true}' };
    return { code: 1 };
  });
  const rt = await probeReviewTransportRuntime({ spawn });
  assert.equal(rt['codex:default'].available, false);
  assert.equal(rt['codex:default'].reason, 'not authenticated');
  assert.equal(rt['claude:opus'].available, true);
  assert.equal(rt['claude:opus'].authChecked, true);
  assert.ok(spawn.calls.some((c) => c.command === 'codex' && c.args.join(' ') === 'login status'));
  assert.ok(spawn.calls.some((c) => c.command === 'claude' && c.args.join(' ') === 'auth status'));
});
