import test from 'node:test';
import assert from 'node:assert/strict';

import { createGptReviewerAdapter } from '../src/orchestrator/adapters/gptReviewerAdapter.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { ResponseTimeoutError, RequestTimeoutError, ChromeUnavailableError } from '../src/bridge/errors.js';

function demoRepositoryContext(overrides = {}) {
  return {
    repository_name: 'gpt-dev-loop',
    repository_url: 'https://github.com/example/gpt-dev-loop',
    branch: 'phase1-handshake',
    commit_sha: 'abc123',
    ...overrides,
  };
}

function demoTaskCard(overrides = {}) {
  return {
    task_id: 'demo-task',
    repository_context: demoRepositoryContext(),
    goal: 'demo',
    context: 'demo',
    scope: 'demo',
    allowed_files: ['src/**'],
    forbidden_files: [],
    acceptance_criteria: ['demo works'],
    verification_commands: ['npm test'],
    completion_signal: 'DONE',
    ...overrides,
  };
}

function demoExecutionReport(overrides = {}) {
  return {
    task_id: 'demo-task',
    repository_context: demoRepositoryContext({ commit_sha: 'def456' }),
    status: 'DONE',
    changed_files: ['src/foo.js'],
    tests_run: ['npm test'],
    test_results: ['npm test: pass'],
    issues: 'none',
    next_recommendation: 'proceed',
    ...overrides,
  };
}

function demoEvidence(overrides = {}) {
  return {
    pass: true,
    results: [{ command: 'npm test', pass: true, output: '3 passing' }],
    ...overrides,
  };
}

function resultText({ taskId = 'demo-task', decision = 'PASS' } = {}) {
  return `## task_id
${taskId}

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

## decision
${decision}

## findings
- looks correct

## required_changes
${decision === 'PASS' ? 'none' : '- fix the thing'}

## rationale
meets acceptance_criteria`;
}

test('gpt reviewer adapter: parses a PASS result into review_result shape', async () => {
  let capturedPrompt;
  const askGptFn = async (prompt) => {
    capturedPrompt = prompt;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.deepEqual(result, {
    task_id: 'demo-task',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'https://github.com/example/gpt-dev-loop',
      branch: 'phase1-handshake',
      commit_sha: 'def456',
    },
    decision: 'PASS',
    findings: ['looks correct'],
    required_changes: 'none',
    rationale: 'meets acceptance_criteria',
  });

  assert.match(capturedPrompt, /## task_id\ndemo-task/);
  assert.match(capturedPrompt, /Task Card \(TASK_PROTOCOL\.md\)/);
  assert.match(capturedPrompt, /Execution Report \(EXECUTION_REPORT\.md\)/);
  assert.match(capturedPrompt, /gate results/);
  assert.match(capturedPrompt, /`npm test`: pass/);
});

test('gpt reviewer adapter: prompt includes an explicit Repository/GitHub/Branch/Commit header', async () => {
  let capturedPrompt;
  const askGptFn = async (prompt) => {
    capturedPrompt = prompt;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.match(capturedPrompt, /Repository:\ngpt-dev-loop/);
  assert.match(capturedPrompt, /GitHub:\nhttps:\/\/github\.com\/example\/gpt-dev-loop/);
  assert.match(capturedPrompt, /Branch:\nphase1-handshake/);
  assert.match(capturedPrompt, /Commit:\nabc123/);
});

test('gpt reviewer adapter: falls back to the Execution Report repository_context when the Task Card has none', async () => {
  let capturedPrompt;
  const askGptFn = async (prompt) => {
    capturedPrompt = prompt;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await adapter.review(
    demoTaskCard({ repository_context: undefined }),
    demoExecutionReport(),
    demoEvidence()
  );

  assert.match(capturedPrompt, /Commit:\ndef456/);
});

test('gpt reviewer adapter: an evidence NO_CHANGES status is passed through as fact, not an error', async () => {
  let capturedPrompt;
  const askGptFn = async (prompt) => {
    capturedPrompt = prompt;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(
    demoTaskCard(),
    demoExecutionReport(),
    demoEvidence({ status: 'NO_CHANGES', diff: '' })
  );

  assert.equal(result.decision, 'PASS');
  assert.match(capturedPrompt, /diff status\nNO_CHANGES/);
  assert.match(capturedPrompt, /\(no changes\)/);
});

test('gpt reviewer adapter: includes git diff/base-head evidence when supplied', async () => {
  let capturedPrompt;
  const askGptFn = async (prompt) => {
    capturedPrompt = prompt;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await adapter.review(
    demoTaskCard(),
    demoExecutionReport(),
    demoEvidence({ base: 'abc123', head: 'def456', diff: '+added line' })
  );

  assert.match(capturedPrompt, /base: abc123/);
  assert.match(capturedPrompt, /head: def456/);
  assert.match(capturedPrompt, /\+added line/);
});

test('gpt reviewer adapter: REWORK decision carries required_changes as a list', async () => {
  const askGptFn = async () => resultText({ decision: 'REWORK' });
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(result.decision, 'REWORK');
  assert.deepEqual(result.required_changes, ['fix the thing']);
});

test('gpt reviewer adapter: accepts HUMAN_REQUIRED decision', async () => {
  const askGptFn = async () => resultText({ decision: 'HUMAN_REQUIRED' });
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('gpt reviewer adapter: missing section throws REVIEWER_INVALID_OUTPUT', async () => {
  const askGptFn = async () => `## task_id
demo-task

## decision
PASS`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: invalid decision value throws REVIEWER_INVALID_OUTPUT', async () => {
  const askGptFn = async () => resultText({ decision: 'MAYBE' });
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: mismatched task_id throws REVIEWER_INVALID_OUTPUT', async () => {
  const askGptFn = async () => resultText({ taskId: 'other-task' });
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: unparseable output (no headings) throws REVIEWER_INVALID_OUTPUT', async () => {
  const askGptFn = async () => 'not a review result at all';
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: bridge ResponseTimeoutError maps to REVIEWER_TIMEOUT', async () => {
  const askGptFn = async () => {
    throw new ResponseTimeoutError('no response in time');
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: bridge RequestTimeoutError maps to REVIEWER_TIMEOUT', async () => {
  const askGptFn = async () => {
    throw new RequestTimeoutError('overall budget exceeded');
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_TIMEOUT);
      return true;
    }
  );
});

test('gpt reviewer adapter: bridge ChromeUnavailableError maps to REVIEWER_UNAVAILABLE', async () => {
  const askGptFn = async () => {
    throw new ChromeUnavailableError('could not launch Chrome');
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE);
      return true;
    }
  );
});

test('gpt reviewer adapter: an unexpected error still maps to REVIEWER_UNAVAILABLE', async () => {
  const askGptFn = async () => {
    throw new Error('something else broke');
  };
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_UNAVAILABLE);
      return true;
    }
  );
});

test('gpt reviewer adapter: a workflowId scopes the Chrome profile to that workflow, not the shared default', async () => {
  let capturedConfig;
  const askGptFn = async (prompt, config) => {
    capturedConfig = config;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({
    askGptFn,
    config: { profileDir: '/home/user/.gpt-dev-loop/chrome-profile' },
    workflowId: 'wf-abc123',
  });

  await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.match(capturedConfig.profileDir, /workflows[\\/]wf-abc123[\\/]chrome-profile$/);
  assert.notEqual(capturedConfig.profileDir, '/home/user/.gpt-dev-loop/chrome-profile');
});

test('gpt reviewer adapter: two different workflowIds get non-conflicting Chrome profile paths', async () => {
  const askGptFn = async () => resultText({ decision: 'PASS' });
  const sharedConfig = { profileDir: '/home/user/.gpt-dev-loop/chrome-profile' };

  let firstConfig;
  const first = createGptReviewerAdapter({
    askGptFn: async (prompt, config) => {
      firstConfig = config;
      return askGptFn();
    },
    config: sharedConfig,
    workflowId: 'wf-111',
  });
  let secondConfig;
  const second = createGptReviewerAdapter({
    askGptFn: async (prompt, config) => {
      secondConfig = config;
      return askGptFn();
    },
    config: sharedConfig,
    workflowId: 'wf-222',
  });

  await first.review(demoTaskCard(), demoExecutionReport(), demoEvidence());
  await second.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.notEqual(firstConfig.profileDir, secondConfig.profileDir);
});

test('gpt reviewer adapter: without a workflowId, falls back to the shared config profileDir unchanged', async () => {
  let capturedConfig;
  const askGptFn = async (prompt, config) => {
    capturedConfig = config;
    return resultText({ decision: 'PASS' });
  };
  const adapter = createGptReviewerAdapter({
    askGptFn,
    config: { profileDir: '/home/user/.gpt-dev-loop/chrome-profile' },
  });

  await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(capturedConfig.profileDir, '/home/user/.gpt-dev-loop/chrome-profile');
});

test('gpt reviewer adapter: with no askGptFn override, resolves the transport from config.browserMode', async () => {
  let resolvedWithConfig;
  const fakeExtensionAskGpt = async () => resultText({ decision: 'PASS' });
  const resolveAskGptFn = (config) => {
    resolvedWithConfig = config;
    return fakeExtensionAskGpt;
  };
  const adapter = createGptReviewerAdapter({
    config: { browserMode: 'extension' },
    resolveAskGptFn,
  });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(result.decision, 'PASS');
  assert.equal(resolvedWithConfig.browserMode, 'extension');
});

test('gpt reviewer adapter: an explicit askGptFn takes priority over browserMode resolution', async () => {
  let resolveAskGptFnCalled = false;
  const askGptFn = async () => resultText({ decision: 'PASS' });
  const resolveAskGptFn = () => {
    resolveAskGptFnCalled = true;
    return askGptFn;
  };
  const adapter = createGptReviewerAdapter({
    askGptFn,
    config: { browserMode: 'extension' },
    resolveAskGptFn,
  });

  await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(resolveAskGptFnCalled, false);
});
