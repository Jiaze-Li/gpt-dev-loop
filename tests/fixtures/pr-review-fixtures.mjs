// Raw provider review payloads (Codex / Claude / internal) used to exercise the
// unified normalized review parser at the PR Closeout provider boundary.

export const codexCleanReview = {
  provider: 'codex',
  reviewer: 'codex',
  id: 'codex-rev-1',
  head_sha: 'sha-1',
  findings: [],
};

export const codexActionableReview = {
  provider: 'codex',
  reviewer: 'codex',
  id: 'codex-rev-2',
  head_sha: 'sha-1',
  findings: [
    { severity: 'P1', file: 'src/a.js', line: 12, title: 'off-by-one', description: 'loop overruns the buffer' },
    { severity: 'nit', file: 'src/a.js', title: 'rename var' },
  ],
};

export const claudeActionableReview = {
  provider: 'claude',
  reviewer: 'claude',
  review_id: 900,
  headSha: 'sha-1',
  review: {
    findings: [
      { level: 'blocker', path: 'src/b.js', lineNumber: 3, message: 'null deref' },
      { level: 'P3', path: 'src/b.js', message: 'style' },
    ],
  },
};

export const internalNonBlockingReview = {
  provider: 'internal',
  reviewer: 'internal',
  headSha: 'sha-1',
  issues: [
    { severity: 'P3', file: 'src/c.js', message: 'doc typo' },
    { severity: 'suggestion', file: 'src/c.js', message: 'extract helper' },
  ],
};

export const codexProviderErrorReview = {
  provider: 'codex',
  reviewer: 'codex',
  ok: false,
  failure: 'model provider timed out',
};

export const malformedReview = 'not-an-object';

export const noFindingsChannelReview = {
  provider: 'claude',
  reviewer: 'claude',
  headSha: 'sha-1',
  summary: 'looks good to me',
};
