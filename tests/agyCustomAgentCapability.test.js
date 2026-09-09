// Effective-loading verification for the isolated `reviewloop-minimal` AGY agent.
//
// Root cause this guards against: agy silently falls back to its ambient default
// agent when `--agent reviewloop-minimal` cannot be resolved. "The agent file
// exists" is NOT proof the review ran isolated. These tests pin:
//   - verifyEffectiveAgyAgent() log parsing (activated / fell-back / no marker)
//   - detectAgyCustomAgentSupport() startup probe (supported / unsupported /
//     flag-rejected / timed out), zero real model turns
//   - pool wiring: unsupported capability -> AGY families fail closed, never a
//     default-agent call
//   - pool per-call: an agy run that fell back to the default agent raises and
//     is NOT returned as a usable result
//   - pool per-call: a verified-isolated run is allowed through
//
// No real spawns, no real model calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';

import {
  verifyEffectiveAgyAgent,
  detectAgyCustomAgentSupport,
} from '../src/reviewloop/adapters/agyCustomAgentCapability.js';
import { MINIMAL_AGY_AGENT_NAME } from '../src/reviewloop/adapters/minimalAgyAgent.js';
import { createReviewLoopProviderPool } from '../src/reviewloop/providerWiring.js';

const ACTIVATED = 'conversation_manager.go:429] Starting new conversation (agent=true)';
const FELL_BACK = [
  'session.go:81] Agent "reviewloop-minimal" not found, falling back to default',
  'conversation_manager.go:429] Starting new conversation (agent=false)',
].join('\n');

// ---- verifyEffectiveAgyAgent -------------------------------------------------

test('verifyEffectiveAgyAgent: activation marker -> verified', () => {
  const v = verifyEffectiveAgyAgent({ logText: `noise\n${ACTIVATED}\nmore`, agentName: MINIMAL_AGY_AGENT_NAME });
  assert.equal(v.verified, true);
});

test('verifyEffectiveAgyAgent: explicit fallback -> not verified', () => {
  const v = verifyEffectiveAgyAgent({ logText: FELL_BACK, agentName: MINIMAL_AGY_AGENT_NAME });
  assert.equal(v.verified, false);
  assert.match(v.reason, /fell back to the default agent/);
});

test('verifyEffectiveAgyAgent: agent=false without the not-found line -> not verified', () => {
  const v = verifyEffectiveAgyAgent({ logText: 'Starting new conversation (agent=false)', agentName: MINIMAL_AGY_AGENT_NAME });
  assert.equal(v.verified, false);
  assert.match(v.reason, /agent=false/);
});

test('verifyEffectiveAgyAgent: empty / missing log -> not verified (fail closed)', () => {
  assert.equal(verifyEffectiveAgyAgent({ logText: '', agentName: MINIMAL_AGY_AGENT_NAME }).verified, false);
  assert.equal(verifyEffectiveAgyAgent({ logText: undefined, agentName: MINIMAL_AGY_AGENT_NAME }).verified, false);
});

test('verifyEffectiveAgyAgent: a log with no agent marker at all -> not verified', () => {
  const v = verifyEffectiveAgyAgent({ logText: 'started\nauthenticated\nstreaming', agentName: MINIMAL_AGY_AGENT_NAME });
  assert.equal(v.verified, false);
  assert.match(v.reason, /did not confirm/);
});

// ---- detectAgyCustomAgentSupport (fake spawn, zero model turns) -------------

function fakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.pid = 999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    const r = handler({ command, args }) ?? {};
    queueMicrotask(() => {
      if (r.spawnError) { child.emit('error', Object.assign(new Error('x'), { code: r.spawnError })); return; }
      const i = args.indexOf('--log-file');
      if (i !== -1 && r.log != null) writeFileSync(args[i + 1], r.log);
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function withGeminiDir(fn) {
  const gd = mkdtempSync(path.join(os.tmpdir(), 'reviewloop-cap-'));
  return Promise.resolve(fn(gd)).finally(() => rmSync(gd, { recursive: true, force: true }));
}

test('detect: provisions the real agent file, probes with --gemini_dir + --agent, activation marker -> supported', async () => {
  await withGeminiDir(async (gd) => {
    const spawn = fakeSpawn(() => ({ log: ACTIVATED, stdout: '{"event":"init"}\n' }));
    const res = await detectAgyCustomAgentSupport({ geminiDir: gd, spawn });
    assert.equal(res.supported, true);
    // the probe really provisioned the agent under the gemini dir
    assert.ok(existsSync(path.join(gd, 'config', 'agents', MINIMAL_AGY_AGENT_NAME, 'agent.md')));
    const { args } = spawn.calls[0];
    assert.ok(args.includes(`--gemini_dir=${gd}`), '--gemini_dir attached');
    assert.equal(args[args.indexOf('--agent') + 1], MINIMAL_AGY_AGENT_NAME);
    assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  });
});

test('detect: agy falls back to the default agent -> unsupported', async () => {
  await withGeminiDir(async (gd) => {
    const spawn = fakeSpawn(() => ({ log: FELL_BACK }));
    const res = await detectAgyCustomAgentSupport({ geminiDir: gd, spawn });
    assert.equal(res.supported, false);
    assert.match(res.reason, /did not load the isolated agent/);
  });
});

test('detect: this agy build rejects --gemini_dir -> unsupported (never a hard-coded assumption)', async () => {
  await withGeminiDir(async (gd) => {
    const spawn = fakeSpawn(() => ({ code: 2, stderr: 'flags provided but not defined: -gemini_dir' }));
    const res = await detectAgyCustomAgentSupport({ geminiDir: gd, spawn });
    assert.equal(res.supported, false);
    assert.match(res.reason, /does not accept --gemini_dir/);
  });
});

test('detect: agy binary missing -> unsupported, no throw', async () => {
  await withGeminiDir(async (gd) => {
    const spawn = fakeSpawn(() => ({ spawnError: 'ENOENT' }));
    const res = await detectAgyCustomAgentSupport({ geminiDir: gd, spawn });
    assert.equal(res.supported, false);
    assert.match(res.reason, /not found/);
  });
});

test('detect: provisioning failure -> unsupported, probe never spawned', async () => {
  const spawn = fakeSpawn(() => ({ log: ACTIVATED }));
  const res = await detectAgyCustomAgentSupport({
    geminiDir: '/tmp/whatever', spawn,
    provision: () => { throw new Error('boom'); },
  });
  assert.equal(res.supported, false);
  assert.equal(spawn.calls.length, 0);
});

// ---- pool wiring: capability gate + per-call verification ------------------

function poolWith({ customAgentSupport, callAgy }) {
  return createReviewLoopProviderPool({ callAgy, customAgentSupport });
}

test('pool: agent missing / capability unsupported -> AGY families UNAVAILABLE, never a default-agent call', () => {
  let called = false;
  const pool = poolWith({
    customAgentSupport: { supported: false, reason: 'agy fell back to the default agent' },
    callAgy: async () => { called = true; return { text: '{"findings":[]}' }; },
  });
  for (const f of ['agy:gemini-reviewer', 'agy:gemini-supervisor', 'agy:gpt-oss', 'agy:sonnet', 'agy:opus']) {
    assert.equal(pool.runtimeStatus[f].runtimeAvailable, false);
    assert.equal(pool.transports[f], undefined);
    assert.match(pool.runtimeStatus[f].reason, /does not load the isolated reviewloop-minimal agent/);
  }
  assert.equal(pool.route('reviewer'), null);
  assert.equal(pool.route('supervisor', { allowHighContext: true }), null);
  assert.equal(called, false);
});

test('pool: capability supported but a call fell back to the default agent -> raises, result not usable, AGY marked unavailable', async () => {
  const pool = poolWith({
    customAgentSupport: { supported: true, reason: 'ok' },
    // simulate agy writing a "fell back" log for this call
    callAgy: async (opts) => {
      if (opts?.logFile) writeFileSync(opts.logFile, FELL_BACK);
      return { text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const sel = pool.route('reviewer');
  assert.ok(sel.family.startsWith('agy:'));
  await assert.rejects(
    () => sel.transport('P'),
    (err) => err.code === 'AGY_ISOLATION_UNVERIFIED' && /unverified/.test(err.message),
  );
  // the whole AGY pool is now fenced off so bounded failover routes AWAY
  for (const f of ['agy:gemini-reviewer', 'agy:gemini-supervisor', 'agy:gpt-oss', 'agy:sonnet', 'agy:opus']) {
    const role = (f === 'agy:gpt-oss' || f === 'agy:gemini-reviewer' || f === 'agy:opus') ? 'reviewer' : 'supervisor';
    assert.equal(pool.route(role, { allowHighContext: true })?.family?.startsWith('agy:') ?? false, false);
  }
});

test('pool: capability supported and the call is verified isolated -> allowed through', async () => {
  const seen = [];
  const pool = poolWith({
    customAgentSupport: { supported: true, reason: 'ok' },
    callAgy: async (opts) => {
      seen.push(opts);
      if (opts?.logFile) writeFileSync(opts.logFile, ACTIVATED);
      return { text: '{"findings":[]}', usage: { input_tokens: 2, output_tokens: 1 } };
    },
  });
  const sel = pool.route('reviewer');
  const res = await sel.transport('P');
  assert.match(res.text, /findings/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent, MINIMAL_AGY_AGENT_NAME);
  assert.ok(typeof seen[0].geminiDir === 'string' && seen[0].geminiDir.length > 0);
  assert.ok(typeof seen[0].logFile === 'string' && seen[0].logFile.length > 0);
  assert.equal(pool.runtimeStatus['agy:gemini-reviewer'].effectiveLoadingVerified, true);
});

test('pool: no capability verdict (null) -> AGY wired, per-call verification skipped (inspection/test mode)', async () => {
  const seen = [];
  const pool = poolWith({ customAgentSupport: null, callAgy: async (opts) => { seen.push(opts); return { text: '{"findings":[]}' }; } });
  const sel = pool.route('reviewer');
  await sel.transport('P');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].logFile, undefined, 'no --log-file requested when not enforcing');
  assert.equal(pool.runtimeStatus['agy:gemini-reviewer'].effectiveLoadingVerified, false);
});
