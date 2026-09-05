import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSuperGptRequest } from '../src/control/requestCompiler.js';

test('non-closeout goal carries a null pr_closeout annotation', () => {
  const request = compileSuperGptRequest({ goal: 'Implement authentication', cwd: '/tmp/example' });
  assert.equal(request.pr_closeout, null);
});

test('PR closeout natural language is recognized and annotated deterministically', () => {
  const request = compileSuperGptRequest({
    goal: 'closeout owner/repo PR #123',
    cwd: '/tmp/example',
    mode: 'execute',
  });
  assert.equal(request.schema, 'supergpt.request/v1');
  assert.ok(request.pr_closeout);
  assert.equal(request.pr_closeout.pr_number, 123);
  assert.equal(request.pr_closeout.repository, 'owner/repo');
  assert.equal(request.pr_closeout.ambiguous_repository, false);
});

for (const frontend of ['generic', 'gemini', 'claude', 'codex']) {
  test(`${frontend} natural language converges on supergpt.request/v1`, () => {
    const request = compileSuperGptRequest({ goal: 'Use SuperGPT to implement authentication', cwd: '/tmp/example', mode: 'execute' });
    assert.equal(request.schema, 'supergpt.request/v1');
    assert.equal(request.goal, 'Use SuperGPT to implement authentication');
    assert.equal(request.workspace, '/tmp/example');
    assert.equal(request.execution_mode, 'execute');
  });
}
