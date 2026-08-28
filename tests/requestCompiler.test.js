import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSuperGptRequest } from '../src/control/requestCompiler.js';

for (const frontend of ['generic', 'gemini', 'claude', 'codex']) {
  test(`${frontend} natural language converges on supergpt.request/v1`, () => {
    const request = compileSuperGptRequest({ goal: 'Use SuperGPT to implement authentication', cwd: '/tmp/example', mode: 'execute' });
    assert.equal(request.schema, 'supergpt.request/v1');
    assert.equal(request.goal, 'Use SuperGPT to implement authentication');
    assert.equal(request.workspace, '/tmp/example');
    assert.equal(request.execution_mode, 'execute');
  });
}
