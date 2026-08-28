// Explicit Supervisor / Reviewer provider selection for the MVP agy
// workflow entry point (scripts/run-agy-workflow.js).
//
//   SUPERVISOR_PROVIDER=agy   REVIEWER_PROVIDER=agy
//
// Only the all-agy combination is wired here. The existing Chrome/web
// Supervisor + Reviewer path is untouched and still reachable through
// scripts/test-automated-loop-live.js — it is simply never selected from
// this entry point, satisfying "existing providers remain available but
// must not be used when agy is selected" and "no Chrome tab when both
// providers are agy" (nullWindowSession opens nothing).

import { createAgySupervisorProvider } from './adapters/agySupervisorProvider.js';
import { createAgyReviewerProvider } from './adapters/agyReviewerProvider.js';
import {
  createAgySupervisorSession,
  createAgyReviewerSessionFactory,
  createAgyProviderSessionStore,
  nullWindowSession,
} from './agyProviderSessions.js';
import { resolveAgySupervisorModel, resolveAgyReviewerModel } from '../agy/agyConfig.js';

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Returns { supervisorModel, reviewerModel, supervisorSession,
// createReviewerSession, windowSession } ready to hand to
// runAutomatedWorkflow. The Supervisor and Reviewer each get ONLY their own
// resolved model — the Claude executor is never handed either. Throws (fail
// closed) if either provider env var is not exactly "agy".
export function selectProviders({
  env = process.env,
  callAgy,
  timeoutMs,
  jsonSchema,
  persistence,
  workflowId,
} = {}) {
  const supervisor = normalize(env.SUPERVISOR_PROVIDER);
  const reviewer = normalize(env.REVIEWER_PROVIDER);

  if (supervisor !== 'agy' || reviewer !== 'agy') {
    throw new Error(
      'run-agy-workflow requires SUPERVISOR_PROVIDER=agy and REVIEWER_PROVIDER=agy ' +
        `(got supervisor="${env.SUPERVISOR_PROVIDER ?? 'unset'}", reviewer="${env.REVIEWER_PROVIDER ?? 'unset'}"). ` +
        'The Chrome/web providers remain available via scripts/test-automated-loop-live.js.'
    );
  }

  const supervisorModel = resolveAgySupervisorModel(env);
  const reviewerModel = resolveAgyReviewerModel(env);
  const supervisorProvider = createAgySupervisorProvider({
    callAgy,
    model: supervisorModel,
    timeoutMs,
    jsonSchema,
  });
  const reviewerProvider = createAgyReviewerProvider({
    callAgy,
    model: reviewerModel,
    timeoutMs,
    jsonSchema,
  });

  // One shared persistent-conversation store for this workflow: the
  // Supervisor session and every per-task Reviewer session created below
  // read/write the same map, persisted to workflow state when a
  // `persistence` + `workflowId` pair is supplied.
  const sessionStore = createAgyProviderSessionStore({ persistence, workflowId });

  return {
    supervisorModel,
    reviewerModel,
    supervisorSession: createAgySupervisorSession(supervisorProvider, { store: sessionStore }),
    createReviewerSession: createAgyReviewerSessionFactory(reviewerProvider, { store: sessionStore }),
    windowSession: nullWindowSession,
    sessionStore,
  };
}
