#!/usr/bin/env node
// Live 2-turn create -> resume smoke test for persistent agy conversations.
//
// NOT part of `npm test`. Makes exactly TWO tiny real requests to the model
// through the Google account already authenticated on this Mac, to prove
// src/agy/agyClient.js's `conversationId` resume path actually continues the
// SAME agy conversation turn-to-turn (which is what the persistent
// Supervisor / per-task Reviewer conversations in agyProviderSessions.js
// rely on):
//
//   turn 1  callAgy({ prompt })                 -> capture conversation_id + num_turns
//   turn 2  callAgy({ prompt, conversationId }) -> assert SAME conversation_id
//                                                  AND num_turns strictly increased
//
// A mismatch (different id, missing id, or a turn count that did not go up)
// exits non-zero — the resume must be exact or it is a failure, never a
// silently-detached second conversation.
//
// Usage:
//   node scripts/test-agy-conversations-live.js [model]
//   AGY_MODEL=gemini-3.7-flash-high node scripts/test-agy-conversations-live.js
//
// Privacy: prompt text and reply text are never printed. Only the
// executable, model, exit status, conversation id, and turn count are shown.

import { execFileSync } from 'node:child_process';
import { callAgy, DEFAULT_AGY_MODEL } from '../src/agy/agyClient.js';

// Tolerant extraction of a turn counter from whatever envelope
// `agy --output-format json` produced — the exact field name is
// version-dependent. Returns a finite number or null.
export function extractNumTurns(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.num_turns,
    json.numTurns,
    json.turn_count,
    json.turnCount,
    json.turns,
    json.conversation && json.conversation.num_turns,
    json.conversation && json.conversation.turn_count,
    Array.isArray(json.messages) ? json.messages.length : undefined,
    Array.isArray(json.history) ? json.history.length : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

// Pure verdict for the 2-turn result — exported for a deterministic unit
// test. `turn2Id` must equal `turn1Id` (exact resume) and, when both turn
// counts are known, `turn2Turns` must be strictly greater than `turn1Turns`.
export function evaluateResume({ turn1Id, turn2Id, turn1Turns, turn2Turns }) {
  const problems = [];
  if (!turn1Id) problems.push('turn 1 returned no conversation_id');
  if (!turn2Id) problems.push('turn 2 returned no conversation_id');
  if (turn1Id && turn2Id && turn1Id !== turn2Id) {
    problems.push(`conversation_id changed between turns: ${turn1Id} -> ${turn2Id}`);
  }
  if (turn1Turns !== null && turn2Turns !== null && !(turn2Turns > turn1Turns)) {
    problems.push(`num_turns did not increase: ${turn1Turns} -> ${turn2Turns}`);
  }
  return { ok: problems.length === 0, problems };
}

const PROMPT_1 =
  'Respond with ONLY a compact JSON object, no prose, no code fence: ' +
  '{"status":"PASS","turn":1}';
const PROMPT_2 =
  'Respond with ONLY a compact JSON object, no prose, no code fence: ' +
  '{"status":"PASS","turn":2}';

function detectExecutable() {
  try {
    return execFileSync('/usr/bin/which', ['agy']).toString().trim();
  } catch {
    return '(not found on PATH)';
  }
}

async function main() {
  const model =
    (typeof process.argv[2] === 'string' && process.argv[2].trim() !== '' && process.argv[2].trim()) ||
    (typeof process.env.AGY_MODEL === 'string' && process.env.AGY_MODEL.trim() !== '' && process.env.AGY_MODEL.trim()) ||
    DEFAULT_AGY_MODEL;

  console.log('executable detected :', detectExecutable());
  console.log('model              :', model);

  let turn1;
  try {
    turn1 = await callAgy({ prompt: PROMPT_1, model, timeoutMs: 120_000 });
  } catch (err) {
    console.log('turn 1             : FAILURE', err.code ?? err.name, '-', err.message);
    process.exit(err.exitCode ?? 1);
  }
  const turn1Turns = extractNumTurns(turn1.json);
  console.log('turn 1 exit        :', turn1.exitCode);
  console.log('turn 1 conversation:', turn1.conversationId ?? '(none)');
  console.log('turn 1 num_turns   :', turn1Turns ?? '(unknown)');

  if (!turn1.conversationId) {
    console.log('result             : FAILURE — turn 1 produced no conversation_id to resume');
    process.exit(1);
  }

  let turn2;
  try {
    turn2 = await callAgy({
      prompt: PROMPT_2,
      model,
      timeoutMs: 120_000,
      conversationId: turn1.conversationId,
    });
  } catch (err) {
    // AgyConversationResumeError lands here — an exact-resume failure.
    console.log('turn 2             : FAILURE', err.code ?? err.name, '-', err.message);
    process.exit(err.exitCode ?? 1);
  }
  const turn2Turns = extractNumTurns(turn2.json);
  console.log('turn 2 exit        :', turn2.exitCode);
  console.log('turn 2 conversation:', turn2.conversationId ?? '(none)');
  console.log('turn 2 num_turns   :', turn2Turns ?? '(unknown)');

  const verdict = evaluateResume({
    turn1Id: turn1.conversationId,
    turn2Id: turn2.conversationId,
    turn1Turns,
    turn2Turns,
  });

  if (verdict.ok) {
    console.log('result             : SUCCESS — same conversation_id, num_turns advanced');
    process.exit(0);
  }
  console.log('result             : FAILURE');
  for (const p of verdict.problems) console.log('  -', p);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
