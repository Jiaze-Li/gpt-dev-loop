// Mock Executor Adapter — docs/workflow/ADAPTER_INTERFACE.md §1:
// execute(task_card) -> execution_report (shaped per EXECUTION_REPORT.md §2).

export function createMockExecutorAdapter({ status = 'DONE' } = {}) {
  return {
    async execute(taskCard) {
      const verificationCommands = taskCard.verification_commands ?? [];
      return {
        task_id: taskCard.task_id,
        repository_context: taskCard.repository_context ?? null,
        status,
        changed_files: [],
        tests_run: verificationCommands,
        test_results: verificationCommands.map((command) => `${command}: pass`),
        issues: 'none',
        next_recommendation: status === 'DONE' ? 'proceed' : 'mock executor stopped',
      };
    },
  };
}
