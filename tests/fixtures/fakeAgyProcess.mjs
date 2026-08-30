// Deterministic fake for node:child_process spawn(), used by
// tests/agyClient.test.js. No real `agy` process is ever started.
import { EventEmitter } from 'node:events';

class FakeStream extends EventEmitter {}

export function makeFakeSpawn(behavior) {
  const calls = [];
  function spawn(executable, args, options) {
    calls.push({ executable, args, options });

    if (behavior.throwOnSpawn) {
      throw behavior.throwOnSpawn;
    }

    const child = new EventEmitter();
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();
    let killed = false;
    child.kill = (signal) => { killed = true; child.killedWith = signal; return true; };
    Object.defineProperty(child, 'killed', { get: () => killed });

    queueMicrotask(() => {
      if (behavior.emitError) {
        child.emit('error', behavior.emitError);
        return;
      }
      if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout));
      if (behavior.stderr) child.stderr.emit('data', Buffer.from(behavior.stderr));
      if (behavior.hang) return; // never emits 'close' -> exercises timeout
      child.emit('close', behavior.code ?? 0);
    });

    return child;
  }
  spawn.calls = calls;
  return spawn;
}
