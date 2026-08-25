// Entry point behind `bin/gpt-loop-run.js` — starts a real
// docs/workflow/ORCHESTRATOR_DESIGN.md workflow from a Task Card file on
// disk. Wires the three adapters (ADAPTER_INTERFACE.md) to their default
// concrete implementations; does not change the core Workflow Manager
// (workflowManager.js), the state machine (stateMachine.js), or the MCP/
// browser bridge.

import path from 'node:path';

import { readTaskCard } from './orchestrator/taskCard.js';
import { Persistence } from './orchestrator/persistence.js';
import { WorkflowManager } from './orchestrator/workflowManager.js';
import { STATES } from './orchestrator/stateMachine.js';
import { createClaudeExecutorAdapter } from './orchestrator/adapters/claudeExecutorAdapter.js';
import { createGptReviewerAdapter } from './orchestrator/adapters/gptReviewerAdapter.js';
import { createGateRunner } from './orchestrator/adapters/gateRunner.js';
import { createGitEvidenceCollector } from './adapters/gate/git-evidence/index.js';
import { UsageError, mapErrorToExitCode } from './bridge/errors.js';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    throw new UsageError('Usage: gpt-loop-run run <task-card-path>');
  }
  const taskCardPath = rest[0];
  if (!taskCardPath) {
    throw new UsageError('Missing task card path. Usage: gpt-loop-run run <task-card-path>');
  }
  return { command, taskCardPath };
}

// Wraps Persistence so each distinct state the workflow passes through is
// reported as it happens. writeState is the one call the Workflow Manager
// already makes on every transition (workflowManager.js's _start/
// _transition), so hooking it here observes the full PENDING -> ... ->
// terminal path without adding a notification hook to the core.
function withStateLogging(persistence, onState) {
  let lastLogged = null;
  return {
    taskDir: persistence.taskDir.bind(persistence),
    ensureTaskDir: persistence.ensureTaskDir.bind(persistence),
    readState: persistence.readState.bind(persistence),
    readEvents: persistence.readEvents.bind(persistence),
    saveArtifact: persistence.saveArtifact.bind(persistence),
    appendEvent: persistence.appendEvent.bind(persistence),
    async writeState(state) {
      if (state.current_state !== lastLogged) {
        lastLogged = state.current_state;
        onState(state.current_state);
      }
      return persistence.writeState(state);
    },
  };
}

const DEFAULT_BASE_DIR = path.join(process.cwd(), '.gpt-dev-loop', 'workflows');

export async function runWorkflow(
  taskCardPath,
  {
    baseDir = DEFAULT_BASE_DIR,
    createPersistence = (dir) => new Persistence(dir),
    createExecutorAdapter = () => createClaudeExecutorAdapter(),
    createReviewerAdapter = () => createGptReviewerAdapter(),
    createGateRunnerAdapter = () => createGateRunner({ gitEvidenceCollector: createGitEvidenceCollector() }),
    readTaskCardFn = readTaskCard,
    log = (line) => console.log(line),
  } = {}
) {
  const taskCard = await readTaskCardFn(taskCardPath);
  const persistence = withStateLogging(createPersistence(baseDir), log);

  const manager = new WorkflowManager({
    executorAdapter: createExecutorAdapter(),
    reviewerAdapter: createReviewerAdapter(),
    gateRunner: createGateRunnerAdapter(),
    persistence,
  });

  return manager.runTask(taskCard);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = mapErrorToExitCode(err);
    return;
  }

  try {
    const finalState = await runWorkflow(parsed.taskCardPath);
    console.log(`workflow_id: ${finalState.workflow_id}`);
    console.log(`final state: ${finalState.current_state}`);
    if (finalState.last_error) {
      console.log(`last_error: ${finalState.last_error}`);
    }
    process.exitCode = finalState.current_state === STATES.COMPLETE ? 0 : 1;
  } catch (err) {
    console.error(`gpt-loop-run: ${err.message}`);
    process.exitCode = mapErrorToExitCode(err);
  }
}
