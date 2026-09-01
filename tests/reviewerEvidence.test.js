// reviewerEvidence.test.js — comprehensive tests for the deterministic
// compact evidence projection and Reviewer hard budget guard.
//
// REAL MODEL CALLS = 0
// All tests use makeFakeCallAgy or pure function tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactDiff,
  compactGateOutput,
  compactEvidence,
  enforcePromptBudget,
  REVIEWER_PROMPT_HARD_LIMIT,
  REVIEWER_DIFF_MAX_CHARS,
  REVIEWER_GATE_OUTPUT_MAX_CHARS,
} from '../src/orchestrator/adapters/reviewerEvidence.js';

import { createAgyReviewerProvider, buildAgyReviewPrompt } from '../src/orchestrator/adapters/agyReviewerProvider.js';
import { ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { makeFakeCallAgy, validTaskCardObject } from './fixtures/fakeAgy.mjs';

// ── Helpers ─────────────────────────────────────────────────────────

function generateHugeDiff(fileCount, linesPerFile) {
  const parts = [];
  for (let i = 0; i < fileCount; i++) {
    const fileName = `src/module${i}/handler.js`;
    parts.push(`diff --git a/${fileName} b/${fileName}`);
    parts.push(`--- a/${fileName}`);
    parts.push(`+++ b/${fileName}`);
    for (let h = 0; h < 3; h++) {
      parts.push(`@@ -${10 + h * 20},7 +${10 + h * 20},10 @@ function handler${h}() {`);
      for (let l = 0; l < linesPerFile; l++) {
        parts.push(`+  const value${l} = computeSomethingExpensive(${l}, '${'x'.repeat(50)}');`);
      }
    }
  }
  return parts.join('\n');
}

function taskCard() {
  const o = validTaskCardObject();
  return { ...o, repository_context: { ...o.repository_context, repository_url: null } };
}

function executionReport(changedFiles) {
  return {
    task_id: 'auto-a',
    repository_context: taskCard().repository_context,
    status: 'DONE',
    changed_files: changedFiles ?? ['work/auto-a.txt'],
    tests_run: ['gate'],
    test_results: ['pass'],
    issues: 'none',
    next_recommendation: 'review',
  };
}

const SMALL_DIFF = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 module.exports = a;`;

// ── Constants ───────────────────────────────────────────────────────

test('constants are exported with correct values', () => {
  assert.equal(REVIEWER_PROMPT_HARD_LIMIT, 40_000);
  assert.equal(REVIEWER_DIFF_MAX_CHARS, 12_000);
  assert.equal(REVIEWER_GATE_OUTPUT_MAX_CHARS, 2_000);
});

// ── compactDiff ─────────────────────────────────────────────────────

test('compactDiff: huge diff is truncated to maxChars', () => {
  const hugeDiff = generateHugeDiff(30, 20);
  assert.ok(hugeDiff.length > 50_000, `expected huge diff > 50k chars, got ${hugeDiff.length}`);

  const result = compactDiff(hugeDiff);

  // compact is within budget + truncation marker overhead (< 200 chars)
  assert.ok(result.compact.length <= REVIEWER_DIFF_MAX_CHARS + 200,
    `compact should be ≤ ${REVIEWER_DIFF_MAX_CHARS + 200}, got ${result.compact.length}`);
  assert.equal(result.truncated, true);
  assert.ok(result.fileList.length > 0);
  assert.ok(result.stats.files > 0);
  assert.ok(result.compact.includes('[TRUNCATED'));
  assert.equal(result.fullLength, hugeDiff.length);
});

test('compactDiff: small diff is NOT truncated', () => {
  const result = compactDiff(SMALL_DIFF);

  assert.equal(result.truncated, false);
  assert.equal(result.compact, SMALL_DIFF);
  assert.deepEqual(result.fileList, ['src/foo.js']);
  assert.equal(result.stats.files, 1);
  assert.equal(result.stats.insertions, 1);
  assert.equal(result.stats.deletions, 0);
});

test('compactDiff: empty string diff', () => {
  const result = compactDiff('');
  assert.equal(result.truncated, false);
  assert.equal(result.compact, '');
  assert.deepEqual(result.fileList, []);
  assert.equal(result.stats.files, 0);
});

test('compactDiff: null/undefined diff', () => {
  const r1 = compactDiff(null);
  assert.equal(r1.truncated, false);
  assert.deepEqual(r1.fileList, []);
  assert.equal(r1.fullLength, 0);

  const r2 = compactDiff(undefined);
  assert.equal(r2.truncated, false);
  assert.deepEqual(r2.fileList, []);
});

test('compactDiff: respects maxHunksPerFile', () => {
  // Create a diff with 10 hunks in one file
  const parts = ['diff --git a/big.js b/big.js', '--- a/big.js', '+++ b/big.js'];
  for (let h = 0; h < 10; h++) {
    parts.push(`@@ -${h * 10 + 1},3 +${h * 10 + 1},4 @@ function fn${h}() {`);
    parts.push(`+  line${h};`);
  }
  const diff = parts.join('\n');

  const result = compactDiff(diff, { maxHunksPerFile: 3, maxChars: 100_000 });
  // Should have truncated hunks
  assert.ok(result.compact.includes('more hunk(s)'));
  assert.deepEqual(result.fileList, ['big.js']);
});

test('compactDiff: file list extracts all changed files', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,2 @@',
    '+new line',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,1 +1,2 @@',
    '+another line',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,1 +1,2 @@',
    '-old',
    '+new',
  ].join('\n');

  const result = compactDiff(diff);
  assert.deepEqual(result.fileList, ['src/a.js', 'src/b.ts', 'README.md']);
  assert.equal(result.stats.files, 3);
});

// ── compactGateOutput ───────────────────────────────────────────────

test('compactGateOutput: PASS gate output is stripped', () => {
  const results = [{
    command: 'npm test',
    pass: true,
    output: 'x'.repeat(5000),
    exitCode: 0,
  }];

  const { results: compacted, truncated } = compactGateOutput(results);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].pass, true);
  assert.equal(compacted[0].command, 'npm test');
  assert.ok(compacted[0].output.length < 100, 'PASS output should be short');
  assert.ok(compacted[0].output.includes('output omitted'));
  // PASS stripping is not considered "truncation" in the same sense
});

test('compactGateOutput: FAIL gate output tail is kept', () => {
  const longOutput = 'x'.repeat(10_000);
  const results = [{
    command: 'npm test',
    pass: false,
    output: longOutput,
    exitCode: 1,
  }];

  const { results: compacted, truncated } = compactGateOutput(results);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].pass, false);
  assert.equal(truncated, true);
  assert.ok(compacted[0].output.includes('[TRUNCATED'));
  // Should keep the tail
  assert.ok(compacted[0].output.length <= REVIEWER_GATE_OUTPUT_MAX_CHARS + 200);
});

test('compactGateOutput: small FAIL output is NOT truncated', () => {
  const results = [{
    command: 'npm test',
    pass: false,
    output: 'Error: assertion failed at line 42',
    exitCode: 1,
  }];

  const { results: compacted, truncated } = compactGateOutput(results);
  assert.equal(compacted[0].output, 'Error: assertion failed at line 42');
  assert.equal(truncated, false);
});

test('compactGateOutput: mixed PASS/FAIL gates', () => {
  const results = [
    { command: 'lint', pass: true, output: 'All good\n'.repeat(100), exitCode: 0 },
    { command: 'test', pass: false, output: 'FAIL'.repeat(5000), exitCode: 1 },
    { command: 'build', pass: true, output: 'Build successful', exitCode: 0 },
  ];

  const { results: compacted } = compactGateOutput(results);
  assert.equal(compacted.length, 3);
  assert.ok(compacted[0].output.includes('output omitted'), 'PASS lint stripped');
  assert.ok(compacted[1].output.includes('[TRUNCATED'), 'FAIL test truncated');
  assert.ok(compacted[2].output.includes('output omitted'), 'PASS build stripped');
});

test('compactGateOutput: empty/null results', () => {
  const r1 = compactGateOutput([]);
  assert.deepEqual(r1.results, []);
  assert.equal(r1.truncated, false);

  const r2 = compactGateOutput(null);
  assert.equal(r2.truncated, false);
});

// ── compactEvidence ─────────────────────────────────────────────────

test('compactEvidence: preserves non-diff/result fields', () => {
  const evidence = {
    status: 'CHANGED',
    head: 'abc123',
    base: 'def456',
    pass: true,
    diff: SMALL_DIFF,
    results: [{ command: 'test', pass: true, output: 'ok', exitCode: 0 }],
    baseline: { branch: 'main', head: 'abc', clean: true },
    untracked_files: [{ path: 'new.txt', included: true, bytes: 100 }],
  };

  const { evidence: compactEv } = compactEvidence(evidence, taskCard(), executionReport());
  assert.equal(compactEv.status, 'CHANGED');
  assert.equal(compactEv.head, 'abc123');
  assert.equal(compactEv.base, 'def456');
  assert.equal(compactEv.pass, true);
  assert.deepEqual(compactEv.baseline, evidence.baseline);
  assert.deepEqual(compactEv.untracked_files, evidence.untracked_files);
});

test('compactEvidence: fullEvidenceRef records original sizes', () => {
  const hugeDiff = generateHugeDiff(20, 15);
  const evidence = {
    status: 'CHANGED', head: 'h', base: 'b',
    diff: hugeDiff,
    pass: false,
    results: [{ command: 'test', pass: false, output: 'x'.repeat(10_000), exitCode: 1 }],
  };

  const { fullEvidenceRef, truncated } = compactEvidence(evidence, taskCard(), executionReport());
  assert.equal(truncated, true);
  assert.equal(fullEvidenceRef.diffChars, hugeDiff.length);
  assert.ok(fullEvidenceRef.gateOutputChars > 0);
  assert.ok(fullEvidenceRef.truncatedFields.includes('diff'));
  assert.ok(fullEvidenceRef.truncatedFields.includes('gateOutput'));
});

test('compactEvidence: de-duplication — diff files already in executionReport', () => {
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    '--- a/src/foo.js', '+++ b/src/foo.js',
    '@@ -1,1 +1,2 @@', '+new',
  ].join('\n');
  const evidence = { status: 'CHANGED', diff, pass: true, results: [] };
  const report = executionReport(['src/foo.js']);

  const { evidence: compactEv } = compactEvidence(evidence, taskCard(), report);
  // The _diffSummary should NOT have additionalFiles since they're already in report
  if (compactEv._diffSummary) {
    assert.equal(compactEv._diffSummary.additionalFiles, undefined);
  }
});

test('compactEvidence: null/undefined evidence handled gracefully', () => {
  const r = compactEvidence(null, taskCard(), executionReport());
  assert.equal(r.truncated, false);
  assert.equal(r.fullEvidenceRef.diffChars, 0);
});

// ── enforcePromptBudget ─────────────────────────────────────────────

test('enforcePromptBudget: under limit — prompt unchanged', () => {
  const prompt = 'A short prompt.';
  const result = enforcePromptBudget(prompt);
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.prompt, prompt);
  assert.equal(result.originalLength, prompt.length);
  assert.equal(result.limit, REVIEWER_PROMPT_HARD_LIMIT);
});

test('enforcePromptBudget: over limit — truncated with marker', () => {
  const prompt = 'x'.repeat(50_000);
  const result = enforcePromptBudget(prompt);
  assert.equal(result.budgetExceeded, true);
  assert.ok(result.prompt.length < prompt.length);
  assert.ok(result.prompt.includes('REVIEWER_CONTEXT_BUDGET_EXCEEDED'));
  assert.equal(result.originalLength, 50_000);
  assert.equal(result.limit, REVIEWER_PROMPT_HARD_LIMIT);
});

test('enforcePromptBudget: exactly at limit — not exceeded', () => {
  const prompt = 'y'.repeat(REVIEWER_PROMPT_HARD_LIMIT);
  const result = enforcePromptBudget(prompt);
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.prompt, prompt);
});

// ── Integration: agyReviewerProvider with compact evidence ──────────

test('integration: huge evidence → REVIEWER_CONTEXT_BUDGET_EXCEEDED, no model call', async () => {
  // After compact projection, diff is truncated to ~12k. To exceed the 40k budget,
  // we need many FAIL gate results (each keeps up to 2k output) to push the total over.
  const failResults = [];
  for (let i = 0; i < 25; i++) {
    failResults.push({
      command: `test-suite-${i}`,
      pass: false,
      output: `ERROR: assertion failed in test ${i}\n${'stack trace line '.repeat(200)}`,
      exitCode: 1,
    });
  }
  const hugeDiff = generateHugeDiff(50, 30);
  const evidence = {
    status: 'CHANGED', head: 'h', base: 'b',
    diff: hugeDiff,
    pass: false,
    results: failResults,
  };

  const callAgy = makeFakeCallAgy({
    decision: 'PASS', findings: [], required_changes: [], rationale: 'ok',
  });

  const provider = createAgyReviewerProvider({ callAgy });
  const err = await provider
    .review(taskCard(), executionReport(), evidence, { attempt: 1 })
    .then(() => null, (e) => e);

  assert.ok(err, 'should have thrown');
  assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_CONTEXT_BUDGET_EXCEEDED);
  assert.ok(err.message.includes('hard limit'));
  assert.ok(err.details.originalLength > REVIEWER_PROMPT_HARD_LIMIT);
  assert.equal(err.details.limit, REVIEWER_PROMPT_HARD_LIMIT);
  // CRITICAL: callAgy must NOT have been called
  assert.equal(callAgy.calls.length, 0, 'no model call should have been made');
});

test('integration: normal evidence still works, prompt is compact', async () => {
  const evidence = {
    status: 'CHANGED', head: 'h', base: 'b',
    diff: SMALL_DIFF,
    pass: true,
    results: [{ command: 'test', pass: true, output: 'all 42 tests passed' }],
  };

  const callAgy = makeFakeCallAgy({
    decision: 'PASS', findings: ['meets criteria'], required_changes: [], rationale: 'looks good',
  });

  const provider = createAgyReviewerProvider({ callAgy });
  const r = await provider.review(taskCard(), executionReport(), evidence, { attempt: 1 });

  assert.equal(r.decision, 'PASS');
  assert.equal(callAgy.calls.length, 1, 'model should have been called once');
  // Prompt sent to model should be well under the hard limit
  assert.ok(callAgy.calls[0].prompt.length < REVIEWER_PROMPT_HARD_LIMIT,
    `prompt should be < ${REVIEWER_PROMPT_HARD_LIMIT}, got ${callAgy.calls[0].prompt.length}`);
});

test('integration: compact evidence — PASS gate output is stripped in prompt', async () => {
  const evidence = {
    status: 'CHANGED', head: 'h', base: 'b',
    diff: SMALL_DIFF,
    pass: true,
    results: [{ command: 'npm test', pass: true, output: 'VERBOSE LOG '.repeat(500) }],
  };

  const callAgy = makeFakeCallAgy({
    decision: 'PASS', findings: [], required_changes: [], rationale: 'ok',
  });

  const provider = createAgyReviewerProvider({ callAgy });
  await provider.review(taskCard(), executionReport(), evidence, { attempt: 1 });

  const sentPrompt = callAgy.calls[0].prompt;
  // The verbose log should NOT be in the prompt
  assert.equal(sentPrompt.includes('VERBOSE LOG'), false,
    'PASS gate verbose output should be stripped');
  assert.ok(sentPrompt.includes('output omitted'));
});

test('integration: review result carries fullEvidenceRef as non-enumerable', async () => {
  const evidence = {
    status: 'CHANGED', head: 'h', base: 'b',
    diff: SMALL_DIFF,
    pass: true,
    results: [{ command: 'test', pass: true, output: 'ok' }],
  };

  const callAgy = makeFakeCallAgy({
    decision: 'PASS', findings: [], required_changes: [], rationale: 'ok',
  });

  const r = await createAgyReviewerProvider({ callAgy }).review(
    taskCard(), executionReport(), evidence, { attempt: 1 },
  );

  // Non-enumerable: not in JSON.stringify
  assert.equal(JSON.stringify(r).includes('fullEvidenceRef'), false);
  // But accessible
  assert.ok(r.fullEvidenceRef);
  assert.equal(typeof r.fullEvidenceRef.diffChars, 'number');
  assert.equal(typeof r.evidenceTruncated, 'boolean');
});

test('integration: truncation markers present for oversized diff in compact output', () => {
  const hugeDiff = generateHugeDiff(30, 20);
  const result = compactDiff(hugeDiff);
  assert.ok(result.truncated);
  assert.ok(result.compact.includes('[TRUNCATED'));
  assert.ok(result.compact.includes('files changed'));
});

// ── Edge cases ──────────────────────────────────────────────────────

test('compactDiff: custom maxChars respected', () => {
  const diff = generateHugeDiff(5, 10);
  const result = compactDiff(diff, { maxChars: 500 });
  assert.ok(result.compact.length <= 700, 'compact + marker should be near 500');
  assert.equal(result.truncated, true);
});

test('compactGateOutput: FAIL gate with short output not truncated', () => {
  const { results, truncated } = compactGateOutput([
    { command: 'test', pass: false, output: 'Error at line 5', exitCode: 1 },
  ]);
  assert.equal(results[0].output, 'Error at line 5');
  assert.equal(truncated, false);
});

test('compactGateOutput: preserves exitCode', () => {
  const { results } = compactGateOutput([
    { command: 'build', pass: false, output: 'fail', exitCode: 2 },
    { command: 'lint', pass: true, output: 'ok', exitCode: 0 },
  ]);
  assert.equal(results[0].exitCode, 2);
  assert.equal(results[1].exitCode, 0);
});

test('compactEvidence: repeated evidence (duplicate fields) does not duplicate', () => {
  const diff = [
    'diff --git a/work/auto-a.txt b/work/auto-a.txt',
    '--- a/work/auto-a.txt', '+++ b/work/auto-a.txt',
    '@@ -1 +1 @@', '-old', '+new',
  ].join('\n');
  const evidence = { status: 'CHANGED', diff, pass: true, results: [] };
  // executionReport already lists this file
  const report = executionReport(['work/auto-a.txt']);

  const { evidence: compactEv } = compactEvidence(evidence, taskCard(), report);
  // _diffSummary should not list additionalFiles since they match
  if (compactEv._diffSummary) {
    assert.equal(compactEv._diffSummary.additionalFiles, undefined,
      'files already in execution report should not be repeated');
  }
});
