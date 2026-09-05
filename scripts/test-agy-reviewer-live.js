#!/usr/bin/env node
// Smallest possible REAL Reviewer-shaped live call.
//
// NOT part of `npm test`. Makes exactly ONE real request to `agy` through
// the SAME code path the automated workflow's Reviewer uses —
// createAgyReviewerProvider(...).review(taskCard, executionReport,
// evidence) — with a tiny synthetic Task Card, a tiny Execution Report,
// a PASS gate, and tiny Evidence. It never touches automatedLoop, the
// Supervisor, Claude execution, the gates, model selection, or retry
// behavior.
//
// Purpose: reproduce / diagnose a REVIEWER_UNAVAILABLE ("agy exited with
// status N") failure in isolation, with the safe underlying agy stderr and
// exit code surfaced.
//
// Privacy: prints ONLY the model, success/failure, the decision on success,
// and — on failure — the safe non-content diagnostics (exit code, agy
// stderr, duration). It never prints the prompt, the model's reply text, or
// any auth/credential data.
//
// Usage:
//   node scripts/test-agy-reviewer-live.js
//   AGY_REVIEWER_MODEL=... node scripts/test-agy-reviewer-live.js   (override)

import { createAgyReviewerProvider } from '../src/orchestrator/adapters/agyReviewerProvider.js';
import { resolveAgyReviewerModel } from '../src/agy/agyConfig.js';
import { assertRealProviderCallsAuthorized, REAL_PROVIDER_CALL_FLAG } from '../src/orchestrator/realProviderCallGuard.js';

// Tiny synthetic Reviewer inputs — just enough structure for the provider's
// existing renderers. No real repository state is read.
const TASK_CARD = Object.freeze({
  task_id: 'agy-reviewer-live',
  repository_context: {
    repository_name: 'gpt-dev-loop-phase1',
    repository_url: 'none',
    branch: 'unknown',
    commit_sha: 'unknown',
  },
  goal: 'Create work/agy-reviewer-live.txt containing exactly: ok',
  context: 'Standalone Reviewer transport probe.',
  scope: 'Only work/agy-reviewer-live.txt is in scope.',
  allowed_files: ['work/agy-reviewer-live.txt'],
  forbidden_files: [],
  acceptance_criteria: ['work/agy-reviewer-live.txt trimmed content is exactly "ok"'],
  verification_commands: ['test "$(cat work/agy-reviewer-live.txt)" = "ok"'],
  completion_signal: 'DONE',
});

const EXECUTION_REPORT = Object.freeze({
  task_id: 'agy-reviewer-live',
  repository_context: TASK_CARD.repository_context,
  status: 'DONE',
  changed_files: ['work/agy-reviewer-live.txt'],
  tests_run: ['gate'],
  test_results: ['pass'],
  issues: 'none',
  next_recommendation: 'review',
});

const EVIDENCE = Object.freeze({
  status: 'CHANGED',
  base: 'b',
  head: 'h',
  diff: '+ok',
  pass: true,
  results: [{ command: 'test "$(cat work/agy-reviewer-live.txt)" = "ok"', pass: true, output: 'ok' }],
});

async function main() {
  const explicitLiveIntent = process.argv.slice(2).includes(REAL_PROVIDER_CALL_FLAG);
  assertRealProviderCallsAuthorized({ explicitLiveIntent, entrypoint: 'scripts/test-agy-reviewer-live.js' });

  const model = resolveAgyReviewerModel(process.env);
  console.log('model              :', model);

  const provider = createAgyReviewerProvider({ model, timeoutMs: 120_000 });

  try {
    const result = await provider.review(TASK_CARD, EXECUTION_REPORT, EVIDENCE, { attempt: 1 });
    console.log('result             : SUCCESS');
    console.log('decision           :', result.decision);
    process.exit(0);
  } catch (err) {
    console.log('result             : FAILURE');
    console.log('error code         :', err.code ?? err.name);
    const d = err.details ?? {};
    console.log('agy error          :', d.agyErrorName ?? 'n/a');
    console.log('exit code          :', d.exitCode ?? 'n/a');
    console.log('duration ms        :', d.durationMs ?? 'n/a');
    if (typeof d.stderr === 'string' && d.stderr.trim() !== '') {
      console.log('agy stderr         :');
      for (const line of d.stderr.replace(/\s+$/, '').split('\n')) console.log('  ', line);
    } else {
      console.log('agy stderr         : (none captured)');
    }
    process.exit(err.exitCode ?? 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(err.exitCode ?? 1);
  });
}
