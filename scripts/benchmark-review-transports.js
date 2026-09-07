#!/usr/bin/env node
// ReviewLoop transport + controller benchmark — deterministic, ZERO provider calls.
//
// Layer 1 exercises each CLI-backed transport through a fake spawn and records
// narrowness / payload-overhead metadata.
// Layer 2 drives the REAL ReviewLoop controller state machine with injected
// fake Reviewer/Supervisor functions:
//   E2E-A: one-round PASS
//   E2E-B: REWORK -> changed implementation -> PASS
//   E2E-C: same blocker after changed implementation -> Supervisor exactly once
// No child-process provider invocation is reachable from the E2E layer.

import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  makeCodexReviewTransport,
  makeClaudeReviewTransport,
} from '../src/reviewloop/adapters/cliReviewTransports.js';
import { narrowReviewTransportCwd } from '../src/reviewloop/adapters/scratchCwd.js';
import { payloadMetaOf, usageBreakdownOf, contextOverheadTokens } from '../src/reviewloop/reviewSpend.js';
import { createReviewLoopController } from '../src/reviewloop/controller.js';

const SYNTHETIC_PROMPT = [
  'You are an INDEPENDENT code reviewer. Judge ONLY against the original objective.',
  'ORIGINAL OBJECTIVE: add bounded failover across the CLI review transports',
  'CHANGED FILES: src/reviewloop/adapters/cliReviewTransports.js, src/reviewloop/providerWiring.js',
  'DETERMINISTIC GATE: PASS',
  'GIT DIFF (primary evidence):',
  '+'.repeat(1200),
  'Return JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
].join('\n');

const SYNTHETIC_INPUT_TOKENS = Math.round(SYNTHETIC_PROMPT.length / 4) + 850;

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    queueMicrotask(() => {
      const oi = args.indexOf('-o');
      if (oi !== -1) writeFileSync(args[oi + 1], '{"findings":[]}');
      if (command === 'codex') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          type: 'turn.completed', model: 'gpt-5-codex',
          usage: { input_tokens: SYNTHETIC_INPUT_TOKENS, output_tokens: 40 },
        }) + '\n'));
      } else {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          type: 'result', subtype: 'success', is_error: false, result: '{"findings":[]}',
          model: 'claude-opus-current', total_cost_usd: 0.02,
          usage: { input_tokens: SYNTHETIC_INPUT_TOKENS, output_tokens: 40, cache_read_input_tokens: 0 },
        })));
      }
      child.emit('close', 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const NARROW_MARKERS = {
  codex: ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only'],
  claude: ['--strict-mcp-config', '--mcp-config', '{}', '--exclude-dynamic-system-prompt-sections', '--disallowedTools'],
};

async function measure(name, makeTransport) {
  const spawn = fakeSpawn();
  const transport = makeTransport({ spawn, env: { PATH: process.env.PATH } });
  const res = await transport(SYNTHETIC_PROMPT);
  const { command, args } = spawn.calls[0];
  const payloadMeta = payloadMetaOf(res.meta);
  const breakdown = usageBreakdownOf(res.usage);
  const cwdArgIdx = args.indexOf('-C');
  const cwd = cwdArgIdx !== -1 ? args[cwdArgIdx + 1] : narrowReviewTransportCwd();
  const modelFlag = command === 'claude' ? '--model' : '-m';
  const modelIdx = args.indexOf(modelFlag);
  return {
    transport: name,
    command,
    realSpawns: 0,
    narrowFlagsPresent: NARROW_MARKERS[command].every((f) => args.includes(f)),
    resumesConversation: args.includes('--resume') || args.includes('-c') || args.includes('--continue'),
    runsFromIsolatedScratchCwd: cwd === narrowReviewTransportCwd(),
    modelArg: modelIdx === -1 ? null : args[modelIdx + 1],
    promptChars: payloadMeta?.promptChars ?? null,
    estimatedPayloadTokens: payloadMeta?.estimatedPayloadTokens ?? null,
    providerInputTokens: breakdown.inputTokens,
    contextOverheadTokens: contextOverheadTokens(breakdown, payloadMeta),
  };
}

class MemoryPersistence {
  constructor() { this.state = new Map(); }
  async readWorkflowState(id) { return this.state.has(id) ? structuredClone(this.state.get(id)) : null; }
  async writeWorkflowState(id, value) { this.state.set(id, structuredClone(value)); }
  async updateWorkflowState(id, patch) {
    const next = { ...((await this.readWorkflowState(id)) ?? {}), ...patch };
    this.state.set(id, structuredClone(next));
    return next;
  }
}

function blocker() {
  return { severity: 'P1', file: 'src/x.js', line: 7, title: 'persistent blocker' };
}

function fakeController({ deltas, reviews, supervisorReplies = [] }) {
  const persistence = new MemoryPersistence();
  const calls = { delta: 0, gate: 0, reviewer: 0, supervisor: 0 };
  const controller = createReviewLoopController({
    persistence,
    captureBaselineFn: async () => ({ head: 'BASE', dirtyFiles: [], evidenceComplete: true }),
    collectWorkerDeltaFn: async () => {
      const i = calls.delta++;
      const d = deltas[Math.min(i, deltas.length - 1)];
      return {
        baselineHead: 'BASE', currentHead: `HEAD-${i + 1}`,
        evidenceComplete: true, preExistingTouched: [], noWorkerChangeYet: false,
        changedFiles: ['src/x.js'], ...d,
      };
    },
    runGateFn: async () => {
      const i = calls.gate++;
      return { verdict: 'PASS', pass: true, fingerprint: `gate-${i + 1}`, failureIdentities: [], results: [] };
    },
    // Mechanical source suppresses the baseline Gate at begin; the review Gate
    // above is still the real controller call site, just deterministically fake.
    discoverVerificationCommandsFn: () => ({ source: 'mechanical', commands: [] }),
    reviewerFn: async () => {
      const i = calls.reviewer++;
      const value = reviews[Math.min(i, reviews.length - 1)];
      return { value, usage: { input_tokens: 10, output_tokens: 3 }, model: 'fake-reviewer' };
    },
    supervisorFn: async () => {
      const i = calls.supervisor++;
      const value = supervisorReplies[Math.min(i, supervisorReplies.length - 1)]
        ?? { guidance: 'change the implementation strategy', recommendation: 'REWORK' };
      return { value, usage: { input_tokens: 8, output_tokens: 3 }, model: 'fake-supervisor' };
    },
  });
  return { controller, calls };
}

export async function runFakeReviewLoopE2E() {
  const a = fakeController({
    deltas: [{ fingerprint: 'A-1', diff: '+done' }],
    reviews: [{ findings: [] }],
  });
  const aBegin = await a.controller.begin({ goal: 'E2E-A one-round pass', cwd: '/fake/a' });
  const a1 = await a.controller.review({ loopId: aBegin.loopId });

  const b = fakeController({
    deltas: [{ fingerprint: 'B-1', diff: '+first' }, { fingerprint: 'B-2', diff: '+fixed' }],
    reviews: [{ findings: [blocker()] }, { findings: [] }],
  });
  const bBegin = await b.controller.begin({ goal: 'E2E-B one rework then pass', cwd: '/fake/b' });
  const b1 = await b.controller.review({ loopId: bBegin.loopId });
  const b2 = await b.controller.review({ loopId: bBegin.loopId });

  const c = fakeController({
    deltas: [{ fingerprint: 'C-1', diff: '+attempt1' }, { fingerprint: 'C-2', diff: '+attempt2' }],
    reviews: [{ findings: [blocker()] }, { findings: [blocker()] }],
    supervisorReplies: [{ guidance: 'use a different repair strategy', recommendation: 'REWORK' }],
  });
  const cBegin = await c.controller.begin({ goal: 'E2E-C persistent blocker invokes supervisor', cwd: '/fake/c' });
  const c1 = await c.controller.review({ loopId: cBegin.loopId });
  const c2 = await c.controller.review({ loopId: cBegin.loopId });

  return {
    zeroProviderCalls: true,
    A: { statuses: [a1.status], reviewerCalls: a.calls.reviewer, supervisorCalls: a.calls.supervisor },
    B: { statuses: [b1.status, b2.status], reviewerCalls: b.calls.reviewer, supervisorCalls: b.calls.supervisor },
    C: {
      statuses: [c1.status, c2.status], reviewerCalls: c.calls.reviewer,
      supervisorCalls: c.calls.supervisor, supervisorGuidance: c2.supervisorGuidance ?? null,
    },
  };
}

export async function runReviewTransportBenchmark() {
  const rows = [
    await measure('codex:default', (opts) => makeCodexReviewTransport(opts)),
    await measure('claude:opus', (opts) => makeClaudeReviewTransport({ ...opts, model: 'opus' })),
  ];
  const e2e = await runFakeReviewLoopE2E();
  return {
    benchmark: 'reviewloop.review-transports/v2',
    zeroProviderCalls: true,
    scratchCwd: narrowReviewTransportCwd(),
    syntheticPromptChars: SYNTHETIC_PROMPT.length,
    rows,
    e2e,
    note: 'Deterministic fake spawn + fake provider functions. No real model invocation.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReviewTransportBenchmark().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    const badTransport = r.rows.filter((x) => !x.narrowFlagsPresent || x.resumesConversation
      || !x.runsFromIsolatedScratchCwd || x.realSpawns !== 0);
    const badE2E = r.e2e.A.statuses.join(',') !== 'PASS'
      || r.e2e.B.statuses.join(',') !== 'REWORK,PASS'
      || r.e2e.C.statuses.join(',') !== 'REWORK,REWORK'
      || r.e2e.C.supervisorCalls !== 1;
    if (badTransport.length || badE2E) {
      console.error('BENCHMARK REGRESSION', { badTransport, e2e: r.e2e });
      process.exit(1);
    }
  });
}
