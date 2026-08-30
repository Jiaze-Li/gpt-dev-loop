import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgySupervisorSession,
  createAgyReviewerSessionFactory,
  createAgyProviderSessionStore,
} from '../src/orchestrator/agyProviderSessions.js';

test('supervisor context rotation: rotates after maxTurns and passes structured checkpoint', async () => {
  const store = createAgyProviderSessionStore();
  const promptsSeen = [];
  let convCounter = 0;

  const mockProvider = {
    model: 'gemini-3.7-flash-high',
    async decide(context, { conversationId } = {}) {
      promptsSeen.push({ context, conversationId });
      const cid = conversationId || `sup-conv-${++convCounter}`;
      return {
        action: 'NEXT_TASK',
        task_card: {
          task_id: `task-${convCounter}`,
          repository_context: { repository_name: 'test', branch: 'main', commit_sha: '123' },
          goal: 'goal',
          context: 'ctx',
          scope: 'all',
          allowed_files: ['src/**'],
          forbidden_files: [],
          acceptance_criteria: ['done'],
          verification_commands: ['npm test'],
          completion_signal: 'DONE',
        },
        conversationId: cid,
        usage: { input_tokens: 500, output_tokens: 100 },
      };
    },
  };

  // maxTurns = 2 for quick testing
  const supervisor = createAgySupervisorSession(mockProvider, { store, maxTurns: 2 });

  // Turn 1: fresh conversation
  await supervisor.decide({
    workflowGoal: 'build feature',
    history: [],
    latestReviewResult: null,
  });
  assert.equal(promptsSeen.length, 1);
  assert.equal(promptsSeen[0].conversationId, undefined);
  assert.equal(supervisor.conversationId, 'sup-conv-1');

  // Turn 2: resumes conversation sup-conv-1
  await supervisor.decide({
    workflowGoal: 'build feature',
    history: [{ task_id: 'task-1', decision: 'PASS', attempts: 1 }],
    latestReviewResult: null,
  });
  assert.equal(promptsSeen.length, 2);
  assert.equal(promptsSeen[1].conversationId, 'sup-conv-1');

  // Turn 3: reaches maxTurns -> triggers rotation!
  await supervisor.decide({
    workflowGoal: 'build feature',
    history: [
      { task_id: 'task-1', decision: 'PASS', attempts: 1 },
      { task_id: 'task-2', decision: 'PASS', attempts: 1 },
    ],
    latestReviewResult: null,
  });
  assert.equal(promptsSeen.length, 3);
  // Must NOT pass old conversation ID:
  assert.equal(promptsSeen[2].conversationId, undefined);
  // New conversation ID established:
  assert.equal(supervisor.conversationId, 'sup-conv-2');
  // Checkpoint was provided in context:
  assert.ok(promptsSeen[2].context.checkpoint);
  assert.equal(promptsSeen[2].context.checkpoint.overall_goal, 'build feature');
  assert.equal(promptsSeen[2].context.checkpoint.completed_tasks.length, 2);

  // Check store rotations recorded:
  const rotations = await store.getSupervisorRotations();
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].from, 'sup-conv-1');
  assert.equal(rotations[0].to, 'sup-conv-2');
});

test('reviewer continuity is structured and does not resume opaque provider transcripts', async () => {
  const store = createAgyProviderSessionStore();
  const promptsSeen = [];
  let convCounter = 0;

  const mockProvider = {
    model: 'gpt-oss-120b-medium',
    async review(taskCard, executionReport, evidence, { attempt, conversationId, checkpoint } = {}) {
      promptsSeen.push({ attempt, conversationId, checkpoint });
      const cid = conversationId || `rev-conv-${++convCounter}`;
      return {
        task_id: taskCard.task_id,
        decision: attempt < 3 ? 'REWORK' : 'PASS',
        findings: ['defect found'],
        required_changes: attempt < 3 ? ['fix edge case in parser'] : 'none',
        rationale: 'needs fix',
        conversationId: cid,
        usage: { input_tokens: 800, output_tokens: 150 },
      };
    },
  };

  // Every review is a fresh call; only compact prior changes carry forward.
  const reviewerFactory = createAgyReviewerSessionFactory(mockProvider, { store, maxReworkTurns: 1 });
  const reviewer = reviewerFactory();

  const dummyCard = {
    task_id: 'rework-task',
    acceptance_criteria: ['parser handles edge cases'],
  };
  const dummyReport = { task_id: 'rework-task', status: 'DONE' };
  const dummyEvidence = { pass: true };

  // Attempt 1: fresh
  await reviewer.review('rework-task', dummyCard, dummyReport, dummyEvidence);
  assert.equal(promptsSeen[0].conversationId, undefined);
  assert.equal(reviewer.conversationId, null);

  // Attempt 2 receives structured continuity, never a conversation id.
  await reviewer.review('rework-task', dummyCard, dummyReport, dummyEvidence);
  assert.equal(promptsSeen[1].conversationId, undefined);
  assert.deepEqual(promptsSeen[1].checkpoint.prior_required_changes, ['fix edge case in parser']);

  // Attempt 3 remains fresh too.
  await reviewer.review('rework-task', dummyCard, dummyReport, dummyEvidence);
  assert.equal(promptsSeen[2].conversationId, undefined);
  assert.equal(reviewer.conversationId, null);
  assert.ok(promptsSeen[2].checkpoint);
  assert.deepEqual(promptsSeen[2].checkpoint.prior_required_changes, ['fix edge case in parser']);

  const rotations = await store.getReviewerRotations('rework-task');
  assert.equal(rotations.length, 0);
});
