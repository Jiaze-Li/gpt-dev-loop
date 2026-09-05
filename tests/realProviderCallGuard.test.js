// Developer/test/diagnostic real-provider-call guard — regression suite.
//
// REAL MODEL CALLS = 0. Every case below runs with
// SUPERGPT_ALLOW_REAL_PROVIDER_CALLS unset/false and asserts the guard blocks
// before any provider boundary; the one authorized-branch case mocks the
// dispatch entirely so it never reaches a real provider either.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REAL_PROVIDER_CALL_ENV,
  REAL_PROVIDER_CALL_FLAG,
  REAL_PROVIDER_CALL_NOT_AUTHORIZED,
  realProviderCallsAuthorized,
  assertRealProviderCallsAuthorized,
  RealProviderCallNotAuthorizedError,
  REAL_PROVIDER_CALL_ENTRYPOINTS,
} from '../src/orchestrator/realProviderCallGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Ensure this suite itself never accidentally inherits a live opt-in from the
// ambient environment.
test.beforeEach(() => {
  delete process.env[REAL_PROVIDER_CALL_ENV];
});

// ── 1-4: guard helper truth table ─────────────────────────────────────────

test('guard: no env, CLI intent true -> DENY', () => {
  assert.equal(
    realProviderCallsAuthorized({ env: {}, explicitLiveIntent: true }),
    false,
  );
  assert.throws(
    () => assertRealProviderCallsAuthorized({ env: {}, explicitLiveIntent: true, entrypoint: 'test' }),
    RealProviderCallNotAuthorizedError,
  );
});

test('guard: env=1 only, CLI intent false -> DENY', () => {
  const env = { [REAL_PROVIDER_CALL_ENV]: '1' };
  assert.equal(realProviderCallsAuthorized({ env, explicitLiveIntent: false }), false);
  assert.throws(
    () => assertRealProviderCallsAuthorized({ env, explicitLiveIntent: false, entrypoint: 'test' }),
    RealProviderCallNotAuthorizedError,
  );
});

test('guard: CLI intent only, env absent -> DENY', () => {
  assert.equal(realProviderCallsAuthorized({ env: {}, explicitLiveIntent: true }), false);
});

test('guard: both conditions -> ALLOW (mock dispatch only, zero real provider calls)', () => {
  const env = { [REAL_PROVIDER_CALL_ENV]: '1' };
  assert.equal(realProviderCallsAuthorized({ env, explicitLiveIntent: true }), true);
  assert.doesNotThrow(() =>
    assertRealProviderCallsAuthorized({ env, explicitLiveIntent: true, entrypoint: 'test' }),
  );

  // Mock dispatch boundary — proves the *shape* of the authorized branch
  // without ever touching a real provider.
  let mockDispatchCalls = 0;
  const mockCallAgy = () => { mockDispatchCalls += 1; return { exitCode: 0 }; };
  assertRealProviderCallsAuthorized({ env, explicitLiveIntent: true, entrypoint: 'test' });
  mockCallAgy();
  assert.equal(mockDispatchCalls, 1);
});

// Thrown error carries the stable code and never leaks credentials/env dump.
test('guard: thrown error carries REAL_PROVIDER_CALL_NOT_AUTHORIZED and no secret leakage', () => {
  try {
    assertRealProviderCallsAuthorized({
      env: { [REAL_PROVIDER_CALL_ENV]: '', SOME_API_KEY: 'sk-should-not-appear' },
      explicitLiveIntent: false,
      entrypoint: 'test-entry',
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, REAL_PROVIDER_CALL_NOT_AUTHORIZED);
    assert.match(err.message, /REAL_PROVIDER_CALL_NOT_AUTHORIZED/);
    assert.match(err.message, /SUPERGPT_ALLOW_REAL_PROVIDER_CALLS=1/);
    assert.doesNotMatch(err.message, /sk-should-not-appear/);
  }
});

// ── 5: scripts/test-agy-live.js accidental execution ──────────────────────

test('scripts/test-agy-live.js: unauthorized direct execution exits non-zero and never reaches agy', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts/test-agy-live.js')], {
      cwd: repoRoot,
      env: { ...process.env, [REAL_PROVIDER_CALL_ENV]: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.notEqual(err.status, 0);
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    assert.match(output, /REAL_PROVIDER_CALL_NOT_AUTHORIZED/);
    return true;
  });
});

// ── 6: env only against a live-only script -> still zero provider calls ──

test('scripts/test-agy-live.js: env opt-in alone (no CLI flag) still denies', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts/test-agy-live.js')], {
      cwd: repoRoot,
      env: { ...process.env, [REAL_PROVIDER_CALL_ENV]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.notEqual(err.status, 0);
    assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /REAL_PROVIDER_CALL_NOT_AUTHORIZED/);
    return true;
  });
});

// ── 7: CLI confirmation only, env absent -> zero provider calls ──────────

test('scripts/test-agy-live.js: CLI flag alone (no env) still denies', () => {
  assert.throws(() => {
    execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/test-agy-live.js'), REAL_PROVIDER_CALL_FLAG],
      {
        cwd: repoRoot,
        env: { ...process.env, [REAL_PROVIDER_CALL_ENV]: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }, (err) => {
    assert.notEqual(err.status, 0);
    assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /REAL_PROVIDER_CALL_NOT_AUTHORIZED/);
    return true;
  });
});

// ── 8: benchmark deterministic mode requires no opt-in ────────────────────

test('bin/benchmark-tokens.js: deterministic mode is zero-model and needs no opt-in', async () => {
  const { runDeterministicBenchmark } = await import('../bin/benchmark-tokens.js');
  const result = runDeterministicBenchmark({ scenario: 'rework' });
  assert.equal(result.isLive, false);
  assert.ok(result.summary);
});

// ── 9: benchmark live mode without env -> zero runSuperGPT calls ─────────

test('bin/benchmark-tokens.js: --live without env opt-in denies before runSuperGPT', async () => {
  const { runLiveBenchmark } = await import('../bin/benchmark-tokens.js');
  delete process.env[REAL_PROVIDER_CALL_ENV];
  await assert.rejects(
    () => runLiveBenchmark({ scenario: 'rework' }),
    (err) => {
      assert.equal(err.code, REAL_PROVIDER_CALL_NOT_AUTHORIZED);
      return true;
    },
  );
});

// ── 10: provider overhead probe unauthorized -> zero probe calls ─────────

test('bin/probe-provider-overhead.js: unauthorized direct execution never runs the probe', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [path.join(repoRoot, 'bin/probe-provider-overhead.js')], {
      cwd: repoRoot,
      env: { ...process.env, [REAL_PROVIDER_CALL_ENV]: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.notEqual(err.status, 0);
    assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /REAL_PROVIDER_CALL_NOT_AUTHORIZED/);
    return true;
  });
});

// ── 11: mechanical inventory — every known live entrypoint calls the guard ─

test('inventory: every registered real-provider entrypoint source references the shared guard', () => {
  assert.ok(REAL_PROVIDER_CALL_ENTRYPOINTS.length >= 9, 'registry should list the known live entrypoints');
  for (const entry of REAL_PROVIDER_CALL_ENTRYPOINTS) {
    const relPath = entry.split(' ')[0]; // strip a trailing "--live" style suffix
    const fullPath = path.join(repoRoot, relPath);
    const source = readFileSync(fullPath, 'utf8');
    assert.match(
      source,
      /assertRealProviderCallsAuthorized/,
      `${relPath} must call assertRealProviderCallsAuthorized before its provider boundary`,
    );
  }
});

// ── 12: bare `node --test`-style discovery regression ─────────────────────
//
// The actual accident was bare test discovery importing/executing a live
// script's top-level code. Every guarded entrypoint above now gates on
// executed-as-main (fileURLToPath(import.meta.url) === resolved argv[1]),
// so importing it as a module — exactly what test discovery does — never
// reaches main()/run() at all. This proves the import side is inert without
// spawning a real bare `node --test` pass (which risked exactly the
// regression this guard exists to prevent, before the guard existed).

test('bare test-discovery regression: importing a live script never calls main/run', async () => {
  let importedWithoutSideEffects = true;
  try {
    await import('../scripts/test-agy-live.js');
    await import('../scripts/test-agy-conversations-live.js');
    await import('../scripts/live-smoke-active-pools.js');
    await import('../scripts/measure-supervisor-decisions.js');
  } catch {
    importedWithoutSideEffects = false;
  }
  assert.equal(importedWithoutSideEffects, true, 'plain import of a live script must not throw/execute main');
});
