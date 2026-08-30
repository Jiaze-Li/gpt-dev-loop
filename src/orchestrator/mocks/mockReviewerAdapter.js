// Mock Reviewer Adapter — docs/workflow/ADAPTER_INTERFACE.md §2:
// review(task_card, execution_report, evidence) -> review_result
// (shaped per REVIEW_RESULT.md §2).

export function createMockReviewerAdapter({ decision = 'PASS' } = {}) {
  return {
    async review(taskCard) {
      return {
        task_id: taskCard.task_id,
        repository_context: taskCard.repository_context ?? null,
        decision,
        findings: [],
        required_changes: decision === 'PASS' ? 'none' : ['mock required change'],
        rationale: `mock reviewer decision: ${decision}`,
      };
    },
  };
}
