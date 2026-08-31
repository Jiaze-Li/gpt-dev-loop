import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectWorkflowPath,
  buildFastPathTaskContract,
  restorePathDecision,
  serializePathDecision,
  pathProgressFields,
  describePathDecision,
  fastPathResolvedPlan,
  WORKFLOW_PATHS,
  PATH_SELECTION_REASONS,
  FAST_PATH_MAX_FILES,
} from '../src/orchestrator/pathSelection.js';

const SAFE_BOUNDED_TASK = Object.freeze({
  goal: 'Fix the off-by-one in the pagination offset calculation',
  allowed_files: ['src/pagination.js'],
  verification_commands: ['node --test tests/pagination.test.js'],
});

function safeTask(overrides = {}) {
  return { ...SAFE_BOUNDED_TASK, ...overrides };
}

// --- safe Fast Path selection -----------------------------------------

test('Fast Path: selected for exactly one safe bounded task with concrete scope and verification', () => {
  const d = selectWorkflowPath({ goal: 'fix the pagination bug', boundedTask: safeTask() });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_BOUNDED_SINGLE_TASK);
  assert.deepEqual(d.taskContract.allowed_files, ['src/pagination.js']);
  assert.deepEqual(d.taskContract.verification_commands, ['node --test tests/pagination.test.js']);
  assert.equal(d.frozenPlan, null);
  assert.equal(d.restored, false);
  assert.ok(Object.isFrozen(d));
});

test('Fast Path: multiple concrete files within the bound still select Fast Path', () => {
  const d = selectWorkflowPath({
    boundedTask: safeTask({ allowed_files: ['src/a.js', 'src/b.js', 'tests/a.test.js'] }),
  });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.taskContract.allowed_files.length, 3);
});

// --- conservative Full Path fallbacks ---------------------------------

test('Full Path: no bounded task contract in trusted input', () => {
  const d = selectWorkflowPath({ goal: 'fix the pagination bug' });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK);
  assert.equal(d.taskContract, null);
});

test('Full Path: explicit caller request for planning', () => {
  const d = selectWorkflowPath({ boundedTask: safeTask(), explicitFullPath: true });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_REQUEST);
});

test('Full Path: explicit multi-step goal text', () => {
  for (const goal of [
    'add the endpoint then wire it into the router',
    'Step 1: rename the module. Step 2: update callers.',
    'refactor the parser and also add caching',
    'do X\n1. first thing\n2. second thing',
  ]) {
    const d = selectWorkflowPath({ goal, boundedTask: safeTask({ goal: 'x' }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL, goal);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP, goal);
  }
});

test('Full Path: bounded task carrying more than one task', () => {
  const d = selectWorkflowPath({ boundedTask: { ...safeTask(), tasks: [{}, {}] } });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP);
});

test('Full Path: bounded task supplied as a list', () => {
  const d = selectWorkflowPath({ boundedTask: [safeTask()] });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP);
});

test('Full Path: missing file scope', () => {
  for (const allowed_files of [undefined, [], null]) {
    const d = selectWorkflowPath({ boundedTask: safeTask({ allowed_files }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_MISSING_FILE_SCOPE);
  }
});

test('Full Path: broad / unsafe file scope', () => {
  for (const entry of ['src/**', 'src/', '.', '/etc/passwd', '../outside.js', 'src/*.js', 'lib/{a,b}.js']) {
    const d = selectWorkflowPath({ boundedTask: safeTask({ allowed_files: [entry] }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL, entry);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_BROAD_FILE_SCOPE, entry);
  }
});

test('Full Path: file scope larger than the Fast Path bound', () => {
  const many = Array.from({ length: FAST_PATH_MAX_FILES + 1 }, (_, i) => `src/f${i}.js`);
  const d = selectWorkflowPath({ boundedTask: safeTask({ allowed_files: many }) });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_BROAD_FILE_SCOPE);
});

test('Full Path: missing or empty verification commands', () => {
  for (const verification_commands of [undefined, [], ['  ']]) {
    const d = selectWorkflowPath({ boundedTask: safeTask({ verification_commands }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_MISSING_VERIFICATION);
  }
});

test('Full Path: architectural / product ambiguity', () => {
  for (const goal of [
    'design a caching layer for the API',
    'investigate why the queue stalls and fix it',
    'decide which serialization format to use',
    'should we split this module?',
  ]) {
    const d = selectWorkflowPath({ goal, boundedTask: safeTask({ goal: 'x' }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL, goal);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_AMBIGUOUS_INTENT, goal);
  }
});

test('Full Path: high-risk operations', () => {
  for (const goal of [
    'delete the deprecated users table',
    'run the database migration',
    'force-push the rebased branch',
    'rotate the API key in the config',
    'update .github/workflows/ci.yml',
    'deploy the new build to production',
  ]) {
    const d = selectWorkflowPath({ goal, boundedTask: safeTask({ goal: 'x' }) });
    assert.equal(d.path, WORKFLOW_PATHS.FULL, goal);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_HIGH_RISK, goal);
  }
});

test('Full Path: closeout-only work', () => {
  const d = selectWorkflowPath({ goal: 'merge the PR and close out the ticket', boundedTask: safeTask({ goal: 'x' }) });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_CLOSEOUT_ONLY);
});

test('Full Path: invalid bounded task (no goal)', () => {
  const d = selectWorkflowPath({ boundedTask: { allowed_files: ['a.js'], verification_commands: ['x'] } });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_INVALID_BOUNDED_TASK);
});

test('uncertain classification is never Fast Path: ambiguity in the bounded goal itself also falls back', () => {
  const d = selectWorkflowPath({
    boundedTask: safeTask({ goal: 'explore options for reducing memory use' }),
  });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_AMBIGUOUS_INTENT);
});

// --- planner bypass on Fast Path -------------------------------------

test('Fast Path: fastPathResolvedPlan yields exactly one frozen task and promotes verification to closeout', () => {
  const d = selectWorkflowPath({ goal: 'fix pagination', boundedTask: safeTask() });
  const resolved = fastPathResolvedPlan(d, { goal: 'fix pagination' });
  assert.equal(resolved.status, 'READY');
  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].task_id, 'fast-path-task');
  assert.deepEqual(resolved.tasks[0].allowed_files, ['src/pagination.js']);
  assert.deepEqual(resolved.closeoutVerificationCommands, ['node --test tests/pagination.test.js']);
  assert.ok(typeof resolved.plan === 'string' && resolved.plan.includes('Planner bypassed'));
});

test('fastPathResolvedPlan refuses a Full Path decision', () => {
  const d = selectWorkflowPath({ goal: 'design a thing' });
  assert.throws(() => fastPathResolvedPlan(d), /Fast Path decision/);
});

// --- Full Path keeps planning (planner-once) -------------------------

test('Full Path decision carries no task contract and no frozen plan (Planner still runs once)', () => {
  const d = selectWorkflowPath({ goal: 'build a feature' });
  assert.equal(d.taskContract, null);
  assert.equal(d.frozenPlan, null);
});

// --- persistence / resume ------------------------------------------

test('serialize then restore round-trips a Fast Path decision without weakening scope', () => {
  const d = selectWorkflowPath({ goal: 'fix pagination', boundedTask: safeTask() });
  const persisted = serializePathDecision(d);
  const restored = restorePathDecision(persisted);
  assert.equal(restored.path, WORKFLOW_PATHS.FAST);
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.taskContract.allowed_files, d.taskContract.allowed_files);
  assert.deepEqual(restored.taskContract.verification_commands, d.taskContract.verification_commands);
});

test('resume via frozenDecision returns the persisted path verbatim', () => {
  const d = selectWorkflowPath({ goal: 'fix pagination', boundedTask: safeTask() });
  const frozen = serializePathDecision(d);
  const resumed = selectWorkflowPath({ goal: 'something completely different now', frozenDecision: frozen });
  assert.equal(resumed.path, WORKFLOW_PATHS.FAST);
  assert.equal(resumed.restored, true);
});

test('restore rejects a persisted Fast Path whose scope no longer validates', () => {
  assert.throws(
    () => restorePathDecision({ path: WORKFLOW_PATHS.FAST, taskContract: { goal: 'x', allowed_files: ['src/**'], verification_commands: ['x'] } }),
    /weaken scope|no longer validates/,
  );
});

test('restore rejects an unrecognized persisted path', () => {
  assert.throws(() => restorePathDecision({ path: 'TURBO' }), /not a recognized workflow path/);
  assert.throws(() => restorePathDecision(null), /missing or not an object/);
});

test('restore of a Full Path decision needs no contract', () => {
  const d = selectWorkflowPath({ goal: 'build a feature' });
  const restored = restorePathDecision(serializePathDecision(d));
  assert.equal(restored.path, WORKFLOW_PATHS.FULL);
  assert.equal(restored.taskContract, null);
});

// --- progress exposure helpers -----------------------------------

test('pathProgressFields exposes the path and reason for status/watch/result', () => {
  const d = selectWorkflowPath({ goal: 'fix pagination', boundedTask: safeTask() });
  assert.deepEqual(pathProgressFields(d), {
    workflowPath: 'FAST',
    pathSelectionReason: PATH_SELECTION_REASONS.FAST_BOUNDED_SINGLE_TASK,
    pathSelectionDetail: d.reasonDetail,
  });
  assert.match(describePathDecision(d), /^Fast Path/);
});

// --- frontend identity independence -----------------------------

test('selection is identical regardless of frontend identity or extra caller fields', () => {
  const base = { goal: 'fix the pagination bug', boundedTask: safeTask() };
  const a = selectWorkflowPath({ ...base, frontend: 'claude', clientId: 'x' });
  const b = selectWorkflowPath({ ...base, frontend: 'codex', clientId: 'y' });
  const c = selectWorkflowPath({ ...base, frontend: 'agy' });
  assert.deepEqual(serializePathDecision(a), serializePathDecision(b));
  assert.deepEqual(serializePathDecision(b), serializePathDecision(c));
});

// --- buildFastPathTaskContract direct -------------------------------

test('buildFastPathTaskContract accepts camelCase aliases and normalizes', () => {
  const r = buildFastPathTaskContract({
    goal: '  trim me  ',
    allowedFiles: [' src/a.js '],
    verificationCommands: [' npm test '],
    forbiddenFiles: ['src/legacy.js'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.contract.goal, 'trim me');
  assert.deepEqual(r.contract.allowed_files, ['src/a.js']);
  assert.deepEqual(r.contract.verification_commands, ['npm test']);
  assert.deepEqual(r.contract.forbidden_files, ['src/legacy.js']);
});
