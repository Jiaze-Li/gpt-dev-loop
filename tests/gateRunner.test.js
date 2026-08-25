import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGateRunner } from '../src/orchestrator/adapters/gateRunner.js';

// Fake child_process.spawn keyed by the exact shell command string, like a
// scripted shell — mirrors tests/gitEvidenceCollector.test.js's makeFakeGit.
function makeFakeSpawn(responses) {
  const calls = [];
  const spawn = (command, args) => {
    const shellCommand = args[args.length - 1];
    calls.push(shellCommand);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      const response = responses[shellCommand];
      if (!response) {
        child.emit('error', new Error(`unscripted command: ${shellCommand}`));
        return;
      }
      if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit('data', Buffer.from(response.stderr));
      child.emit('close', response.code ?? 0);
    });

    return child;
  };
  return { spawn, calls };
}

function fakeGitEvidenceCollector(evidenceOverrides = {}) {
  const calls = [];
  return {
    collector: {
      async collect_evidence(context) {
        calls.push(context);
        return { current_commit: 'abc123', ...evidenceOverrides, test_results: context.testResults, pass: context.testResults.pass, results: context.testResults.results };
      },
    },
    calls,
  };
}

test('gate runner: runs every verification command and reports pass/fail per command', async () => {
  const { spawn } = makeFakeSpawn({
    'npm test': { code: 0, stdout: '3 passing\n' },
    'npm run lint': { code: 1, stderr: 'lint error\n' },
  });
  const { collector, calls } = fakeGitEvidenceCollector();
  const gateRunner = createGateRunner({ gitEvidenceCollector: collector, cwd: '/repo', spawn });

  const evidence = await gateRunner.run(['npm test', 'npm run lint']);

  assert.equal(evidence.pass, false);
  assert.deepEqual(evidence.results, [
    { command: 'npm test', pass: true, output: '3 passing' },
    { command: 'npm run lint', pass: false, output: 'lint error' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/repo');
  assert.deepEqual(calls[0].testResults.results.map((r) => r.command), ['npm test', 'npm run lint']);
});

test('gate runner: an empty verification_commands list still calls the git evidence collector', async () => {
  const { spawn } = makeFakeSpawn({});
  const { collector, calls } = fakeGitEvidenceCollector();
  const gateRunner = createGateRunner({ gitEvidenceCollector: collector, cwd: '/repo', spawn });

  const evidence = await gateRunner.run([]);

  assert.equal(evidence.pass, true);
  assert.deepEqual(evidence.results, []);
  assert.equal(calls.length, 1);
});

test('gate runner: all commands passing yields overall pass', async () => {
  const { spawn } = makeFakeSpawn({
    'npm test': { code: 0, stdout: 'ok\n' },
  });
  const { collector } = fakeGitEvidenceCollector();
  const gateRunner = createGateRunner({ gitEvidenceCollector: collector, cwd: '/repo', spawn });

  const evidence = await gateRunner.run(['npm test']);

  assert.equal(evidence.pass, true);
});
