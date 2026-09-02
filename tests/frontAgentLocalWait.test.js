// Front-agent token / polling regression coverage for the unified
// `supergpt_start_and_wait` local-wait entrypoint.
//
// REAL MODEL CALLS = 0. Everything is mock/fake: no real SuperGPT workflow,
// no real Claude / Codex / AGY provider, no GitHub, no PR closeout. Every
// dependency of the MCP server is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createSuperGptMcpServer,
  checkPollingRegression,
} from '../bin/supergpt-mcp.js';
import { checkFrontAgentContract } from '../scripts/doctor.js';

const COMMON = fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url));

// A fake workflow that reports "still running" (a local timeout) for the first
// `runningPolls` internal polls, then settles on `terminalStatus`. Models a
// long workflow whose local state is polled hundreds of times while the
// front-agent model is never re-invoked.
function fakeLoop({ runningPolls, terminalStatus, workflowId = 'wf-agy-test-000000' }) {
  const calls = { start: 0, wait: 0 };
  let polls = 0;
  return {
    calls,
    getPolls: () => polls,
    startSuperGptFn: () => {
      calls.start += 1;
      return { status: 'RUNNING', workflowId };
    },
    waitSuperGptFn: async ({ workflowId: id, predicate }) => {
      calls.wait += 1;
      polls += 1;
      if (polls <= runningPolls) {
        throw new Error(`waitForWorkflowState timed out after 30000ms for ${id}`);
      }
      const state = {
        workflowId: id,
        workflowStatus: terminalStatus,
        stage: terminalStatus,
        startedAt: new Date(Date.now() - 1200000).toISOString(),
        summary: terminalStatus === 'DONE' ? 'all tasks complete' : null,
        reason: terminalStatus === 'FAILED' ? 'gate failed' : null,
        question: terminalStatus === 'HUMAN_REQUIRED' ? 'pick A or B?' : null,
        workflowPath: 'FAST',
        deliveredFiles: terminalStatus === 'DONE' ? ['a.js'] : [],
      };
      assert.equal(predicate(state), true, 'terminal state must satisfy the predicate');
      return state;
    },
  };
}

async function connect(overrides) {
  const notifications = [];
  const server = createSuperGptMcpServer({
    ensureDashboardOpenFn: async () => ({ opened: false }),
    ...overrides,
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  client.fallbackNotificationHandler = async (n) => { notifications.push(n); };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, notifications };
}

test('start_and_wait: long RUNNING, hundreds of local polls, terminal DONE, one external call, watch=0', async () => {
  const fake = fakeLoop({ runningPolls: 250, terminalStatus: 'DONE' });
  const { client, server } = await connect(fake);

  const progressEvents = [];
  const res = await client.callTool(
    {
      name: 'supergpt_start_and_wait',
      arguments: { goal: 'ship a feature', cwd: '/tmp/ws', keepaliveMs: 1000 },
    },
    undefined,
    { onprogress: (p) => progressEvents.push(p) },
  );

  const out = res.structuredContent;
  assert.equal(out.status, 'DONE');
  assert.equal(out.workflowId, 'wf-agy-test-000000');
  assert.equal(out.summary, 'all tasks complete');
  assert.deepEqual(out.deliveredFiles, ['a.js']);

  // start called exactly once; ~250 internal local polls happened.
  assert.equal(fake.calls.start, 1);
  assert.equal(out.localPollCount, 250);
  assert.equal(fake.getPolls(), 251); // 250 running + 1 terminal

  // Internal polls never touched the model-facing wait/watch counters.
  assert.equal(out.frontAgentWaitCount, 0);
  assert.equal(out.frontAgentWatchCount, 0);

  const counters = server._frontAgentCounters;
  assert.equal(counters.startAndWaitCount, 1);
  assert.equal(counters.startCount, 0);
  assert.equal(counters.waitCount, 0);
  assert.equal(counters.watchCount, 0);
  assert.equal(counters.routeCount, 0);
  assert.equal(counters.statusCount, 0);
  assert.equal(server._getInternalPollCount(), 250);

  // Keep-alive progress notifications were emitted locally (0 model tokens),
  // one per running poll — never a model re-invocation.
  assert.equal(progressEvents.length, 250);

  await client.close();
});

test('start_and_wait: terminal FAILED is surfaced as isError', async () => {
  const fake = fakeLoop({ runningPolls: 3, terminalStatus: 'FAILED' });
  const { client } = await connect(fake);
  const res = await client.callTool({
    name: 'supergpt_start_and_wait',
    arguments: { goal: 'x', keepaliveMs: 1000 },
  });
  assert.equal(res.structuredContent.status, 'FAILED');
  assert.equal(res.structuredContent.reason, 'gate failed');
  assert.equal(res.isError, true);
  await client.close();
});

test('start_and_wait: HUMAN_REQUIRED returns the pending question, one external call', async () => {
  const fake = fakeLoop({ runningPolls: 5, terminalStatus: 'HUMAN_REQUIRED' });
  const { client, server } = await connect(fake);
  const res = await client.callTool({
    name: 'supergpt_start_and_wait',
    arguments: { goal: 'x', keepaliveMs: 1000 },
  });
  assert.equal(res.structuredContent.status, 'HUMAN_REQUIRED');
  assert.equal(res.structuredContent.question, 'pick A or B?');
  assert.equal(fake.calls.start, 1);
  assert.equal(server._frontAgentCounters.startAndWaitCount, 1);
  await client.close();
});

test('supergpt_telemetry reports counters, usageAvailable=false, no regression after a clean run', async () => {
  const fake = fakeLoop({ runningPolls: 40, terminalStatus: 'DONE' });
  const { client } = await connect(fake);
  await client.callTool({ name: 'supergpt_start_and_wait', arguments: { goal: 'x', keepaliveMs: 1000 } });

  const tel = (await client.callTool({ name: 'supergpt_telemetry', arguments: {} })).structuredContent;
  assert.equal(tel.usageAvailable, false);
  assert.equal(tel.contractVersion, 2);
  assert.equal(tel.startAndWaitCount, 1);
  assert.equal(tel.waitCount, 0);
  assert.equal(tel.watchCount, 0);
  assert.equal(tel.internalPollCount, 40);
  assert.equal(tel.regression, false);
  assert.deepEqual(tel.regressionIssues, []);
  await client.close();
});

test('supergpt_telemetry flags a regression when the front agent loops on watch', async () => {
  const { client } = await connect({
    watchSuperGptFn: async ({ workflowId }) => ({ workflowId, status: 'RUNNING', stage: 'EXECUTOR', formattedProgress: '...' }),
  });
  // Simulate a front agent that re-woke and polled watch three times.
  await client.callTool({ name: 'supergpt_watch', arguments: { workflowId: 'wf-agy-test-000000' } });
  await client.callTool({ name: 'supergpt_watch', arguments: { workflowId: 'wf-agy-test-000000' } });
  await client.callTool({ name: 'supergpt_watch', arguments: { workflowId: 'wf-agy-test-000000' } });

  const tel = (await client.callTool({ name: 'supergpt_telemetry', arguments: {} })).structuredContent;
  assert.equal(tel.watchCount, 3);
  assert.equal(tel.regression, true);
  assert.ok(tel.regressionIssues.some((i) => i.signal === 'watch-loop'));
  await client.close();
});

test('checkPollingRegression: pure-function polling-regression detection', () => {
  // Clean: one start_and_wait, many internal polls, zero model-facing watch/wait.
  assert.equal(checkPollingRegression({ startAndWaitCount: 1, waitCount: 0, watchCount: 0 }).regression, false);
  // One manual watch/wait (debug/recovery) is allowed.
  assert.equal(checkPollingRegression({ startAndWaitCount: 1, watchCount: 1, waitCount: 1 }).regression, false);
  // A watch loop is a regression.
  assert.equal(checkPollingRegression({ watchCount: 4 }).regression, true);
  // Front agent re-woken to continue waiting is a regression.
  assert.equal(checkPollingRegression({ waitCount: 3 }).regression, true);
  // Legacy start -> watch pattern is a regression even at count 1.
  const legacy = checkPollingRegression({ startCount: 1, startAndWaitCount: 0, watchCount: 1 });
  assert.equal(legacy.regression, true);
  assert.ok(legacy.issues.some((i) => i.signal === 'legacy-start-watch'));
});

test('doctor: front-agent contract check passes for the live repo (all three frontends share one COMMON)', () => {
  const res = checkFrontAgentContract();
  assert.equal(res.ok, true, JSON.stringify(res.issues));
  assert.equal(res.contractVersion, 2);
});

test('doctor: contract check fails on a stale contract version', async () => {
  const stale = path.join('/tmp', `common-stale-${Date.now()}.md`);
  await writeFile(stale, '# SuperGPT Front-Agent Contract\n\nContract version: 1\n\nAttach `supergpt_watch({ workflowId })` until terminal.\n');
  try {
    const res = checkFrontAgentContract({ policyFile: stale });
    assert.equal(res.ok, false);
    assert.equal(res.contractVersion, 1);
    assert.ok(res.issues.some((i) => /predates/.test(i)));
    assert.ok(res.issues.some((i) => /start_and_wait/.test(i)));
    assert.ok(res.issues.some((i) => /retired auto-watch/.test(i)));
  } finally {
    await rm(stale, { force: true });
  }
});

test('doctor: contract check fails when the MCP server drops the unified entrypoint', async () => {
  const serverFile = path.join('/tmp', `fake-server-${Date.now()}.js`);
  await writeFile(serverFile, "server.registerTool('supergpt_start', {});\n");
  try {
    const res = checkFrontAgentContract({ serverFile });
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => /does not register the supergpt_start_and_wait tool/.test(i)));
  } finally {
    await rm(serverFile, { force: true });
  }
});
