#!/usr/bin/env node
// SuperGPT CLI.
//
//   supergpt "<instruction>"            run from a natural-language goal
//   supergpt --plan=<path>              run from an existing plan file
//   supergpt "<goal>" --output-format=json|text
//   supergpt "<goal>" --cwd=<path>      invocation workspace (default: cwd)
//
// json mode streams one ndjson typed event per line to stdout, then a final
// { "type": "result", ... } line. text mode streams compact status lines.
// SIGINT / SIGTERM cancel the run cleanly via AbortSignal.

import path from 'node:path';
import { runSuperGPT } from '../src/orchestrator/supergpt.js';

function parseArgs(argv) {
  const opts = { outputFormat: 'text' };
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--plan=')) opts.planPath = arg.slice('--plan='.length);
    else if (arg.startsWith('--output-format=')) opts.outputFormat = arg.slice('--output-format='.length);
    else if (arg.startsWith('--cwd=')) opts.cwd = arg.slice('--cwd='.length);
    else if (arg.startsWith('--')) opts.unknown = arg;
    else positionals.push(arg);
  }
  opts.goal = positionals.length ? positionals.join(' ') : undefined;
  return opts;
}

const USAGE = `usage: supergpt "<instruction>" [--plan=<path>] [--output-format=json|text] [--cwd=<path>]

  SUPERVISOR_PROVIDER=agy REVIEWER_PROVIDER=agy must be set for the real run.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (opts.unknown) {
    process.stderr.write(`supergpt: unknown option ${opts.unknown}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (!opts.goal && !opts.planPath) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (!['json', 'text'].includes(opts.outputFormat)) {
    process.stderr.write(`supergpt: --output-format must be "json" or "text" (got "${opts.outputFormat}")\n`);
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  let cancelling = false;
  const onSignal = (sig) => {
    if (cancelling) process.exit(130);
    cancelling = true;
    if (opts.outputFormat === 'text') {
      process.stderr.write(`\n[supergpt] ${sig} received — cancelling (press again to force-quit)…\n`);
    }
    controller.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const result = await runSuperGPT({
    goal: opts.goal,
    planPath: opts.planPath,
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    outputFormat: opts.outputFormat,
    signal: controller.signal,
  });

  if (opts.outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify({ type: 'result', ...result })}\n`);
  } else {
    process.stdout.write(`\n[supergpt] ${result.status}\n`);
    if (result.summary) process.stdout.write(`${result.summary}\n`);
    for (const file of result.deliveredFiles ?? []) process.stdout.write(`  delivered ${file}\n`);
    if (result.reason) process.stdout.write(`reason:   ${result.reason}\n`);
    if (result.question) process.stdout.write(`question: ${result.question}\n`);
  }

  process.exitCode =
    result.status === 'WORKFLOW_DONE' ? 0 : result.status === 'CANCELLED' ? 130 : 1;
}

main().catch((err) => {
  process.stderr.write(`supergpt: ${err?.stack || err?.message || err}\n`);
  process.exitCode = 1;
});
