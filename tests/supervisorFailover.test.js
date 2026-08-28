import test from 'node:test';
import assert from 'node:assert/strict';
import { createFailoverSupervisorSession } from '../src/orchestrator/supervisorFailover.js';

test('quota failure switches Supervisor without losing the logical workflow context', async () => {
  const events = []; let received;
  const session = createFailoverSupervisorSession({
    providers: [
      { name: 'gemini', session: { async decide() { const e = new Error('quota'); e.details = { providerFailure: 'PROVIDER_QUOTA_EXHAUSTED' }; throw e; } } },
      { name: 'codex', session: { async decide(context) { received = context; return { action: 'WORKFLOW_DONE', summary: 'done' }; } } },
    ],
    onEvent: (event) => events.push(event),
  });
  const decision = await session.decide({ workflowGoal: 'ship', history: [{ task_id: 'one', decision: 'PASS', attempts: 1 }], latestReviewResult: null });
  assert.equal(decision.action, 'WORKFLOW_DONE');
  assert.equal(session.provider, 'codex');
  assert.equal(received.checkpoint.completed_tasks[0].task_id, 'one');
  assert.deepEqual(events.map((e) => e.type), ['SUPERVISOR_PROVIDER_FAILED', 'SUPERVISOR_PROVIDER_SWITCHED']);
});
