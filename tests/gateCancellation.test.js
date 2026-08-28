// Deterministic proof for Codex finding #3: gate/verification commands are
// owned cancellable subprocesses. A hung gate is interruptible, cancellation
// terminates the actual process, and no gate PASS / evidence is produced
// afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGateRunner, GateCancelledError } from '../src/orchestrator/adapters/gateRunner.js';

function recordingCollector() {
  const calls = [];
  return {
    calls,
    collector: {
      async collect_evidence(ctx) {
        calls.push(ctx);
        return { pass: ctx.testResults.pass, results: ctx.testResults.results };
      },
    },
  };
}

test('an already-aborted signal makes run() reject before spawning anything', async () => {
  const { collector, calls } = recordingCollector();
  const controller = new AbortController();
  controller.abort();
  const gate = createGateRunner({ gitEvidenceCollector: collector, cwd: process.cwd(), signal: controller.signal });
  await assert.rejects(() => gate.run(['echo hi']), GateCancelledError);
  assert.equal(calls.length, 0, 'no evidence collected after cancellation');
});

test('a hung gate command is interrupted promptly and yields no PASS/evidence', async () => {
  const { collector, calls } = recordingCollector();
  const controller = new AbortController();
  const gate = createGateRunner({
    gitEvidenceCollector: collector,
    cwd: process.cwd(),
    signal: controller.signal,
  });

  const started = Date.now();
  const runPromise = gate.run(['sleep 60']).then(
    () => ({ resolved: true }),
    (err) => ({ err }),
  );
  setTimeout(() => controller.abort(), 100);

  const outcome = await runPromise;
  const elapsed = Date.now() - started;

  assert.ok(outcome.err instanceof GateCancelledError, 'run() rejected with GateCancelledError');
  assert.ok(elapsed < 10000, `cancellation returned promptly (${elapsed}ms), not after the 60s sleep`);
  assert.equal(calls.length, 0, 'the git evidence collector was never called — no gate PASS is possible');
});

test('cancellation between commands stops before running the next one', async () => {
  const { collector, calls } = recordingCollector();
  const controller = new AbortController();
  const gate = createGateRunner({ gitEvidenceCollector: collector, cwd: process.cwd(), signal: controller.signal });

  // First command is quick; abort fires during/just after it; the second
  // (hung) command must never gate a PASS. A regression here hangs on
  // `sleep 60` and trips node:test's own timeout.
  const started = Date.now();
  const p = gate.run(['true', 'sleep 60']).then(() => ({ resolved: true }), (err) => ({ err }));
  setTimeout(() => controller.abort(), 50);
  const outcome = await p;
  assert.ok(Date.now() - started < 10000, 'did not hang on the second command');
  assert.ok(outcome.err instanceof GateCancelledError);
  assert.equal(calls.length, 0);
});
