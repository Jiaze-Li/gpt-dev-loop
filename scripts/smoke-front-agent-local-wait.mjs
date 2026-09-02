// Minimal REAL smoke for the Front-Agent unified local-wait call pattern.
//
// Exercises the real MCP server, the real supergpt_start_and_wait handler, the
// real file-based workflow state machine, the real supergptWait local polling
// and the real front-agent counters. The ONLY stub is the provider pipeline
// (the "Core" work): it does a tiny scripted RUNNING -> DONE with ZERO real
// model / provider calls, so Core token cost is 0 by construction.
//
// Purpose: prove one high-level call starts + waits locally to terminal without
// the front agent re-waking (watch=0, wait=0), NOT to prove providers work.

import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';
import { startSuperGPT } from '../src/orchestrator/supergpt.js';

const execFileAsync = promisify(execFile);
const WALL_CLOCK_ABORT_MS = 90_000; // hard safety cap — smoke must be quick

// Zero-cost stub Core: real state manager, real persisted state files, no model.
async function stubPipeline({ workflowStateManager }) {
  workflowStateManager.startStage('EXECUTOR', { taskId: 't-1', taskName: 'append one line', taskIndex: 1, taskTotal: 1 });
  workflowStateManager.setWorkflowStatus('RUNNING');
  // Stay RUNNING long enough that the local wait times out its keep-alive slice
  // at least twice -> internalPollCount > 0, front agent still asleep.
  await new Promise((r) => setTimeout(r, 5_000));
  workflowStateManager.transitionTerminal('DONE', { summary: 'smoke: appended one line (stub Core, 0 model tokens)' });
  return {
    status: 'WORKFLOW_DONE',
    summary: 'smoke: appended one line (stub Core, 0 model tokens)',
    deliveredFiles: ['SMOKE.md'],
    path: 'FAST',
    tokenUsage: { note: 'stub Core — no provider/model invocation', total: 0 },
  };
}

async function main() {
  const repo = await mkdtemp(path.join(tmpdir(), 'sg-smoke-'));
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'sg-smoke-rt-'));
  const progressEvents = [];
  let client;
  const killTimer = setTimeout(() => {
    console.error('\n[SMOKE ABORT] wall-clock cap hit — stopping, no retry.');
    process.exit(2);
  }, WALL_CLOCK_ABORT_MS);

  try {
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'smoke'], { cwd: repo });
    await writeFile(path.join(repo, 'SMOKE.md'), '# smoke\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const server = createSuperGptMcpServer({
      cwd: repo,
      ensureDashboardOpenFn: async () => ({ opened: false }),
      // Real startSuperGPT, but with the zero-cost stub pipeline + isolated root.
      startSuperGptFn: (opts) => startSuperGPT({ ...opts, root: runtimeRoot, _pipeline: stubPipeline }),
    });

    client = new Client({ name: 'smoke-front-agent', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    // Front agent step 1: route.
    const route = (await client.callTool({
      name: 'supergpt_route',
      arguments: { goal: 'append one line to SMOKE.md', cwd: repo },
    })).structuredContent;

    // Front agent step 2: ONE high-level call — start + local wait to terminal.
    const t0 = Date.now();
    const res = (await client.callTool(
      {
        name: 'supergpt_start_and_wait',
        arguments: { goal: 'append one line to SMOKE.md', cwd: repo, keepaliveMs: 2000, maxWaitMs: 60_000 },
      },
      undefined,
      { onprogress: (p) => progressEvents.push(p) },
    )).structuredContent;
    const elapsedMs = Date.now() - t0;

    // Front agent step 3: read local telemetry counters.
    const tel = (await client.callTool({ name: 'supergpt_telemetry', arguments: {} })).structuredContent;

    const frontAgentReWoke = tel.watchCount > 0 || tel.waitCount > 0;
    const patternOk =
      tel.startAndWaitCount === 1 &&
      tel.watchCount === 0 &&
      tel.waitCount === 0 &&
      res.status === 'DONE' &&
      progressEvents.length >= 1;

    console.log(JSON.stringify({
      routeDecision: route.decision,
      workflowId: res.workflowId,
      terminalStatus: res.status,
      summary: res.summary,
      elapsedMs,
      localWaitElapsedMs: elapsedMs,
      keepaliveProgressNotifications: progressEvents.length,
      counters: {
        routeCount: tel.routeCount,
        startCount: tel.startCount,
        startAndWaitCount: tel.startAndWaitCount,
        waitCount: tel.waitCount,
        watchCount: tel.watchCount,
        statusCount: tel.statusCount,
        internalPollCount: tel.internalPollCount,
      },
      localPollCountFromResult: res.localPollCount,
      frontAgentReWoke,
      contractVersion: tel.contractVersion,
      usageAvailable: tel.usageAvailable,
      coreTokenUsage: res.__coreTokenUsage ?? 'see workflow result (stub Core: 0)',
      oneHighLevelCallWaitedToTerminal: patternOk,
    }, null, 2));

    clearTimeout(killTimer);
    await client.close();
    if (frontAgentReWoke) {
      console.error('\n[SMOKE FAIL] front agent re-woke (watch>0 or wait>0). Stopping, no retry.');
      process.exit(1);
    }
    if (!patternOk) {
      console.error('\n[SMOKE FAIL] pattern assertion failed. Stopping, no retry.');
      process.exit(1);
    }
    console.log('\n[SMOKE PASS] one high-level call, local wait to terminal, front agent asleep throughout.');
  } finally {
    clearTimeout(killTimer);
    try { if (client) await client.close(); } catch { /* ignore */ }
    await rm(repo, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[SMOKE ERROR]', err?.stack || err);
  process.exit(1);
});
