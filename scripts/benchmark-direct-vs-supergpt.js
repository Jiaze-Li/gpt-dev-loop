#!/usr/bin/env node
// DIRECT (Claude Code) vs SUPERGPT token-economics benchmark.
//
// Measurement only. Makes real provider calls and therefore requires the
// standard double opt-in used by every other live entrypoint:
//   node scripts/benchmark-direct-vs-supergpt.js --allow-real-provider-calls
//   with SUPERGPT_ALLOW_REAL_PROVIDER_CALLS=1 in the environment.
//
// It never changes orchestrator behaviour: it builds two throwaway fixture
// repositories, runs each through (a) the `claude` CLI directly and (b)
// production `runSuperGPT`, from a byte-identical initial commit, and reports
// apples-to-apples usageVolume / cost / call-count / wall-clock.
//
//   CASE A  small bounded task   -> Direct  vs  SuperGPT FAST
//   CASE B  medium two-part task -> Direct  vs  SuperGPT FULL (explicit planning)

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm, cp, readFile } from 'node:fs/promises';

import {
  assertRealProviderCallsAuthorized,
  REAL_PROVIDER_CALL_FLAG,
} from '../src/orchestrator/realProviderCallGuard.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { readLiveWorkflowState } from '../src/orchestrator/workflowState.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Fixed timestamps so the initial commit hash is identical for every
// materialisation of a fixture.
const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Benchmark',
  GIT_AUTHOR_EMAIL: 'bench@local',
  GIT_COMMITTER_NAME: 'Benchmark',
  GIT_COMMITTER_EMAIL: 'bench@local',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_A = {
  name: 'parse-number-fixture',
  files: {
    'package.json': JSON.stringify(
      { name: 'parse-number-fixture', version: '1.0.0', type: 'module', private: true },
      null,
      2,
    ) + '\n',
    'src/parseNumber.js':
`// Convert a string to an integer.
export function parseNumber(input) {
  return parseInt(input, 10);
}
`,
    'tests/parseNumber.test.js':
`import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber } from '../src/parseNumber.js';

test('parses a plain integer', () => {
  assert.equal(parseNumber('42'), 42);
});

test('accepts surrounding whitespace', () => {
  assert.equal(parseNumber('   42   '), 42);
});

test('rejects partially numeric strings', () => {
  assert.throws(() => parseNumber('12abc'));
});

test('rejects non-numeric and empty input', () => {
  assert.throws(() => parseNumber('abc'));
  assert.throws(() => parseNumber(''));
});

test('preserves negative integers', () => {
  assert.equal(parseNumber('-7'), -7);
});
`,
  },
  goal:
    'Update the parseNumber function in src/parseNumber.js so it accepts surrounding whitespace, ' +
    'rejects partially numeric strings such as "12abc" by throwing, and preserves existing valid ' +
    'integer behaviour including negatives. The suite in tests/parseNumber.test.js already covers ' +
    'these cases; verify with `node --test tests/parseNumber.test.js`.',
  verify: ['node --test tests/parseNumber.test.js'],
  allowedTools: ['Bash(node --test tests/parseNumber.test.js)'],
  explicitFullPath: false,
};

const FIXTURE_B = {
  name: 'session-config-fixture',
  files: {
    'package.json': JSON.stringify(
      { name: 'session-config-fixture', version: '1.0.0', type: 'module', private: true },
      null,
      2,
    ) + '\n',
    'src/config.js':
`// Parse a duration into milliseconds.
export function parseDuration(value) {
  return Number(value);
}
`,
    'src/session.js':
`import { parseDuration } from './config.js';

export function createSession(id, ttl = '1h') {
  return { id, createdAt: Date.now(), ttl };
}

export function isExpired(session, now = Date.now()) {
  return session.createdAt + session.ttl < now;
}
`,
    'tests/config.test.js':
`import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/config.js';

test('parses second/minute/hour suffixes', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
});

test('passes a plain millisecond number through', () => {
  assert.equal(parseDuration('1000'), 1000);
  assert.equal(parseDuration(1000), 1000);
});

test('rejects an unparseable duration', () => {
  assert.throws(() => parseDuration('soon'));
});
`,
    'tests/session.test.js':
`import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, isExpired } from '../src/session.js';

test('a fresh session is not expired', () => {
  const s = createSession('a', '1h');
  assert.equal(isExpired(s, Date.now()), false);
});

test('a session past its ttl is expired', () => {
  const s = createSession('b', '1h');
  assert.equal(isExpired(s, s.createdAt + 3_600_001), true);
});

test('the exact expiry instant counts as expired', () => {
  const s = createSession('c', '1h');
  assert.equal(isExpired(s, s.createdAt + 3_600_000), true);
});

test('ttl accepts a duration string', () => {
  const s = createSession('d', '30s');
  assert.equal(isExpired(s, s.createdAt + 29_000), false);
  assert.equal(isExpired(s, s.createdAt + 31_000), true);
});
`,
  },
  goal:
    'Fix session expiration handling in src/session.js and add configurable duration parsing in ' +
    'src/config.js, while preserving existing valid behaviour. Verify with ' +
    '`node --test tests/session.test.js` and `node --test tests/config.test.js`.',
  verify: ['node --test tests/session.test.js', 'node --test tests/config.test.js'],
  allowedTools: [
    'Bash(node --test tests/session.test.js)',
    'Bash(node --test tests/config.test.js)',
  ],
  explicitFullPath: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function materializeFixture(fixture, root, tag) {
  const dir = path.join(root, `${fixture.name}-${tag}`);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(fixture.files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  const env = { ...process.env, ...FIXED_GIT_ENV };
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial fixture baseline'], { cwd: dir, env });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, head: stdout.trim() };
}

async function gitDiffStat(dir) {
  const { stdout: names } = await execFileAsync('git', ['diff', '--name-only'], { cwd: dir });
  const { stdout: full } = await execFileAsync('git', ['diff'], { cwd: dir });
  const { stdout: untracked } = await execFileAsync(
    'git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir },
  );
  return {
    changedFiles: names.split('\n').filter(Boolean),
    untracked: untracked.split('\n').filter(Boolean),
    diff: full,
  };
}

async function runVerification(dir, commands) {
  const results = [];
  for (const cmd of commands) {
    const [bin, ...args] = cmd.split(' ');
    try {
      // `node --test` exits 0 only when every test passed; a non-zero exit
      // rejects here. The `fail 0` check is a belt-and-braces cross-check
      // against both the modern (`ℹ fail 0`) and TAP (`# fail 0`) reporters.
      const { stdout, stderr } = await execFileAsync(bin, args, { cwd: dir, timeout: 120_000 });
      const out = stdout + stderr;
      const failLine = out.match(/(?:ℹ|#)\s*fail\s+(\d+)/);
      results.push({ cmd, pass: !failLine || failLine[1] === '0', tail: out.trim().split('\n').slice(-6).join('\n') });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      results.push({ cmd, pass: false, tail: out.trim().split('\n').slice(-6).join('\n') });
    }
  }
  return results;
}

// Mirror the flags SuperGPT's Claude executor adapter passes, so the model,
// permission posture and MCP surface match. The only intentional difference is
// the absence of the Task-Card / workflow scaffolding.
function directClaudeArgs(allowedTools) {
  return [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--permission-mode', 'acceptEdits',
    '--model', 'sonnet',
    '--max-turns', '30',
    '--max-budget-usd', '0.50',
    ...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []),
  ];
}

function directPrompt(fixture) {
  return `You are working directly in a small repository. Complete this task, then run the verification command(s) yourself and confirm they pass.

GOAL
${fixture.goal}

ALLOWED SCOPE
- Edit only implementation files under src/. Do not modify the test files.

ACCEPTANCE CRITERIA
- Every test in the named test file(s) passes.
- Existing valid behaviour is preserved.

VERIFICATION COMMANDS (run exactly these)
${fixture.verify.map((c) => `- ${c}`).join('\n')}

When the verification commands pass, briefly report what you changed.`;
}

async function runDirect(fixture, dir) {
  const started = Date.now();
  const child = spawn('claude', directClaudeArgs(fixture.allowedTools), {
    cwd: dir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  child.stdin.write(directPrompt(fixture));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  const durationMs = Date.now() - started;
  const stdout = Buffer.concat(out).toString('utf8');
  const stderr = Buffer.concat(err).toString('utf8');

  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* ignore */ }
  if (!parsed) {
    throw new Error(`Direct run produced no JSON (exit ${code}): ${stderr.slice(-500) || stdout.slice(-500)}`);
  }

  const u = parsed.usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
  usage.usageVolume = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;

  return {
    mode: 'Direct',
    exitCode: code,
    calls: 1,
    numTurns: parsed.num_turns ?? null,
    costUsd: Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : null,
    durationMs,
    usage,
  };
}

function roleBucket(summary, key) {
  const b = summary?.[key] ?? {};
  return {
    calls: b.calls ?? 0,
    input: b.inputTokens ?? 0,
    output: b.outputTokens ?? 0,
    cacheCreation: b.cacheCreationTokens ?? 0,
    cacheRead: b.cacheReadTokens ?? 0,
    usageVolume: b.usageVolume ?? 0,
    costUsd: b.costUsd ?? 0,
  };
}

// The SuperGPT arm is measured END-TO-END: a real front-agent `claude` session
// receives the identical user prompt, routes it, launches the workflow through
// the production MCP contract (supergpt_route -> supergpt_start_and_wait), and
// reads the terminal result. That session's own provider-native usage is the
// front-agent cost; the internal role usage is read back from the workflow's
// persisted state file by its workflowId.
function superFrontAgentArgs() {
  return [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'acceptEdits',
    '--model', 'sonnet',
    '--max-turns', '40',
    '--max-budget-usd', '3.00',
    '--allowedTools',
    'mcp__supergpt__supergpt_route',
    'mcp__supergpt__supergpt_start_and_wait',
  ];
}

function superFrontAgentPrompt(fixture, dir) {
  return `You are a front-agent interface bound by the SuperGPT front-agent contract. A user has submitted this request for the repository at:
  ${dir}

USER REQUEST
${fixture.goal}

DO EXACTLY THIS
1. Call supergpt_route with { "goal": <the user request>, "cwd": "${dir}" }.
2. If it returns SUPERGPT, call supergpt_start_and_wait ONCE with { "goal": <the user request>, "cwd": "${dir}" }. Never poll, never call watch/wait, never call it more than once.
3. If it returns DIRECT, say so and stop.
4. When supergpt_start_and_wait returns a terminal result, briefly relay the outcome.

Then, as the FINAL two lines of your reply, output literally:
WORKFLOW_ID=<the workflowId from the tool result, or NONE>
ROUTE_DECISION=<DIRECT or SUPERGPT>`;
}

function usageFromClaudeEnvelope(parsed) {
  const u = parsed.usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
  usage.usageVolume = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
  return usage;
}

async function runSuper(fixture, dir) {
  const started = Date.now();
  // Benchmark/test-only Full Path seam. Only opt in for the fixture that is
  // explicitly designed to measure the Full Path; everything else routes
  // naturally. The seam is double-gated in pathSelection.js (this var AND the
  // live-provider opt-in) so it can never take effect in a production config.
  const superEnv = { ...process.env };
  if (fixture.explicitFullPath === true) {
    superEnv.SUPERGPT_BENCHMARK_FORCE_FULL = '1';
  } else {
    delete superEnv.SUPERGPT_BENCHMARK_FORCE_FULL;
  }
  const child = spawn('claude', superFrontAgentArgs(), {
    cwd: dir,
    env: superEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  child.stdin.write(superFrontAgentPrompt(fixture, dir));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  const durationMs = Date.now() - started;
  const stdout = Buffer.concat(out).toString('utf8');
  const stderr = Buffer.concat(err).toString('utf8');

  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* ignore */ }
  if (!parsed) {
    throw new Error(`SuperGPT front-agent run produced no JSON (exit ${code}): ${stderr.slice(-500) || stdout.slice(-500)}`);
  }

  const frontUsage = usageFromClaudeEnvelope(parsed);
  const resultText = typeof parsed.result === 'string' ? parsed.result : '';
  const wfMatch = resultText.match(/WORKFLOW_ID=(\S+)/);
  const routeMatch = resultText.match(/ROUTE_DECISION=(\S+)/);
  const workflowId = wfMatch && wfMatch[1] !== 'NONE' ? wfMatch[1] : null;
  const routeDecision = routeMatch ? routeMatch[1] : null;

  // Internal role usage: read back from the persisted workflow state.
  let internalRoles = { planner: roleBucket({}, 'x'), supervisor: roleBucket({}, 'x'), executor: roleBucket({}, 'x'), reviewer: roleBucket({}, 'x') };
  let internalTotal = roleBucket({}, 'x');
  let workflowStatus = null;
  let safetyEvents = [];
  if (workflowId) {
    try {
      const state = readLiveWorkflowState({ workflowId, root: SUPERGPT_WORKTREE_ROOT });
      const s = state?.tokenUsage ?? {};
      internalRoles = {
        planner: roleBucket(s, 'planner'),
        supervisor: roleBucket(s, 'supervisor'),
        executor: roleBucket(s, 'executor'),
        reviewer: roleBucket(s, 'internalReviewer'),
      };
      internalTotal = roleBucket(s, 'measuredTotal');
      workflowStatus = state?.workflowStatus ?? null;
      safetyEvents = Array.isArray(state?.safetyEvents) ? state.safetyEvents : [];
    } catch (readErr) {
      internalTotal = { ...internalTotal, readError: readErr?.message ?? String(readErr) };
    }
  }

  const e2eUsageVolume = frontUsage.usageVolume + internalTotal.usageVolume;

  return {
    mode: 'SuperGPT',
    status: workflowStatus ?? (parsed.is_error ? 'FAILED' : 'UNKNOWN'),
    routeDecision,
    workflowId,
    frontAgent: {
      usage: frontUsage,
      usageVolume: frontUsage.usageVolume,
      costUsd: Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : null,
      numTurns: parsed.num_turns ?? null,
      exitCode: code,
    },
    roles: internalRoles,
    total: internalTotal,
    e2eUsageVolume,
    calls: internalTotal.calls,
    durationMs,
    safetyEvents,
    frontAgentStderrTail: stderr.trim().split('\n').slice(-6).join('\n'),
  };
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function ratio(a, b) {
  if (!b) return 'n/a';
  return (a / b).toFixed(2) + '×';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  assertRealProviderCallsAuthorized({
    explicitLiveIntent: process.argv.slice(2).includes(REAL_PROVIDER_CALL_FLAG),
    entrypoint: 'scripts/benchmark-direct-vs-supergpt.js',
  });

  const { stdout: headOut } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT });
  const headBefore = headOut.trim();

  const workRoot = path.join(os.tmpdir(), `bench-direct-vs-supergpt-${Date.now()}`);
  await mkdir(workRoot, { recursive: true });

  const report = { headBefore, cases: {} };

  for (const [label, fixture] of [['A', FIXTURE_A], ['B', FIXTURE_B]]) {
    console.log(`\n${'='.repeat(72)}\nCASE ${label} — ${fixture.name}\n${'='.repeat(72)}`);

    const directFix = await materializeFixture(fixture, workRoot, `${label}-direct`);
    const superFix = await materializeFixture(fixture, workRoot, `${label}-supergpt`);
    console.log(`  initial commit (direct):   ${directFix.head}`);
    console.log(`  initial commit (supergpt): ${superFix.head}`);
    const sameCommit = directFix.head === superFix.head;

    console.log('\n  >> Direct run...');
    const direct = await runDirect(fixture, directFix.dir);
    const directDiff = await gitDiffStat(directFix.dir);
    const directVerify = await runVerification(directFix.dir, fixture.verify);
    direct.verifyPass = directVerify.every((r) => r.pass);
    direct.changedFiles = [...directDiff.changedFiles, ...directDiff.untracked];
    direct.diff = directDiff.diff;
    direct.verify = directVerify;
    console.log(`     calls=1 turns=${direct.numTurns} vol=${fmt(direct.usage.usageVolume)} cost=${direct.costUsd} verify=${direct.verifyPass ? 'PASS' : 'FAIL'}`);

    console.log('\n  >> SuperGPT run...');
    const sup = await runSuper(fixture, superFix.dir);
    const supDiff = await gitDiffStat(superFix.dir);
    const supVerify = await runVerification(superFix.dir, fixture.verify);
    sup.verifyPass = supVerify.every((r) => r.pass);
    sup.changedFilesActual = [...supDiff.changedFiles, ...supDiff.untracked];
    sup.diff = supDiff.diff;
    sup.verify = supVerify;
    console.log(`     status=${sup.status} route=${sup.routeDecision} wf=${sup.workflowId} frontVol=${fmt(sup.frontAgent.usageVolume)} internalVol=${fmt(sup.total.usageVolume)} e2eVol=${fmt(sup.e2eUsageVolume)} verify=${sup.verifyPass ? 'PASS' : 'FAIL'}`);

    report.cases[label] = { fixture: fixture.name, sameCommit, initialCommit: directFix.head, direct, sup };
  }

  // ---- ratios ----
  // INTERNAL multiplier  = SuperGPT internal role usage  / Direct front-agent usage
  // E2E TOTAL multiplier = (SuperGPT front-agent + internal) / Direct front-agent usage  <- product metric
  const A = report.cases.A;
  const B = report.cases.B;
  const mult = (sup, direct) => ({
    internal: ratio(sup.total.usageVolume, direct.usage.usageVolume),
    e2e: ratio(sup.e2eUsageVolume, direct.usage.usageVolume),
    exec: ratio(sup.roles.executor.usageVolume, direct.usage.usageVolume),
  });
  const A_m = mult(A.sup, A.direct);
  const B_m = mult(B.sup, B.direct);

  // Cost multiplier uses front-agent native cost on the Direct side, and
  // (front-agent native cost + internal role cost) on the SuperGPT side.
  const supE2ECost = (c) =>
    (Number.isFinite(c.sup.frontAgent.costUsd) ? c.sup.frontAgent.costUsd : 0) + (c.sup.total.costUsd ?? 0);

  report.ratios = {
    fastInternalMult: A_m.internal,
    fastE2EMult: A_m.e2e,
    fullInternalMult: B_m.internal,
    fullE2EMult: B_m.e2e,
    fastExecMult: A_m.exec,
    fullExecMult: B_m.exec,
    fastCostMult: A.direct.costUsd ? ratio(supE2ECost(A), A.direct.costUsd) : 'UNKNOWN',
    fullCostMult: B.direct.costUsd ? ratio(supE2ECost(B), B.direct.costUsd) : 'UNKNOWN',
    fastWallMult: ratio(A.sup.durationMs, A.direct.durationMs),
    fullWallMult: ratio(B.sup.durationMs, B.direct.durationMs),
    fastFrontAgentUsageSource: A.sup.frontAgent.usage.usageVolume > 0 ? 'provider-native' : 'UNKNOWN',
    fullFrontAgentUsageSource: B.sup.frontAgent.usage.usageVolume > 0 ? 'provider-native' : 'UNKNOWN',
  };

  const reportPath = path.join(workRoot, 'benchmark-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n${'='.repeat(72)}\nRESULTS\n${'='.repeat(72)}`);
  const row = (scenario, mode, front, planner, exec, rev, sup, totalUsage, tests) =>
    `| ${scenario} | ${mode} | ${fmt(front)} | ${fmt(planner)} | ${fmt(exec)} | ${fmt(rev)} | ${fmt(sup)} | ${fmt(totalUsage)} | ${tests} |`;
  console.log('\n| Scenario | Mode | Front Agent | Planner | Executor | Reviewer | Supervisor | Total Usage | Tests |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---|');
  console.log(row('Small', 'Direct', A.direct.usage.usageVolume, 0, 0, 0, 0, A.direct.usage.usageVolume, A.direct.verifyPass ? 'PASS' : 'FAIL'));
  console.log(row('Small', 'SuperGPT', A.sup.frontAgent.usageVolume, A.sup.roles.planner.usageVolume, A.sup.roles.executor.usageVolume, A.sup.roles.reviewer.usageVolume, A.sup.roles.supervisor.usageVolume, A.sup.e2eUsageVolume, A.sup.verifyPass ? 'PASS' : 'FAIL'));
  console.log(row('Medium', 'Direct', B.direct.usage.usageVolume, 0, 0, 0, 0, B.direct.usage.usageVolume, B.direct.verifyPass ? 'PASS' : 'FAIL'));
  console.log(row('Medium', 'SuperGPT', B.sup.frontAgent.usageVolume, B.sup.roles.planner.usageVolume, B.sup.roles.executor.usageVolume, B.sup.roles.reviewer.usageVolume, B.sup.roles.supervisor.usageVolume, B.sup.e2eUsageVolume, B.sup.verifyPass ? 'PASS' : 'FAIL'));
  console.log('');
  console.log(`FAST INTERNAL MULTIPLIER = ${report.ratios.fastInternalMult}`);
  console.log(`FAST E2E MULTIPLIER      = ${report.ratios.fastE2EMult}`);
  console.log(`FULL INTERNAL MULTIPLIER = ${report.ratios.fullInternalMult}`);
  console.log(`FULL E2E MULTIPLIER      = ${report.ratios.fullE2EMult}`);
  console.log(`FRONT AGENT USAGE SOURCE = fast:${report.ratios.fastFrontAgentUsageSource} full:${report.ratios.fullFrontAgentUsageSource}`);
  console.log(`SuperGPT statuses        = small:${A.sup.status} medium:${B.sup.status}`);
  if (A.sup.safetyEvents.length || B.sup.safetyEvents.length) {
    console.log(`safety events            = small:${JSON.stringify(A.sup.safetyEvents.map((e) => e.code))} medium:${JSON.stringify(B.sup.safetyEvents.map((e) => e.code))}`);
  }
  console.log('\n' + JSON.stringify(report.ratios, null, 2));
  console.log(`\nFull JSON: ${reportPath}`);
  console.log(`Fixtures kept at: ${workRoot}`);

  return { report, reportPath, workRoot };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('\nBENCHMARK FAILED:', err?.stack ?? err);
    process.exit(1);
  });
}

export { FIXTURE_A, FIXTURE_B, materializeFixture, runDirect, runSuper, gitDiffStat, runVerification, main };
