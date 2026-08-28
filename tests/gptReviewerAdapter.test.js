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
  return `@@ task_id
${taskId}

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

@@ decision
${decision}

@@ findings
- looks correct

@@ required_changes
${decision === 'PASS' ? 'none' : '- fix the thing'}

@@ rationale
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

  assert.match(capturedPrompt, /@@ task_id\ndemo-task/);
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
  const askGptFn = async () => `@@ task_id
demo-task

@@ decision
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

// Live evidence (2026-08-27): a real ReviewerSession.review() round trip
// came back with "reviewer output is missing the repository_context
// section" even though GPT's reply plainly discussed it — because the
// reply crosses through ChatGPT's rendered DOM (extension/domActions.js
// reads .innerText, not raw markdown source) and a literal "## field_name"
// heading does not survive that rendering (see parseReviewResult's own doc
// comment). This is the exact regression that motivated switching the wire
// format to "@@ field_name" markers.
test('gpt reviewer adapter: missing "@@ repository_context" specifically is rejected', async () => {
  const askGptFn = async () => `@@ task_id
demo-task

@@ decision
PASS

@@ findings
- looks correct

@@ required_changes
none

@@ rationale
meets acceptance_criteria`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      assert.match(err.message, /repository_context/);
      return true;
    }
  );
});

// Markdown "## field_name" headings must never be treated as an acceptable
// primary wire contract, even when every field is otherwise present in the
// right order — only "@@ field_name" markers are read.
test('gpt reviewer adapter: Markdown-only "## field_name" headings are rejected, not silently accepted', async () => {
  const askGptFn = async () => `## task_id
demo-task

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

## decision
PASS

## findings
- looks correct

## required_changes
none

## rationale
meets acceptance_criteria`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      return true;
    }
  );
});

// Simulates exactly what crosses the ChatGPT rendered-DOM boundary: no
// blank line before the marker's own content is guaranteed to be preserved
// oddly by rendering in every case, but the "@@ field_name" marker text
// itself must survive untouched (unlike "##", which the browser turns into
// an <h2> element and strips entirely) — this is the render-stability
// property the whole wire format switch depends on.
test('gpt reviewer adapter: "@@ field_name" markers parse correctly as rendered-web plain text (no "##" anywhere)', async () => {
  const renderedText = `@@ task_id
demo-task

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

@@ decision
PASS

@@ findings
- observation one
- observation two

@@ required_changes
none

@@ rationale
meets acceptance_criteria`;
  assert.ok(!renderedText.includes('##'), 'fixture must not contain any Markdown heading syntax');

  const askGptFn = async () => renderedText;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.equal(result.decision, 'PASS');
  assert.deepEqual(result.findings, ['observation one', 'observation two']);
});

// The prompt template's own placeholder line must never be mistaken for a
// real decision if GPT echoes it back verbatim instead of picking one.
test('gpt reviewer adapter: literal "PASS | REWORK | HUMAN_REQUIRED" placeholder is rejected', async () => {
  const askGptFn = async () => resultText({ decision: 'PASS | REWORK | HUMAN_REQUIRED' });
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      assert.match(err.message, /placeholder/);
      return true;
    }
  );
});

test('gpt reviewer adapter: findings and required_changes multiline lists survive parsing', async () => {
  const askGptFn = async () => `@@ task_id
demo-task

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

@@ decision
REWORK

@@ findings
- first finding, tied to a specific file
- second finding, tied to a specific behavior
- third finding, tied to a specific criterion

@@ required_changes
- fix the first thing
- fix the second thing

@@ rationale
meets some but not all acceptance_criteria`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  const result = await adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence());

  assert.deepEqual(result.findings, [
    'first finding, tied to a specific file',
    'second finding, tied to a specific behavior',
    'third finding, tied to a specific criterion',
  ]);
  assert.deepEqual(result.required_changes, ['fix the first thing', 'fix the second thing']);
});

test('gpt reviewer adapter: a duplicate "@@ decision" marker is rejected', async () => {
  const askGptFn = async () => `@@ task_id
demo-task

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

@@ decision
PASS

@@ decision
REWORK

@@ findings
- looks correct

@@ required_changes
none

@@ rationale
meets acceptance_criteria`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      assert.match(err.message, /duplicate/);
      return true;
    }
  );
});

test('gpt reviewer adapter: "@@ field_name" markers out of order are rejected', async () => {
  const askGptFn = async () => `@@ task_id
demo-task

@@ decision
PASS

@@ repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: phase1-handshake
commit_sha: def456

@@ findings
- looks correct

@@ required_changes
none

@@ rationale
meets acceptance_criteria`;
  const adapter = createGptReviewerAdapter({ askGptFn, config: {} });

  await assert.rejects(
    () => adapter.review(demoTaskCard(), demoExecutionReport(), demoEvidence()),
    (err) => {
      assert.equal(err.code, ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT);
      assert.match(err.message, /exactly this order/);
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
