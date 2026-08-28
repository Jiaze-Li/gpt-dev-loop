import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgyReviewerProvider, buildAgyReviewPrompt } from '../src/orchestrator/adapters/agyReviewerProvider.js';
import { ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { AgyTimeoutError, AgyExitError } from '../src/agy/agyClient.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

function taskCard() {
  const o = validTaskCardObject();
  return { ...o, repository_context: { ...o.repository_context, repository_url: null } };
}
function executionReport() {
  return {
    task_id: 'auto-a',
    repository_context: taskCard().repository_context,
    status: 'DONE',
    changed_files: ['work/auto-a.txt'],
    tests_run: ['gate'],
    test_results: ['pass'],
    issues: 'none',
    next_recommendation: 'review',
  };
}
const EVIDENCE = { status: 'CHANGED', head: 'h', base: 'b', diff: '+ok', pass: true, results: [{ command: 'test x', pass: true, output: 'ok' }] };

test('PASS -> normalized review result', async () => {
  const callAgy = makeFakeCallAgy({ decision: 'PASS', findings: ['meets criteria'], required_changes: [], rationale: 'content is exact' });
  const provider = createAgyReviewerProvider({ callAgy, model: 'gemini-3.7-flash-high' });
  const r = await provider.review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 });

  assert.equal(r.decision, 'PASS');
  assert.equal(r.task_id, 'auto-a');
  assert.equal(r.required_changes, 'none');
  assert.deepEqual(r.findings, ['meets criteria']);
  assert.equal(callAgy.calls[0].model, 'gemini-3.7-flash-high');
});

test('REWORK -> required_changes array is preserved and usable', async () => {
  const callAgy = makeFakeCallAgy({
    decision: 'REWORK',
    findings: ['content has a trailing space'],
    required_changes: ['remove the trailing space from work/auto-a.txt'],
    rationale: 'does not match acceptance_criteria exactly',
  });
  const r = await createAgyReviewerProvider({ callAgy }).review(taskCard(), executionReport(), EVIDENCE, { attempt: 2 });
  assert.equal(r.decision, 'REWORK');
  assert.deepEqual(r.required_changes, ['remove the trailing space from work/auto-a.txt']);
});

test('fail closed: REWORK without required_changes -> REVIEWER_INVALID_OUTPUT', async () => {
  const callAgy = makeFakeCallAgy({ decision: 'REWORK', findings: [], required_changes: [], rationale: 'nope' });
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
  );
});

test('fail closed: invalid decision -> REVIEWER_INVALID_OUTPUT', async () => {
  const callAgy = makeFakeCallAgy({ decision: 'LGTM', findings: [], required_changes: [], rationale: 'x' });
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
  );
});

test('fail closed: malformed JSON -> REVIEWER_INVALID_OUTPUT', async () => {
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy: makeFakeCallAgy('```\nnope\n```') }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
  );
});

test('fail closed: missing rationale -> REVIEWER_INVALID_OUTPUT', async () => {
  const callAgy = makeFakeCallAgy({ decision: 'PASS', findings: [], required_changes: [] });
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT,
  );
});

test('fail closed: agy timeout -> REVIEWER_TIMEOUT, nonzero exit -> REVIEWER_UNAVAILABLE', async () => {
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy: makeFakeCallAgy(new AgyTimeoutError(1)) }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT,
  );
  await assert.rejects(
    () => createAgyReviewerProvider({ callAgy: makeFakeCallAgy(new AgyExitError(1, 'x')) }).review(taskCard(), executionReport(), EVIDENCE),
    (err) => err.code === ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE,
  );
});

test('AgyExitError -> REVIEWER_UNAVAILABLE with safe underlying diagnostics preserved', async () => {
  const exit = new AgyExitError(1, 'quota exceeded for this account\ntry again later');
  exit.durationMs = 6870;
  const err = await createAgyReviewerProvider({
    callAgy: makeFakeCallAgy(exit),
    model: 'gpt-oss-120b-medium',
  })
    .review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 })
    .then(() => null, (e) => e);

  // high-level code preserved
  assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE);
  // not collapsed to bare "agy exited with status 1"
  assert.notEqual(err.message, 'agy exited with status 1');
  assert.match(err.message, /agy exited with status 1/);
  assert.match(err.message, /agy stderr: quota exceeded for this account \| try again later/);

  // structured, safe-only details
  assert.deepEqual(err.details, {
    role: 'reviewer',
    model: 'gpt-oss-120b-medium',
    agyErrorName: 'AgyExitError',
    agyCode: 'AGY_NONZERO_EXIT',
    exitCode: 1,
    stderr: 'quota exceeded for this account\ntry again later',
    durationMs: 6870,
    agyEnvelope: null,
  });
});

test('AgyExitError envelope: safe operational metadata from stdout is surfaced on details, generated text is not', async () => {
  const stdout = JSON.stringify({
    status: 'error',
    error: { code: 'context_length_exceeded', type: 'invalid_request_error' },
    model: 'gpt-oss-120b-medium',
    response: 'GENERATED MODEL TEXT THAT MUST NOT LEAK',
    usage: { prompt_tokens: 131072, completion_tokens: 0 },
  });
  const exit = new AgyExitError(1, 'context length exceeded', { stdout });
  const err = await createAgyReviewerProvider({
    callAgy: makeFakeCallAgy(exit),
    model: 'gpt-oss-120b-medium',
  })
    .review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 })
    .then(() => null, (e) => e);

  assert.equal(err.details.agyEnvelope.status, 'error');
  assert.equal(err.details.agyEnvelope.code, 'context_length_exceeded');
  assert.deepEqual(err.details.agyEnvelope.usage, { prompt_tokens: 131072, completion_tokens: 0 });
  assert.equal(JSON.stringify(err.details).includes('MUST NOT LEAK'), false);
});

test('AgyTimeoutError -> REVIEWER_TIMEOUT, details carry role/model/exit code', async () => {
  const err = await createAgyReviewerProvider({
    callAgy: makeFakeCallAgy(new AgyTimeoutError(1000)),
    model: 'gpt-oss-120b-medium',
  })
    .review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 })
    .then(() => null, (e) => e);
  assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT);
  assert.equal(err.details.role, 'reviewer');
  assert.equal(err.details.model, 'gpt-oss-120b-medium');
  assert.equal(err.details.exitCode, 124);
  assert.equal(err.details.stderr, null);
});

test('a non-agy error passes straight through unchanged', async () => {
  const weird = new Error('boom');
  const err = await createAgyReviewerProvider({ callAgy: makeFakeCallAgy(weird) })
    .review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 })
    .then(() => null, (e) => e);
  assert.equal(err, weird);
});

test('safe diagnostics never contain prompt or reply text', async () => {
  const exit = new AgyExitError(1, 'auth token expired');
  const err = await createAgyReviewerProvider({ callAgy: makeFakeCallAgy(exit), model: 'gpt-oss-120b-medium' })
    .review(taskCard(), executionReport(), EVIDENCE, { attempt: 1 })
    .then(() => null, (e) => e);
  const blob = JSON.stringify({ message: err.message, details: err.details });
  assert.equal(blob.includes('You are the Reviewer'), false);
  assert.equal(blob.includes('acceptance_criteria'), false);
  assert.equal(blob.includes(taskCard().goal), false);
});

test('prompt carries attempt number and the rendered Task Card', () => {
  const p = buildAgyReviewPrompt(taskCard(), executionReport(), EVIDENCE, { attempt: 3 });
  assert.match(p, /attempt 3 for this task/);
  assert.match(p, /# Task Card/);
  assert.match(p, /# Execution Report/);
  assert.match(p, /# Evidence/);
});
