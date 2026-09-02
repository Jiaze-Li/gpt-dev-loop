import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideDeterministically,
  materializePlannedTask,
  validPlannedTasks,
} from '../src/orchestrator/deterministicSupervisorPolicy.js';

const tasks = [
  {
    task_id: 'one',
    goal: 'Implement one',
    scope: 'src/one.js only',
    allowed_files: ['src/one.js'],
    verification_commands: ['node --test test/one.test.js'],
  },
  {
    task_id: 'two',
    goal: 'Implement two',
    scope: 'src/two.js only',
    allowed_files: ['src/two.js'],
    verification_commands: ['node --test test/two.test.js'],
  },
];

const repositoryContext = {
  repository_name: 'demo', repository_url: null, branch: 'main', commit_sha: 'abc',
};

function ctx(overrides = {}) {
  return {
    workflowGoal: 'Do both tasks.',
    repositoryContext,
    history: [],
    latestReviewResult: null,
    ...overrides,
  };
}

test('planned task validation is fail-closed', () => {
  assert.equal(validPlannedTasks(tasks), true);
  assert.equal(validPlannedTasks([]), false);
  assert.equal(validPlannedTasks([{ ...tasks[0], task_id: '' }]), false);
  assert.equal(validPlannedTasks([tasks[0], { ...tasks[1], task_id: 'one' }]), false);
});

test('initial decision selects first Planner task without Supervisor', () => {
  const result = decideDeterministically({ context: ctx(), plannedTasks: tasks });
  assert.equal(result.handled, true);
  assert.equal(result.decision.action, 'NEXT_TASK');
  assert.equal(result.decision.task_card.task_id, 'one');
  assert.deepEqual(result.decision.task_card.repository_context, repositoryContext);
  assert.match(result.decision.task_card.acceptance_criteria[0], /Implement one/);
});

test('Reviewer PASS advances directly to next task then DONE', () => {
  const memory = new Map();
  const next = decideDeterministically({
    context: ctx({
      history: [{ task_id: 'one', decision: 'PASS', attempts: 1 }],
      latestReviewResult: { task_id: 'one', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'ship both',
    reworkMemory: memory,
  });
  assert.equal(next.decision.action, 'NEXT_TASK');
  assert.equal(next.decision.task_card.task_id, 'two');

  const done = decideDeterministically({
    context: ctx({
      history: [
        { task_id: 'one', decision: 'PASS', attempts: 1 },
        { task_id: 'two', decision: 'PASS', attempts: 1 },
      ],
      latestReviewResult: { task_id: 'two', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'ship both',
    reworkMemory: memory,
  });
  assert.deepEqual(done.decision, { action: 'WORKFLOW_DONE', summary: 'ship both' });
});

test('first Gate REWORK returns directly to Executor; identical repeat is blocked (no new information)', () => {
  const memory = new Map();
  const review = {
    task_id: 'one', decision: 'REWORK', source: 'GATE', required_changes: ['Fix failing verification command: npm test'],
  };
  const gate = {
    results: [{ command: 'npm test', pass: false, output: '✖ D. Timeline shows newest-first (1.2ms)\n✖ Q. API /api/focus (3ms)' }],
    diff: 'diff --git a/src/one.js b/src/one.js\n+export const x = 1;\n',
    changed_files: ['src/one.js'],
  };
  const first = decideDeterministically({
    context: ctx({ latestReviewResult: review, latestGateEvidence: gate }),
    plannedTasks: tasks,
    reworkMemory: memory,
  });
  assert.equal(first.handled, true);
  assert.equal(first.decision.action, 'CONTINUE_REWORK');
  assert.equal(first.reason, 'gate_rework');

  const second = decideDeterministically({
    context: ctx({ latestReviewResult: review, latestGateEvidence: gate }),
    plannedTasks: tasks,
    reworkMemory: memory,
  });
  assert.equal(second.handled, true);
  assert.equal(second.decision.action, 'HUMAN_REQUIRED');
  assert.equal(second.reason, 'gate_rework_no_new_information');
  assert.ok(second.decision.noNewInformation.gateFingerprint);
  assert.ok(second.decision.noNewInformation.diffHash);
});

// ── NO NEW INFORMATION -> NO NEW MODEL CALL (Gate-source REWORK) ──────────
function gateReview(overrides = {}) {
  return {
    task_id: 'one',
    decision: 'REWORK',
    source: 'GATE',
    required_changes: ['Fix failing verification command: npm test'],
    ...overrides,
  };
}
function gateEvidence({ output = '✖ Scenario D: resume transitions\n✖ Q. API /api/focus', diff = '+export const x = 1;', files = ['src/one.js'] } = {}) {
  return {
    results: [{ command: 'npm test', pass: false, exitCode: 1, output }],
    diff: `diff --git a/src/one.js b/src/one.js\n${diff}\n`,
    changed_files: files,
  };
}

test('A. same gate fingerprint + same diff hash on the 2nd attempt blocks the 3rd Executor dispatch', () => {
  const memory = new Map();
  const ev = gateEvidence();
  const r1 = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: ev }), plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(r1.decision.action, 'CONTINUE_REWORK');

  const r2 = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: ev }), plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(r2.decision.action, 'HUMAN_REQUIRED');
  assert.equal(r2.reason, 'gate_rework_no_new_information');

  // A 3rd identical decision is still blocked — the loop never dispatches Executor again.
  const r3 = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: ev }), plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(r3.decision.action, 'HUMAN_REQUIRED');
});

test('B. a different gate failure fingerprint is allowed to continue', () => {
  const memory = new Map();
  const a = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: gateEvidence({ output: '✖ test alpha' }) }),
    plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(a.decision.action, 'CONTINUE_REWORK');

  const b = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: gateEvidence({ output: '✖ test beta' }) }),
    plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(b.decision.action, 'CONTINUE_REWORK', 'new failing test set => new information => keep going');
});

test('C. same gate fingerprint but a changed task diff is allowed to continue', () => {
  const memory = new Map();
  const first = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: gateEvidence({ diff: '+export const x = 1;' }) }),
    plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(first.decision.action, 'CONTINUE_REWORK');

  const second = decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: gateEvidence({ diff: '+export const x = 2;' }) }),
    plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(second.decision.action, 'CONTINUE_REWORK', 'the implementation actually changed => not a no-op retry');
});

test('D. a Reviewer REWORK with a new required change is not blocked by a stale gate fingerprint', () => {
  const memory = new Map();
  // Round 1: gate failure recorded.
  decideDeterministically({
    context: ctx({ latestReviewResult: gateReview(), latestGateEvidence: gateEvidence() }), plannedTasks: tasks, reworkMemory: memory,
  });
  // Round 2: gate now passes, Reviewer asks for a concrete new change.
  const reviewer = decideDeterministically({
    context: ctx({ latestReviewResult: { task_id: 'one', decision: 'REWORK', required_changes: ['Add a null check in parse()'] } }),
    plannedTasks: tasks, reworkMemory: memory,
  });
  assert.equal(reviewer.handled, true);
  assert.equal(reviewer.decision.action, 'CONTINUE_REWORK');
  assert.equal(reviewer.reason, 'ordinary_reviewer_rework');
});

test('first Reviewer REWORK is direct; identical non-convergence escalates', () => {
  const memory = new Map();
  const review = {
    task_id: 'one', decision: 'REWORK', required_changes: ['Fix the race condition'],
  };
  const first = decideDeterministically({ context: ctx({ latestReviewResult: review }), plannedTasks: tasks, reworkMemory: memory });
  assert.equal(first.handled, true);
  assert.equal(first.decision.action, 'CONTINUE_REWORK');

  const second = decideDeterministically({ context: ctx({ latestReviewResult: review }), plannedTasks: tasks, reworkMemory: memory });
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'reviewer_rework_nonconvergence');
});

test('Reviewer HUMAN_REQUIRED and plan/history mismatch escalate', () => {
  const human = decideDeterministically({
    context: ctx({ latestReviewResult: { task_id: 'one', decision: 'HUMAN_REQUIRED' } }),
    plannedTasks: tasks,
  });
  assert.equal(human.handled, false);
  assert.equal(human.reason, 'reviewer_human_required');

  const mismatch = decideDeterministically({
    context: ctx({ history: [{ task_id: 'old-task', decision: 'PASS' }] }),
    plannedTasks: tasks,
  });
  assert.equal(mismatch.handled, false);
  assert.equal(mismatch.reason, 'plan_history_mismatch');
});

test('Reviewer OUT_OF_SCOPE closes the task and advances to the next planned task', () => {
  const memory = new Map([['one', 'some prior signature']]);
  const result = decideDeterministically({
    context: ctx({
      latestReviewResult: { task_id: 'one', decision: 'OUT_OF_SCOPE', required_changes: ['touch src/other.js'] },
    }),
    plannedTasks: tasks,
    reworkMemory: memory,
  });
  assert.equal(result.handled, true);
  assert.equal(result.decision.action, 'NEXT_TASK');
  assert.equal(result.decision.task_card.task_id, 'one');
  assert.equal(result.reason, 'review_out_of_scope_next_task');
  // The closed task's rework memory is cleared, exactly as it is on PASS.
  assert.equal(memory.has('one'), false);
});

test('an OUT_OF_SCOPE history entry counts as a completed task (queue advances past it)', () => {
  const next = decideDeterministically({
    context: ctx({
      history: [{ task_id: 'one', decision: 'OUT_OF_SCOPE', attempts: 1 }],
      latestReviewResult: { task_id: 'one', decision: 'OUT_OF_SCOPE', required_changes: ['x'] },
    }),
    plannedTasks: tasks,
  });
  assert.equal(next.decision.action, 'NEXT_TASK');
  assert.equal(next.decision.task_card.task_id, 'two');

  const done = decideDeterministically({
    context: ctx({
      history: [
        { task_id: 'one', decision: 'OUT_OF_SCOPE', attempts: 1 },
        { task_id: 'two', decision: 'PASS', attempts: 1 },
      ],
      latestReviewResult: { task_id: 'two', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'shipped',
  });
  assert.equal(done.decision.action, 'WORKFLOW_DONE');
});

test('OUT_OF_SCOPE closure is honoured deterministically after a persistence reload (no re-execution)', () => {
  // A checkpoint serialized and reloaded through persistence: the first task
  // was closed OUT_OF_SCOPE before the crash. On resume the deterministic
  // policy must advance past it, never re-select it, and reach DONE once the
  // remaining task passes — with no Supervisor call.
  const reloadedHistory = JSON.parse(JSON.stringify([
    { task_id: 'one', decision: 'OUT_OF_SCOPE', attempts: 2, out_of_scope_changes: ['touch src/other.js'] },
  ]));
  const afterReload = decideDeterministically({
    context: ctx({ history: reloadedHistory, latestReviewResult: null }),
    plannedTasks: tasks,
  });
  assert.equal(afterReload.handled, true);
  assert.equal(afterReload.decision.action, 'NEXT_TASK');
  assert.equal(afterReload.decision.task_card.task_id, 'two', 'closed task is not re-selected');

  const done = decideDeterministically({
    context: ctx({
      history: [...reloadedHistory, { task_id: 'two', decision: 'PASS', attempts: 1 }],
      latestReviewResult: { task_id: 'two', decision: 'PASS' },
    }),
    plannedTasks: tasks,
    planSummary: 'shipped',
  });
  assert.equal(done.decision.action, 'WORKFLOW_DONE');
});

test('materialized task preserves explicit acceptance criteria when Planner provides them', () => {
  const card = materializePlannedTask({
    ...tasks[0], acceptance_criteria: ['returns 200', 'rejects invalid input'], forbidden_files: ['src/secret.js'],
  }, { repositoryContext, workflowGoal: 'goal' });
  assert.deepEqual(card.acceptance_criteria, ['returns 200', 'rejects invalid input']);
  assert.deepEqual(card.forbidden_files, ['src/secret.js']);
});

test('deterministic closeout fast path: Gate PASS + Reviewer PASS + queue empty -> deterministic WORKFLOW_DONE without model calls', () => {
  const context = ctx({
    history: [
      { task_id: 'one', decision: 'PASS', attempts: 1 },
      { task_id: 'two', decision: 'PASS', attempts: 1 },
    ],
    latestReviewResult: {
      task_id: 'two',
      decision: 'PASS',
      findings: ['Everything verified cleanly'],
      required_changes: [],
    },
    plannedTasks: tasks,
    planSummary: 'All tasks completed successfully',
  });

  const result = decideDeterministically({ context, plannedTasks: tasks });
  assert.equal(result.handled, true);
  assert.equal(result.reason, 'all_planned_tasks_passed');
  assert.equal(result.decision.action, 'WORKFLOW_DONE');
  assert.equal(result.decision.summary, 'All tasks completed successfully');
});
