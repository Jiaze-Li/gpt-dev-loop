// Phase 1 — a hung Gate command terminates deterministically, and teardown
// reaches the whole process tree (a descendant the Gate shell spawned does not
// outlive the timeout).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { runGate, GATE_VERDICTS, GATE_TIMEOUT_EXIT_CODE } from '../src/reviewloop/gatePolicy.js';

test('a command that exceeds the timeout is killed and reported FAIL, not awaited to completion', async () => {
  const started = Date.now();
  const gate = await runGate({
    cwd: os.tmpdir(),
    commands: ['sleep 20'],
    timeoutMs: 250,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `gate returned in ${elapsed}ms, not after the full 20s sleep`);
  assert.equal(gate.verdict, GATE_VERDICTS.FAIL);
  assert.equal(gate.results[0].exitCode, GATE_TIMEOUT_EXIT_CODE);
  assert.equal(gate.results[0].timedOut, true);
});

test('a descendant the Gate shell spawned does not survive the timeout teardown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-gate-tree-'));
  try {
    const marker = path.join(dir, 'grandchild-ran');
    // The `/bin/sh -c` becomes a process-group leader (detached). It spawns a
    // background subshell that would touch the marker after 1s, then blocks.
    await runGate({
      cwd: dir,
      commands: [`( sleep 1 && touch "${marker}" ) & sleep 30`],
      timeoutMs: 200,
    });
    // Give the (killed) background subshell well past its 1s window.
    await sleep(1500);
    assert.equal(fs.existsSync(marker), false, 'the background descendant was terminated with the group');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an injected runner path is unaffected by the timeout plumbing', async () => {
  const gate = await runGate({
    cwd: '/x',
    commands: ['echo hi'],
    runner: async (cmd) => ({ command: cmd, exitCode: 0, stdout: 'hi', stderr: '' }),
  });
  assert.equal(gate.verdict, GATE_VERDICTS.PASS);
});
