// Regression coverage for deterministic Fast Path derivation from a plain
// request goal (no caller-supplied boundedTask contract). Motivated by the
// Section-I measurement: a `kebabCase` + deterministic-tests task incorrectly
// entered Full Path and paid ~105k tokens / ~33s for an unnecessary Planner
// call. These tests pin the structural classifier — positive, negative, and
// the H-style one-comment regression — with zero model/provider calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  selectWorkflowPath,
  deriveBoundedTaskFromGoal,
  fastPathResolvedPlan,
  serializePathDecision,
  restorePathDecision,
  WORKFLOW_PATHS,
  PATH_SELECTION_REASONS,
} from '../src/orchestrator/pathSelection.js';

// --- disposable workspace fixture ------------------------------------

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-derive-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body ?? '// stub\n');
  }
  return root;
}

const repos = [];
function repo(files) {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}

test.after(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

// ============================================================
// POSITIVE — must now select Fast Path with ZERO Planner calls
// ============================================================

test('positive 1: pure function + existing deterministic tests (the Section-I class)', () => {
  const cwd = repo({
    'src/kebabCase.js': 'export function kebabCase(){ throw new Error("not implemented"); }\n',
    'test/kebabCase.test.js': 'import { kebabCase } from "../src/kebabCase.js";\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  const goal = 'Implement the kebabCase function in src/kebabCase.js so that every test in test/kebabCase.test.js passes. It is currently a stub that throws. Do not modify the test file. Verify with `npm test`.';

  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK);
  // impl file is the only edit target; the test file is protected.
  assert.deepEqual(d.taskContract.allowed_files, ['src/kebabCase.js']);
  assert.deepEqual(d.taskContract.forbidden_files, ['test/kebabCase.test.js']);
  assert.deepEqual(d.taskContract.verification_commands, ['npm test']);

  // exactly one bounded Task Card, Planner bypassed
  const resolved = fastPathResolvedPlan(d, { goal });
  assert.equal(resolved.status, 'READY');
  assert.equal(resolved.tasks.length, 1);
  assert.deepEqual(resolved.closeoutVerificationCommands, ['npm test']);
  assert.match(resolved.plan, /Planner bypassed/);
});

test('positive 2: one-file bug fix with an explicit failing test', () => {
  const cwd = repo({
    'src/pagination.js': 'export function offset(){ return 0; }\n',
    'tests/pagination.test.js': 'import assert from "node:assert";\n',
  });
  const goal = 'Fix the off-by-one in src/pagination.js. The failing test is tests/pagination.test.js — make it pass. Run `node --test tests/pagination.test.js` to verify.';

  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK);
  assert.deepEqual(d.taskContract.allowed_files, ['src/pagination.js']);
  assert.deepEqual(d.taskContract.forbidden_files, ['tests/pagination.test.js']);
  assert.deepEqual(d.taskContract.verification_commands, ['node --test tests/pagination.test.js']);
});

test('positive 3: small config/code change with a deterministic verification command', () => {
  const cwd = repo({
    'src/config.js': 'export const TIMEOUT_MS = 1000;\n',
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  const goal = 'Raise the default client timeout to 5000ms in src/config.js. Verify with `npm test`.';

  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK);
  assert.deepEqual(d.taskContract.allowed_files, ['src/config.js']);
  assert.deepEqual(d.taskContract.verification_commands, ['npm test']);
});

test('positive: a not-yet-created file in an existing directory is an acceptable bounded target', () => {
  const cwd = repo({ 'src/index.js': '\n', 'package.json': '{}\n' });
  const goal = 'Add a new pure helper in src/slugify.js. Verify with `npm test`.';
  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.deepEqual(d.taskContract.allowed_files, ['src/slugify.js']);
});

test('positive: derived Fast Path round-trips through serialize/restore without weakening scope', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Implement the parser in src/a.js. Verify with `npm test`.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  const restored = restorePathDecision(serializePathDecision(d));
  assert.equal(restored.path, WORKFLOW_PATHS.FAST);
  assert.equal(restored.reason, PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK);
  assert.deepEqual(restored.taskContract.allowed_files, ['src/a.js']);
});

// ============================================================
// NEGATIVE — must still select Full Path (Planner stays)
// ============================================================

test('negative 1: multi-subsystem feature requiring separate ordered tasks', () => {
  const cwd = repo({ 'src/auth/oauth.js': '\n', 'src/auth/session.js': '\n', 'src/server.js': '\n' });
  const goal = 'Add SSO: implement the OAuth handler in src/auth/oauth.js, then add the session store in src/auth/session.js, then wire both into src/server.js. Verify with `npm test`.';
  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP);
});

test('negative 2: migration requiring ordered stages', () => {
  const cwd = repo({ 'src/db.js': '\n' });
  const goal = 'Migrate the users table to the new schema in src/db.js. Verify with `npm test`.';
  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_HIGH_RISK);
});

test('negative 3: request with multiple independent deliverables', () => {
  const cwd = repo({ 'src/a.js': '\n', 'src/b.js': '\n' });
  const goal = 'Implement the exporter in src/a.js as well as the importer in src/b.js. Verify with `npm test`.';
  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP);
});

test('negative: genuinely decomposable work that names no concrete file / command', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  for (const goal of ['Rebuild the reporting dashboard', 'Improve error handling across the API layer', 'build a feature']) {
    const d = selectWorkflowPath({ goal, cwd });
    assert.equal(d.path, WORKFLOW_PATHS.FULL, goal);
    assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK, goal);
  }
});

test('negative: names a file but no verification command -> Full Path', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Refactor the tokenizer in src/a.js for readability.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK);
});

test('negative: architectural ambiguity in the request still routes to Planner', () => {
  const cwd = repo({ 'src/cache.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Design a caching layer in src/cache.js. Verify with `npm test`.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_AMBIGUOUS_INTENT);
});

test('negative: verification-looking token that is not an allowlisted runner is ignored', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Implement src/a.js. Verify with `curl http://localhost:3000`.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK);
});

test('negative: shell-chained verification command is rejected', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Implement src/a.js. Verify with `npm test && rm -rf /`.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
});

test('negative: file scope beyond the Fast Path bound falls back to Planner', () => {
  const files = {};
  const names = [];
  for (let i = 0; i < 15; i += 1) { files[`src/f${i}.js`] = '\n'; names.push(`src/f${i}.js`); }
  const cwd = repo(files);
  const goal = `Touch every one of ${names.join(', ')}. Verify with \`npm test\`.`;
  const d = selectWorkflowPath({ goal, cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
});

test('negative: only a test file is named (no implementation target) -> Planner', () => {
  const cwd = repo({ 'tests/thing.test.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Make the assertions in tests/thing.test.js pass. Verify with `npm test`.', cwd });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
});

// ============================================================
// REGRESSION
// ============================================================

test('regression: H-style trivial one-comment task remains Fast Path (explicit contract untouched)', () => {
  const explicit = selectWorkflowPath({
    goal: 'add a clarifying comment',
    boundedTask: {
      goal: 'Add a one-line clarifying comment to the top of src/foo.js',
      allowed_files: ['src/foo.js'],
      verification_commands: ['npm test'],
    },
  });
  assert.equal(explicit.path, WORKFLOW_PATHS.FAST);
  assert.equal(explicit.reason, PATH_SELECTION_REASONS.FAST_BOUNDED_SINGLE_TASK);
});

test('regression: H-style trivial one-comment task as a plain goal is now also Fast Path', () => {
  const cwd = repo({ 'src/foo.js': '\n' });
  const d = selectWorkflowPath({
    goal: 'Add a one-line clarifying comment to the top of src/foo.js. Verify with `npm test`.',
    cwd,
  });
  assert.equal(d.path, WORKFLOW_PATHS.FAST);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK);
});

test('regression: an explicitly supplied boundedTask still wins its original reason code', () => {
  const d = selectWorkflowPath({
    goal: 'fix the pagination bug',
    boundedTask: {
      goal: 'Fix the off-by-one in the pagination offset calculation',
      allowed_files: ['src/pagination.js'],
      verification_commands: ['node --test tests/pagination.test.js'],
    },
  });
  assert.equal(d.reason, PATH_SELECTION_REASONS.FAST_BOUNDED_SINGLE_TASK);
});

test('regression: explicitFullPath overrides a derivable goal', () => {
  const cwd = repo({ 'src/a.js': '\n' });
  const d = selectWorkflowPath({ goal: 'Implement src/a.js. Verify with `npm test`.', cwd, explicitFullPath: true });
  assert.equal(d.path, WORKFLOW_PATHS.FULL);
  assert.equal(d.reason, PATH_SELECTION_REASONS.FULL_EXPLICIT_REQUEST);
});

// ============================================================
// UNIT — deriveBoundedTaskFromGoal directly
// ============================================================

test('deriveBoundedTaskFromGoal: returns null without a usable cwd for a bare filename', () => {
  assert.equal(deriveBoundedTaskFromGoal('Implement foo.js. Verify with `npm test`.', {}), null);
});

test('deriveBoundedTaskFromGoal: accepts a conventional-root path even without cwd', () => {
  const r = deriveBoundedTaskFromGoal('Implement src/foo.js. Verify with `npm test`.', {});
  assert.ok(r);
  assert.deepEqual(r.allowed_files, ['src/foo.js']);
  assert.deepEqual(r.verification_commands, ['npm test']);
});

test('deriveBoundedTaskFromGoal: explicit "do not modify" moves a named file to forbidden', () => {
  const cwd = repo({ 'src/a.js': '\n', 'src/schema.js': '\n' });
  const r = deriveBoundedTaskFromGoal('Update src/a.js. Do not modify src/schema.js. Verify with `npm test`.', { cwd });
  assert.deepEqual(r.allowed_files, ['src/a.js']);
  assert.deepEqual(r.forbidden_files, ['src/schema.js']);
});

test('deriveBoundedTaskFromGoal: null for traversal / glob / absolute paths', () => {
  for (const g of [
    'Edit ../outside.js. Verify with `npm test`.',
    'Edit src/*.js. Verify with `npm test`.',
    'Edit /etc/passwd.js. Verify with `npm test`.',
  ]) {
    assert.equal(deriveBoundedTaskFromGoal(g, {}), null, g);
  }
});
