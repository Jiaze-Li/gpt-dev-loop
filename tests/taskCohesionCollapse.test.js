import test from 'node:test';
import assert from 'node:assert/strict';

import { assessTaskCohesion, collapseCohesiveTasks } from '../src/orchestrator/taskCohesion.js';
import { parsePlannerJson } from '../src/orchestrator/planner.js';
import { fastPathResolvedPlan } from '../src/orchestrator/pathSelection.js';

const REPO_FILES = [
  'src/config.js',
  'src/session.js',
  'src/auth/login.js',
  'src/billing/invoice.js',
  'tests/config.test.js',
  'tests/billing.test.js',
];

function readyPlan(tasks, extra = {}) {
  return {
    status: 'READY',
    summary: 'do the thing',
    plan_text: 'ordered plan document',
    tasks,
    ...extra,
  };
}

// --- 1. cohesive two-file fixture collapses 2 -> 1 ----------------------

test('cohesive config.js + session.js tasks collapse from 2 to 1', () => {
  const parsed = parsePlannerJson(
    readyPlan([
      {
        task_id: 'add-config-field',
        goal: 'Add retryLimit to the config loader',
        scope: 'in: config parsing; out: unrelated modules',
        allowed_files: ['src/config.js'],
        verification_commands: ['npm test'],
      },
      {
        task_id: 'consume-config-field',
        goal: 'Read retryLimit from config inside the session manager',
        scope: 'in: session wiring',
        allowed_files: ['src/session.js', 'src/config.js'],
        verification_commands: ['npm test'],
      },
    ]),
    { repoFiles: REPO_FILES },
  );

  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.taskCollapse.collapsed, true);
  assert.equal(parsed.taskCollapse.from, 2);
  assert.equal(parsed.taskCollapse.to, 1);

  const [merged] = parsed.tasks;
  // 3. allowed_files union, exact, no widening
  assert.deepEqual(merged.allowed_files, ['src/config.js', 'src/session.js']);
  // 4. verification commands losslessly merged (de-duped)
  assert.deepEqual(merged.verification_commands, ['npm test']);
  // 5. constraints (scope) preserved from both members
  assert.match(merged.scope, /config parsing/);
  assert.match(merged.scope, /session wiring/);
  // dependency/order info retained
  assert.deepEqual(merged.merged_from, ['add-config-field', 'consume-config-field']);
  assert.equal(merged.task_id, 'add-config-field+consume-config-field');
  // order preserved: first goal appears before second
  assert.ok(merged.goal.indexOf('config loader') < merged.goal.indexOf('session manager'));
});

// --- 2. independent subsystems stay split -----------------------------

test('independent subsystems are not merged', () => {
  const parsed = parsePlannerJson(
    readyPlan([
      {
        task_id: 'auth-work',
        goal: 'Harden the login flow',
        scope: 'in: auth',
        allowed_files: ['src/auth/login.js'],
        verification_commands: ['npm test -- auth'],
      },
      {
        task_id: 'billing-work',
        goal: 'Fix invoice rounding',
        scope: 'in: billing',
        allowed_files: ['src/billing/invoice.js'],
        verification_commands: ['npm test -- billing'],
      },
    ]),
    { repoFiles: REPO_FILES },
  );

  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.taskCollapse.collapsed, false);
  assert.deepEqual(parsed.tasks.map((t) => t.task_id), ['auth-work', 'billing-work']);
});

// --- verification_commands lossless union across differing lists -------

test('differing verification command lists merge without loss', () => {
  const parsed = parsePlannerJson(
    readyPlan([
      {
        task_id: 'a',
        goal: 'part one',
        allowed_files: ['src/config.js', 'src/session.js'],
        verification_commands: ['npm test', 'npm run lint'],
      },
      {
        task_id: 'b',
        goal: 'part two',
        allowed_files: ['src/config.js', 'src/session.js'],
        verification_commands: ['npm test', 'npm run typecheck'],
      },
    ]),
    { repoFiles: REPO_FILES },
  );
  assert.equal(parsed.tasks.length, 1);
  assert.deepEqual(parsed.tasks[0].verification_commands, [
    'npm test',
    'npm run lint',
    'npm run typecheck',
  ]);
});

// --- 6. resume / frozen decision path is unaffected -------------------

test('collapse only runs on fresh planner parse; a pre-materialized task list is untouched', () => {
  // The frozen-resume path re-reads persisted task cards and never calls
  // parsePlannerJson / collapseCohesiveTasks. Simulate a frozen 2-task queue
  // and confirm nothing here would re-collapse it: collapseCohesiveTasks is
  // only reachable through parsePlannerJson.
  const frozen = [
    { task_id: 'a', goal: 'g', allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
    { task_id: 'b', goal: 'g', allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
  ];
  // Direct call is idempotent and pure, but the production resume path does not
  // invoke it — this asserts the function's own contract only.
  const once = collapseCohesiveTasks(frozen);
  const twice = collapseCohesiveTasks(once.tasks);
  assert.equal(once.tasks.length, 1);
  assert.equal(twice.tasks.length, 1);
  assert.equal(twice.collapsed, false);
});

// --- 7. Fast Path plan shape is unaffected ---------------------------

test('Fast Path resolved plan keeps its single task and never collapses', () => {
  const contract = {
    task_id: 'fast-task',
    goal: 'tweak the config default',
    scope: 'in: config',
    allowed_files: ['src/config.js'],
    forbidden_files: [],
    verification_commands: ['npm test'],
  };
  const plan = fastPathResolvedPlan(
    { path: 'FAST', taskContract: contract, reason: 'bounded' },
    { goal: 'tweak the config default' },
  );
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.taskCollapse, undefined);
});

// --- 8. merged task remains a valid planned task (Gate/Reviewer shape) --

test('merged task satisfies validPlannedTasks shape', async () => {
  const { validPlannedTasks } = await import('../src/orchestrator/deterministicSupervisorPolicy.js');
  const parsed = parsePlannerJson(
    readyPlan([
      { task_id: 'a', goal: 'g1', allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
      { task_id: 'b', goal: 'g2', allowed_files: ['src/config.js', 'src/session.js'], verification_commands: ['npm test'] },
    ]),
    { repoFiles: REPO_FILES },
  );
  assert.equal(parsed.tasks.length, 1);
  assert.equal(validPlannedTasks(parsed.tasks), true);
});

// --- unit: cohesion predicate signals -------------------------------

test('assessTaskCohesion: identical verification + file subset is cohesive', () => {
  const r = assessTaskCohesion(
    { allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
    { allowed_files: ['src/config.js', 'src/session.js'], verification_commands: ['npm test'] },
  );
  assert.equal(r.cohesive, true);
});

test('assessTaskCohesion: disjoint files + disjoint verification is not cohesive', () => {
  const r = assessTaskCohesion(
    { allowed_files: ['src/a.js'], verification_commands: ['npm test -- a'] },
    { allowed_files: ['src/b.js'], verification_commands: ['npm test -- b'] },
  );
  assert.equal(r.cohesive, false);
});

test('assessTaskCohesion: shared verification only, disjoint files -> not merged (needs shared file surface or identical verification set)', () => {
  const r = assessTaskCohesion(
    { allowed_files: ['src/a.js'], verification_commands: ['npm test', 'npm run lint'] },
    { allowed_files: ['src/b.js'], verification_commands: ['npm test', 'npm run typecheck'] },
  );
  // partial verification overlap (jaccard 1/3) + no file overlap -> below bar
  assert.equal(r.cohesive, false);
});

// --- non-adjacent cohesive tasks separated by an independent one ------

test('non-adjacent cohesive tasks are left alone when an independent task sits between them', () => {
  const res = collapseCohesiveTasks([
    { task_id: 'a', goal: 'g', allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
    { task_id: 'mid', goal: 'g', allowed_files: ['src/billing/invoice.js'], verification_commands: ['npm run test:billing'] },
    { task_id: 'c', goal: 'g', allowed_files: ['src/config.js'], verification_commands: ['npm test'] },
  ]);
  // conservative: adjacency-only, order preserved, no reordering to merge a+c
  assert.deepEqual(res.tasks.map((t) => t.task_id), ['a', 'mid', 'c']);
});
