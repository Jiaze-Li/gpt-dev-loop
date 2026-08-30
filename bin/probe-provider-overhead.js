#!/usr/bin/env node
// Explicit live diagnostic. Intentionally not wired into npm test/benchmark.
import { runProviderOverheadProbe } from '../src/orchestrator/providerOverheadProbe.js';

const report = await runProviderOverheadProbe();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
