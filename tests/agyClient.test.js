import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callAgy,
  AgyError,
  AgyExecutableNotFoundError,
  AgyTimeoutError,
  AgyExitError,
  AgyOutputError,
  AgyConversationResumeError,
  DEFAULT_AGY_MODEL,
} from '../src/agy/agyClient.js';
import { makeFakeSpawn } from './fixtures/fakeAgyProcess.mjs';
import { resolveAgyLiveConfig } from '../scripts/test-agy-live.js';

test('success: parses JSON envelope and normalizes text', async () => {
  const spawn = makeFakeSpawn({
    code: 0,
    stdout: JSON.stringify({ result: '{"status":"PASS","message":"AGY_OK"}' }),
  });
  const out = await callAgy({ prompt: 'ping', model: 'gemini-3.7-flash-low', timeoutMs: 1000, spawn });

  assert.equal(out.exitCode, 0);
  assert.equal(out.model, 'gemini-3.7-flash-low');
  assert.equal(out.text, '{"status":"PASS","message":"AGY_OK"}');
  assert.deepEqual(out.json, { result: '{"status":"PASS","message":"AGY_OK"}' });

  const { args, options } = spawn.calls[0];
  assert.equal(args[0], '--print=ping', 'prompt is attached to --print as the first argv entry');
  assert.ok(!args.includes('--print'), 'no detached --print token that could swallow the next flag');
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.7-flash-low');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.notEqual(options?.shell, true, 'spawn must not use shell:true');
});

test('success: default model is used when none supplied', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: JSON.stringify({ text: 'ok' }) });
  const out = await callAgy({ prompt: 'ping', timeoutMs: 1000, spawn });
  assert.equal(out.model, DEFAULT_AGY_MODEL);
  assert.equal(out.text, 'ok');
});

test('nonzero exit: rejects with AgyExitError carrying stderr', async () => {
  const spawn = makeFakeSpawn({ code: 3, stderr: 'rate limited' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 1000, spawn }),
    (err) => {
      assert.ok(err instanceof AgyExitError);
      assert.equal(err.code, 'AGY_NONZERO_EXIT');
      assert.equal(err.exitCode, 3);
      assert.match(err.stderr, /rate limited/);
      assert.equal(typeof err.durationMs, 'number');
      return true;
    },
  );
});

test('timeout: kills the child and rejects with AgyTimeoutError', async () => {
  const spawn = makeFakeSpawn({ hang: true });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 30, spawn }),
    (err) => {
      assert.ok(err instanceof AgyTimeoutError);
      assert.equal(err.code, 'AGY_TIMEOUT');
      return true;
    },
  );
});

test('malformed output: non-JSON stdout rejects with AgyOutputError', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: 'not json at all' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 1000, spawn }),
    (err) => {
      assert.ok(err instanceof AgyOutputError);
      assert.equal(err.code, 'AGY_MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('malformed output: empty stdout rejects with AgyOutputError', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '   ' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 1000, spawn }),
    (err) => err instanceof AgyOutputError,
  );
});

test('missing executable: synchronous ENOENT throw -> AgyExecutableNotFoundError', async () => {
  const enoent = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
  const spawn = makeFakeSpawn({ throwOnSpawn: enoent });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 1000, executable: 'agy', spawn }),
    (err) => {
      assert.ok(err instanceof AgyExecutableNotFoundError);
      assert.equal(err.exitCode, 127);
      return true;
    },
  );
});

test('missing executable: async error event ENOENT -> AgyExecutableNotFoundError', async () => {
  const enoent = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
  const spawn = makeFakeSpawn({ emitError: enoent });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', timeoutMs: 1000, spawn }),
    (err) => err instanceof AgyExecutableNotFoundError,
  );
});

// --- regression: transport invocation bugs found in the first live run ---

test('regression: --output-format cannot be consumed as the prompt', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{"text":"ok"}' });
  await callAgy({ prompt: '--output-format', model: 'gemini-3.7-flash-high', timeoutMs: 1000, spawn });
  const { args } = spawn.calls[0];
  // The literal prompt "--output-format" is bound to --print=, and the real
  // --output-format flag still carries json.
  assert.equal(args[0], '--print=--output-format');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
});

test('regression: argv carries the selected model', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{"text":"ok"}' });
  await callAgy({ prompt: 'ping', model: 'gemini-3.7-flash-high', timeoutMs: 1000, spawn });
  assert.equal(spawn.calls[0].args[spawn.calls[0].args.indexOf('--model') + 1], 'gemini-3.7-flash-high');
});

test('regression: spawn is never called with shell:true', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{"text":"ok"}' });
  await callAgy({ prompt: 'ping', timeoutMs: 1000, spawn });
  const { options } = spawn.calls[0];
  assert.notEqual(options?.shell, true);
});

test('regression: multiline/quoted prompt stays one argv item, no shell escaping', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{"text":"ok"}' });
  const nasty = 'line one\nline "two" with $VARS and `backticks`\n{"json":true} && rm -rf /';
  await callAgy({ prompt: nasty, timeoutMs: 1000, spawn });
  const { args, options } = spawn.calls[0];
  assert.equal(args[0], `--print=${nasty}`, 'entire prompt is a single unmodified argv entry');
  assert.equal(args.filter((a) => a.startsWith('--print=')).length, 1);
  assert.notEqual(options?.shell, true);
});

test('regression: resolveAgyLiveConfig honors AGY_MODEL and precedence', () => {
  assert.equal(
    resolveAgyLiveConfig({ AGY_MODEL: 'gemini-3.7-flash-high' }, []).model,
    'gemini-3.7-flash-high',
  );
  // CLI arg wins over env
  assert.equal(
    resolveAgyLiveConfig({ AGY_MODEL: 'gemini-3.7-flash-high' }, ['gemini-3.1-pro-high']).model,
    'gemini-3.1-pro-high',
  );
  // default when neither set
  assert.equal(resolveAgyLiveConfig({}, []).model, DEFAULT_AGY_MODEL);
  // role keywords resolve through the workflow per-role precedence
  assert.equal(resolveAgyLiveConfig({}, ['supervisor']).model, 'gemini-3.7-flash-high');
  assert.equal(resolveAgyLiveConfig({}, ['reviewer']).model, 'gpt-oss-120b-medium');
  assert.equal(resolveAgyLiveConfig({ AGY_REVIEWER_MODEL: 'gemini-3.6-flash-low' }, ['reviewer']).model, 'gemini-3.6-flash-low');
});

// --- conversationId: resume support + fail-closed validation ---

test('conversationId: passes --conversation=<id> to the agy CLI', async () => {
  const spawn = makeFakeSpawn({
    code: 0,
    stdout: JSON.stringify({ text: 'hi', conversation_id: 'abc' }),
  });
  const out = await callAgy({ prompt: 'ping', conversationId: 'abc', timeoutMs: 1000, spawn });
  const { args } = spawn.calls[0];
  assert.ok(args.includes('--conversation=abc'), 'attached --conversation flag');
  assert.ok(!args.includes('--conversation'), 'no detached --conversation token');
  assert.equal(out.conversationId, 'abc');
});

test('conversationId: extracted from json.conversation_id on a fresh call', async () => {
  const spawn = makeFakeSpawn({
    code: 0,
    stdout: JSON.stringify({ text: 'hi', conversation_id: 'fresh-123' }),
  });
  const out = await callAgy({ prompt: 'ping', timeoutMs: 1000, spawn });
  assert.equal(out.conversationId, 'fresh-123');
  assert.ok(!spawn.calls[0].args.some((a) => a.startsWith('--conversation')));
});

test('conversationId: null when the envelope carries no id', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: JSON.stringify({ text: 'hi' }) });
  const out = await callAgy({ prompt: 'ping', timeoutMs: 1000, spawn });
  assert.equal(out.conversationId, null);
});

test('conversationId: fail-closed when resumed id mismatches', async () => {
  const spawn = makeFakeSpawn({
    code: 0,
    stdout: JSON.stringify({ text: 'hi', conversation_id: 'other' }),
  });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', conversationId: 'abc', timeoutMs: 1000, spawn }),
    (err) => {
      assert.ok(err instanceof AgyConversationResumeError);
      assert.equal(err.code, 'AGY_CONVERSATION_RESUME_FAILED');
      return true;
    },
  );
});

test('conversationId: fail-closed when resume returns no id', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: JSON.stringify({ text: 'hi' }) });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', conversationId: 'abc', timeoutMs: 1000, spawn }),
    (err) => err instanceof AgyConversationResumeError && err.code === 'AGY_CONVERSATION_RESUME_FAILED',
  );
});

test('conversationId: fail-closed when stderr says conversation not found', async () => {
  const spawn = makeFakeSpawn({ code: 2, stderr: 'Error: conversation abc not found' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', conversationId: 'abc', timeoutMs: 1000, spawn }),
    (err) => {
      assert.ok(err instanceof AgyConversationResumeError);
      assert.equal(err.code, 'AGY_CONVERSATION_RESUME_FAILED');
      return true;
    },
  );
});

test('conversationId: unrelated nonzero exit still surfaces as AgyExitError', async () => {
  const spawn = makeFakeSpawn({ code: 3, stderr: 'rate limited' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', conversationId: 'abc', timeoutMs: 1000, spawn }),
    (err) => err instanceof AgyExitError && err.code === 'AGY_NONZERO_EXIT',
  );
});

test('conversationId: empty string is rejected before spawning', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{}' });
  await assert.rejects(
    () => callAgy({ prompt: 'ping', conversationId: '   ', spawn }),
    (err) => err instanceof AgyError && err.code === 'AGY_BAD_INPUT',
  );
  assert.equal(spawn.calls.length, 0);
});

test('input validation: empty prompt rejects before spawning', async () => {
  const spawn = makeFakeSpawn({ code: 0, stdout: '{}' });
  await assert.rejects(
    () => callAgy({ prompt: '   ', spawn }),
    (err) => err instanceof AgyError && err.code === 'AGY_BAD_INPUT',
  );
  assert.equal(spawn.calls.length, 0);
});
