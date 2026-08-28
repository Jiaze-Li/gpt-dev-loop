#!/usr/bin/env node
// Focused Live Production E2E to verify the Reviewer REWORK convergence path.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSuperGptMcpServer } from '../src/mcp/supergptMcpServer.js';
import { decideAutoRoute } from '../src/control/autoRoutePolicy.js';
import { compileSuperGptRequest } from '../src/control/requestCompiler.js';
import { runSuperGPT, supergptStatus, SUPERGPT_EVENTS } from '../src/orchestrator/supergpt.js';

const execFileAsync = promisify(execFile);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function run() {
  console.log('========================================================================');
  console.log('SUPERGPT V1 LIVE REWORK CONVERGENCE PROOF');
  console.log('========================================================================\n');

  const testRoot = path.join('/tmp', `supergpt-rework-acceptance-${Date.now()}`);
  const targetRepo = path.join(testRoot, 'kv-rework-repo');
  await mkdir(targetRepo, { recursive: true });

  console.log(`[1] Initializing disposable acceptance repo at: ${targetRepo}`);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: targetRepo });
  await execFileAsync('git', ['config', 'user.name', 'SuperGPT Acceptor'], { cwd: targetRepo });
  await execFileAsync('git', ['config', 'user.email', 'acceptor@supergpt.local'], { cwd: targetRepo });

  const pkgJson = {
    name: 'kv-rework-lib',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --test test/*.test.js',
    },
  };
  await writeFile(path.join(targetRepo, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');

  // Baseline code: src/index.js
  await mkdir(path.join(targetRepo, 'src'), { recursive: true });
  await writeFile(path.join(targetRepo, 'src', 'index.js'), 'export const LIB_VERSION = "1.0.0";\n', 'utf8');

  // Baseline test: test/index.test.js
  await mkdir(path.join(targetRepo, 'test'), { recursive: true });
  await writeFile(path.join(targetRepo, 'test', 'index.test.js'), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { LIB_VERSION } from "../src/index.js";\ntest("baseline", () => assert.equal(LIB_VERSION, "1.0.0"));\n', 'utf8');

  // Add strict test that expects InvalidKeyError and SyntaxError
  const parserTestJs = `import test from 'node:test';
import assert from 'node:assert/strict';

test('parseKeyValue parses valid pairs', async () => {
  const { parseKeyValue } = await import('../src/parser.js');
  assert.deepEqual(parseKeyValue('foo=bar\\nnum=42'), { foo: 'bar', num: '42' });
});

test('parseKeyValue throws InvalidKeyError on invalid key names', async () => {
  const { parseKeyValue, InvalidKeyError } = await import('../src/parser.js');
  assert.ok(InvalidKeyError, 'InvalidKeyError must be exported');
  assert.throws(() => parseKeyValue('123bad=val'), (err) => err instanceof InvalidKeyError);
});

test('parseKeyValue throws SyntaxError with "Unterminated quote" on unclosed quotes', async () => {
  const { parseKeyValue } = await import('../src/parser.js');
  assert.throws(() => parseKeyValue('name="unclosed'), (err) => err instanceof SyntaxError && /Unterminated quote/i.test(err.message));
});
`;
  await writeFile(path.join(targetRepo, 'test', 'parser.test.js'), parserTestJs, 'utf8');

  await execFileAsync('git', ['add', '.'], { cwd: targetRepo });
  await execFileAsync('git', ['commit', '-m', 'chore: initial repository baseline'], { cwd: targetRepo });

  // Unrelated dirty user file
  await mkdir(path.join(targetRepo, 'notes'), { recursive: true });
  const dirtyContent = `DIRTY USER SCRATCHPAD\nCreated: ${new Date().toISOString()}\n`;
  const dirtyPath = path.join(targetRepo, 'notes', 'user-local.txt');
  await writeFile(dirtyPath, dirtyContent, 'utf8');
  const dirtyHashBefore = sha256(dirtyContent);

  console.log('\n[2] Setting up fresh frontend session (MCP client)...');
  const server = createSuperGptMcpServer({ cwd: targetRepo });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'frontend-rework-session', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(clientTransport);

  const naturalUserRequest = 'Implement src/parser.js with parseKeyValue and InvalidKeyError class (handling comments, unquoting, escaped quotes, and unterminated quote SyntaxError), re-export in src/index.js, and verify all tests pass across the module while keeping existing behavior unchanged.';

  const autoRouteDecision = decideAutoRoute(naturalUserRequest);
  console.log(`  ✔ AutoRoute decision: mode=${autoRouteDecision.mode}, route=${autoRouteDecision.route}`);

  const prepareResponse = await mcpClient.callTool({
    name: 'supergpt_prepare',
    arguments: { goal: naturalUserRequest, cwd: targetRepo },
  });
  console.log(`  ✔ Prepared canonical request: ${JSON.parse(prepareResponse.content[0].text).schema}`);

  console.log('\n[3] Launching SuperGPT workflow...');
  const recordedRework = {
    gateFailOccurred: false,
    reviewerReworkOccurred: false,
    requiredChanges: [],
    freshAttemptStarted: false,
    laterGatePass: false,
    laterReviewerPass: false,
    taskId: null,
    attempts: [],
  };

  const runResult = await runSuperGPT({
    goal: naturalUserRequest,
    cwd: targetRepo,
    onEvent: (event) => {
      if (event.type === 'task_started') {
        recordedRework.taskId = event.taskId;
        console.log(`  [EVENT] task_started: ${event.taskId}`);
      } else if (event.type === 'task_attempt_started') {
        recordedRework.attempts.push(event.attempt);
        if (event.attempt > 1) recordedRework.freshAttemptStarted = true;
        console.log(`  [EVENT] task_attempt_started: task=${event.taskId} attempt=${event.attempt}`);
      } else if (event.type === 'verification_finished') {
        if (event.result === 'FAIL') recordedRework.gateFailOccurred = true;
        if (event.result === 'PASS' && recordedRework.attempts.length > 1) recordedRework.laterGatePass = true;
        console.log(`  [EVENT] verification_finished: result=${event.result}`);
      } else if (event.type === 'review_finished') {
        if (event.decision === 'REWORK') {
          recordedRework.reviewerReworkOccurred = true;
          recordedRework.requiredChanges = event.requiredChanges || [];
        }
        if (event.decision === 'PASS' && recordedRework.attempts.length > 1) recordedRework.laterReviewerPass = true;
        console.log(`  [EVENT] review_finished: task=${event.taskId} attempt=${event.attempt} decision=${event.decision}`);
      } else if (event.type === 'rework_requested') {
        console.log(`  [EVENT] rework_requested: task=${event.taskId} attempt=${event.attempt}`);
      } else if (event.type === 'delivery_succeeded') {
        console.log(`  [EVENT] delivery_succeeded`);
      }
    },
  });

  console.log('\n========================================================================');
  console.log('REWORK CONVERGENCE RESULT');
  console.log('========================================================================');
  console.log(`Status:                  ${runResult.status}`);
  console.log(`Task ID:                 ${recordedRework.taskId}`);
  console.log(`Total Attempts:          ${recordedRework.attempts.length}`);
  console.log(`Gate FAIL Occurred:      ${recordedRework.gateFailOccurred ? 'YES' : 'NO'}`);
  console.log(`Reviewer REWORK:         ${recordedRework.reviewerReworkOccurred ? 'YES' : 'NO'}`);
  console.log(`Required Changes:        ${JSON.stringify(recordedRework.requiredChanges)}`);
  console.log(`Fresh Executor Attempt:  ${recordedRework.freshAttemptStarted ? 'YES' : 'NO'}`);
  console.log(`Subsequent Gate PASS:    ${recordedRework.laterGatePass ? 'YES' : 'NO'}`);
  console.log(`Subsequent Reviewer PASS:${recordedRework.laterReviewerPass ? 'YES' : 'NO'}`);

  // Verify dirty file
  const dirtyContentAfter = await readFile(dirtyPath, 'utf8');
  const dirtyHashAfter = sha256(dirtyContentAfter);
  console.log(`Dirty file preserved:    ${dirtyHashBefore === dirtyHashAfter ? 'YES' : 'NO'}`);

  // Test suite in target repo
  const { stdout: testStdout } = await execFileAsync('npm', ['test'], { cwd: targetRepo });
  console.log('\nTarget Repo Tests:');
  console.log(testStdout.trim().replace(/^/gm, '    '));

  return { runResult, recordedRework, dirtyPreserved: dirtyHashBefore === dirtyHashAfter };
}

run().catch((err) => {
  console.error('✖ REWORK E2E FAILED:', err);
  process.exit(1);
});
