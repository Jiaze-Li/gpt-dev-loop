import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { callAgy } from '../src/agy/agyClient.js';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('callAgy disables agy auto-update for its owned subprocess without dropping inherited env', async () => {
  const marker = '__reviewloop_agy_disable_auto_update_probe__';
  process.env[marker] = 'inherited-value';

  let capturedEnv = null;
  const spawn = (_command, _args, options) => {
    capturedEnv = options.env;
    const child = fakeChild();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok' })));
      child.emit('close', 0);
    });
    return child;
  };

  try {
    await callAgy({ prompt: 'ping', spawn });
  } finally {
    delete process.env[marker];
  }

  assert.equal(
    capturedEnv.AGY_CLI_DISABLE_AUTO_UPDATE,
    'true',
    'agy subprocess must get the documented true value, not 1',
  );
  assert.equal(
    capturedEnv[marker],
    'inherited-value',
    'spawn env must inherit process.env rather than replacing it',
  );
});
