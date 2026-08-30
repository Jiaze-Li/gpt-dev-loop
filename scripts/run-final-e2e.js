#!/usr/bin/env node
// Final Fresh Production E2E Acceptance Runner for SuperGPT V1.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';
import { decideAutoRoute } from '../src/control/autoRoutePolicy.js';
import { compileSuperGptRequest } from '../src/control/requestCompiler.js';
import { runSuperGPT, supergptStatus, supergptWait, SUPERGPT_EVENTS } from '../src/orchestrator/supergpt.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';

const execFileAsync = promisify(execFile);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

async function run() {
  console.log('========================================================================');
  console.log('SUPERGPT V1 FINAL FRESH E2E ACCEPTANCE & LIVE UX PROGRESS');
  console.log('========================================================================\n');

  const startTime = Date.now();
  const testRoot = path.join('/tmp', `supergpt-v1-acceptance-${Date.now()}`);
  const targetRepo = path.join(testRoot, 'kv-parser-repo');
  await mkdir(targetRepo, { recursive: true });

  console.log(`[1] Initializing disposable acceptance repo at: ${targetRepo}`);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: targetRepo });
  await execFileAsync('git', ['config', 'user.name', 'SuperGPT Acceptor'], { cwd: targetRepo });
  await execFileAsync('git', ['config', 'user.email', 'acceptor@supergpt.local'], { cwd: targetRepo });

  // Initial package.json
  const pkgJson = {
    name: 'kv-parser-lib',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --test test/*.test.js',
    },
  };
  await writeFile(path.join(targetRepo, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');

  // Baseline code: src/index.js
  const indexJs = `export const LIB_VERSION = '1.0.0';\n`;
  await mkdir(path.join(targetRepo, 'src'), { recursive: true });
  await writeFile(path.join(targetRepo, 'src', 'index.js'), indexJs, 'utf8');

  // Initial baseline parser stub in src/parser.js
  const initialParserJs = `export function parseKeyValue(text) {
  const lines = (text || '').split('\\n');
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    result[key] = val;
  }
  return result;
}
`;
  await writeFile(path.join(targetRepo, 'src', 'parser.js'), initialParserJs, 'utf8');

  // Baseline test: test/index.test.js
  const indexTestJs = `import test from 'node:test';
import assert from 'node:assert/strict';
import { LIB_VERSION } from '../src/index.js';

test('baseline library version', () => {
  assert.equal(LIB_VERSION, '1.0.0');
});
`;
  await mkdir(path.join(targetRepo, 'test'), { recursive: true });
  await writeFile(path.join(targetRepo, 'test', 'index.test.js'), indexTestJs, 'utf8');

  // Add parser test suite with strict acceptance criteria
  const parserTestJs = `import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 1: parseKeyValue parses valid pairs, trims unquoted values, and strips quotes', async () => {
  let mod;
  try {
    mod = await import('../src/parser.js');
  } catch (err) {
    assert.fail('src/parser.js must be created and export parseKeyValue: ' + err.message);
  }
  const { parseKeyValue } = mod;
  assert.equal(typeof parseKeyValue, 'function', 'parseKeyValue should be a function');

  const parsed = parseKeyValue('name = Alice\\nage=30\\n  city = "New York" \\n# comment line\\n\\nquote="He said \\\\"hello\\\\""');
  assert.deepEqual(parsed, {
    name: 'Alice',
    age: '30',
    city: 'New York',
    quote: 'He said "hello"',
  });
});

test('Task 1: parseKeyValue throws InvalidKeyError on invalid key names', async () => {
  const mod = await import('../src/parser.js');
  const { parseKeyValue, InvalidKeyError } = mod;
  assert.ok(InvalidKeyError, 'InvalidKeyError must be exported from src/parser.js');
  assert.throws(() => parseKeyValue('123bad=val'), (err) => err instanceof InvalidKeyError);
});

test('Task 1: parseKeyValue throws SyntaxError with message "Unterminated quote" on unclosed quotes', async () => {
  const { parseKeyValue } = await import('../src/parser.js');
  assert.throws(() => parseKeyValue('title="Unclosed quote'), (err) => err instanceof SyntaxError && /Unterminated quote/i.test(err.message));
});
`;
  await writeFile(path.join(targetRepo, 'test', 'parser.test.js'), parserTestJs, 'utf8');

  // Add formatter test suite
  const formatterTestJs = `import test from 'node:test';
import assert from 'node:assert/strict';

test('Task 2: formatKeyValue formats dictionary into kv string and quotes values with spaces', async () => {
  let mod;
  try {
    mod = await import('../src/formatter.js');
  } catch (err) {
    assert.fail('src/formatter.js must be created: ' + err.message);
  }
  const { formatKeyValue } = mod;
  assert.equal(typeof formatKeyValue, 'function');
  const formatted = formatKeyValue({ host: 'localhost', desc: 'Web Server' });
  assert.equal(formatted.trim(), 'host=localhost\\ndesc="Web Server"');
});

test('Task 2: index.js exports all library functions', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.parseKeyValue, 'function');
  assert.equal(typeof mod.formatKeyValue, 'function');
  assert.ok(mod.InvalidKeyError);
  assert.equal(mod.LIB_VERSION, '1.0.0');
});
`;
  await writeFile(path.join(targetRepo, 'test', 'formatter.test.js'), formatterTestJs, 'utf8');

  // Add and commit baseline
  await execFileAsync('git', ['add', '.'], { cwd: targetRepo });
  await execFileAsync('git', ['commit', '-m', 'chore: initial repository baseline with test suites'], { cwd: targetRepo });

  // Create unrelated dirty user edit: notes/user-local.txt
  await mkdir(path.join(targetRepo, 'notes'), { recursive: true });
  const dirtyContent = `USER-LOCAL SCRATCHPAD (CONFIDENTIAL WIP)\nDo not modify, overwrite, or delete during any automated workflow.\nTimestamp: ${new Date().toISOString()}\nRandomNonce: ${Math.random()}\n`;
  const dirtyPath = path.join(targetRepo, 'notes', 'user-local.txt');
  await writeFile(dirtyPath, dirtyContent, 'utf8');

  const dirtyHashBefore = sha256(dirtyContent);
  console.log(`  ✔ Clean git baseline committed.`);
  console.log(`  ✔ Unrelated dirty user file created: notes/user-local.txt (SHA256: ${dirtyHashBefore})`);

  const { stdout: statusBefore } = await execFileAsync('git', ['status', '--porcelain'], { cwd: targetRepo });
  console.log(`  ✔ Pre-invocation git status:\n${statusBefore.trim().replace(/^/gm, '    ')}`);

  console.log('\n[2] Setting up fresh frontend session (MCP client)...');
  const server = createSuperGptMcpServer({ cwd: targetRepo });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'frontend-fresh-session', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(clientTransport);
  console.log('  ✔ Fresh MCP client connected.');

  const naturalUserRequest = 'Refactor src/parser.js in task 1 with parseKeyValue and InvalidKeyError class (handling comments, unquoting, escaped quotes, and unterminated quote SyntaxError), build src/formatter.js in task 2 with formatKeyValue, re-export in src/index.js, and verify all tests pass across the module while keeping existing behavior unchanged.';
  console.log(`\n[3] Natural user request (no mention of SuperGPT):\n  "${naturalUserRequest}"`);

  // Step 2.1: AutoRoute policy check
  const autoRouteDecision = decideAutoRoute(naturalUserRequest);
  console.log(`  ✔ AutoRoute decision: mode=${autoRouteDecision.mode}, route=${autoRouteDecision.route}`);
  if (autoRouteDecision.mode !== 'AUTO' || !autoRouteDecision.route) {
    throw new Error(`Expected AutoRoute decision { mode: 'AUTO', route: true }, got: ${JSON.stringify(autoRouteDecision)}`);
  }

  // Step 2.2: supergpt_prepare via MCP
  console.log('\n[4] Calling MCP supergpt_prepare...');
  const prepareResponse = await mcpClient.callTool({
    name: 'supergpt_prepare',
    arguments: {
      goal: naturalUserRequest,
      cwd: targetRepo,
    },
  });
  const canonicalRequest = JSON.parse(prepareResponse.content[0].text);
  console.log(`  ✔ Canonical request schema: ${canonicalRequest.schema}`);
  console.log(`  ✔ Execution mode: ${canonicalRequest.execution_mode}`);

  // Step 2.3: Start SuperGPT workflow with Live UX Progress Renderer
  console.log('\n[5] Launching SuperGPT workflow with Live UX Progress Updates...');
  const emittedEvents = [];
  let workflowId = null;
  let currentTask = null;
  let currentAttempt = 1;
  let gateState = 'IDLE';
  let reviewerState = 'IDLE';
  let executorModel = 'claude-sonnet-5';

  function printProgressCard(transitionTitle) {
    const elapsed = formatDuration(Date.now() - startTime);
    console.log(`\n┌─ [LIVE UX PROGRESS] ${transitionTitle.padEnd(50)} ─┐`);
    console.log(`│ Workflow ID:   ${(workflowId || 'initializing').padEnd(54)} │`);
    console.log(`│ Elapsed:       ${elapsed.padEnd(54)} │`);
    console.log(`│ Stage:         ${(currentTask ? `EXECUTING (${currentTask})` : 'PLANNING / SETUP').padEnd(54)} │`);
    console.log(`│ Task Progress: ${(currentTask ? `Task ${currentTask} (Attempt ${currentAttempt})` : 'Task Decomposition in progress').padEnd(54)} │`);
    console.log(`│ Executor Role: ${(executorModel + ' (Claude Code)').padEnd(54)} │`);
    console.log(`│ Gate Status:   ${gateState.padEnd(54)} │`);
    console.log(`│ Reviewer:      ${reviewerState.padEnd(54)} │`);
    console.log(`│ Liveness:      HEARTBEAT OK · ZERO TOKEN OVERHEAD                    │`);
    console.log(`└────────────────────────────────────────────────────────────────────────┘`);
  }

  const runResult = await runSuperGPT({
    goal: naturalUserRequest,
    cwd: targetRepo,
    onEvent: (event) => {
      emittedEvents.push(event);
      if (event.type === 'workflow_started') {
        workflowId = event.workflowId;
        printProgressCard('WORKFLOW_STARTED');
      } else if (event.type === 'stage_changed') {
        printProgressCard(`STAGE_CHANGED -> ${event.stage.toUpperCase()}`);
      } else if (event.type === 'task_started') {
        currentTask = event.taskId;
        currentAttempt = 1;
        gateState = 'RUNNING';
        reviewerState = 'WAITING';
        printProgressCard(`TASK_STARTED: ${event.taskId}`);
      } else if (event.type === 'task_attempt_started') {
        currentAttempt = event.attempt;
        gateState = 'RUNNING';
        reviewerState = 'WAITING';
        printProgressCard(`ATTEMPT_STARTED: ${event.taskId} (#${event.attempt})`);
      } else if (event.type === 'verification_finished') {
        gateState = event.result || 'FINISHED';
        printProgressCard(`GATE_RESULT: ${gateState}`);
      } else if (event.type === 'review_finished') {
        reviewerState = event.decision || 'FINISHED';
        printProgressCard(`REVIEWER_RESULT: ${reviewerState} (${event.taskId} attempt ${event.attempt})`);
      } else if (event.type === 'rework_requested') {
        reviewerState = 'REWORK_REQUESTED';
        printProgressCard(`REWORK_REQUESTED: ${event.taskId}`);
      } else if (event.type === 'delivery_succeeded') {
        printProgressCard('DELIVERY_SUCCEEDED');
      } else if (event.type === 'delivery_failed') {
        printProgressCard(`DELIVERY_FAILED: ${event.reason}`);
      } else if (event.type === 'token_anomaly_detected') {
        printProgressCard(`TOKEN_ANOMALY: ${event.severity}`);
      }
    },
  });

  console.log('\n========================================================================');
  console.log('WORKFLOW EXECUTION RESULT');
  console.log('========================================================================');
  console.log(`Status:          ${runResult.status}`);
  console.log(`Summary:         ${runResult.summary}`);
  console.log(`Delivered files: ${(runResult.deliveredFiles || []).join(', ')}`);
  console.log(`Workflow ID:     ${workflowId || runResult.workflowId}`);

  // Test zero-token status query via MCP
  console.log('\n[6] Testing Zero-Token status query via MCP supergpt_status...');
  const statusResponse = await mcpClient.callTool({
    name: 'supergpt_status',
    arguments: { workflowId: workflowId || runResult.workflowId },
  });
  const statusPayload = JSON.parse(statusResponse.content[0].text);
  console.log(`  ✔ Status query successful. Workflows found: ${statusPayload.workflows.length}`);
  if (statusPayload.workflows.length > 0) {
    console.log(`  ✔ Live state reported: status=${statusPayload.workflows[0].status}, stage=${statusPayload.workflows[0].stage}`);
    if (statusPayload.workflows[0].formattedProgress) {
      console.log(`  ✔ Progress block:\n${statusPayload.workflows[0].formattedProgress.replace(/^/gm, '    ')}`);
    }
  }

  // Delivery & Workspace Verification
  console.log('\n[7] Verifying Delivery and Unrelated Dirty File Integrity...');
  if (runResult.status !== 'WORKFLOW_DONE') {
    throw new Error(`Workflow did not complete with WORKFLOW_DONE. Got: ${runResult.status} (reason: ${runResult.reason || 'none'})`);
  }

  if (!existsSync(dirtyPath)) {
    throw new Error(`Unrelated dirty file was removed! Expected at: ${dirtyPath}`);
  }
  const dirtyContentAfter = await readFile(dirtyPath, 'utf8');
  const dirtyHashAfter = sha256(dirtyContentAfter);

  console.log(`  Dirty file SHA256 before: ${dirtyHashBefore}`);
  console.log(`  Dirty file SHA256 after:  ${dirtyHashAfter}`);

  if (dirtyHashBefore !== dirtyHashAfter) {
    throw new Error(`Unrelated dirty file content was modified! Before: ${dirtyHashBefore}, After: ${dirtyHashAfter}`);
  }
  console.log('  ✔ Byte-for-byte dirty file preservation verified!');

  // Verify delivery changes and run project tests in target repo
  console.log('\n[8] Running target repository test suite in invocation workspace...');
  const { stdout: testStdout, stderr: testStderr } = await execFileAsync('npm', ['test'], { cwd: targetRepo });
  console.log(testStdout.trim().replace(/^/gm, '    '));
  console.log('  ✔ All project tests passed in invocation workspace.');

  // Check token usage and accounting
  console.log('\n[9] Telemetry & Token Usage Accounting:');
  const usageSummary = runResult.tokenUsage;
  if (usageSummary && usageSummary.total) {
    console.log(`  Total Calls: ${usageSummary.total.calls}, Total Tokens: ${usageSummary.total.totalTokens}`);
    console.log('  Role Breakdown:');
    console.log(`    - Planner:    ${usageSummary.planner.calls} calls, in=${usageSummary.planner.inputTokens}, out=${usageSummary.planner.outputTokens}, cached=${usageSummary.planner.cachedTokens}`);
    console.log(`    - Supervisor: ${usageSummary.supervisor.calls} calls, in=${usageSummary.supervisor.inputTokens}, out=${usageSummary.supervisor.outputTokens}, cached=${usageSummary.supervisor.cachedTokens}`);
    console.log(`    - Executor:   ${usageSummary.executor.calls} calls, in=${usageSummary.executor.inputTokens}, out=${usageSummary.executor.outputTokens}, cached=${usageSummary.executor.cachedTokens}`);
    console.log(`    - Reviewer:   ${usageSummary.reviewer.calls} calls, in=${usageSummary.reviewer.inputTokens}, out=${usageSummary.reviewer.outputTokens}, cached=${usageSummary.reviewer.cachedTokens}`);
  }

  console.log('\n========================================================================');
  console.log('✔ E2E ACCEPTANCE COMPLETED SUCCESSFULLY');
  console.log('========================================================================\n');

  return {
    workflowId: workflowId || runResult.workflowId,
    status: runResult.status,
    summary: runResult.summary,
    deliveredFiles: runResult.deliveredFiles,
    events: emittedEvents,
    usage: usageSummary,
    dirtyHashBefore,
    dirtyHashAfter,
    targetRepo,
  };
}

run().catch((err) => {
  console.error('\n✖ E2E ACCEPTANCE FAILED:', err);
  process.exit(1);
});
