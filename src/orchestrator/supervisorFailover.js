// Provider-neutral Supervisor failover. The workflow context supplied to
// decide() is authoritative; a fallback starts from a compact checkpoint,
// never a copied provider transcript.

const RECOVERABLE = new Set(['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT']);

export function createSupervisorHandoffCheckpoint(context = {}) {
  return {
    schema: 'supergpt.supervisor-checkpoint/v1',
    workflow_goal: context.workflowGoal ?? null,
    repository_context: context.repositoryContext ?? null,
    completed_tasks: (context.history ?? []).map(({ task_id, decision, attempts }) => ({ task_id, decision, attempts })),
    current_task: context.latestReviewResult?.task_id ?? null,
    latest_reviewer_decision: context.latestReviewResult?.decision ?? null,
    required_rework: context.latestReviewResult?.required_changes ?? [],
  };
}

export function createFailoverSupervisorSession({ providers, onEvent } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('At least one Supervisor provider is required');
  let index = 0;
  return {
    async create() { return providers[index].session.create?.() ?? {}; },
    async close() { return providers[index].session.close?.(); },
    async decide(context) {
      try {
        return await providers[index].session.decide(context);
      } catch (error) {
        const reason = error?.details?.providerFailure ?? error?.providerFailure ?? null;
        if (!RECOVERABLE.has(reason) || index + 1 >= providers.length) throw error;
        const from = providers[index];
        index += 1;
        const to = providers[index];
        onEvent?.({ type: 'SUPERVISOR_PROVIDER_FAILED', provider: from.name, reason });
        onEvent?.({ type: 'SUPERVISOR_PROVIDER_SWITCHED', from: from.name, to: to.name, checkpoint: createSupervisorHandoffCheckpoint(context) });
        return to.session.decide({ ...context, checkpoint: createSupervisorHandoffCheckpoint(context), isProviderHandoff: true });
      }
    },
    get provider() { return providers[index].name; },
  };
}
