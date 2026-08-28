#!/usr/bin/env node
// Tiny, non-auto-run live probe for Supervisor NEXT_TASK structural
// diagnostics (not part of `npm test`). Asks a real Supervisor conversation
// for exactly one NEXT_TASK decision, using the same workflowGoal/
// repositoryContext shape as scripts/test-automated-loop-live.js, then
// prints ONLY:
//   - on a NEXT_TASK parse failure, the structural diagnostic
//     supervisorProtocol.js's parseNextTask already folds into the thrown
//     AdapterError's message (marker names, missing/duplicate marker
//     names, reply length; never field content)
//   - on a transport-level failure (e.g. RESPONSE_TIMEOUT from
//     domActions.js's waitForReply), the fixed, content-free TransportError
//     message (see src/bridge/errors.js) — never the raw reply
//   - the parsed decision's action, if parsing succeeded
//
// Never prints the raw reply, the workflow goal, repository context, or any
// Task Card field value. Does not loop, retry, or drive any task to
// completion — it exists purely to see the exact wire shape a real
// Supervisor reply has, for diagnosing malformed-output failures like a
// missing "@@ repository_context" section, or transport failures like a
// stalled RESPONSE_TIMEOUT.
//
// Usage:
//   GPT_BROWSER_MODE=extension node scripts/test-supervisor-next-task-diagnostics-live.js
//   GPT_BROWSER_MODE=extension node scripts/test-supervisor-next-task-diagnostics-live.js --keep-open-on-failure
//
// --keep-open-on-failure: on a NEXT_TASK parse failure OR any
// TransportError (including RESPONSE_TIMEOUT), skip closing the Supervisor
// tab and this process's extension server, and keep this process alive
// (Ctrl+C to exit) — so the tab can be inspected by hand (its own devtools
// console, opened on the chatgpt.com tab itself, carries the
// completion-provenance diagnostics logged by domActions.js's waitForReply)
// while watching whether the visible ChatGPT reply keeps growing after Node
// already gave up on it. No effect on success.

import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { SupervisorSession } from '../src/bridge/supervisorSession.js';
import { closeExtensionServer } from '../src/bridge/extensionServer.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { TransportError } from '../src/bridge/errors.js';

const REPO_ROOT = process.cwd();

const WORKFLOW_GOAL = `Complete exactly two independent tasks, one at a time, each its own Task Card:

Task 1: create the file work/auto-a.txt with EXACTLY this content (no trailing text, a single trailing newline is fine):
auto-a-ok

Task 2: create the file work/auto-b.txt with EXACTLY this content (no trailing text, a single trailing newline is fine):
auto-b-ok

Each task's acceptance_criteria must require the exact file content above. Each task's verification_commands must include a shell command that fails if the content is wrong, e.g.:
  test "$(cat work/auto-a.txt)" = "auto-a-ok"
Do not scope any other files. Once both files exist with the exact required content and their verification_commands pass, the workflow is done.`;

// Classifies a decide() failure as "keepable" — one --keep-open-on-failure
// should preserve the tab for — vs. one that should propagate and crash the
// process as before. Exported (and covered directly by
// tests/testSupervisorNextTaskDiagnosticsLive.test.js) so this decision can
// be verified deterministically without driving a real ChatGPT tab.
export function classifyDecideFailure(err) {
  if (err instanceof AdapterError && err.code === ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT) {
    return { keepable: true, message: err.message };
  }
  // TransportError covers RESPONSE_TIMEOUT (ResponseTimeoutError) and every
  // other transport-level failure (ChromeUnavailableError,
  // SelectorMismatchError, etc.) — --keep-open-on-failure exists precisely
  // to inspect the live tab after one of these, not just after a NEXT_TASK
  // parse failure. err.message on every TransportError subclass is a fixed,
  // content-free diagnostic string (see src/bridge/errors.js) — never the
  // raw reply.
  if (err instanceof TransportError) {
    return { keepable: true, message: err.message };
  }
  return { keepable: false, message: null };
}

async function currentRepositoryContext() {
  return {
    repository_name: path.basename(REPO_ROOT),
    repository_url: null,
    branch: 'phase1-handshake',
    commit_sha: 'unknown',
  };
}

async function main() {
  const config = loadConfig();
  if (config.browserMode !== 'extension') {
    console.error(`This script requires GPT_BROWSER_MODE=extension (current: "${config.browserMode}").`);
    process.exitCode = 1;
    return;
  }

  const keepOpenOnFailure = process.argv.includes('--keep-open-on-failure');
  let keepOpen = false;

  const supervisorSession = new SupervisorSession(config);
  try {
    await supervisorSession.create();

    let decision;
    try {
      decision = await supervisorSession.decide({
        workflowGoal: WORKFLOW_GOAL,
        repositoryContext: await currentRepositoryContext(),
      });
    } catch (err) {
      const classified = classifyDecideFailure(err);
      if (classified.keepable) {
        // The structural diagnostic is already folded into err.message by
        // supervisorProtocol.js's parseNextTask (parse failures) or is the
        // fixed TransportError message (transport failures) — print only
        // that, never the raw reply this error may also be carrying in
        // other fields.
        console.log(classified.message);
        process.exitCode = 1;
        if (keepOpenOnFailure) {
          keepOpen = true;
          console.log(
            '--keep-open-on-failure: leaving the Supervisor tab and extension server open for manual ' +
              'inspection. This process will not exit on its own — Ctrl+C when done.'
          );
        }
        return;
      }
      throw err;
    }

    console.log(`parsed action=${decision.action}`);
    if (decision.action === 'NEXT_TASK') {
      // Re-derive the diagnostic from the parsed task_id/goal-free shape
      // for a clean success-path print (parse already succeeded, so this
      // is just for visibility, not validation).
      console.log('supervisor reply parsed successfully — full structural diagnostic not needed.');
    }
  } finally {
    if (!keepOpen) {
      await supervisorSession.close().catch(() => {});
      await closeExtensionServer().catch(() => {});
    }
  }
}

// Only auto-run when executed directly (`node scripts/....js`), not when
// imported — tests import classifyDecideFailure without wanting main() (a
// real Chrome/ChatGPT session) to run.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`gpt-loop-live: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
