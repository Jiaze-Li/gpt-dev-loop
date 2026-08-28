#!/usr/bin/env node
// Live transport smoke test for the local Antigravity CLI (`agy`).
//
// NOT part of `npm test`. This makes exactly ONE tiny real request to
// Gemini through the Google account already authenticated on this Mac, to
// prove src/agy/agyClient.js can shell out and get a machine-readable
// answer back. It does not touch automatedLoop or any session/gate code.
//
// Usage:
//   node scripts/test-agy-live.js [model]
//   AGY_MODEL=gemini-3.7-flash-high node scripts/test-agy-live.js
//   (CLI arg wins over AGY_MODEL wins over the built-in default)
//
// Privacy: the prompt text and the model's reply text are never printed.
// Only the executable, model, exit status, and the normalized structured
// result are shown. No auth information is read or displayed.

import { execFileSync } from 'node:child_process';
import { callAgy, DEFAULT_AGY_MODEL } from '../src/agy/agyClient.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../src/agy/agyConfig.js';

// Testable config helper: resolve the model for exactly ONE tiny live probe.
// No shell, no side effects.
//   node scripts/test-agy-live.js                 -> AGY_MODEL or the raw default
//   node scripts/test-agy-live.js supervisor      -> the workflow Supervisor model
//   node scripts/test-agy-live.js reviewer        -> the workflow Reviewer model (GPT-OSS)
//   node scripts/test-agy-live.js <explicit-id>   -> that id verbatim
export function resolveAgyLiveConfig(env = process.env, argv = []) {
  const arg = typeof argv[0] === 'string' && argv[0].trim() !== '' ? argv[0].trim() : null;
  if (arg === 'supervisor') return { model: resolveAgySupervisorModel(env), role: 'supervisor' };
  if (arg === 'reviewer') return { model: resolveAgyReviewerModel(env), role: 'reviewer' };
  const fromEnv = typeof env.AGY_MODEL === 'string' && env.AGY_MODEL.trim() !== '' ? env.AGY_MODEL.trim() : null;
  return { model: arg || fromEnv || DEFAULT_AGY_MODEL, role: arg ? 'explicit' : 'default' };
}

// A trivial structured ask. Kept in this file only; never logged.
const PROMPT =
  'Respond with ONLY a compact JSON object, no prose, no code fence: ' +
  '{"status":"PASS","message":"AGY_OK"}';

function detectExecutable() {
  // Direct argv spawn, no shell.
  try {
    return execFileSync('/usr/bin/which', ['agy']).toString().trim();
  } catch {
    return '(not found on PATH)';
  }
}

async function main() {
  const { model, role } = resolveAgyLiveConfig(process.env, process.argv.slice(2));

  console.log('executable detected :', detectExecutable());
  console.log('role               :', role);
  console.log('model              :', model);

  try {
    const result = await callAgy({ prompt: PROMPT, model, timeoutMs: 120_000 });
    console.log('exit status        :', result.exitCode);
    console.log('duration ms        :', result.durationMs);

    let structured = result.json;
    if (typeof result.text === 'string') {
      const cleaned = result.text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try { structured = JSON.parse(cleaned); } catch { structured = { raw_text_len: result.text.length }; }
    }
    console.log('normalized result  :', JSON.stringify(structured));

    const ok = structured && structured.status === 'PASS' && structured.message === 'AGY_OK';
    console.log(ok ? '\nAGY LIVE SMOKE: PASS' : '\nAGY LIVE SMOKE: response did not match expected shape');
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.log('exit status        :', err.exitCode ?? 1);
    console.log('error              :', err.name, '-', err.code ?? 'n/a', '-', err.message);
    if (err.stderr) console.log('agy stderr         :', err.stderr);
    process.exit(err.exitCode ?? 1);
  }
}

// Only run the live request when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
