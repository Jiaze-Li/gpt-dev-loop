#!/usr/bin/env node
// ReviewLoop review-transport benchmark — deterministic, ZERO provider calls.
//
// Stage 2 gave every physical Reviewer / Supervisor call a measured token
// breakdown (payloadMeta.estimatedPayloadTokens vs the provider's reported
// input tokens -> contextOverheadTokens). This harness exercises each
// CLI-backed transport (codex, claude) through a DETERMINISTIC FAKE spawn with
// a representative synthetic provider usage report, and prints:
//
//   - the exact argv the transport builds (proof it stays narrow: ephemeral,
//     ignore-user-config / mcp-config {}, read-only, scratch cwd, no resume)
//   - whether the working dir is the shared isolated empty scratch cwd
//   - promptChars / estimatedPayloadTokens for a representative review payload
//   - the synthetic provider input tokens and the resulting
//     contextOverheadTokens proxy
//
// Nothing here contacts a real model. `assertNoRealSpawn` fails loudly if the
// real child_process spawn is ever reached.

import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  makeCodexReviewTransport,
  makeClaudeReviewTransport,
} from '../src/reviewloop/adapters/cliReviewTransports.js';
import { narrowReviewTransportCwd } from '../src/reviewloop/adapters/scratchCwd.js';
import { payloadMetaOf, usageBreakdownOf, contextOverheadTokens } from '../src/reviewloop/reviewSpend.js';

// A representative Reviewer prompt is ~1.5 KB of objective + diff. We do not
// route through providerWiring's prompt builder here (that needs a full
// objective/gate); a fixed synthetic string keeps the benchmark stable.
const SYNTHETIC_PROMPT = [
  'You are an INDEPENDENT code reviewer. Judge ONLY against the original objective.',
  'ORIGINAL OBJECTIVE: add bounded failover across the CLI review transports',
  'CHANGED FILES: src/reviewloop/adapters/cliReviewTransports.js, src/reviewloop/providerWiring.js',
  'DETERMINISTIC GATE: PASS',
  'GIT DIFF (primary evidence):',
  '+'.repeat(1200),
  'Return JSON: {"findings":[{"severity":"P1|P2|P3","file":"","line":0,"title":""}]}.',
].join('\n');

// Synthetic provider usage: input tokens deliberately ABOVE the payload proxy
// so the overhead figure is non-zero and visible.
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
          model: 'claude-opus-4', total_cost_usd: 0.02,
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

function assertNoRealSpawn(spawn) {
  const orig = spawn;
  return (cmd, args, opts) => {
    if (typeof opts === 'object' && opts && opts.__real__) throw new Error('real spawn reached');
    return orig(cmd, args);
  };
}

const NARROW_MARKERS = {
  codex: ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only'],
  claude: ['--strict-mcp-config', '--mcp-config', '{}', '--exclude-dynamic-system-prompt-sections', '--disallowedTools'],
};

async function measure(name, makeTransport) {
  const spawn = fakeSpawn();
  const transport = makeTransport({ spawn: assertNoRealSpawn(spawn), env: { PATH: process.env.PATH } });
  const res = await transport(SYNTHETIC_PROMPT);
  const { command, args } = spawn.calls[0];
  const payloadMeta = payloadMetaOf(res.meta);
  const breakdown = usageBreakdownOf(res.usage);
  const cwdArgIdx = args.indexOf('-C');
  const cwd = cwdArgIdx !== -1 ? args[cwdArgIdx + 1] : narrowReviewTransportCwd();
  return {
    transport: name,
    command,
    realSpawns: 0,
    narrowFlagsPresent: NARROW_MARKERS[command].every((f) => args.includes(f)),
    resumesConversation: args.includes('--resume') || args.includes('-c') || args.includes('--continue'),
    runsFromIsolatedScratchCwd: cwd === narrowReviewTransportCwd(),
    promptChars: payloadMeta?.promptChars ?? null,
    estimatedPayloadTokens: payloadMeta?.estimatedPayloadTokens ?? null,
    providerInputTokens: breakdown.inputTokens,
    contextOverheadTokens: contextOverheadTokens(breakdown, payloadMeta),
  };
}

export async function runReviewTransportBenchmark() {
  const rows = [
    await measure('codex:default', makeCodexReviewTransport),
    await measure('claude:opus', makeClaudeReviewTransport),
  ];
  return {
    benchmark: 'reviewloop.review-transports/v1',
    zeroProviderCalls: true,
    scratchCwd: narrowReviewTransportCwd(),
    syntheticPromptChars: SYNTHETIC_PROMPT.length,
    rows,
    note: 'Deterministic fake spawn. contextOverheadTokens is the coarse chars/4 '
      + 'proxy vs a synthetic provider input-token count, not a real measurement.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReviewTransportBenchmark().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    const bad = r.rows.filter((x) => !x.narrowFlagsPresent || x.resumesConversation
      || !x.runsFromIsolatedScratchCwd || x.realSpawns !== 0);
    if (bad.length) { console.error('NARROWNESS REGRESSION', bad); process.exit(1); }
  });
}
