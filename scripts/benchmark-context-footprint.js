#!/usr/bin/env node
// ReviewLoop benchmark — deterministic, zero-provider.
//
// ReviewLoop cannot observe the foreground Worker's token usage through MCP,
// so there is no honest "E2E multiplier" to report here. What IS measurable
// deterministically is the always-loaded Worker-context footprint the design
// minimizes, plus ReviewLoop-owned Reviewer / Supervisor / external-trigger
// counts from a run's telemetry.
//
// Historical V1/V2 "Direct vs SuperGPT" numbers live in
// docs/history/SUPERGPT_V1_V2_LESSONS.md — they are NOT ReviewLoop numbers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReviewLoopMcpServer } from '../src/mcp/reviewloopMcpServer.js';

const common = readFileSync(fileURLToPath(new URL('../agent-policy/COMMON.md', import.meta.url)), 'utf8');
const server = createReviewLoopMcpServer({ controller: { begin: async () => ({}), review: async () => ({}) } });
const tools = server._registeredTools ?? {};
const names = Object.keys(tools);
let schemaBytes = 0;
for (const n of names) {
  schemaBytes += Buffer.byteLength(JSON.stringify({ d: tools[n].description, i: Object.keys(tools[n].inputSchema ?? {}) }), 'utf8');
}

console.log(JSON.stringify({
  benchmark: 'reviewloop.context-footprint/v1',
  commonBytes: Buffer.byteLength(common, 'utf8'),
  workerFacingMcpTools: names,
  workerFacingMcpToolCount: names.length,
  combinedMcpSchemaBytes: schemaBytes,
  note: 'Worker token usage is external / not observable by ReviewLoop. First-pass ReviewLoop model overhead is structurally: Direct Worker + one compact independent Reviewer call.',
}, null, 2));
