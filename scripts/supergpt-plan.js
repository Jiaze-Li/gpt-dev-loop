#!/usr/bin/env node
// Standalone planner CLI.
//
//   node scripts/supergpt-plan.js "<high-level coding instruction>"
//
//   AGY_MODEL overrides the planner model (default gemini-3.7-flash-high).
//
// Collects repository context from the current working directory, asks Gemini
// (via agy) for a bounded SuperGPT plan, and prints either the plan text or —
// when the instruction hides a real architecture/scope decision — the single
// question a human must answer first. Exit code 0 on READY, 1 on AMBIGUOUS or
// any failure. Never prints prompt or raw model output.

import { pathToFileURL } from 'node:url';

import { collectRepositoryContext, generatePlan } from '../src/orchestrator/planner.js';
import { callAgy as defaultCallAgy } from '../src/agy/agyClient.js';
import { AGY_SUPERVISOR_DEFAULT_MODEL } from '../src/agy/agyConfig.js';

export async function runPlanCli({
  argv = [],
  cwd = process.cwd(),
  env = process.env,
  callAgy = defaultCallAgy,
  collect = collectRepositoryContext,
  generate = generatePlan,
  write = (s) => console.log(s),
  writeErr = (s) => console.error(s),
} = {}) {
  const userIntent = argv.join(' ').trim();
  if (userIntent === '') {
    writeErr('usage: node scripts/supergpt-plan.js "<high-level coding instruction>"');
    return 1;
  }

  const repoContext = await collect({ cwd });
  const model = (typeof env.AGY_MODEL === 'string' && env.AGY_MODEL.trim() !== '')
    ? env.AGY_MODEL.trim()
    : AGY_SUPERVISOR_DEFAULT_MODEL;

  let result;
  try {
    result = await generate({ userIntent, repoContext, callAgy, model });
  } catch (err) {
    writeErr(`supergpt-plan: FAILED (${err.code ?? err.name}) — ${err.message}`);
    return 1;
  }

  if (result.status === 'AMBIGUOUS') {
    write('AMBIGUOUS — a human decision is needed before planning can continue:');
    write(result.question);
    return 1;
  }

  write(result.planText);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runPlanCli({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`supergpt-plan: ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}
