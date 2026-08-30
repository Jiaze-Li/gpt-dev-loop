// Implements docs/workflow/ORCHESTRATOR_DESIGN.md's Workflow Manager +
// State Update components, driving one Task Card through
// docs/workflow/STATE_MACHINE.md.
//
// This core speaks only the three adapter signatures from
// docs/workflow/ADAPTER_INTERFACE.md §4 — it must not know which concrete
// executor/reviewer/gate implementation it was given.

import { randomUUID } from 'node:crypto';
import { STATES, STATE_OWNERS, nextState, isTerminal } from './stateMachine.js';

export class WorkflowManager {
  constructor({ executorAdapter, reviewerAdapter, gateRunner, persistence, maxAttempts = 3 }) {
    this.executorAdapter = executorAdapter;
    this.reviewerAdapter = reviewerAdapter;
    this.gateRunner = gateRunner;
    this.persistence = persistence;
    this.maxAttempts = maxAttempts;
  }

  // ORCHESTRATOR_DESIGN.md §1 "Creating a workflow" / PERSISTENCE.md §1
  // `workflow_id`.
  createWorkflowId() {
    return `wf-${randomUUID()}`;
  }

  // Drives one Task Card (TASK_PROTOCOL.md) through the full state machine
  // to a terminal state (COMPLETE / HUMAN_REQUIRED / ABORTED).
  async runTask(taskCard, { workflowId } = {}) {
    const workflow_id = workflowId ?? this.createWorkflowId();
    const state = this._initState(workflow_id, taskCard.task_id);

    await this._start(state);
    await this._saveArtifact(state, 'task_card.json', taskCard);
    await this._transition(state, 'task_card_generated', 'shell');

    let executionReport;
    let evidence;

    while (!isTerminal(state.current_state)) {
      switch (state.current_state) {
        case STATES.EXECUTING: {
          executionReport = await this.executorAdapter.execute(taskCard);
          await this._saveArtifact(state, `execution_report_${state.attempt_count}.json`, executionReport);

          if (executionReport.status === 'DONE') {
            await this._transition(state, 'executor_reports_done', 'claude');
          } else if (executionReport.status === 'BLOCKED') {
            await this._transition(state, 'executor_reports_blocked', 'claude');
          } else if (executionReport.status === 'HUMAN_REQUIRED') {
            state.last_error = 'executor reported HUMAN_REQUIRED';
            await this._transition(state, 'executor_reports_human_required', 'claude');
          } else {
            throw new Error(`Invalid execution report status: ${executionReport.status}`);
          }
          break;
        }

        case STATES.VERIFYING: {
          evidence = await this.gateRunner.run(taskCard.verification_commands);
          await this._saveArtifact(state, `test_results_${state.attempt_count}.json`, evidence);

          if (evidence.pass) {
            await this._transition(state, 'verification_passed', 'shell');
          } else {
            state.last_error = 'verification failed';
            await this._transition(state, 'verification_failed', 'shell');
          }
          break;
        }

        case STATES.REWORK: {
          if (state.attempt_count >= this.maxAttempts) {
            state.last_error = `retry limit exceeded (${this.maxAttempts})`;
            await this._transition(state, 'retry_limit_exceeded', 'shell');
          } else {
            state.attempt_count += 1;
            await this._transition(state, 'carry_forward', 'shell');
          }
          break;
        }

        case STATES.REVIEWING: {
          const reviewResult = await this.reviewerAdapter.review(taskCard, executionReport, evidence);
          await this._saveArtifact(state, `review_result_${state.attempt_count}.json`, reviewResult);

          if (reviewResult.decision === 'PASS') {
            await this._transition(state, 'review_pass', 'gpt');
          } else if (reviewResult.decision === 'REWORK') {
            // STATE_MACHINE.md §2: REVIEWING's REWORK verdict transitions
            // straight to EXECUTING (unlike a gate failure, which passes
            // through the REWORK state) — so the retry-count/limit check
            // that the REWORK case below applies must also run here.
            state.last_error = JSON.stringify(reviewResult.required_changes);
            if (state.attempt_count >= this.maxAttempts) {
              state.last_error = `retry limit exceeded (${this.maxAttempts})`;
              await this._transition(state, 'retry_limit_exceeded', 'shell');
            } else {
              state.attempt_count += 1;
              await this._transition(state, 'review_rework', 'gpt');
            }
          } else if (reviewResult.decision === 'HUMAN_REQUIRED') {
            state.last_error = reviewResult.rationale;
            await this._transition(state, 'review_human_required', 'gpt');
          } else {
            throw new Error(`Invalid review decision: ${reviewResult.decision}`);
          }
          break;
        }

        default:
          throw new Error(`Unhandled state: ${state.current_state}`);
      }
    }

    return state;
  }

  // PERSISTENCE.md §1 state.json shape.
  _initState(workflow_id, task_id) {
    const now = new Date().toISOString();
    return {
      workflow_id,
      task_id,
      current_state: null,
      created_at: now,
      updated_at: now,
      attempt_count: 0,
      current_executor: null,
      artifacts: [],
      last_error: null,
    };
  }

  // Entry into PENDING is workflow creation, not a transition from another
  // state, so it bypasses stateMachine.nextState.
  async _start(state) {
    state.current_state = STATES.PENDING;
    state.current_executor = STATE_OWNERS.PENDING;
    state.updated_at = state.created_at;
    await this.persistence.writeState(state);
    await this.persistence.appendEvent({
      workflow_id: state.workflow_id,
      task_id: state.task_id,
      timestamp: state.updated_at,
      previous_state: null,
      new_state: STATES.PENDING,
      trigger: 'workflow_created',
      actor: 'shell',
    });
  }

  async _transition(state, trigger, actor) {
    const previous = state.current_state;
    const newState = nextState(previous, trigger);
    state.current_state = newState;
    state.current_executor = STATE_OWNERS[newState];
    state.updated_at = new Date().toISOString();
    await this.persistence.writeState(state);
    await this.persistence.appendEvent({
      workflow_id: state.workflow_id,
      task_id: state.task_id,
      timestamp: state.updated_at,
      previous_state: previous,
      new_state: newState,
      trigger,
      actor,
    });
    return newState;
  }

  // PERSISTENCE.md §1 `artifacts` — appended, never overwritten.
  async _saveArtifact(state, name, content) {
    const filePath = await this.persistence.saveArtifact(state.workflow_id, state.task_id, name, content);
    state.artifacts.push(filePath);
    await this.persistence.writeState(state);
    return filePath;
  }
}
