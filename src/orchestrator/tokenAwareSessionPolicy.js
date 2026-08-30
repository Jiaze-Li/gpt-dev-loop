// Local-only physical session decisions. No token values are invented.
export class TokenAwareSessionPolicy {
  constructor({ maxPhysicalCalls = 12, maxInputGrowthRatio = 1.75, maxConsecutiveGrowth = 3, maxLatencyGrowthRatio = 2, contextUtilizationThreshold = 0.8 } = {}) {
    Object.assign(this, { maxPhysicalCalls, maxInputGrowthRatio, maxConsecutiveGrowth, maxLatencyGrowthRatio, contextUtilizationThreshold });
  }
  initial() { return { generation: 1, physicalCallCount: 0, totalNativeInput: 0, previousInput: null, growthStreak: 0, previousLatency: null, latencyStreak: 0, cacheEffectiveness: null }; }
  observe(session, telemetry = {}) {
    const next = { ...session, physicalCallCount: session.physicalCallCount + 1 };
    const input = Number.isFinite(telemetry.inputTokens) ? telemetry.inputTokens : null;
    if (input !== null) { next.totalNativeInput += input; next.growthStreak = session.previousInput && input / session.previousInput >= this.maxInputGrowthRatio ? session.growthStreak + 1 : 0; next.previousInput = input; }
    const latency = Number.isFinite(telemetry.latencyMs) ? telemetry.latencyMs : null;
    if (latency !== null) { next.latencyStreak = session.previousLatency && latency / session.previousLatency >= this.maxLatencyGrowthRatio ? session.latencyStreak + 1 : 0; next.previousLatency = latency; }
    if (Number.isFinite(telemetry.cacheReadTokens) && input) next.cacheEffectiveness = telemetry.cacheReadTokens / input;
    return next;
  }
  rotationReason(session, telemetry = {}) {
    if (telemetry.protocolInstability || telemetry.providerCompaction) return telemetry.protocolInstability ? 'protocol_instability' : 'provider_compaction';
    if (Number.isFinite(telemetry.contextUtilization) && telemetry.contextUtilization >= this.contextUtilizationThreshold) return 'context_cost_pressure';
    if (session.physicalCallCount >= this.maxPhysicalCalls) return 'physical_call_safety_ceiling';
    if (session.growthStreak >= this.maxConsecutiveGrowth) return 'uncached_input_growth';
    if (session.latencyStreak >= this.maxConsecutiveGrowth) return 'latency_context_degradation';
    return null;
  }
  rotate(session) { return { ...this.initial(), generation: session.generation + 1 }; }
}

export function createSupervisorCheckpoint(context = {}) {
  const completedTasks = (context.history ?? []).map(({ task_id, decision, attempts }) => ({ task_id, decision, attempts }));
  const required = context.latestReviewResult?.required_changes ?? [];
  const currentTask = context.currentTask ?? context.latestReviewResult?.task_id ?? null;
  // snake_case compatibility fields keep existing providers protocol-stable.
  return { schema: 'supergpt.supervisor-checkpoint/v1', workflowGoal: context.workflowGoal ?? null, canonicalRequest: context.canonicalRequest ?? null, planSummary: context.planSummary ?? null, completedTasks, currentTask, attempt: context.attempt ?? null, latestGateResult: context.latestGateResult ?? null, latestReviewerDecision: context.latestReviewResult?.decision ?? null, latestRequiredChanges: required, remainingTasks: context.remainingTasks ?? [], constraints: context.constraints ?? null, decisions: context.workflowDecisions ?? [], overall_goal: context.workflowGoal ?? 'unknown', completed_tasks: completedTasks.map(({ task_id, decision, attempts }) => ({ task_id, status: decision || 'PASS', attempts: attempts || 1 })), current_task: context.latestReviewResult && context.latestReviewResult.decision !== 'PASS' ? { status: 'REWORK', task_id: currentTask, required_changes: required } : null, unresolved_decisions: 'none', workflow_invariants: { single_task_at_a_time: true, isolated_workspace: true } };
}
