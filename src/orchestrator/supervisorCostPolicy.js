// Deterministic physical-session and effort policy for Supervisor calls.
// Workflow truth stays with the orchestrator, never a provider transcript.
export const SUPERVISOR_SESSION_STRATEGIES = Object.freeze({ CHECKPOINT_FRESH: 'CHECKPOINT_FRESH', BOUNDED_STICKY: 'BOUNDED_STICKY' });

export function supervisorSessionStrategy(family) {
  return family === 'agy:gemini' ? SUPERVISOR_SESSION_STRATEGIES.CHECKPOINT_FRESH : SUPERVISOR_SESSION_STRATEGIES.BOUNDED_STICKY;
}

export function supervisorDecisionEffort(context = {}, { priorSemanticFailures = 0 } = {}) {
  const review = context.latestReviewResult?.decision;
  const cycles = Number(context.reworkCycles ?? context.signals?.reworkCycles ?? 0);
  if (priorSemanticFailures >= 2 || cycles >= 2 || context.contradictoryEvidence || context.likelyHumanRequired || context.deliveryAmbiguity || context.workspaceAmbiguity) return 'high';
  if (priorSemanticFailures === 1) return 'medium';
  if ((review && review !== 'PASS') || context.multipleLegitimateOptions || context.workflowAmbiguity) return 'medium';
  return 'low';
}

export function serializedSize(value) { try { return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8'); } catch { return null; } }
