import test from 'node:test';
import assert from 'node:assert/strict';
import {
  supergptRoute,
  decideAutoRoute,
  AUTO_ROUTE,
  ROUTE_DECISION,
  ROUTE_RULE,
} from '../src/control/autoRoutePolicy.js';

test('AutoRoutePolicy FORCE, BYPASS, and conservative AUTO contracts (backwards-compatible decideAutoRoute)', () => {
  const forceRes = decideAutoRoute('Use SuperGPT to refactor auth');
  assert.equal(forceRes.mode, AUTO_ROUTE.FORCE);
  assert.equal(forceRes.route, true);
  assert.equal(forceRes.decision, ROUTE_DECISION.SUPERGPT);
  assert.equal(forceRes.rule, ROUTE_RULE.EXPLICIT_FORCE);

  const bypassRes = decideAutoRoute('Do not use SuperGPT; change this typo');
  assert.equal(bypassRes.mode, AUTO_ROUTE.BYPASS);
  assert.equal(bypassRes.route, false);
  assert.equal(bypassRes.decision, ROUTE_DECISION.DIRECT);
  assert.equal(bypassRes.rule, ROUTE_RULE.EXPLICIT_BYPASS);

  assert.equal(decideAutoRoute('Refactor authentication across server/client, preserve compatibility, add migration and tests').route, true);
  assert.equal(decideAutoRoute('Explain this stack trace').route, false);
  assert.equal(decideAutoRoute('Summarize this long non-engineering document about history and literature').route, false);
  assert.equal(decideAutoRoute('Build server and client settings components with tests').route, true);
  assert.equal(decideAutoRoute('Create a module with node:test coverage and run tests').route, true);
});

test('V2 supergptRoute: Explicit bypass -> DIRECT', () => {
  const prompts = [
    'Do not use SuperGPT; fix this typo',
    "Don't use SuperGPT for this task",
    'without SuperGPT please',
    'Bypass SuperGPT and run directly',
    'direct only mode',
    'handle this directly please',
    'no supergpt',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.DIRECT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.EXPLICIT_BYPASS, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: Explicit force -> SUPERGPT', () => {
  const prompts = [
    'Use SuperGPT to build the login screen',
    'Run SuperGPT for this refactoring',
    'via SuperGPT implement tests',
    'with supergpt',
    'using supergpt',
    'delegate to SuperGPT',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.SUPERGPT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.EXPLICIT_FORCE, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: Explanation / research / non-modifying -> DIRECT', () => {
  const prompts = [
    'Explain this stack trace',
    'What does decideAutoRoute do?',
    'Why does the gate fail on dirty worktree?',
    'How does supergpt_route work?',
    'Summarize docs/ARCHITECTURE.md',
    'Research the best way to handle streaming MCP events',
    'Search for all occurrences of runSuperGPT in src/',
    'Find where workflowId is validated',
    'Where is the router configuration defined?',
    'Read package.json and tell me dependencies',
    'Show me the list of available MCP tools',
    'Describe the role of Supervisor',
    'Inspect the repository state',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.DIRECT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.NON_MODIFYING, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: Clearly trivial single-step low-risk edit -> DIRECT', () => {
  const prompts = [
    'Fix typo in README.md',
    'Fix spelling mistake in doc comment',
    'Fix a small typo in variable description',
    'Add a comment to explain the timeout constant',
    'Update docstring in helper.js',
    'Bump version to 1.2.0 in package.json',
    'Update port in config.json to 8080',
    'Rename variable foo to bar in utils.js',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.DIRECT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.TRIVIAL_EDIT, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: Feature, bug fix, refactor, migration, tests, multi-file -> SUPERGPT', () => {
  const prompts = [
    'Implement user authentication with JWT tokens',
    'Build server and client settings components with tests',
    'Fix bug where session expires prematurely',
    'Debug crash occurring on high concurrency requests',
    'Refactor authentication across server/client, preserve compatibility, add migration and tests',
    'Migrate database schema to Prisma v5',
    'Add unit tests for autoRoutePolicy',
    'Write e2e test suite for SuperGPT workflows',
    'Upgrade dependencies and verify compatibility',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.SUPERGPT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.SUBSTANTIAL_ENGINEERING, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: PR Closeout natural-language entry points -> SUPERGPT', () => {
  const prompts = [
    'closeout PR #123',
    '检查并修复 PR #123',
    '检查 PR #123 并修到 review clean',
    'closeout owner/repo PR #123',
    'review and fix PR #789',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.SUPERGPT, `Failed for prompt: ${p}`);
    assert.equal(res.rule, ROUTE_RULE.SUBSTANTIAL_ENGINEERING, `Failed rule for prompt: ${p}`);
  }
});

test('V2 supergptRoute: Uncertain / ambiguous classification -> SUPERGPT', () => {
  const prompts = [
    'Change this logic',
    'Make adjustments',
    'Do the next step',
    '',
  ];
  for (const p of prompts) {
    const res = supergptRoute({ goal: p });
    assert.equal(res.decision, ROUTE_DECISION.SUPERGPT, `Failed for prompt: "${p}"`);
    assert.equal(res.rule, ROUTE_RULE.UNCERTAIN_DEFAULT, `Failed rule for prompt: "${p}"`);
  }
});

