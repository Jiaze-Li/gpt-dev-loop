// Deterministic tests for the external SuperGPT interface. The real
// pipeline (Chrome / agy / git worktrees) is never exercised here — every
// test injects a fake `_pipeline`, or drives the pure helpers directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runSuperGPT,
  translateLogLine,
  formatEvent,
  SUPERGPT_EVENTS,
} from '../src/orchestrator/supergpt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function collector() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('SUPERGPT_EVENTS carries the documented event types', () => {
  assert.deepEqual(
    new Set(Object.values(SUPERGPT_EVENTS)),
    new Set([
      'workflow_started',
      'stage_changed',
      'task_started',
      'task_attempt_started',
      'verification_started',
      'verification_finished',
      'review_finished',
      'rework_requested',
      'human_required',
      'delivery_succeeded',
      'delivery_failed',
      'token_anomaly_detected',
      'supervisor_provider_failed',
      'supervisor_provider_switched',
      'workflow_finished',
    ]),
  );
});

test('runSuperGPT emits workflow_started first, workflow_finished last, and returns the full contract', async () => {
  const { events, onEvent } = collector();
  const result = await runSuperGPT({
    goal: 'do the thing',
    onEvent,
    _pipeline: async ({ emit, workflowId }) => {
      emit(SUPERGPT_EVENTS.STAGE_CHANGED, { stage: 'executing' });
      emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles: ['a.js'] });
      return {
        status: 'WORKFLOW_DONE',
        summary: 'all done',
        deliveredFiles: ['a.js', 'b.js'],
        workflowId,
        conversations: { supervisor: 'c-1' },
        reason: null,
        question: null,
      };
    },
  });

  assert.equal(events[0].type, 'workflow_started');
  assert.equal(events.at(-1).type, 'workflow_finished');
  assert.equal(events.at(-1).status, 'WORKFLOW_DONE');
  assert.ok(events.every((e) => typeof e.timestamp === 'string'));

  assert.equal(result.status, 'WORKFLOW_DONE');
  assert.equal(result.summary, 'all done');
  assert.deepEqual(result.deliveredFiles, ['a.js', 'b.js']);
  assert.match(result.workflowId, /^wf-agy-/);
  assert.deepEqual(result.conversations, { supervisor: 'c-1' });
  assert.equal(result.reason, null);
  assert.equal(result.question, null);
});

test('runSuperGPT passes HUMAN_REQUIRED reason/question through', async () => {
  const result = await runSuperGPT({
    goal: 'ambiguous ask',
    _pipeline: async ({ emit }) => {
      emit(SUPERGPT_EVENTS.HUMAN_REQUIRED, { reason: 'plan_ambiguous', question: 'which module?' });
      return {
        status: 'HUMAN_REQUIRED',
        summary: null,
        deliveredFiles: [],
        conversations: null,
        reason: 'ambiguous',
        question: 'which module?',
      };
    },
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.question, 'which module?');
});

test('runSuperGPT reports a pipeline throw as FAILED without rethrowing', async () => {
  const { events, onEvent } = collector();
  const result = await runSuperGPT({
    goal: 'boom',
    onEvent,
    _pipeline: async () => {
      throw new Error('worktree exploded');
    },
  });
  assert.equal(result.status, 'FAILED');
  assert.match(result.reason, /worktree exploded/);
  assert.equal(events.at(-1).type, 'workflow_finished');
  assert.equal(events.at(-1).status, 'FAILED');
});

test('runSuperGPT cancels cleanly when the AbortSignal fires mid-run', async () => {
  const controller = new AbortController();
  const { events, onEvent } = collector();

  const started = runSuperGPT({
    goal: 'long job',
    onEvent,
    signal: controller.signal,
    _pipeline: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('pipeline saw abort')), { once: true });
        // never resolves on its own
      }),
  });

  await new Promise((r) => setImmediate(r));
  controller.abort();

  const result = await started;
  assert.equal(result.status, 'CANCELLED');
  assert.equal(events.at(-1).type, 'workflow_finished');
  assert.equal(events.at(-1).status, 'CANCELLED');
});

test('cancellation waits for owned pipeline shutdown and never emits delivery afterwards', async () => {
  const controller = new AbortController();
  const { events, onEvent } = collector();
  let shutdownComplete = false;

  const running = runSuperGPT({
    goal: 'cancel an owned executor',
    signal: controller.signal,
    onEvent,
    _pipeline: ({ signal, emit }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          shutdownComplete = true;
          // A late completion must not be able to turn cancellation into a
          // delivered result after the child has been asked to stop.
          emit(SUPERGPT_EVENTS.DELIVERY_SUCCEEDED, { changedFiles: ['late.js'] });
          resolve({ status: 'WORKFLOW_DONE', deliveredFiles: ['late.js'] });
        }, 20);
      }, { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await running;

  assert.equal(shutdownComplete, true);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(events.at(-1).type, 'workflow_finished');
  assert.equal(events.at(-1).status, 'CANCELLED');
  assert.equal(events.some((event) => event.type === SUPERGPT_EVENTS.DELIVERY_SUCCEEDED), false);
});

test('runSuperGPT returns CANCELLED immediately for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let pipelineCalled = false;
  const result = await runSuperGPT({
    goal: 'x',
    signal: controller.signal,
    _pipeline: async () => {
      pipelineCalled = true;
      return { status: 'WORKFLOW_DONE' };
    },
  });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(pipelineCalled, false);
});

test('outputFormat "json" streams one parseable ndjson event per line', async () => {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await runSuperGPT({
      goal: 'g',
      outputFormat: 'json',
      _pipeline: async ({ emit }) => {
        emit(SUPERGPT_EVENTS.TASK_STARTED, { taskId: 't-1' });
        return { status: 'WORKFLOW_DONE' };
      },
    });
  } finally {
    process.stdout.write = original;
  }
  const parsed = lines.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed[0].type, 'workflow_started');
  assert.ok(parsed.some((e) => e.type === 'task_started' && e.taskId === 't-1'));
  assert.equal(parsed.at(-1).type, 'workflow_finished');
});

test('outputFormat "text" streams compact [supergpt] lines', async () => {
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await runSuperGPT({
      goal: 'g',
      outputFormat: 'text',
      _pipeline: async () => ({ status: 'WORKFLOW_DONE' }),
    });
  } finally {
    process.stdout.write = original;
  }
  assert.ok(lines.every((l) => l.startsWith('[supergpt] ')));
});

test('translateLogLine maps automatedLoop log lines to typed events', () => {
  assert.deepEqual(translateLogLine('task selected: task-3'), {
    type: 'task_started',
    taskId: 'task-3',
  });
  assert.deepEqual(translateLogLine('claude attempt started: task=task-3 attempt=2'), {
    type: 'task_attempt_started',
    taskId: 'task-3',
    attempt: 2,
  });
  assert.deepEqual(translateLogLine('gate started: task=task-3 attempt=1'), {
    type: 'verification_started',
    taskId: 'task-3',
    attempt: 1,
  });
  assert.deepEqual(translateLogLine('gate completed: task=task-3 attempt=1'), {
    type: 'verification_finished',
    taskId: 'task-3',
    attempt: 1,
  });
  assert.deepEqual(translateLogLine('review completed: task=task-3 attempt=1 decision=REWORK'), {
    type: 'review_finished',
    taskId: 'task-3',
    attempt: 1,
    decision: 'REWORK',
  });
  assert.deepEqual(translateLogLine('supervisor decision: CONTINUE_REWORK'), {
    type: 'rework_requested',
  });
  assert.equal(translateLogLine('supervisor decision: WORKFLOW_DONE').type, 'stage_changed');
  assert.equal(translateLogLine('some unrelated line'), null);
});

test('formatEvent renders json and text forms', () => {
  const event = { type: 'task_started', timestamp: '2026-01-01T00:00:00.000Z', taskId: 't-1' };
  assert.equal(formatEvent(event, 'json'), JSON.stringify(event));
  assert.equal(formatEvent(event, 'text'), '[supergpt] task_started taskId=t-1');
});

test('package.json registers the supergpt bin', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.bin.supergpt);
  assert.match(pkg.bin.supergpt, /bin\/supergpt\.js$/);
});

test('bin/supergpt.js --help exits 0; no args exits 1', () => {
  const bin = path.join(repoRoot, 'bin', 'supergpt.js');
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: supergpt/);

  const noArgs = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
});
