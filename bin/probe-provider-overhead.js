#!/usr/bin/env node
// Explicit live diagnostic. Intentionally not wired into npm test/benchmark.
import { runProviderOverheadProbe } from '../src/orchestrator/providerOverheadProbe.js';
import { assertRealProviderCallsAuthorized, REAL_PROVIDER_CALL_FLAG } from '../src/orchestrator/realProviderCallGuard.js';

async function main() {
  assertRealProviderCallsAuthorized({
    explicitLiveIntent: process.argv.slice(2).includes(REAL_PROVIDER_CALL_FLAG),
    entrypoint: 'bin/probe-provider-overhead.js',
  });

  const report = await runProviderOverheadProbe();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(err.exitCode ?? 1);
});
