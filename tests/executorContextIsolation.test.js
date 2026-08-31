import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, measureExecutorInputBreakdown } from '../src/orchestrator/adapters/claudeExecutorAdapter.js';
import { buildExecutorHandoff, executorRelevantPaths } from '../src/orchestrator/workflowContext.js';

function card(extra = {}) {
  return {
    task_id: 'current-task',
    repository_context: { repository_name: 'repo', repository_url: null, branch: 'main', commit_sha: 'abc' },
    goal: 'change current file', context: 'current task context', scope: 'one file',
    allowed_files: ['src/current.js'], forbidden_files: [], acceptance_criteria: ['works'],
    verification_commands: ['node --test tests/current.test.js'], completion_signal: 'DONE',
    ...extra,
  };
}

test('executor prompt excludes raw workflow history, transcripts, diffs, and unrelated evidence', () => {
  const huge = 'UNRELATED_PRIOR_TRANSCRIPT_'.repeat(5000);
  const prompt = buildPrompt(card({
    history: [{ transcript: huge }],
    previous_executor_transcript: huge,
    workflow_history: huge,
    evidence: { diff: huge, results: [{ output: huge }] },
    git_diff: huge,
  }));
  assert.doesNotMatch(prompt, /UNRELATED_PRIOR_TRANSCRIPT_/);
  assert.ok(Buffer.byteLength(prompt) < 20_000);
});

test('structured handoff keeps corrections and only task-relevant repository snapshots', () => {
  const taskCard = card({
    rework_feedback: { findings: ['edge case'], required_changes: ['fix edge case'], rationale: 'review' },
    supervisor_guidance: 'preserve the public API',
    auxiliary_snapshots: [
      { original_path: 'src/current.js', snapshot_path: '.aux/current.js', sha256: 'a', read_only: true },
      { original_path: 'src/unrelated.js', snapshot_path: '.aux/unrelated.js', sha256: 'b', read_only: true },
    ],
  });
  const handoff = buildExecutorHandoff(taskCard);
  assert.deepEqual(executorRelevantPaths(taskCard), ['src/current.js']);
  assert.deepEqual(handoff.corrections.required_changes, ['fix edge case']);
  assert.equal(handoff.supervisor_guidance, 'preserve the public API');
  assert.deepEqual(handoff.repository_snapshots.map((item) => item.original_path), ['src/current.js']);
  assert.doesNotMatch(JSON.stringify(handoff), /unrelated/);
});

test('breakdown measures the final serialized compact prompt and reconciles categories by bytes', () => {
  const taskCard = card({ rework_feedback: { required_changes: ['fix it'] } });
  const prompt = buildPrompt(taskCard);
  const breakdown = measureExecutorInputBreakdown(taskCard, prompt);
  const categoryBytes = Object.values(breakdown.categories).reduce((sum, value) => sum + value.bytes, 0);
  assert.equal(categoryBytes, breakdown.serialized.bytes);
  assert.ok(breakdown.categories.history.bytes > 0);
  assert.equal(breakdown.categories.evidence.bytes, 0);
});
