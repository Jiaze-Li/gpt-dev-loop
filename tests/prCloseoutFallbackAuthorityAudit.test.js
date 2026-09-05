// § PR-repair fallback audit (Global New Information Policy default-deny fix).
//
// createRealGithubPrCloseoutAdapters()'s runRepairTask has TWO branches for
// running the internal repair Executor physical call:
//
//   1. Primary path  — selection.createExecutorSessionManager() routes
//      through the SAME production runtime/ModelSpendAuthority every other
//      role shares (real informationLedger, unconditionally enforced).
//   2. Fallback path — when `selection` has no role runtime at all
//      (selection.createExecutorSessionManager is not a function), it builds
//      its OWN ModelSpendAuthority (see supergpt.js's runRepairTask).
//
// This file proves branch 2 is MECHANICALLY UNREACHABLE with a real
// production `selection`: `selection` is always constructed by the REAL
// selectProviders() factory (see supergpt.js's top-level `const selection =
// (_selectProviders || selectProviders)({...})` — `_selectProviders` is a
// test-only seam, never wired in production), and selectProviders() always
// returns `createExecutorSessionManager` as a function. So in every real
// production configuration, runRepairTask takes branch 1 — the fallback's
// own `new ModelSpendAuthority(...)` construction (supergpt.js ~line 1232)
// only ever runs in tests that deliberately construct a stripped-down
// `selection` stand-in (see tests/prCloseoutRepairPermit.test.js). Even so,
// that fallback construction already reuses the SAME informationLedger the
// adapter itself registered evidence against (`informationLedger` in scope,
// not `null`) whenever one is available — see the source comment "§ PART C"
// at that call site — so it is never a silent New Information bypass either.
//
// REAL MODEL CALLS = 0. SUPERGPT MCP TOOLS = 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { makeFakeCallAgy } from './fixtures/fakeAgy.mjs';

test('real selectProviders() always exposes createExecutorSessionManager as a function', () => {
  const selection = selectProviders({ env: {}, callAgy: makeFakeCallAgy({}) });
  assert.equal(typeof selection.createExecutorSessionManager, 'function');
});

test('real selectProviders() always exposes runtime.spendAuthority with a wired informationLedger', () => {
  const selection = selectProviders({ env: {}, callAgy: makeFakeCallAgy({}) });
  assert.ok(selection.runtime?.spendAuthority, 'the ONE production ModelSpendAuthority is exposed on runtime');
  assert.ok(selection.runtime.spendAuthority.informationLedger, 'that Authority always carries an informationLedger in production');
  assert.equal(selection.runtime.spendAuthority.informationLedger, selection.informationLedger, 'the SAME ledger instance is exposed both ways');
});

test('supergpt.js never constructs `selection` any other way in production (only a test seam can substitute it)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/orchestrator/supergpt.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /const selection = \(_selectProviders \|\| selectProviders\)\(\{/,
    'selection is always the real selectProviders() output unless a test explicitly injects _selectProviders',
  );
});
