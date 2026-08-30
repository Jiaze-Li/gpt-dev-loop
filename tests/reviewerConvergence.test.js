import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewerReworkNonConvergence } from '../src/orchestrator/automatedLoop.js';

test('repeated structured reviewer finding after a passing gate emits local non-convergence diagnostic', () => {
  const oldFinding = { decision: 'REWORK', required_changes: ['Add validation to src/auth.js'] };
  const repeated = { decision: 'REWORK', required_changes: [' add  validation to src/auth.js '] };
  assert.equal(reviewerReworkNonConvergence(oldFinding, repeated, { pass: true }), true);
  assert.equal(reviewerReworkNonConvergence(oldFinding, repeated, { pass: false }), false);
});
