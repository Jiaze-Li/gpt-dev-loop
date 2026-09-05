import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectRepositoryContext,
  formatRepositoryContextBlock,
  buildPlannerPrompt,
  parsePlannerJson,
  generatePlan,
  PlannerError,
} from '../src/orchestrator/planner.js';
import { resolveWorkflowPlan } from '../scripts/run-agy-workflow.js';
import { AgyTimeoutError, AgyExitError } from '../src/agy/agyClient.js';
import { makeFakeCallAgy } from './fixtures/fakeAgy.mjs';

// --- deterministic repository probes -----------------------------------

function fakeRepo({ files = [], texts = {} } = {}) {
  return {
    cwd: '/repo/gpt-dev-loop',
    listRepoFiles: async () => files,
    readTextFile: async (rel) => (rel in texts ? texts[rel] : null),
  };
}

const PACKAGE_JSON = JSON.stringify({
  name: 'demo-app',
  version: '2.1.0',
  scripts: { test: 'node --test', build: 'tsc' },
  dependencies: { zod: '^3', ws: '^8' },
  devDependencies: { typescript: '^5' },
});

// --- collectRepositoryContext -----------------------------------------

test('collectRepositoryContext: extracts package.json, listings, and configs', async () => {
  const repo = fakeRepo({
    files: ['package.json', 'tsconfig.json', 'src/index.js', 'src/lib/a.js', 'tests/a.test.js'],
    texts: { 'package.json': PACKAGE_JSON },
  });
  const summary = await collectRepositoryContext(repo);

  assert.equal(summary.repository_name, 'demo-app');
  assert.equal(summary.package.version, '2.1.0');
  assert.deepEqual(summary.package.dependencies, ['ws', 'zod']);
  assert.deepEqual(summary.package.devDependencies, ['typescript']);
  assert.deepEqual(summary.top_level_entries, ['package.json', 'src/', 'tests/', 'tsconfig.json']);
  assert.equal(summary.file_count, 5);
  assert.ok(summary.config_files.includes('tsconfig.json'));

  assert.match(summary.promptBlock, /repository_name: demo-app/);
  assert.match(summary.promptBlock, /test="node --test"/);
  assert.match(summary.promptBlock, /src\/lib\/a\.js/);
});

test('collectRepositoryContext: missing/invalid package.json is tolerated', async () => {
  const summary = await collectRepositoryContext(
    fakeRepo({ files: ['README.md', 'main.py'], texts: { 'package.json': 'not json {' } }),
  );
  assert.equal(summary.package, null);
  assert.equal(summary.repository_name, 'gpt-dev-loop'); // basename(cwd) fallback
  assert.match(summary.promptBlock, /package\.json: \(absent or unreadable\)/);
  // README.md is a whitelisted config candidate and present in the listing
  assert.ok(summary.config_files.includes('README.md'));
});

test('collectRepositoryContext: empty repo yields a well-formed block', async () => {
  const summary = await collectRepositoryContext(fakeRepo({}));
  assert.equal(summary.file_count, 0);
  assert.match(summary.promptBlock, /top-level entries: \(none\)/);
  assert.match(summary.promptBlock, /tracked files \(0\):/);
});

test('collectRepositoryContext: file listing is capped at maxFilesListed', async () => {
  const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.js`);
  const summary = await collectRepositoryContext({ ...fakeRepo({ files }), maxFilesListed: 4 });
  assert.equal(summary.file_count, 10);
  assert.equal(summary.files.length, 4);
  assert.equal(summary.files_truncated, true);
  assert.match(summary.promptBlock, /tracked files \(10, showing first 4\):/);
});

// --- prompt construction ---------------------------------------------

test('buildPlannerPrompt carries the repo context block and the user intent', () => {
  const prompt = buildPlannerPrompt({
    userIntent: 'add a rate limiter to the API',
    repositoryContextBlock: 'repository_name: demo-app',
  });
  assert.match(prompt, /repository_name: demo-app/);
  assert.match(prompt, /add a rate limiter to the API/);
  assert.match(prompt, /"status": "READY" \| "AMBIGUOUS"/);
});

// --- parsePlannerJson (fail-closed) ---------------------------------

const READY_OBJ = {
  status: 'READY',
  summary: 'Add a token-bucket limiter middleware.',
  plan_text: 'Task 1: implement src/mw/rateLimit.js ... Task 2: wire it into the router.',
  tasks: [
    {
      task_id: 'rate-limit-mw',
      goal: 'Implement a token-bucket rate limiter middleware.',
      scope: 'in: src/mw/rateLimit.js; out: everything else',
      allowed_files: ['src/mw/rateLimit.js', 'tests/rateLimit.test.js'],
      verification_commands: ['npm test'],
    },
  ],
};

test('parsePlannerJson: valid READY object -> normalized plan', () => {
  const parsed = parsePlannerJson(READY_OBJ);
  assert.equal(parsed.status, 'READY');
  assert.equal(parsed.planText, READY_OBJ.plan_text);
  assert.equal(parsed.summary, READY_OBJ.summary);
  assert.equal(parsed.tasks.length, 1);
  assert.deepEqual(parsed.tasks[0].allowed_files, ['src/mw/rateLimit.js', 'tests/rateLimit.test.js']);
  assert.deepEqual(parsed.closeoutVerificationCommands, ['npm test']);
});

test('parsePlannerJson: automatically falls back to unique tasks verification_commands if closeout_verification_commands is omitted', () => {
  const parsed = parsePlannerJson({
    status: 'READY',
    summary: 'Create tmp/file.txt',
    plan_text: 'Task 1: Create tmp/file.txt with exact content',
    tasks: [
      {
        task_id: 'create-file',
        goal: 'Create tmp/file.txt with PROMPT-A-DONE',
        allowed_files: ['tmp/file.txt'],
        verification_commands: ["node -e 'assert.equal(fs.readFileSync(\"tmp/file.txt\", \"utf8\").trim(), \"PROMPT-A-DONE\")'"],
      },
    ],
  });
  assert.equal(parsed.status, 'READY');
  assert.deepEqual(parsed.closeoutVerificationCommands, [
    "node -e 'assert.equal(fs.readFileSync(\"tmp/file.txt\", \"utf8\").trim(), \"PROMPT-A-DONE\")'",
  ]);
});

test('parsePlannerJson: AMBIGUOUS requires a question', () => {
  assert.deepEqual(parsePlannerJson({ status: 'AMBIGUOUS', question: 'REST or GraphQL?' }), {
    status: 'AMBIGUOUS',
    question: 'REST or GraphQL?',
  });
  assert.throws(() => parsePlannerJson({ status: 'AMBIGUOUS' }), (e) => e.code === 'PLANNER_INVALID_OUTPUT');
});

test('parsePlannerJson: fail closed on unknown status / missing fields', () => {
  assert.throws(() => parsePlannerJson({ status: 'MAYBE' }), (e) => e.code === 'PLANNER_INVALID_OUTPUT');
  assert.throws(
    () => parsePlannerJson({ ...READY_OBJ, plan_text: '' }),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT',
  );
  assert.throws(
    () => parsePlannerJson({ ...READY_OBJ, tasks: [] }),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT',
  );
  assert.throws(
    () => parsePlannerJson({ ...READY_OBJ, tasks: [{ task_id: 'x', goal: 'y', allowed_files: [], verification_commands: ['t'] }] }),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT',
  );
});

// --- parsePlannerJson: workspace path normalization -----------------

const readyWithAllowed = (allowed) => ({ ...READY_OBJ, tasks: [{ ...READY_OBJ.tasks[0], allowed_files: allowed }] });

test('parsePlannerJson: normal relative paths pass through unchanged', () => {
  const parsed = parsePlannerJson(readyWithAllowed(['src/a.js', 'tests/a.test.js']));
  assert.deepEqual(parsed.tasks[0].allowed_files, ['src/a.js', 'tests/a.test.js']);
});

test('parsePlannerJson: unstable representations normalize to stable workspace-relative paths', () => {
  const parsed = parsePlannerJson(readyWithAllowed(['./src/./a.js', 'src/lib/../a.js', 'tests//a.test.js']));
  assert.deepEqual(parsed.tasks[0].allowed_files, ['src/a.js', 'tests/a.test.js']);
});

test('parsePlannerJson: post-normalization duplicates collapse to one entry', () => {
  const parsed = parsePlannerJson(readyWithAllowed(['src/a.js', './src/a.js', 'src/./a.js']));
  assert.deepEqual(parsed.tasks[0].allowed_files, ['src/a.js']);
});

test('parsePlannerJson: absolute allowed_files fail closed', () => {
  assert.throws(
    () => parsePlannerJson(readyWithAllowed(['/etc/passwd'])),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT' && /absolute/.test(e.message),
  );
});

test('parsePlannerJson: path escape in allowed_files fails closed', () => {
  assert.throws(
    () => parsePlannerJson(readyWithAllowed(['../../secrets.txt'])),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT' && /escapes/.test(e.message),
  );
});

test('parsePlannerJson: workspace-root reference is not a valid allowed_file', () => {
  assert.throws(
    () => parsePlannerJson(readyWithAllowed(['src/..'])),
    (e) => e.code === 'PLANNER_INVALID_OUTPUT',
  );
});

test('parsePlannerJson: closeout_policy_sources normalize and drop unsafe entries', () => {
  const parsed = parsePlannerJson({
    ...READY_OBJ,
    closeout_policy_sources: ['./docs/x.md', 'docs/x.md', '/abs/policy.md', '../escape.md'],
  });
  assert.deepEqual(parsed.closeoutPolicySources, ['docs/x.md']);
});

// --- generatePlan ---------------------------------------------------

const REPO_SUMMARY = { repository_name: 'demo-app', promptBlock: 'repository_name: demo-app\ntracked files (0):' };

test('generatePlan: clear intent -> READY plan with task list', async () => {
  const callAgy = makeFakeCallAgy(READY_OBJ);
  const result = await generatePlan({ userIntent: 'add a rate limiter', repoContext: REPO_SUMMARY, callAgy });
  assert.equal(result.status, 'READY');
  assert.equal(result.tasks[0].task_id, 'rate-limit-mw');
  assert.match(callAgy.calls[0].prompt, /repository_name: demo-app/);
  assert.match(callAgy.calls[0].prompt, /add a rate limiter/);
});

test('generatePlan: code-fenced JSON is tolerated', async () => {
  const fenced = '```json\n' + JSON.stringify(READY_OBJ) + '\n```';
  const result = await generatePlan({ userIntent: 'x', repoContext: REPO_SUMMARY, callAgy: makeFakeCallAgy(fenced) });
  assert.equal(result.status, 'READY');
});

test('generatePlan: ambiguous intent -> AMBIGUOUS question', async () => {
  const callAgy = makeFakeCallAgy({ status: 'AMBIGUOUS', question: 'Which datastore should sessions use?' });
  const result = await generatePlan({ userIntent: 'add sessions', repoContext: REPO_SUMMARY, callAgy });
  assert.deepEqual(result, { status: 'AMBIGUOUS', question: 'Which datastore should sessions use?' });
});

test('generatePlan: empty intent -> PLANNER_BAD_INPUT', async () => {
  await assert.rejects(
    () => generatePlan({ userIntent: '  ', repoContext: REPO_SUMMARY, callAgy: makeFakeCallAgy(READY_OBJ) }),
    (e) => e instanceof PlannerError && e.code === 'PLANNER_BAD_INPUT',
  );
});

test('generatePlan: malformed model reply -> PLANNER_INVALID_OUTPUT', async () => {
  await assert.rejects(
    () => generatePlan({ userIntent: 'x', repoContext: REPO_SUMMARY, callAgy: makeFakeCallAgy('not json {') }),
    (e) => e instanceof PlannerError && e.code === 'PLANNER_INVALID_OUTPUT',
  );
});

test('generatePlan: agy timeout / nonzero exit fail closed', async () => {
  await assert.rejects(
    () => generatePlan({ userIntent: 'x', repoContext: REPO_SUMMARY, callAgy: makeFakeCallAgy(new AgyTimeoutError(1000)) }),
    (e) => e.code === 'PLANNER_TIMEOUT',
  );
  await assert.rejects(
    () => generatePlan({ userIntent: 'x', repoContext: REPO_SUMMARY, callAgy: makeFakeCallAgy(new AgyExitError(2, 'boom')) }),
    (e) => e.code === 'PLANNER_MODEL_UNAVAILABLE',
  );
});

// --- run-agy-workflow entry integration -----------------------------

test('resolveWorkflowPlan: an existing file is read verbatim (backward-compatible)', async () => {
  const resolved = await resolveWorkflowPlan({
    planArg: 'plan.txt',
    cwd: '/repo',
    statFile: async () => ({ isFile: () => true }),
    readPlanFile: async (p) => `PLAN FILE @ ${p}`,
  });
  assert.equal(resolved.source, 'file');
  assert.match(resolved.plan, /PLAN FILE @ \/repo\/plan\.txt/);
});

test('resolveWorkflowPlan: a natural-language string is planned into planText', async () => {
  let collectedCwd = null;
  const resolved = await resolveWorkflowPlan({
    planArg: 'make the CLI print a version flag',
    cwd: '/repo',
    statFile: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    collect: async ({ cwd }) => { collectedCwd = cwd; return REPO_SUMMARY; },
    generate: async ({ userIntent, repoContext }) => {
      assert.equal(userIntent, 'make the CLI print a version flag');
      assert.equal(repoContext, REPO_SUMMARY);
      return { status: 'READY', planText: 'Task 1: add --version', summary: 's', tasks: [] };
    },
  });
  assert.equal(collectedCwd, '/repo');
  assert.equal(resolved.source, 'nl');
  assert.equal(resolved.plan, 'Task 1: add --version');
});

test('resolveWorkflowPlan: an ambiguous instruction surfaces the question, no plan', async () => {
  const resolved = await resolveWorkflowPlan({
    planArg: 'redesign the persistence layer',
    cwd: '/repo',
    statFile: async () => { throw new Error('nope'); },
    collect: async () => REPO_SUMMARY,
    generate: async () => ({ status: 'AMBIGUOUS', question: 'SQL or KV store?' }),
  });
  assert.deepEqual(resolved, { status: 'AMBIGUOUS', question: 'SQL or KV store?', source: 'nl' });
});

test('resolveWorkflowPlan: empty argument fails closed', async () => {
  await assert.rejects(
    () => resolveWorkflowPlan({ planArg: '   ', cwd: '/repo' }),
    (e) => e instanceof PlannerError && e.code === 'PLANNER_BAD_INPUT',
  );
});
