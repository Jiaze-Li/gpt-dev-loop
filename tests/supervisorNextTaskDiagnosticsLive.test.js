import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDecideFailure } from '../scripts/test-supervisor-next-task-diagnostics-live.js';
import { AdapterError, ADAPTER_ERROR_CODES } from '../src/orchestrator/errors.js';
import { ResponseTimeoutError, ChromeUnavailableError } from '../src/bridge/errors.js';

// --keep-open-on-failure must preserve the tab on a NEXT_TASK parse failure
// (already covered live) AND on a transport-level failure like
// RESPONSE_TIMEOUT — the live report that prompted this file was exactly a
// RESPONSE_TIMEOUT that closed the tab before it could be inspected by hand.

test('classifyDecideFailure treats a NEXT_TASK parse failure as keepable', () => {
  const err = new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, 'missing @@ repository_context marker');
  const result = classifyDecideFailure(err);
  assert.equal(result.keepable, true);
  assert.equal(result.message, 'missing @@ repository_context marker');
});

test('classifyDecideFailure treats a RESPONSE_TIMEOUT transport failure as keepable', () => {
  const err = new ResponseTimeoutError('Assistant response did not finish within 20000ms.');
  const result = classifyDecideFailure(err);
  assert.equal(result.keepable, true);
  assert.equal(result.message, 'Assistant response did not finish within 20000ms.');
});

test('classifyDecideFailure treats other TransportError subclasses as keepable too', () => {
  const err = new ChromeUnavailableError('Chrome is not reachable.');
  const result = classifyDecideFailure(err);
  assert.equal(result.keepable, true);
});

test('classifyDecideFailure treats an unrelated error as not keepable (propagates/crashes as before)', () => {
  const err = new Error('some unrelated bug');
  const result = classifyDecideFailure(err);
  assert.equal(result.keepable, false);
  assert.equal(result.message, null);
});
