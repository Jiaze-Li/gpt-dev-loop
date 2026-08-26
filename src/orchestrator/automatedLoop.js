// Automated orchestration loop (Issue #2, step 4) — first fully-automatic
// end-to-end wiring of the primitives already built in earlier steps:
//
//   SupervisorSession   (src/bridge/supervisorSession.js)   — one persistent
//                        ChatGPT conversation for the whole workflow
//   ReviewerSession     (src/bridge/reviewerSession.js)     — one persistent
//                        ChatGPT conversation per task, reused across every
//                        REWORK round of that task
//   ClaudeSessionManager(src/orchestrator/adapters/claudeSessionManager.js)
//                        — a brand-new Claude session for every single
//                        execute() call (initial attempt and every rework)
//   gate runner          (src/orchestrator/adapters/gateRunner.js)  — runs
//                        verification_commands and collects evidence
//
// This file does not reimplement any of the above. It only sequences them:
//
//   Supervisor.decide() -> NEXT_TASK
//     -> Claude.execute() -> gate.run() -> Reviewer.review()
//     -> Supervisor.decide() again, now carrying that Review Result
//     -> CONTINUE_REWORK  loops back to a fresh Claude.execute() on the
//                         SAME task, through the SAME ReviewerSession
//     -> NEXT_TASK/WORKFLOW_DONE/HUMAN_REQUIRED ends that task
//
// Deliberately bypasses workflowManager.js/stateMachine.js: that state
// machine drives EXECUTING/VERIFYING/REWORK/REVIEWING for one task straight
// through to a terminal state without ever consulting the Supervisor
// per-attempt. This loop's whole point is the opposite — the Supervisor is
// asked to approve (or refuse) every single rework round via
// CONTINUE_REWORK, per Issue #2's spec. Reusing workflowManager.js's
// internal auto-retry would silently drop that consultation, so this is a
// new, separate thin controller instead of a change to that file.
//
// Legal supervisor-decision / workflow-state pairing (enforced below by
// assertLegalTransition, independent of whatever parseSupervisorDecision
// already validated about the reply's own shape):
//
//   latest Review Result is REWORK/HUMAN_REQUIRED (a task is mid-flight)
//     -> only CONTINUE_REWORK or HUMAN_REQUIRED are legal
//   latest Review Result is PASS, or no task is active yet
//     -> only NEXT_TASK, WORKFLOW_DONE, or HUMAN_REQUIRED are legal
//
// A Supervisor reply that violates this is a protocol violation, not a
// signal to guess at the "right" action — it throws
// AdapterError(SUPERVISOR_ILLEGAL_TRANSITION) and the loop takes no action
// at all for that reply.

import { AdapterError, ADAPTER_ERROR_CODES } from './errors.js';

function formatReviewFeedback(reviewResult) {
  const changes = Array.isArray(reviewResult.required_changes)
    ? reviewResult.required_changes.map((change) => `- ${change}`).join('\n')
    : String(reviewResult.required_changes ?? 'none');
  return `Reviewer decision: ${reviewResult.decision}

Findings:
${reviewResult.findings ?? 'none'}

Required changes:
${changes}

Rationale:
${reviewResult.rationale ?? 'none'}`;
}

function assertLegalTransition(decision, hasPendingRework) {
  if (hasPendingRework) {
    if (decision.action !== 'CONTINUE_REWORK' && decision.action !== 'HUMAN_REQUIRED') {
      throw new AdapterError(
        ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION,
        `Supervisor returned "${decision.action}" while the current task's latest Review Result was not PASS. Only CONTINUE_REWORK or HUMAN_REQUIRED are legal here — refusing to act.`
      );
    }
  } else if (decision.action === 'CONTINUE_REWORK') {
    throw new AdapterError(
      ADAPTER_ERROR_CODES.SUPERVISOR_ILLEGAL_TRANSITION,
      'Supervisor returned CONTINUE_REWORK with no pending rework task to continue (either no task is active yet, or the latest Review Result was PASS) — refusing to act.'
    );
  }
}

// runAutomatedWorkflow drives one workflow, start to finish, without any
// human copying a prompt between GPT and Claude by hand.
//
//   workflowId               — string, threaded into ClaudeSessionManager's
//                               persistence key and this loop's history
//   supervisorSession         — a SupervisorSession-shaped object:
//                               { create(), decide(context), close() }.
//                               create() is called once at the start of
//                               this function; close() is called only on
//                               WORKFLOW_DONE.
//   createReviewerSession()   — returns a fresh ReviewerSession-shaped
//                               object: { create(taskId), review(taskId,
//                               taskCard, executionReport, evidence),
//                               close() }. Called once per task (a new task
//                               gets a new session; the same task's rework
//                               rounds reuse the one already created).
//   createClaudeSessionManager({ taskId }) — returns an Executor-Adapter-
//                               shaped object: { execute(taskCard) ->
//                               execution_report }. Called once per task;
//                               every execute() call on the object it
//                               returns is a fresh Claude session per that
//                               object's own contract.
//   gateRunner                — { run(verification_commands) -> evidence },
//                               unchanged from ADAPTER_INTERFACE.md §3.
//   persistence                — optional Persistence-shaped object
//                               ({ writeState }); when given, Reviewer
//                               feedback is written to
//                               { workflow_id, task_id, last_error } before
//                               every rework attempt so
//                               ClaudeSessionManager's own rework-prompt
//                               logic (which reads exactly that state) can
//                               fold it in. Required if any task actually
//                               goes through a rework round; omit only for
//                               workflows you're certain will PASS first
//                               try.
//   workflowGoal/repositoryContext — passed straight through to
//                               buildSupervisorPrompt via decide().
//   maxAttemptsPerTask         — bounded-retry safety guard (default 3):
//                               the maximum number of Claude execute()
//                               attempts (initial + every rework) for a
//                               single task before this loop stops itself
//                               and returns HUMAN_REQUIRED, instead of
//                               following CONTINUE_REWORK forever.
//
// Returns one of:
//   { status: 'WORKFLOW_DONE', summary, history }
//   { status: 'HUMAN_REQUIRED', reason, question, history, taskId? }
export async function runAutomatedWorkflow({
  workflowId,
  supervisorSession,
  createReviewerSession,
  createClaudeSessionManager,
  gateRunner,
  persistence,
  workflowGoal,
  repositoryContext,
  maxAttemptsPerTask = 3,
}) {
  const history = [];
  let latestReviewResult = null;
  let currentTaskCard = null;
  let reviewerSession = null;
  let claudeManager = null;
  let attemptCount = 0;

  await supervisorSession.create();

  async function closeReviewer() {
    if (reviewerSession) {
      await reviewerSession.close();
      reviewerSession = null;
    }
  }

  // Runs exactly one Claude execute() -> gate.run() -> Reviewer.review()
  // round for currentTaskCard. Returns { done: false } to let the outer
  // loop go back to the Supervisor with the fresh Review Result, or
  // { done: true, result } if the maxAttemptsPerTask guard tripped.
  async function runAttempt() {
    attemptCount += 1;
    if (attemptCount > maxAttemptsPerTask) {
      return {
        done: true,
        result: {
          status: 'HUMAN_REQUIRED',
          reason: `Task "${currentTaskCard.task_id}" reached maxAttemptsPerTask (${maxAttemptsPerTask}) without a PASS.`,
          question: 'This task has been reworked the maximum allowed number of times and still has not passed review. How should this be handled?',
          taskId: currentTaskCard.task_id,
          history,
        },
      };
    }

    const executionReport = await claudeManager.execute(currentTaskCard);
    const evidence = await gateRunner.run(currentTaskCard.verification_commands);
    const reviewResult = await reviewerSession.review(currentTaskCard.task_id, currentTaskCard, executionReport, evidence);

    if (reviewResult.decision !== 'PASS' && persistence) {
      await persistence.writeState({
        workflow_id: workflowId,
        task_id: currentTaskCard.task_id,
        last_error: formatReviewFeedback(reviewResult),
      });
    }

    latestReviewResult = reviewResult;
    if (reviewResult.decision === 'PASS') {
      history.push({ task_id: currentTaskCard.task_id, decision: 'PASS', attempts: attemptCount });
    }
    return { done: false };
  }

  for (;;) {
    const decision = await supervisorSession.decide({
      workflowGoal,
      repositoryContext,
      history,
      latestReviewResult,
    });

    const hasPendingRework = latestReviewResult !== null && latestReviewResult.decision !== 'PASS';
    assertLegalTransition(decision, hasPendingRework);

    if (decision.action === 'HUMAN_REQUIRED') {
      // Deliberately does not close either session: HUMAN_REQUIRED means
      // "stop and preserve enough state to continue later", and the whole
      // point of these being persistent conversations is that a human (or
      // a resumed run) can pick the same conversation back up.
      return { status: 'HUMAN_REQUIRED', reason: decision.reason, question: decision.question, history };
    }

    if (decision.action === 'WORKFLOW_DONE') {
      await closeReviewer();
      await supervisorSession.close();
      return { status: 'WORKFLOW_DONE', summary: decision.summary, history };
    }

    if (decision.action === 'CONTINUE_REWORK') {
      const outcome = await runAttempt();
      if (outcome.done) return outcome.result;
      continue;
    }

    // decision.action === 'NEXT_TASK'
    await closeReviewer(); // closes the PREVIOUS task's reviewer tab, if any — conversation itself is left in the account, not deleted
    currentTaskCard = decision.task_card;
    reviewerSession = createReviewerSession();
    await reviewerSession.create(currentTaskCard.task_id);
    claudeManager = createClaudeSessionManager({ taskId: currentTaskCard.task_id });
    attemptCount = 0;
    latestReviewResult = null;

    const outcome = await runAttempt();
    if (outcome.done) return outcome.result;
  }
}
