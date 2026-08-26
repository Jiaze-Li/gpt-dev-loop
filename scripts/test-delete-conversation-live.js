#!/usr/bin/env node
// Live E2E validation for the deleteConversation primitive
// (src/bridge/chatgptExtension.js), added 2026-08-26. Not part of
// `npm test` — this needs your real, already-logged-in Chrome with the
// gpt-dev-loop extension loaded and connected to the local bridge server
// (see extension/README.md), and it creates and deletes real conversations
// in your real ChatGPT account. Run it deliberately, not automatically.
//
// For each iteration this does exactly what
// docs/handoff/... (issue #1 follow-up) asked to be validated:
//   create a fresh conversation -> capture its identity (/c/<id>) ->
//   delete it -> confirm it is gone.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-delete-conversation-live.js [iterations]
// (iterations defaults to 2; the task asked for 2-3 consecutive runs so a
// pass isn't just luck)
//
// Only stage names and the captured conversation id are logged — never the
// test prompt or any reply text (same policy as extension/content.js).

import { loadConfig } from '../src/config.js';
import { askGptWithIdentity, deleteConversation } from '../src/bridge/chatgptExtension.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';

const TEST_PROMPT = 'Reply exactly DELETE_PRIMITIVE_LIVE_TEST_OK';
const ITERATIONS = Number.parseInt(process.argv[2], 10) || 2;

function stage(iteration, name) {
  console.log(`[iteration ${iteration}] ${name} at +${Date.now() - startedAt}ms`);
}

let startedAt;

async function runIteration(config, iteration) {
  startedAt = Date.now();
  console.log(`\n--- iteration ${iteration}/${ITERATIONS} ---`);

  stage(iteration, 'requesting fresh conversation + test message');
  const { conversationId, identityDiagnostics } = await askGptWithIdentity(TEST_PROMPT, config);
  if (!conversationId) {
    const diag = identityDiagnostics ? ` diagnostics: ${JSON.stringify(identityDiagnostics)}` : '';
    throw new Error(
      `no conversation identity was captured (URL never picked up a /c/<id> segment) — cannot safely delete anything; refusing to guess.${diag}`
    );
  }
  stage(iteration, `identity captured (${conversationId})`);

  await deleteConversation(conversationId, config);
  stage(iteration, `delete confirmed (${conversationId})`);

  return conversationId;
}

async function main() {
  const config = { ...loadConfig(), browserMode: 'extension' };
  const results = [];

  for (let i = 1; i <= ITERATIONS; i += 1) {
    try {
      const conversationId = await runIteration(config, i);
      results.push({ iteration: i, ok: true, conversationId });
    } catch (err) {
      results.push({ iteration: i, ok: false, error: err.message });
      console.log(`[iteration ${i}] FAILED: ${err.message}`);
    }
  }

  await closeExtensionServer().catch(() => {});

  console.log('\n--- summary ---');
  for (const r of results) {
    console.log(r.ok ? `iteration ${r.iteration}: PASS (${r.conversationId})` : `iteration ${r.iteration}: FAIL — ${r.error}`);
  }

  const allPassed = results.every((r) => r.ok);
  console.log(allPassed ? `\nPASS: all ${ITERATIONS} iteration(s) created, identified, and confirmed-deleted a conversation.` : '\nFAIL: see failures above.');
  process.exitCode = allPassed ? 0 : 1;
}

main().catch(async (err) => {
  console.log(`FAIL: unexpected error: ${err.message}`);
  await closeExtensionServer().catch(() => {});
  process.exitCode = 1;
});
