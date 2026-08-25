// Claude Session Manager — docs/design/agent-lifecycle.md §4.
//
// Wraps the Claude Executor Adapter (claudeExecutorAdapter.js) so the
// executor slot workflowManager.js calls stays a short-lived worker
// instead of one Claude conversation growing across an entire workflow.
// Exposes the same execute(task_card) -> execution_report signature as
// any other Executor Adapter (ADAPTER_INTERFACE.md §1), so it is a
// drop-in replacement wired in at orchestratorCli.js — workflowManager.js
// and stateMachine.js are untouched.
//
// Lifecycle per call to execute():
//   1. start a brand-new Claude session (a fresh executor instance/process
//      — never the previous call's)
//   2. wait for it to finish
//   3. collect its Execution Report
//
// The first call for a task is session #1 and runs the Task Card as-is.
// Every later call (a rework, after a gate failure or a GPT REWORK
// verdict) is a new session — #2, #3, ... — built from the *original*
// Task Card plus the current repository state and the feedback
// workflowManager.js already recorded as `last_error` for the previous
// attempt. It does not resume the earlier session's conversation.

import { spawn as nodeSpawn } from 'node:child_process';
import { createClaudeExecutorAdapter } from './claudeExecutorAdapter.js';

function runGit(args, { cwd, spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

async function currentRepositoryState({ cwd, spawn }) {
  const [commit, status] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], { cwd, spawn }),
    runGit(['status', '--short'], { cwd, spawn }),
  ]);
  return `commit: ${commit || 'unknown'}\nchanges:\n${status || '(clean)'}`;
}

// Folds rework feedback + repo state into the Task Card's existing
// `context` field rather than adding a new field, so the Task Card still
// matches TASK_PROTOCOL.md unmodified.
function buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState }) {
  return {
    ...taskCard,
    context: `${taskCard.context}

## Rework — Claude session #${sessionNumber}
This is a new Claude session. The previous session's conversation is not
available to you — treat this as a fresh start informed only by what
follows.

### GPT review / gate feedback from the previous attempt
${feedback}

### Current repository state
${repositoryState}`,
  };
}

export function createClaudeSessionManager({
  workflowId,
  taskId,
  persistence,
  createExecutor = createClaudeExecutorAdapter,
  cwd = process.cwd(),
  spawn = nodeSpawn,
} = {}) {
  let sessionCount = 0;

  return {
    async execute(taskCard) {
      sessionCount += 1;
      const sessionNumber = sessionCount;

      let taskCardForSession = taskCard;
      if (sessionNumber > 1) {
        const state = await persistence.readState(workflowId, taskId);
        const feedback = state?.last_error ?? 'none recorded';
        const repositoryState = await currentRepositoryState({ cwd, spawn });
        taskCardForSession = buildReworkTaskCard(taskCard, { sessionNumber, feedback, repositoryState });
      }

      // A fresh executor per call: starts a new Claude session, waits for
      // it to finish, and collects its Execution Report. Never reuses a
      // previous call's executor/process.
      const executor = createExecutor({ cwd });
      return executor.execute(taskCardForSession);
    },
  };
}
