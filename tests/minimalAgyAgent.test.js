// The dedicated workspace-local `reviewloop-minimal` AGY custom agent:
// deterministic + idempotent provisioning, HOME/global-config safety, and
// fail-closed wiring (a provisioning failure must NEVER fall back to AGY's
// ambient default agent). Zero real provider calls, zero real process spawns.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  provisionMinimalAgyAgent,
  MinimalAgyAgentProvisionError,
  MINIMAL_AGY_AGENT_NAME,
  MINIMAL_AGY_AGENT_RELATIVE_PATH,
  MINIMAL_AGY_AGENT_MARKDOWN,
} from '../src/reviewloop/adapters/minimalAgyAgent.js';
import { createReviewLoopProviderPool, narrowReviewTransportCwd } from '../src/reviewloop/providerWiring.js';

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), 'reviewloop-minimal-agent-'));
}

test('provisioning writes .agents/agents/reviewloop-minimal/agent.md into the given workspace', () => {
  const cwd = scratch();
  try {
    const res = provisionMinimalAgyAgent({ cwd });
    assert.equal(res.name, MINIMAL_AGY_AGENT_NAME);
    assert.equal(res.relativePath, MINIMAL_AGY_AGENT_RELATIVE_PATH);
    assert.equal(res.path, path.join(cwd, '.agents', 'agents', 'reviewloop-minimal', 'agent.md'));
    assert.equal(res.wrote, true);
    assert.equal(readFileSync(res.path, 'utf8'), MINIMAL_AGY_AGENT_MARKDOWN);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the definition disables inherited customizations', () => {
  assert.match(MINIMAL_AGY_AGENT_MARKDOWN, /^inheritCustomizations: false$/m);
  assert.match(MINIMAL_AGY_AGENT_MARKDOWN, /^inheritMcp: false$/m);
  // explicit empty capability lists (belt-and-suspenders across agy versions)
  for (const key of ['tools', 'skills', 'agents', 'plugins', 'rules']) {
    assert.match(MINIMAL_AGY_AGENT_MARKDOWN, new RegExp(`^${key}: \\[\\]$`, 'm'));
  }
  assert.match(MINIMAL_AGY_AGENT_MARKDOWN, /Do not call any tool/);
});

test('provisioning is idempotent — a second run does not rewrite identical content', () => {
  const cwd = scratch();
  try {
    assert.equal(provisionMinimalAgyAgent({ cwd }).wrote, true);
    assert.equal(provisionMinimalAgyAgent({ cwd }).wrote, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('provisioning refuses to write into HOME or a global-config tree', () => {
  const home = os.homedir();
  for (const target of [home, path.join(home, '.gemini'), path.join(home, '.gemini', 'agents'),
    path.join(home, '.config', 'whatever'), path.join(home, '.antigravity')]) {
    assert.throws(
      () => provisionMinimalAgyAgent({ cwd: target }),
      (err) => err instanceof MinimalAgyAgentProvisionError && /refusing to provision/.test(err.message),
      `expected refusal for ${target}`,
    );
  }
});

test('provisioning surfaces a typed error (never a partial success) on a filesystem failure', () => {
  const cwd = scratch();
  try {
    const fs = {
      mkdirSync() {},
      readFileSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      writeFileSync() { throw new Error('EACCES: read-only file system'); },
    };
    assert.throws(
      () => provisionMinimalAgyAgent({ cwd, fs }),
      (err) => err instanceof MinimalAgyAgentProvisionError && err.code === 'AGY_MINIMAL_AGENT_PROVISION_FAILED',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('pool: both AGY families are wired through --agent reviewloop-minimal, from the isolated scratch cwd', async () => {
  const seen = [];
  const pool = createReviewLoopProviderPool({
    callAgy: async (opts) => { seen.push(opts); return { text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }; },
  });

  const reviewer = pool.route('reviewer');
  const supervisor = pool.route('supervisor', { allowHighContext: true });
  assert.ok(reviewer.family.startsWith('agy:'));
  await reviewer.transport('REVIEW PROMPT');
  await supervisor.transport('SUPERVISE PROMPT');

  assert.equal(seen.length, 2);
  for (const opts of seen) {
    assert.equal(opts.agent, MINIMAL_AGY_AGENT_NAME);
    assert.equal(opts.cwd, narrowReviewTransportCwd());
    assert.equal(opts.disableSlashCommands, true);
    assert.equal(opts.conversationId, undefined);
  }
  // the agent file really exists in the scratch workspace the transport runs from
  assert.ok(existsSync(path.join(narrowReviewTransportCwd(), MINIMAL_AGY_AGENT_RELATIVE_PATH)));
});

test('pool: production argv (via agyClient) contains --agent reviewloop-minimal', async () => {
  const { callAgy } = await import('../src/agy/agyClient.js');
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    // minimal fake child
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ result: '{"findings":[]}', conversation_id: 'c1' })));
      child.emit('close', 0);
    });
    return child;
  };

  const pool = createReviewLoopProviderPool({
    callAgy: (opts) => callAgy({ ...opts, spawn: fakeSpawn }),
  });
  await pool.route('reviewer').transport('P');

  const { args } = calls[0];
  const i = args.indexOf('--agent');
  assert.notEqual(i, -1, 'argv must carry --agent');
  assert.equal(args[i + 1], 'reviewloop-minimal');
});

test('fail closed: provisioning failure marks both AGY families UNAVAILABLE, never falls back to the default agent', () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({ text: '{"findings":[]}' }),
    provisionMinimalAgent: () => { throw new MinimalAgyAgentProvisionError('boom'); },
    // no CLI runtime -> codex/claude also unavailable, so the whole pool is empty
    transportRuntime: null,
  });

  for (const family of ['agy:gemini', 'agy:gpt-oss']) {
    assert.equal(pool.runtimeStatus[family].runtimeAvailable, false);
    assert.match(pool.runtimeStatus[family].reason, /fail-closed: reviewloop-minimal agent provisioning failed/);
    assert.equal(pool.transports[family], undefined);
  }
  // nothing selectable -> no phantom default-agent AGY transport
  assert.equal(pool.route('reviewer'), null);
  assert.equal(pool.route('supervisor', { allowHighContext: true }), null);
});

test('fail closed: with CLI runtime available, a provisioning failure still routes AWAY from AGY (to codex), not to a default AGY agent', () => {
  const pool = createReviewLoopProviderPool({
    callAgy: async () => ({ text: '{"findings":[]}' }),
    provisionMinimalAgent: () => { throw new MinimalAgyAgentProvisionError('boom'); },
    transportRuntime: { 'codex:default': { available: true, reason: 'ok' }, 'claude:opus': { available: false, reason: 'x' } },
    spawn: () => { throw new Error('no real spawn in this test'); },
  });
  const sel = pool.route('reviewer');
  assert.equal(sel.family, 'codex:default');
  assert.equal(pool.transports['agy:gpt-oss'], undefined);
  assert.equal(pool.transports['agy:gemini'], undefined);
});
