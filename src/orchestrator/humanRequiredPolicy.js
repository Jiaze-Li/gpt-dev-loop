// Safe HUMAN_REQUIRED Recommendation Policy.
//
// Single deterministic Core-owned policy for recommended next actions and safe human
// intervention procedures.
// Invariant: A HUMAN_REQUIRED recommendation MUST NEVER advise copying, syncing,
// merging, cherry-picking, or manually delivering changes from the isolated worktree
// into the source workspace before final Reviewer/Supervisor acceptance.

export const HUMAN_REQUIRED_ACTION_CODES = Object.freeze({
  RUN_HOST_VERIFICATION: 'RUN_HOST_VERIFICATION',
  ANSWER_AND_RESUME: 'ANSWER_AND_RESUME',
  UPDATE_WORKSPACE_POLICY_AND_START_NEW_WORKFLOW: 'UPDATE_WORKSPACE_POLICY_AND_START_NEW_WORKFLOW',
  INSPECT_EVIDENCE: 'INSPECT_EVIDENCE',
  RESTART_WITH_CURRENT_RUNTIME: 'RESTART_WITH_CURRENT_RUNTIME',
  FIX_ENVIRONMENT_AND_RESUME: 'FIX_ENVIRONMENT_AND_RESUME',
  PROVIDE_GUIDANCE_AND_RESUME: 'PROVIDE_GUIDANCE_AND_RESUME',
  STOP_WORKFLOW: 'STOP_WORKFLOW',
});

// Prohibited recovery patterns that violate SuperGPT workspace isolation invariants
const FORBIDDEN_ADVICE_PATTERNS = [
  /sync.*to\s+(?:source|main|invocation)\s+workspace/i,
  /sync.*isolated\s+worktree.*into.*(?:source|main|workspace)/i,
  /copy.*(?:changes|files|implementation).*into\s+(?:source|main|invocation)\s+workspace/i,
  /cherry-pick.*into\s+(?:source|main|invocation)\s+workspace/i,
  /merge.*(?:branch|worktree).*into\s+(?:source|main|invocation)\s+workspace/i,
  /run\s+tests\s+in\s+(?:main|source|invocation)\s+workspace/i,
  /bypass\s+gate/i,
  /bypass\s+reviewer/i,
];

/**
 * Asserts that a recommendation string does not violate SuperGPT isolation / delivery invariants.
 */
export function sanitizeRecommendationText(text) {
  if (!text || typeof text !== 'string') return text;
  for (const pattern of FORBIDDEN_ADVICE_PATTERNS) {
    if (pattern.test(text)) {
      return 'Run trusted host verification with supergpt_verify, then resume the workflow.';
    }
  }
  return text;
}

/**
 * Deterministically derives the safe structured action code, recommendation message,
 * and available choices based on blocker category, root cause, and context.
 */
export function deriveSafeRecommendation({
  blockerCategory,
  blockerType,
  failingGateCommand,
  rootCause = '',
  hasStaleRuntime = false,
  isDomainAmbiguity = false,
  isExternalRootBlocker = false,
  isVerificationOrToolchainBlocker = false,
} = {}) {
  // 1. External Read Roots blocker -> recommend editing workspace policy for a NEW workflow (frozen policy)
  if (isExternalRootBlocker || blockerType === 'SYMLINK_OUTSIDE_WORKSPACE') {
    return {
      actionCode: HUMAN_REQUIRED_ACTION_CODES.UPDATE_WORKSPACE_POLICY_AND_START_NEW_WORKFLOW,
      recommendedAction: 'External read roots are frozen for active workflows. Update .supergpt/config.json and start a new workflow.',
      availableChoices: [
        'Update .supergpt/config.json for future workflows',
        'Relocate dependency into repository and resume',
        'Stop workflow',
      ],
    };
  }

  // 2. Stale runtime mismatch
  if (hasStaleRuntime) {
    return {
      actionCode: HUMAN_REQUIRED_ACTION_CODES.RESTART_WITH_CURRENT_RUNTIME,
      recommendedAction: 'Workflow started with an older SuperGPT runtime. You may inspect evidence or resume with caution.',
      availableChoices: [
        'Resume existing workflow',
        'Start fresh workflow with current SuperGPT runtime',
        'Stop workflow',
      ],
    };
  }

  // 3. Domain / Architecture / Product ambiguity -> answer and resume
  if (isDomainAmbiguity || blockerCategory === 'AMBIGUITY' || blockerCategory === 'PLANNING') {
    return {
      actionCode: HUMAN_REQUIRED_ACTION_CODES.ANSWER_AND_RESUME,
      recommendedAction: 'Provide answer / clarification to the question, then resume the workflow.',
      availableChoices: [
        'Provide clarification and resume',
        'Stop workflow',
      ],
    };
  }

  // 4. Verification / Toolchain / Permission blocker on Gate commands -> RUN_HOST_VERIFICATION
  if (
    isVerificationOrToolchainBlocker ||
    blockerCategory === 'ENVIRONMENT' ||
    blockerCategory === 'CAPABILITY' ||
    blockerCategory === 'VERIFICATION' ||
    blockerType === 'COMMAND_UNAVAILABLE' ||
    blockerType === 'COMMAND_PERMISSION' ||
    blockerType === 'TOOLCHAIN_UNAVAILABLE' ||
    /command not found|exit code 127|permission denied|EACCES|ENOENT/i.test(rootCause)
  ) {
    return {
      actionCode: HUMAN_REQUIRED_ACTION_CODES.RUN_HOST_VERIFICATION,
      recommendedAction: 'Run trusted host verification with supergpt_verify. Then resume the workflow.',
      availableChoices: [
        'Run trusted host verification (supergpt_verify) and resume',
        'Fix environment dependency on host and resume',
        'Stop workflow',
      ],
    };
  }

  // 5. Implementation / Review failure (max attempts reached)
  if (blockerCategory === 'IMPLEMENTATION' || blockerCategory === 'REVIEW') {
    return {
      actionCode: HUMAN_REQUIRED_ACTION_CODES.PROVIDE_GUIDANCE_AND_RESUME,
      recommendedAction: 'Review required changes and provide guidance for rework, then resume.',
      availableChoices: [
        'Provide design/implementation guidance and resume',
        'Modify task acceptance criteria and resume',
        'Stop workflow',
      ],
    };
  }

  // Default fallback: Inspect evidence & resume
  return {
    actionCode: HUMAN_REQUIRED_ACTION_CODES.INSPECT_EVIDENCE,
    recommendedAction: 'Inspect evidence and address the requirement, then resume.',
    availableChoices: [
      'Address the requirement and resume',
      'Stop workflow',
    ],
  };
}
