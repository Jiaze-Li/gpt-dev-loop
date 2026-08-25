// Entry point behind `bin/gpt-loop-run.js` — starts a real
// docs/workflow/ORCHESTRATOR_DESIGN.md workflow from a Task Card file on
// disk. Wires the three adapters (ADAPTER_INTERFACE.md) to their default
// concrete implementations; does not change the core Workflow Manager
// (workflowManager.js), the state machine (stateMachine.js), or the MCP/
// browser bridge.

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readTaskCard } from './orchestrator/taskCard.js';
import { Persistence } from './orchestrator/persistence.js';
import { WorkflowManager } from './orchestrator/workflowManager.js';
import { STATES } from './orchestrator/stateMachine.js';
import { createClaudeExecutorAdapter } from './orchestrator/adapters/claudeExecutorAdapter.js';
import { createGptReviewerAdapter } from './orchestrator/adapters/gptReviewerAdapter.js';
import { createGateRunner } from './orchestrator/adapters/gateRunner.js';
import { createGitEvidenceCollector } from './adapters/gate/git-evidence/index.js';
import { UsageError, mapErrorToExitCode } from './bridge/errors.js';
import { loadConfig, workflowProfileDir } from './config.js';
import { cleanupWorkflowChromeProfile } from './bridge/chromeProfile.js';

// Same `wf-<uuid>` shape as WorkflowManager.createWorkflowId
// (workflowManager.js) — generated here, not by the core, because the
// reviewer adapter needs the workflow_id *before* runTask() starts in
// order to give it a workflow-scoped Chrome profile (see
// createReviewerAdapter's default below).
function createWorkflowId() {
  return `wf-${randomUUID()}`;
}

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
    createReviewerAdapter = ({ workflowId }) => createGptReviewerAdapter({ workflowId }),
    createGateRunnerAdapter = () => createGateRunner({ gitEvidenceCollector: createGitEvidenceCollector() }),
    readTaskCardFn = readTaskCard,
    log = (line) => console.log(line),
    cleanupChromeProfile = cleanupWorkflowChromeProfile,
  } = {}
) {
  const taskCard = await readTaskCardFn(taskCardPath);
  const persistence = withStateLogging(createPersistence(baseDir), log);
  const workflowId = createWorkflowId();

  const manager = new WorkflowManager({
    executorAdapter: createExecutorAdapter(),
    reviewerAdapter: createReviewerAdapter({ workflowId }),
    gateRunner: createGateRunnerAdapter(),
    persistence,
  });

  const finalState = await manager.runTask(taskCard, { workflowId });

  // Review result + all other artifacts (PERSISTENCE.md) already saved by
  // the core under baseDir, untouched by any of this. Only the throwaway
  // Chrome profile is handled here. Uses console.error directly (not the
  // `log` callback above, which is reserved for state-transition reporting
  // — see withStateLogging) so this doesn't interleave with that output.
  if (finalState.current_state === STATES.HUMAN_REQUIRED) {
    const profileDir = workflowProfileDir(workflowId, loadConfig().profileDir);
    console.error(
      `gpt-loop-run: manual recovery may be needed (login/Cloudflare) — this workflow's Chrome profile is kept at ${profileDir}`
    );
  } else {
    await cleanupChromeProfile(workflowId, loadConfig().profileDir).catch((err) => {
      console.error(`gpt-loop-run: could not clean up chrome profile for ${workflowId}: ${err.message}`);
    });
  }

  return finalState;
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
